import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { z } from 'zod'
import { createConversation, hostArguments } from './conversation.js'

const { plan, summary, forwarded } = await hostArguments('Usage: stream-host <plan.json> <summary.json> [engine arguments]')

const ControlRequest = z.looseObject({
  request_id: z.string(),
  request: z.looseObject({ subtype: z.string(), tool_name: z.string().optional(), tool_use_id: z.string().optional(), input: z.record(z.string(), z.unknown()).optional() }),
})
const ControlResponse = z.looseObject({ response: z.looseObject({ subtype: z.string(), request_id: z.string(), error: z.string().optional() }) })
const CancelRequest = z.looseObject({ request_id: z.string() })

const engine = spawn(plan.engine, [
  '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--permission-prompt-tool', 'stdio',
  ...plan.args, '--permission-mode', plan.permissionMode,
  ...plan.resume === undefined ? [] : ['--resume', plan.resume], ...plan.fork ? ['--fork-session'] : [],
  ...forwarded,
], { env: { ...process.env, ...plan.env }, stdio: ['pipe', 'pipe', 'pipe'] })
const exited = once(engine, 'exit') as Promise<[number | null, NodeJS.Signals | null]>
engine.stderr.pipe(process.stderr)

const write = (message: unknown): void => {
  engine.stdin.write(`${JSON.stringify(message)}\n`)
}
const pending = new Map<string, { resolve: () => void; reject: (error: Error) => void }>()
let requests = 0
const control = (request: Readonly<Record<string, unknown>>): Promise<void> => {
  requests += 1
  const id = `aang-${String(requests)}`
  const answered = new Promise<void>((resolve, reject) => {
    pending.set(id, { resolve, reject })
  })
  write({ type: 'control_request', request_id: id, request })
  return answered
}

const conversation = createConversation(plan, summary, () => control({ subtype: 'interrupt' }))
const cancelled = new Set<string>()
engine.stdin.on('error', conversation.fail)

const answer = async (raw: unknown): Promise<void> => {
  const { request_id: id, request } = ControlRequest.parse(raw)
  if (request.subtype !== 'can_use_tool' || request.tool_name === undefined) {
    write({ type: 'control_response', response: { subtype: 'error', request_id: id, error: 'Unsupported request' } })
    throw new Error(`Unexpected control request ${request.subtype}`)
  }
  const response = await conversation.permission(request.tool_name, request.tool_use_id ?? null, request.input ?? {})
  if (!cancelled.has(id)) write({ type: 'control_response', response: { subtype: 'success', request_id: id, response } })
}

createInterface({ input: engine.stdout }).on('line', (line) => {
  if (line.trim() === '') return
  process.stdout.write(`${line}\n`)
  let message: unknown
  try {
    message = JSON.parse(line)
  } catch {
    conversation.fail(new Error('The engine wrote a line that is not JSON'))
    return
  }
  const type = z.looseObject({ type: z.string() }).safeParse(message).data?.type
  if (type === 'control_request') {
    answer(message).catch(conversation.fail)
    return
  }
  if (type === 'control_cancel_request') {
    cancelled.add(CancelRequest.parse(message).request_id)
    return
  }
  if (type === 'control_response') {
    const { response } = ControlResponse.parse(message)
    const waiter = pending.get(response.request_id)
    pending.delete(response.request_id)
    if (response.subtype === 'success') waiter?.resolve()
    else waiter?.reject(new Error(`Control request failed: ${response.error ?? response.subtype}`))
    return
  }
  conversation.observe(message)
})

const lifecycle = { closing: false }
const expectedExit = (code: number | null): boolean => code === 0 || (code === 1 && conversation.endedByInterrupt())
void exited.then(([code, signal]) => {
  if (!lifecycle.closing) conversation.fail(new Error(`The engine exited with ${signal ?? String(code)} before the conversation finished`))
}, conversation.fail)

try {
  if (plan.initialize) await Promise.race([control({ subtype: 'initialize' }), conversation.failed])
  await conversation.converse((prompt) => {
    write({ type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null, session_id: '' })
  })
  lifecycle.closing = true
  engine.stdin.end()
  const [code, signal] = await exited
  if (!expectedExit(code)) throw new Error(`The engine exited with ${signal ?? String(code)}`)
  await conversation.finish(0)
} catch (error) {
  conversation.fail(error)
  engine.kill()
  process.stderr.write(`${conversation.summary.error ?? 'Host failed'}\n`)
  await conversation.finish(1)
  process.exit(1)
}
