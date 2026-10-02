import { once } from 'node:events'
import { appendFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { z } from 'zod'

export type StubCall =
  | { readonly type: 'function_call'; readonly name: string; readonly namespace?: string; readonly arguments: Readonly<Record<string, unknown>> }
  | { readonly type: 'custom_tool_call'; readonly name: string; readonly input: string }

export interface GatedStep {
  readonly calls: readonly StubCall[]
  readonly when: () => Promise<boolean>
}

export type StubStep = readonly StubCall[] | GatedStep

export type StubScript = Readonly<Record<string, readonly StubStep[]>>

export interface StubReply {
  readonly agent: string
  readonly subagent: string | null
  readonly key: string | null
  readonly step: number
  readonly model: string | null
  readonly calls: readonly string[]
}

export interface ResponsesStub {
  readonly url: string
  readonly replies: readonly StubReply[]
  readonly failures: readonly string[]
  readonly close: () => Promise<void>
}

const Content = z.array(z.looseObject({ text: z.string().optional() }))

const Item = z.looseObject({
  type: z.string().optional(),
  role: z.string().optional(),
  call_id: z.string().optional(),
  content: z.unknown().optional(),
})
type Item = z.infer<typeof Item>

const Body = z.looseObject({
  model: z.string().optional(),
  tools: z.array(z.unknown()).optional(),
  input: z.array(Item).optional(),
})

const TurnMetadata = z.looseObject({ agent_name: z.string().optional() })

const marker = /\[aang:([a-z0-9_-]+)\]/i
const outputTypes = new Set(['function_call_output', 'custom_tool_call_output'])
const stubCall = /^call_aang_(\d+)_\d+$/

const usage = {
  input_tokens: 120,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens: 8,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: 128,
}

const textOf = (item: Item): string => {
  const content = Content.safeParse(item.content)
  return content.success ? content.data.map((part) => part.text ?? '').join('\n') : ''
}

const header = (headers: IncomingHttpHeaders, name: string): string | null => {
  const value = headers[name]
  return typeof value === 'string' ? value : null
}

const agentOf = (headers: IncomingHttpHeaders): string => {
  const metadata = TurnMetadata.safeParse(JSON.parse(header(headers, 'x-codex-turn-metadata') ?? '{}'))
  return metadata.success ? metadata.data.agent_name ?? '/root' : '/root'
}

interface Anchor {
  readonly key: string | null
  readonly index: number
}

const anchorOf = (input: readonly Item[], agent: string): Anchor => {
  if (agent !== '/root') {
    const index = input.findLastIndex((item) => item.type === 'agent_message' && textOf(item).includes('NEW_TASK'))
    return { key: agent.slice(agent.lastIndexOf('/') + 1), index }
  }
  const index = input.findLastIndex((item) => item.type === 'message' && item.role === 'user' && marker.test(textOf(item)))
  const found = index < 0 ? undefined : marker.exec(textOf(input[index] ?? {}))?.[1]
  return { key: found ?? null, index }
}

const stepOf = (after: readonly Item[]): number =>
  new Set(after.filter((item) => outputTypes.has(item.type ?? '')).map((item, position) => stubCall.exec(item.call_id ?? '')?.[1] ?? `other-${String(position)}`)).size

const callItem = (call: StubCall, reply: number, index: number): Record<string, unknown> => {
  const id = `call_aang_${String(reply)}_${String(index)}`
  return call.type === 'function_call'
    ? { type: 'function_call', id: `fc_aang_${String(reply)}_${String(index)}`, call_id: id, name: call.name, ...call.namespace === undefined ? {} : { namespace: call.namespace }, arguments: JSON.stringify(call.arguments) }
    : { type: 'custom_tool_call', id: `ctc_aang_${String(reply)}_${String(index)}`, call_id: id, status: 'completed', name: call.name, input: call.input }
}

const isGated = (step: StubStep): step is GatedStep => !Array.isArray(step)

const released = async (step: StubStep | undefined): Promise<readonly StubCall[]> => {
  if (step === undefined) return []
  if (!isGated(step)) return step
  const deadline = Date.now() + 60_000
  while (!await step.when()) {
    if (Date.now() > deadline) throw new Error('A gated stub step was not released within 60 s')
    await delay(50)
  }
  return step.calls
}

const send = (response: ServerResponse, events: readonly Record<string, unknown>[]): void => {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end(events.map((event) => `event: ${String(event['type'])}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
}

export const startResponsesStub = async (script: StubScript, log: string): Promise<ResponsesStub> => {
  const replies: StubReply[] = []
  const failures: string[] = []
  let count = 0
  const answer = async (path: string, headers: IncomingHttpHeaders, raw: string, response: ServerResponse): Promise<StubReply | null> => {
    if (!path.endsWith('/responses')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{}')
      return null
    }
    const parsed = Body.safeParse(JSON.parse(raw || '{}'))
    const body = parsed.success ? parsed.data : {}
    const input = body.input ?? []
    const agent = agentOf(headers)
    const anchor = anchorOf(input, agent)
    const after = input.slice(anchor.index + 1)
    const step = stepOf(after)
    const tools = (body.tools?.length ?? 0) > 0 || input.some((item) => item.type === 'additional_tools')
    const answered = after.some((item) => item.type === 'message' && item.role === 'user')
    const calls = tools && !answered && anchor.key !== null ? await released(script[anchor.key]?.[step]) : []
    count += 1
    const id = `resp_aang_${String(count)}`
    const items = calls.length > 0
      ? calls.map((call, index) => callItem(call, count, index))
      : [{ type: 'message', role: 'assistant', id: `msg_aang_${String(count)}`, content: [{ type: 'output_text', text: 'done' }] }]
    send(response, [
      { type: 'response.created', response: { id, model: body.model ?? null } },
      ...items.map((item, index) => ({ type: 'response.output_item.done', output_index: index, item })),
      { type: 'response.completed', response: { id, model: body.model ?? null, usage } },
    ])
    return { agent, subagent: header(headers, 'x-openai-subagent'), key: anchor.key, step, model: body.model ?? null, calls: calls.map((call) => call.name) }
  }
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const path = request.url ?? '/'
      const record = (reply: StubReply | null, failure: string | null): Promise<void> =>
        appendFile(log, `${JSON.stringify({ at: new Date().toISOString(), method: request.method, path, reply, failure })}\n`).catch(() => undefined)
      void answer(path, request.headers, Buffer.concat(chunks).toString('utf8'), response).then(async (reply) => {
        if (reply !== null) replies.push(reply)
        await record(reply, null)
      }, async (error: unknown) => {
        failures.push(error instanceof Error ? error.message : String(error))
        if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' })
        response.end('{}')
        await record(null, failures.at(-1) ?? null)
      })
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${String(port)}/v1`,
    replies,
    failures,
    close: async () => {
      server.closeAllConnections()
      server.close()
      await once(server, 'close')
    },
  }
}
