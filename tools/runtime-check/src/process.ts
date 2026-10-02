import { spawn, spawnSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'

export const isWindows = process.platform === 'win32'

interface RunOptions {
  readonly env: NodeJS.ProcessEnv
  readonly timeoutMs: number
  readonly cwd?: string
  readonly stdin?: string | Buffer
  readonly verbatim?: boolean
  readonly argv0?: string
}

export interface RunResult {
  readonly status: number | null
  readonly signal: NodeJS.Signals | null
  readonly error: string | null
  readonly stdout: string
  readonly stderr: string
  readonly durationMs: number
  readonly timedOut: boolean
  readonly pid: number | null
}

export const errorCode = (error: unknown): string => {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    return error.code
  }
  return error instanceof Error ? error.message : String(error)
}

export const killTree = (pid: number): void => {
  if (isWindows) {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    return
  }
}

export const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return errorCode(error) === 'EPERM'
  }
}

export const run = (command: string, args: readonly string[], options: RunOptions): Promise<RunResult> =>
  new Promise((resolve) => {
    const started = performance.now()
    const failed = (error: unknown): RunResult => ({
      status: null,
      signal: null,
      error: errorCode(error),
      stdout: '',
      stderr: '',
      durationMs: performance.now() - started,
      timedOut: false,
      pid: null,
    })
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: !isWindows,
        windowsHide: true,
        windowsVerbatimArguments: options.verbatim ?? false,
        ...(options.argv0 === undefined ? {} : { argv0: options.argv0 }),
      })
    } catch (error) {
      resolve(failed(error))
      return
    }
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk
    })
    child.stdin?.on('error', () => undefined)
    child.stdin?.end(options.stdin ?? '')
    const timer = setTimeout(() => {
      timedOut = true
      if (child.pid !== undefined) {
        killTree(child.pid)
      }
    }, options.timeoutMs)
    const settle = (result: RunResult): void => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        resolve(result)
      }
    }
    child.on('error', (error) => {
      if (child.pid === undefined) {
        settle(failed(error))
      }
    })
    child.on('close', (status, signal) => {
      settle({
        status,
        signal,
        error: null,
        stdout,
        stderr,
        durationMs: performance.now() - started,
        timedOut,
        pid: child.pid ?? null,
      })
    })
  })

export const quoteWindowsArgument = (argument: string): string => {
  if (argument !== '' && !/[\s"]/.test(argument)) {
    return argument
  }
  let quoted = '"'
  let backslashes = 0
  for (const character of argument) {
    if (character === '\\') {
      backslashes += 1
      continue
    }
    quoted += character === '"' ? `${'\\'.repeat(backslashes * 2 + 1)}"` : `${'\\'.repeat(backslashes)}${character}`
    backslashes = 0
  }
  return `${quoted}${'\\'.repeat(backslashes * 2)}"`
}

export const excerpt = (text: string, limit = 600): string =>
  text.length <= limit ? text : `${text.slice(0, limit)}… (${String(text.length)} chars)`

export const outcome = (result: RunResult): Record<string, unknown> => ({
  status: result.status,
  signal: result.signal,
  error: result.error,
  timedOut: result.timedOut,
  durationMs: Math.round(result.durationMs),
  stderr: excerpt(result.stderr.trim()),
})
