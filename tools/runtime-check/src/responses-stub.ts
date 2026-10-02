import { z } from 'zod'
import { parseBody, sendEvents, sendJson, startServer, type StubExchange } from './stub-server.js'

export type CodexStep =
  | {
      readonly type: 'function_call'
      readonly name: string
      readonly namespace?: string
      readonly arguments: Readonly<Record<string, unknown>>
    }
  | { readonly type: 'custom_tool_call'; readonly name: string; readonly namespace?: string; readonly input: string }

interface ResponsesScenario {
  readonly steps: readonly CodexStep[]
  readonly text: string
}

interface ResponsesRequest {
  readonly path: string
  readonly model: string | null
  readonly originator: string | null
  readonly bodyTools: readonly string[] | null
  readonly additionalTools: readonly (readonly string[])[]
  readonly outputs: readonly string[]
}

export interface ResponsesStub {
  readonly url: string
  readonly requests: readonly ResponsesRequest[]
  readonly use: (scenario: ResponsesScenario) => void
  readonly close: () => Promise<void>
}

interface ToolEntry {
  readonly type?: string | undefined
  readonly name?: string | undefined
  readonly tools?: readonly ToolEntry[] | undefined
}

const ToolEntry: z.ZodType<ToolEntry> = z.lazy(() =>
  z.looseObject({ type: z.string().optional(), name: z.string().optional(), tools: z.array(ToolEntry).optional() }),
)

const InputItem = z.looseObject({
  type: z.string().optional(),
  output: z.unknown().optional(),
  tools: z.array(ToolEntry).optional(),
})

const ResponsesBody = z.looseObject({
  model: z.string().optional(),
  tools: z.array(ToolEntry).optional(),
  input: z.array(InputItem).optional(),
})
type ResponsesBody = z.infer<typeof ResponsesBody>

const outputTypes: readonly string[] = ['function_call_output', 'custom_tool_call_output']

const toolNames = (entries: readonly ToolEntry[], prefix = ''): string[] =>
  entries.flatMap((entry) => {
    const name = `${prefix}${entry.name ?? entry.type ?? '?'}`
    return entry.tools === undefined ? [name] : toolNames(entry.tools, `${name}/`)
  })

const outputText = (output: unknown): string => (typeof output === 'string' ? output : JSON.stringify(output))

const usage = {
  input_tokens: 12,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens: 4,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: 16,
}

const itemOf = (scenario: ResponsesScenario, step: number, reply: number): Record<string, unknown> => {
  const tool = scenario.steps[step]
  const callId = `call_aang_${String(reply)}`
  if (tool === undefined) {
    return {
      type: 'message',
      role: 'assistant',
      id: `msg_aang_${String(reply)}`,
      content: [{ type: 'output_text', text: scenario.text }],
    }
  }
  const namespace = tool.namespace === undefined ? {} : { namespace: tool.namespace }
  return tool.type === 'function_call'
    ? {
        type: 'function_call',
        id: `fc_aang_${String(reply)}`,
        call_id: callId,
        name: tool.name,
        ...namespace,
        arguments: JSON.stringify(tool.arguments),
      }
    : {
        type: 'custom_tool_call',
        id: `ctc_aang_${String(reply)}`,
        call_id: callId,
        status: 'completed',
        name: tool.name,
        ...namespace,
        input: tool.input,
      }
}

export const startResponsesStub = async (): Promise<ResponsesStub> => {
  let scenario: ResponsesScenario = { steps: [], text: 'done' }
  const requests: ResponsesRequest[] = []
  let replies = 0
  const handle = ({ method, path, headers, body, response }: StubExchange): void => {
    if (method !== 'POST' || !path.endsWith('/responses')) {
      sendJson(response, {})
      return
    }
    const parsed = ResponsesBody.safeParse(parseBody(body))
    const request: ResponsesBody = parsed.success ? parsed.data : {}
    const input = request.input ?? []
    const outputs = input.filter((item) => outputTypes.includes(item.type ?? '')).map((item) => outputText(item.output))
    const originator = headers.originator
    requests.push({
      path,
      model: request.model ?? null,
      originator: typeof originator === 'string' ? originator : null,
      bodyTools: request.tools === undefined ? null : toolNames(request.tools),
      additionalTools: input
        .filter((item) => item.type === 'additional_tools')
        .map((item) => toolNames(item.tools ?? [])),
      outputs,
    })
    replies += 1
    const id = `resp_aang_${String(replies)}`
    sendEvents(response, [
      { type: 'response.created', response: { id } },
      { type: 'response.output_item.done', output_index: 0, item: itemOf(scenario, outputs.length, replies) },
      { type: 'response.completed', response: { id, usage } },
    ])
  }
  const server = await startServer(handle)
  return {
    url: `${server.origin}/v1`,
    requests,
    use: (next) => {
      scenario = next
      requests.length = 0
    },
    close: server.close,
  }
}
