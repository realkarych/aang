import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { type RpcMessage, startAppServer } from './rpc.js'

const Plan = z.strictObject({
  codex: z.string().min(1),
  client: z.strictObject({ name: z.string(), title: z.string(), version: z.string() }),
  thread: z.record(z.string(), z.unknown()),
  turns: z.array(z.strictObject({ prompt: z.string().min(1) })).min(1),
  approval: z.strictObject({ decision: z.enum(['accept', 'decline']), delayMs: z.int().nonnegative() }),
})

const Started = z.looseObject({ thread: z.looseObject({ id: z.string() }) })
const Completed = z.looseObject({ threadId: z.string(), turn: z.looseObject({ status: z.string() }) })

const approvals = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'])

const [planPath, ...extra] = process.argv.slice(2)
if (planPath === undefined || extra.length > 0) throw new Error('Usage: desktop-host <plan.json>')
const plan = Plan.parse(JSON.parse(await readFile(planPath, 'utf8')))

const state: { root?: string; completed?: (status: string) => void } = {}
const print = (message: RpcMessage): void => {
  if (message.method !== undefined && /delta$/i.test(message.method)) return
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

const server = await startAppServer(plan.codex, ['app-server'], plan.client, (message) => {
  print(message)
  const { id, method } = message
  if (method === undefined) return
  if (id !== undefined) {
    if (approvals.has(method)) {
      void delay(plan.approval.delayMs).then(() => {
        server.respond(id, { result: { decision: plan.approval.decision } })
      })
    } else {
      server.respond(id, { error: { code: -32601, message: `${method} is not answered by the recorder host` } })
    }
    return
  }
  const completed = method === 'turn/completed' ? Completed.safeParse(message.params) : undefined
  if (completed?.success && completed.data.threadId === state.root) state.completed?.(completed.data.turn.status)
})

const timeout = (milliseconds: number): Promise<never> => delay(milliseconds, undefined, { ref: false }).then(() => {
  throw new Error(`No turn/completed within ${String(milliseconds)} ms`)
})

try {
  const started = Started.parse(await Promise.race([server.request('thread/start', plan.thread), server.failed]))
  state.root = started.thread.id
  for (const turn of plan.turns) {
    const completed = new Promise<string>((resolve) => {
      state.completed = resolve
    })
    await Promise.race([server.request('turn/start', { threadId: started.thread.id, input: [{ type: 'text', text: turn.prompt }] }), server.failed])
    const status = await Promise.race([completed, server.failed, timeout(120_000)])
    if (status !== 'completed') throw new Error(`Turn ended with status ${status}`)
  }
} finally {
  await server.close()
}
