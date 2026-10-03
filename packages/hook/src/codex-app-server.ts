import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { z } from 'zod'
import { HookInstallError } from './errors.js'
import { isErrorCode } from './files.js'

export interface CodexCli {
  readonly command: string
  readonly args?: readonly string[]
}

export interface CodexAppServerOptions {
  readonly codexHome: string
  readonly codex: CodexCli
  readonly timeoutMs?: number
}

const HookEntry = z.looseObject({
  key: z.string().min(1),
  eventName: z.string(),
  handlerType: z.string(),
  command: z.string().optional(),
  source: z.string(),
  sourcePath: z.string(),
  enabled: z.boolean(),
  trustStatus: z.string().min(1),
})

export type CodexHookEntry = z.infer<typeof HookEntry>

const HookListing = z.looseObject({
  data: z.array(z.looseObject({
    cwd: z.string(),
    hooks: z.array(HookEntry),
    errors: z.array(z.looseObject({ path: z.string(), message: z.string() })),
    warnings: z.array(z.string()),
  })).length(1),
})

export interface CodexHookListing {
  readonly hooks: readonly CodexHookEntry[]
  readonly warnings: readonly string[]
}

const timeoutDefaultMs = 10_000
const maximumOutputBytes = 64 * 1024 * 1024
const maximumStderrChars = 8192

const failure = (message: string, cause?: unknown): HookInstallError =>
  new HookInstallError('codex_app_server', `codex app-server: ${message}`, { cause })

const parseListing = (value: unknown): CodexHookListing => {
  const parsed = HookListing.safeParse(value)
  if (!parsed.success) {
    throw failure('invalid hooks/list response', parsed.error)
  }
  const entry = parsed.data.data[0]
  if (entry === undefined || entry.errors.length > 0) {
    throw failure(entry?.errors.map((error) => `${error.path}: ${error.message}`).join('; ') ?? 'no hook listing')
  }
  if (new Set(entry.hooks.map((hook) => hook.key)).size !== entry.hooks.length) {
    throw failure('duplicate hook keys in hooks/list')
  }
  if (entry.hooks.some((hook) => hook.handlerType === 'command' && hook.command === undefined)) {
    throw failure('missing command in hooks/list')
  }
  return { hooks: entry.hooks, warnings: entry.warnings }
}

const Message = z.looseObject({
  id: z.union([z.number(), z.string()]).optional(),
  method: z.string().optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
})

export const listCodexHooks = ({ codexHome, codex, timeoutMs = timeoutDefaultMs }: CodexAppServerOptions): Promise<CodexHookListing> =>
  new Promise((complete, reject) => {
    if (process.platform === 'win32') {
      reject(new HookInstallError(
        'unsupported_platform',
        'checking Codex hook state on Windows is not enabled yet: app-server requires a launcher with confirmed process-tree termination',
      ))
      return
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      reject(failure('timeoutMs must be positive and finite'))
      return
    }
    const home = resolve(codexHome)
    const child = spawn(codex.command, [...(codex.args ?? []), 'app-server'], {
      cwd: home,
      env: { ...process.env, CODEX_HOME: home },
      stdio: 'pipe',
      windowsHide: true,
      detached: true,
    })
    let pending = ''
    let stderr = ''
    let outputBytes = 0
    let requestId = 1
    let outcome: { readonly value: CodexHookListing } | { readonly error: HookInstallError } | undefined
    let terminated = false

    const terminate = (): void => {
      if (terminated) {
        return
      }
      try {
        if (child.pid !== undefined) {
          process.kill(-child.pid, 'SIGKILL')
        } else {
          child.kill('SIGKILL')
        }
      } catch (error) {
        const unreapedLeader = child.exitCode === null && child.signalCode === null
        if (isErrorCode(error, 'EPERM') && unreapedLeader) {
          return
        }
        if (!isErrorCode(error, 'ESRCH')) {
          outcome = { error: failure('could not stop the app-server process', error) }
        }
      }
      terminated = true
    }

    const stop = (result: NonNullable<typeof outcome>): void => {
      if (outcome !== undefined) {
        return
      }
      outcome = result
      clearTimeout(timer)
      terminate()
      child.stdin.destroy()
    }
    const fail = (message: string, cause?: unknown): void => {
      stop({ error: failure(message, cause) })
    }
    const timer = setTimeout(() => {
      fail(`timed out after ${String(timeoutMs)} ms`)
    }, timeoutMs)
    const send = (message: unknown): void => {
      child.stdin.write(`${JSON.stringify(message)}\n`)
    }
    const onError = (error: Error): void => {
      fail(error.message, error)
    }
    child.on('error', onError)
    child.stdin.on('error', onError)
    child.stdout.on('error', onError)
    child.stderr.on('error', onError)
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-maximumStderrChars)
    })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (outcome !== undefined) {
        return
      }
      outputBytes += Buffer.byteLength(chunk)
      if (outputBytes > maximumOutputBytes) {
        fail('stdout exceeded the size limit')
        return
      }
      pending += chunk
      for (;;) {
        const end = pending.indexOf('\n')
        if (end === -1) {
          break
        }
        const line = pending.slice(0, end).trim()
        pending = pending.slice(end + 1)
        if (line === '') {
          continue
        }
        try {
          const message = Message.parse(JSON.parse(line))
          if (message.method !== undefined || message.id !== requestId) {
            continue
          }
          if (message.error !== undefined) {
            throw failure(`request ${String(requestId)} failed: ${JSON.stringify(message.error)}`)
          }
          if (!Object.hasOwn(message, 'result')) {
            throw failure('response has no result')
          }
          if (requestId === 1) {
            requestId = 2
            send({ method: 'initialized', params: {} })
            send({ id: requestId, method: 'hooks/list', params: {} })
          } else {
            stop({ value: parseListing(message.result) })
            return
          }
        } catch (error) {
          stop({ error: error instanceof HookInstallError ? error : failure('invalid JSON-RPC response', error) })
          return
        }
      }
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      terminate()
      if (outcome === undefined) {
        reject(failure(`exited before hooks/list completed (${String(code ?? signal)})${stderr === '' ? '' : `: ${stderr.trim()}`}`))
      } else if ('error' in outcome) {
        reject(outcome.error)
      } else {
        complete(outcome.value)
      }
    })
    send({
      id: requestId,
      method: 'initialize',
      params: {
        clientInfo: { name: 'aang', title: 'aang hook installation', version: '0.0.0' },
        capabilities: { experimentalApi: true, requestAttestation: false },
      },
    })
  })
