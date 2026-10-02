import { z } from 'zod'
import { parseBody, sendEvents, sendJson, startServer, type StreamEvent, type StubExchange } from './stub-server.js'

export interface ToolStep {
  readonly name: string
  readonly input: Readonly<Record<string, unknown>>
}

interface AnthropicScenario {
  readonly steps: readonly ToolStep[]
  readonly text: string
}

interface AnthropicRequest {
  readonly path: string
  readonly model: string | null
  readonly tools: readonly string[]
  readonly toolResults: number
  readonly responseTool: string | null
  readonly outputs: readonly { readonly toolUseId: unknown; readonly isError: boolean; readonly content: unknown }[]
}

export interface AnthropicStub {
  readonly url: string
  readonly requests: readonly AnthropicRequest[]
  readonly use: (scenario: AnthropicScenario) => void
  readonly close: () => Promise<void>
}

type Block =
  { readonly type: 'text'; readonly text: string } | ({ readonly type: 'tool_use'; readonly id: string } & ToolStep)

const MessagesBody = z.looseObject({
  model: z.string().optional(),
  stream: z.boolean().optional(),
  tools: z.array(z.looseObject({ name: z.string() })).optional(),
  messages: z
    .array(z.looseObject({ content: z.union([z.string(), z.array(z.looseObject({ type: z.string() }))]) }))
    .optional(),
})
type MessagesBody = z.infer<typeof MessagesBody>

const usage = { input_tokens: 12, output_tokens: 4 }

const countToolResults = (body: MessagesBody): number =>
  (body.messages ?? [])
    .flatMap(({ content }) => (typeof content === 'string' ? [] : content))
    .filter((block) => block.type === 'tool_result').length

const replyBlocks = (scenario: AnthropicScenario, step: number): Block[] => {
  const tool = scenario.steps[step]
  return tool === undefined
    ? [{ type: 'text', text: scenario.text }]
    : [{ type: 'tool_use', id: `toolu_aang_${String(step + 1)}`, ...tool }]
}

const blockEvents = (block: Block, index: number): StreamEvent[] =>
  block.type === 'text'
    ? [
        { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } },
        { type: 'content_block_stop', index },
      ]
    : [
        {
          type: 'content_block_start',
          index,
          content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
        },
        {
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
        },
        { type: 'content_block_stop', index },
      ]

const streamOf = (id: string, blocks: readonly Block[], stopReason: string): StreamEvent[] => [
  {
    type: 'message_start',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model: 'aang-stub',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage,
    },
  },
  ...blocks.flatMap(blockEvents),
  { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage },
  { type: 'message_stop' },
]

export const startAnthropicStub = async (): Promise<AnthropicStub> => {
  let scenario: AnthropicScenario = { steps: [], text: 'done' }
  const requests: AnthropicRequest[] = []
  let replies = 0
  const handle = ({ method, path, body, response }: StubExchange): void => {
    if (method !== 'POST' || !path.startsWith('/v1/messages')) {
      sendJson(response, {})
      return
    }
    if (path.startsWith('/v1/messages/count_tokens')) {
      sendJson(response, { input_tokens: usage.input_tokens })
      return
    }
    const parsed = MessagesBody.safeParse(parseBody(body))
    const request: MessagesBody = parsed.success ? parsed.data : {}
    const step = countToolResults(request)
    requests.push({
      path,
      model: request.model ?? null,
      tools: (request.tools ?? []).map(({ name }) => name),
      toolResults: step,
      responseTool: scenario.steps[step]?.name ?? null,
      outputs: (request.messages ?? []).flatMap(({ content }) => typeof content === 'string' ? [] : content)
        .filter((block) => block.type === 'tool_result')
        .map((block) => ({ toolUseId: block.tool_use_id ?? null, isError: block.is_error === true, content: block.content ?? null })),
    })
    replies += 1
    const id = `msg_aang_${String(replies)}`
    const blocks = replyBlocks(scenario, step)
    const stopReason = blocks.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn'
    if (request.stream === true) {
      sendEvents(response, streamOf(id, blocks, stopReason))
      return
    }
    sendJson(response, {
      id,
      type: 'message',
      role: 'assistant',
      model: 'aang-stub',
      content: blocks,
      stop_reason: stopReason,
      stop_sequence: null,
      usage,
    })
  }
  const server = await startServer(handle)
  return {
    url: server.origin,
    requests,
    use: (next) => {
      scenario = next
      requests.length = 0
    },
    close: server.close,
  }
}
