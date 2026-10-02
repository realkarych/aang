import { once } from 'node:events'
import { appendFile } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { z } from 'zod'

export type StubBlock =
  { readonly text: string } | { readonly tool: string; readonly input: Readonly<Record<string, unknown>> }

export type StubScript = Readonly<Record<string, readonly (readonly StubBlock[])[]>>

export interface ModelStub {
  readonly url: string
  readonly close: () => Promise<void>
}

const Content = z.union([z.string(), z.array(z.looseObject({ type: z.string(), text: z.string().optional() }))])
const MessagesBody = z.looseObject({
  model: z.string().optional(),
  stream: z.boolean().optional(),
  tools: z.array(z.looseObject({ name: z.string().optional() })).optional(),
  messages: z.array(z.looseObject({ role: z.string(), content: Content })).optional(),
})
type MessagesBody = z.infer<typeof MessagesBody>
type Message = NonNullable<MessagesBody['messages']>[number]

type Block =
  { readonly type: 'text'; readonly text: string } |
  { readonly type: 'tool_use'; readonly id: string; readonly name: string; readonly input: Readonly<Record<string, unknown>> }

const marker = /\[aang:([a-z0-9-]+)\]/
const planFile = /(?:create your plan at|plan file already exists at) (.+?\.md)\b/
export const planFilePlaceholder = '{plan-file}'
const usage = { input_tokens: 12, cache_creation_input_tokens: 2, cache_read_input_tokens: 8, output_tokens: 4 }
const aliases: Readonly<Record<string, readonly string[]>> = { Agent: ['Agent', 'Task'], Task: ['Task', 'Agent'] }

const authoredText = (message: Message): string | undefined => {
  if (message.role !== 'user') return undefined
  const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content
  if (blocks.some((block) => block.type === 'tool_result')) return undefined
  const text = blocks.flatMap((block) => block.type === 'text' && block.text !== undefined ? [block.text] : [])
    .filter((value) => !value.trimStart().startsWith('<system-reminder>')).join('\n').trim()
  return text === '' ? undefined : text
}

const plain = (text: string): Block[] => [{ type: 'text', text }]

const allTexts = (messages: readonly Message[]): string[] => messages.flatMap(({ content }) =>
  typeof content === 'string' ? [content] : content.flatMap((block) => block.text === undefined ? [] : [block.text]))

const substitute = (value: unknown, replacements: ReadonlyMap<string, string>): unknown => {
  if (typeof value === 'string') return [...replacements].reduce((text, [token, replacement]) => text.replaceAll(token, replacement), value)
  if (Array.isArray(value)) return value.map((item) => substitute(item, replacements))
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, replacements)]))
  return value
}

const toolName = (requested: string, offered: ReadonlySet<string>): string =>
  (aliases[requested] ?? [requested]).find((name) => offered.has(name)) ?? requested

const replyOf = (script: StubScript, body: MessagesBody): { key: string | null; step: number; blocks: Block[] } => {
  const offered = new Set((body.tools ?? []).flatMap(({ name }) => name === undefined ? [] : [name]))
  const messages = body.messages ?? []
  const texts = messages.map(authoredText)
  const anchor = texts.findLastIndex((text) => text !== undefined && marker.test(text))
  const key = marker.exec(texts[anchor] ?? '')?.[1]
  if (offered.size === 0 || key === undefined) return { key: key ?? null, step: 0, blocks: plain('done') }
  const step = messages.slice(anchor + 1).filter((message) => message.role === 'assistant').length
  if (texts.slice(anchor + 1).some((text) => text !== undefined)) return { key, step, blocks: plain('done') }
  const scripted = script[key]?.[step]
  if (scripted === undefined) return { key, step, blocks: plain('done') }
  const plan = allTexts(messages).map((text) => planFile.exec(text)?.[1]).findLast((path) => path !== undefined)
  const replacements = new Map(plan === undefined ? [] : [[planFilePlaceholder, plan]])
  return {
    key,
    step,
    blocks: scripted.map((block, index) => 'text' in block
      ? { type: 'text', text: block.text }
      : {
          type: 'tool_use',
          id: `toolu_aang_${key}_${String(step)}_${String(index)}`,
          name: toolName(block.tool, offered),
          input: substitute(block.input, replacements) as Readonly<Record<string, unknown>>,
        }),
  }
}

const blockEvents = (block: Block, index: number): unknown[] => block.type === 'text'
  ? [
      { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } },
      { type: 'content_block_stop', index },
    ]
  : [
      { type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } },
      { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } },
      { type: 'content_block_stop', index },
    ]

const sendJson = (response: ServerResponse, value: unknown): void => {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}

const sendEvents = (response: ServerResponse, events: readonly unknown[]): void => {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end(events.map((event) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
}

const parse = (text: string): MessagesBody => {
  try {
    const parsed = MessagesBody.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : {}
  } catch {
    return {}
  }
}

export const startModelStub = async (script: StubScript, log: string): Promise<ModelStub> => {
  let replies = 0
  let logging = Promise.resolve()
  const server = createServer((request, response) => {
    let text = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => {
      text += chunk
    })
    request.on('end', () => {
      const path = request.url ?? '/'
      if (request.method !== 'POST' || !path.startsWith('/v1/messages')) {
        sendJson(response, {})
        return
      }
      if (path.startsWith('/v1/messages/count_tokens')) {
        sendJson(response, { input_tokens: usage.input_tokens })
        return
      }
      const body = parse(text)
      const { key, step, blocks } = replyOf(script, body)
      replies += 1
      const id = `msg_aang_${String(replies)}`
      const model = body.model ?? 'claude-stub'
      const stopReason = blocks.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn'
      const entry = { at: new Date().toISOString(), id, key, step, tools: body.tools?.length ?? 0, reply: blocks.map((block) => block.type === 'text' ? 'text' : block.name) }
      logging = logging.then(() => appendFile(log, `${JSON.stringify(entry)}\n`)).catch(() => undefined)
      if (body.stream !== true) {
        sendJson(response, { id, type: 'message', role: 'assistant', model, content: blocks, stop_reason: stopReason, stop_sequence: null, usage })
        return
      }
      sendEvents(response, [
        { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage } },
        ...blocks.flatMap(blockEvents),
        { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage },
        { type: 'message_stop' },
      ])
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${String(port)}`,
    close: async () => {
      server.closeAllConnections()
      server.close()
      await once(server, 'close')
      await logging
    },
  }
}
