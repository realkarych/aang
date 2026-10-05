import { once } from 'node:events'
import { appendFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createInterface } from 'node:readline'
import { z } from 'zod'

const [log] = process.argv.slice(2)
if (log === undefined) throw new Error('Usage: elicitation-server <log.jsonl>')

const Id = z.union([z.string(), z.number()])
const Incoming = z.looseObject({ id: Id.optional(), method: z.string().optional(), params: z.unknown().optional(), result: z.unknown().optional(), error: z.unknown().optional() })
const Initialize = z.looseObject({
  protocolVersion: z.string(),
  capabilities: z.looseObject({ elicitation: z.looseObject({ url: z.unknown().optional() }).optional() }).optional(),
})
const Call = z.looseObject({ name: z.string() })
const Answer = z.looseObject({ action: z.enum(['accept', 'decline', 'cancel']), content: z.record(z.string(), z.unknown()).optional() })
type Answer = z.infer<typeof Answer>

const greetingSchema = {
  type: 'object',
  properties: { greeting: { type: 'string', title: 'Greeting', enum: ['Hello', 'Hi'] } },
  required: ['greeting'],
} as const

const tools = [
  { name: 'choose_greeting', description: 'Ask the user which greeting the project uses', inputSchema: { type: 'object', properties: {} } },
  { name: 'confirm_link', description: 'Ask the user to confirm the project by opening a link', inputSchema: { type: 'object', properties: {} } },
]

let logging = Promise.resolve()
const note = (event: Readonly<Record<string, unknown>>): void => {
  const line = `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`
  logging = logging.then(() => appendFile(log, line)).catch(() => undefined)
}

const send = (message: Readonly<Record<string, unknown>>): void => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
}

const pending = new Map<string, (result: unknown) => void>()
let requests = 0
const request = (method: string, params: Readonly<Record<string, unknown>>): Promise<unknown> => {
  requests += 1
  const id = `aang-${String(requests)}`
  const answered = new Promise<unknown>((resolve) => {
    pending.set(id, resolve)
  })
  send({ id, method, params })
  return answered
}

const text = (value: string, isError = false): Record<string, unknown> => ({ content: [{ type: 'text', text: value }], isError })

const visits = new Map<string, () => void>()
const site = createServer((incoming, response) => {
  const id = /^\/confirm\/([\w-]+)$/.exec(incoming.url ?? '')?.[1]
  const visited = id === undefined ? undefined : visits.get(id)
  response.writeHead(visited === undefined ? 404 : 200, { 'content-type': 'text/plain' })
  response.end(visited === undefined ? 'unknown link' : 'confirmed')
  if (id !== undefined && visited !== undefined) {
    note({ event: 'visited', elicitationId: id })
    visited()
  }
})
site.listen(0, '127.0.0.1')
await once(site, 'listening')
const origin = `http://127.0.0.1:${String((site.address() as AddressInfo).port)}`

const elicit = async (params: Readonly<Record<string, unknown>>): Promise<Answer> => {
  note({ event: 'elicited', ...params })
  const answer = Answer.parse(await request('elicitation/create', params))
  note({ event: 'answered', mode: params['mode'], elicitationId: params['elicitationId'] ?? null, action: answer.action, content: answer.content ?? null })
  return answer
}

const chooseGreeting = async (): Promise<Record<string, unknown>> => {
  const answer = await elicit({ mode: 'form', message: 'Which greeting should the project use?', requestedSchema: greetingSchema })
  const greeting = z.looseObject({ greeting: z.string() }).safeParse(answer.content).data?.greeting
  return answer.action === 'accept' && greeting !== undefined ? text(`The user chose ${greeting}`) : text(`The user did not choose a greeting: ${answer.action}`, true)
}

let links = 0
const client = { url: false }
const confirmLink = async (): Promise<Record<string, unknown>> => {
  if (!client.url) return text('The client does not support URL elicitation', true)
  links += 1
  const elicitationId = `aang-link-${String(links)}`
  const visited = new Promise<void>((resolve) => {
    visits.set(elicitationId, resolve)
  })
  const answer = await elicit({ mode: 'url', message: 'Open the link to confirm the project', url: `${origin}/confirm/${elicitationId}`, elicitationId })
  if (answer.action !== 'accept') return text(`The user did not open the link: ${answer.action}`, true)
  await visited
  send({ method: 'notifications/elicitation/complete', params: { elicitationId } })
  note({ event: 'completed', elicitationId })
  return text('The user confirmed the project through the link')
}

const handle = async (id: z.infer<typeof Id>, method: string, params: unknown): Promise<void> => {
  if (method === 'initialize') {
    const initialize = Initialize.parse(params)
    client.url = initialize.capabilities?.elicitation?.url !== undefined
    note({ event: 'initialize', protocolVersion: initialize.protocolVersion, elicitation: initialize.capabilities?.elicitation ?? null })
    send({ id, result: { protocolVersion: initialize.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'aang-elicitation', version: '1.0.0' } } })
    return
  }
  if (method === 'ping') {
    send({ id, result: {} })
    return
  }
  if (method === 'tools/list') {
    send({ id, result: { tools } })
    return
  }
  if (method === 'tools/call') {
    const { name } = Call.parse(params)
    const result = name === 'choose_greeting' ? await chooseGreeting() : name === 'confirm_link' ? await confirmLink() : text(`Unknown tool ${name}`, true)
    send({ id, result })
    return
  }
  send({ id, error: { code: -32601, message: `Method not found: ${method}` } })
}

const lines = createInterface({ input: process.stdin })
lines.on('line', (line) => {
  if (line.trim() === '') return
  const message = Incoming.parse(JSON.parse(line))
  if (message.method === undefined && message.id !== undefined) {
    const resolve = pending.get(String(message.id))
    pending.delete(String(message.id))
    if (message.error !== undefined) note({ event: 'rejected', id: message.id, error: message.error })
    resolve?.(message.error === undefined ? message.result : { action: 'cancel' })
    return
  }
  if (message.method === undefined || message.id === undefined) return
  const id = message.id
  handle(id, message.method, message.params).catch((error: unknown) => {
    send({ id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } })
  })
})
await once(lines, 'close')
site.close()
await logging
