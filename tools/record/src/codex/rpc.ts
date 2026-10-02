import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { z } from 'zod'

export const RpcMessage = z.looseObject({
  id: z.union([z.number(), z.string()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
})
export type RpcMessage = z.infer<typeof RpcMessage>

export interface AppServer {
  readonly request: (method: string, params: unknown) => Promise<unknown>
  readonly notify: (method: string, params: unknown) => void
  readonly respond: (id: number | string, body: { readonly result: unknown } | { readonly error: unknown }) => void
  readonly failed: Promise<never>
  readonly close: () => Promise<void>
}

export interface ClientInfo {
  readonly name: string
  readonly title: string
  readonly version: string
}

export const startAppServer = async (command: string, args: readonly string[], client: ClientInfo, onMessage: (message: RpcMessage) => void): Promise<AppServer> => {
  const child = spawn(command, [...args], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
  const pending = new Map<number, { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void }>()
  let next = 0
  let buffer = ''
  let reject: (error: Error) => void = () => undefined
  const failed = new Promise<never>((_resolve, rejectFailure) => {
    reject = rejectFailure
  })
  failed.catch(() => undefined)
  const fail = (error: Error): void => {
    for (const waiter of pending.values()) waiter.reject(error)
    pending.clear()
    reject(error)
  }
  const write = (message: unknown): void => {
    child.stdin.write(`${JSON.stringify(message)}\n`)
  }
  child.on('error', fail)
  child.stdin.on('error', () => undefined)
  child.on('exit', (code, signal) => {
    fail(new Error(`codex app-server exited (${String(code ?? signal)})`))
  })
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    buffer += chunk
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      const line = buffer.slice(0, end).trim()
      buffer = buffer.slice(end + 1)
      if (line === '') continue
      const message = RpcMessage.parse(JSON.parse(line))
      const waiter = message.method === undefined && typeof message.id === 'number' ? pending.get(message.id) : undefined
      if (waiter !== undefined && typeof message.id === 'number') {
        pending.delete(message.id)
        if (message.error === undefined) waiter.resolve(message.result)
        else waiter.reject(new Error(`app-server error: ${JSON.stringify(message.error)}`))
      } else {
        onMessage(message)
      }
    }
  })
  const request = (method: string, params: unknown): Promise<unknown> => new Promise((resolve, rejectRequest) => {
    next += 1
    pending.set(next, { resolve, reject: rejectRequest })
    write({ id: next, method, params })
  })
  const server: AppServer = {
    request,
    notify: (method, params) => {
      write({ method, params })
    },
    respond: (id, body) => {
      write({ id, ...body })
    },
    failed,
    close: async () => {
      const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : once(child, 'exit').then(() => undefined)
      child.stdin.end()
      const timer = setTimeout(() => child.kill('SIGKILL'), 15_000)
      await exited
      clearTimeout(timer)
    },
  }
  await Promise.race([request('initialize', { clientInfo: client, capabilities: { experimentalApi: true } }), failed])
  server.notify('initialized', {})
  return server
}
