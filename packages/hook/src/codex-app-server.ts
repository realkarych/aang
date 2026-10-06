import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
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
  readonly signal?: AbortSignal
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

const treeStopTimeoutMs = 10_000
const treeStopPollMs = 25

const windows = process.platform === 'win32'

const LauncherStatus = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('stopped'), exit_code: z.number().int() }),
  z.object({ outcome: z.literal('not_started'), step: z.string(), error: z.string() }),
])

type LauncherStatus = z.infer<typeof LauncherStatus>

const readLauncherStatus = (path: string): LauncherStatus | undefined => {
  try {
    return LauncherStatus.safeParse(JSON.parse(readFileSync(path, 'utf8'))).data
  } catch {
    return undefined
  }
}

const windowsExecutable = (command: string): string =>
  isAbsolute(command)
    ? command
    : ((process.env.PATH ?? '')
        .split(delimiter)
        .filter((directory) => directory !== '')
        .flatMap((directory) => ['.com', '.exe'].map((extension) => join(directory, `${command}${extension}`)))
        .find((candidate) => existsSync(candidate)) ?? command)

const groupEmpty = (pid: number): boolean => {
  try {
    process.kill(-pid, 0)
    return false
  } catch (error) {
    return isErrorCode(error, 'ESRCH')
  }
}

const unconfirmedTrees = new Map<symbol, string>()

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

export const listCodexHooks = (
  { codexHome, codex, timeoutMs = timeoutDefaultMs, signal }: CodexAppServerOptions,
  launcher: string,
): Promise<CodexHookListing> =>
  new Promise((complete, reject) => {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      reject(failure('timeoutMs must be positive and finite'))
      return
    }
    if (signal?.aborted === true) {
      reject(failure('cancelled'))
      return
    }
    const home = resolve(codexHome)
    if ([...unconfirmedTrees.values()].includes(home)) {
      reject(failure('the previous app-server process tree is not confirmed stopped'))
      return
    }
    const command = windows ? windowsExecutable(codex.command) : codex.command
    const args = [...(codex.args ?? []), 'app-server']
    const statusPath = windows ? join(mkdtempSync(join(tmpdir(), 'aang-app-server-')), 'status.json') : ''
    const options = { cwd: home, env: { ...process.env, CODEX_HOME: home }, stdio: 'pipe', windowsHide: true } as const
    const child = windows
      ? spawn(launcher, ['launch', statusPath, 'stream', command, ...args], options)
      : spawn(command, args, { ...options, detached: true })
    let pending = ''
    let stderr = ''
    let outputBytes = 0
    let requestId = 1
    let outcome: { readonly value: CodexHookListing } | { readonly error: HookInstallError } | undefined
    let terminated = false
    let exited = false
    let closed = false
    let exit: number | NodeJS.Signals | null = null
    let stopRequestedAt: number | undefined
    let stopWatch: NodeJS.Timeout | undefined
    let settled = false
    const call = Symbol(home)

    const terminate = (): void => {
      if (terminated) {
        return
      }
      if (windows) {
        child.stdin.end()
        terminated = true
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

    const stopState = (): 'confirmed' | 'pending' | 'lost' => {
      if (child.pid === undefined) {
        return 'confirmed'
      }
      if (!windows) {
        return exited && groupEmpty(child.pid) ? 'confirmed' : 'pending'
      }
      if (readLauncherStatus(statusPath) !== undefined) {
        return 'confirmed'
      }
      return exited ? 'lost' : 'pending'
    }

    const detach = (): void => {
      child.stdin.destroy()
      child.stdout.destroy()
      child.stderr.destroy()
    }

    const release = (): void => {
      clearInterval(stopWatch)
      detach()
      if (windows) {
        rmSync(dirname(statusPath), { recursive: true, force: true })
      }
    }

    const settle = (unconfirmed?: string): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
      const launched = windows ? readLauncherStatus(statusPath) : undefined
      if (unconfirmed !== undefined) {
        reject(failure(unconfirmed))
      } else if (launched?.outcome === 'not_started') {
        reject(failure(`could not start ${codex.command} (${launched.step}): ${launched.error}`))
      } else if (outcome === undefined) {
        const code = launched?.exit_code ?? exit
        reject(failure(`exited before hooks/list completed (${String(code)})${stderr === '' ? '' : `: ${stderr.trim()}`}`))
      } else if ('error' in outcome) {
        reject(outcome.error)
      } else {
        complete(outcome.value)
      }
    }

    const watchStop = (): void => {
      if (stopRequestedAt === undefined) {
        return
      }
      terminate()
      const state = stopState()
      const expired = Date.now() - stopRequestedAt >= treeStopTimeoutMs
      if (state === 'confirmed' && (closed || expired || settled)) {
        unconfirmedTrees.delete(call)
        settle()
        release()
      } else if (state === 'lost') {
        unconfirmedTrees.set(call, home)
        settle('the launcher exited without confirming that the app-server process tree stopped')
        release()
      } else if (state === 'pending' && expired && !settled) {
        unconfirmedTrees.set(call, home)
        settle('the app-server process tree did not stop')
        stopWatch?.unref()
        child.unref()
        detach()
      }
    }

    const requestStop = (): void => {
      clearTimeout(timer)
      terminate()
      if (stopRequestedAt === undefined) {
        stopRequestedAt = Date.now()
        stopWatch = setInterval(watchStop, treeStopPollMs)
      }
    }

    const stop = (result: NonNullable<typeof outcome>): void => {
      if (outcome !== undefined) {
        return
      }
      outcome = result
      requestStop()
      child.stdin.destroy()
    }
    const fail = (message: string, cause?: unknown): void => {
      stop({ error: failure(message, cause) })
    }
    const timer = setTimeout(() => {
      fail(`timed out after ${String(timeoutMs)} ms`)
    }, timeoutMs)
    const cancel = (): void => {
      fail('cancelled')
    }
    signal?.addEventListener('abort', cancel, { once: true })
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
    child.on('exit', (code, exitSignal) => {
      exited = true
      exit = code ?? exitSignal
      requestStop()
      watchStop()
    })
    child.on('close', () => {
      closed = true
      requestStop()
      watchStop()
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
