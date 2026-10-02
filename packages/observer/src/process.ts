import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { ObserverState } from '@aang/contract'

export interface CliCommand {
  readonly command: string
  readonly args?: readonly string[]
}

export interface ProcessRequest extends CliCommand {
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly input: string
  readonly timeoutMs: number
  readonly signal?: AbortSignal
}

export type ProcessFailure = 'timeout' | 'cancelled' | 'cli_missing' | 'launcher_unavailable' | 'process_stuck' | 'invalid_output'

export interface ProcessResult {
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
  readonly failure: ProcessFailure | null
  readonly stopped: Promise<void>
}

export interface LaunchStatus {
  readonly state: ObserverState
  readonly activeCalls: number
}

export interface ProcessRunnerOptions {
  readonly windowsLauncher?: string
  readonly temporaryDirectory?: string
}

const missing = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ESRCH'

const emptyGroup = (pid: number): boolean => {
  try {
    process.kill(-pid, 0)
    return false
  } catch (error) {
    return missing(error)
  }
}

const killGroup = (pid: number): void => {
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    return
  }
}

type LauncherStatus = { outcome: 'stopped'; exit_code: number } | { outcome: 'not_started' }

const launcherStatus = (path: string): LauncherStatus | undefined => {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof value !== 'object' || value === null || !('outcome' in value)) return undefined
    if (value.outcome === 'not_started') return { outcome: 'not_started' }
    if (value.outcome === 'stopped' && 'exit_code' in value && typeof value.exit_code === 'number' && Number.isInteger(value.exit_code)) {
      return { outcome: 'stopped', exit_code: value.exit_code }
    }
  } catch {
    return undefined
  }
  return undefined
}

export const createProcessRunner = (options: ProcessRunnerOptions = {}) => {
  const active = new Set<symbol>()
  const stuck = new Set<symbol>()
  const listeners = new Set<(status: LaunchStatus) => void>()
  const status = (): LaunchStatus => ({
    activeCalls: active.size,
    state: stuck.size === 0 ? { state: 'ok' } : { state: 'unavailable', reason: 'process_stuck', retry_at: null },
  })
  const notify = (): void => {
    for (const listener of listeners) listener(status())
  }
  const refused = (failure: ProcessFailure): ProcessResult => ({ exitCode: null, stdout: '', stderr: '', failure, stopped: Promise.resolve() })
  const run = async (request: ProcessRequest): Promise<ProcessResult> => {
    if (stuck.size > 0) return refused('process_stuck')
    if (request.signal?.aborted === true) return refused('cancelled')
    if (!isAbsolute(request.command) || /\.(cmd|bat|ps1)$/i.test(request.command)) return refused('cli_missing')
    const windows = process.platform === 'win32'
    if (windows && (options.windowsLauncher === undefined || !isAbsolute(options.windowsLauncher))) return refused('launcher_unavailable')
    const root = join(options.temporaryDirectory ?? tmpdir(), 'aang-observer')
    mkdirSync(root, { recursive: true, mode: 0o700 })
    const directory = mkdtempSync(join(root, 'process-'))
    const statusPath = join(directory, 'status.json')
    const input = Buffer.from(request.input)
    const command = windows ? options.windowsLauncher ?? '' : request.command
    const args = windows
      ? ['launch', statusPath, String(input.length), request.command, ...(request.args ?? [])]
      : [...(request.args ?? [])]
    const child = spawn(command, args, { cwd: request.cwd, env: request.env, shell: false, detached: !windows, windowsHide: true, stdio: 'pipe' })
    const id = Symbol()
    active.add(id)
    notify()
    return new Promise<ProcessResult>((resolve) => {
      let stdout = ''
      let stderr = ''
      let bytes = 0
      let exitCode: number | null = null
      let exited = false
      let closed = false
      let stoppingAt: number | undefined
      let failure: ProcessFailure | null = null
      let returned = false
      let finished = false
      let release: () => void = () => undefined
      const stopped = new Promise<void>((done) => { release = done })
      const deliver = (): void => {
        if (returned) return
        returned = true
        resolve({ exitCode, stdout, stderr, failure, stopped })
      }
      const complete = (): void => {
        if (finished) return
        finished = true
        clearInterval(poll)
        clearTimeout(timeout)
        request.signal?.removeEventListener('abort', cancel)
        active.delete(id)
        stuck.delete(id)
        child.stdin.destroy()
        child.stdout.destroy()
        child.stderr.destroy()
        rmSync(directory, { recursive: true, force: true })
        release()
        notify()
        deliver()
      }
      const stop = (reason: ProcessFailure | null): void => {
        if (stoppingAt !== undefined) return
        stoppingAt = Date.now()
        failure = reason
        clearTimeout(timeout)
        if (windows) child.stdin.end()
        else if (child.pid !== undefined) killGroup(child.pid)
      }
      const cancel = (): void => { stop('cancelled') }
      const timeout = setTimeout(() => { stop('timeout') }, request.timeoutMs)
      const poll = setInterval(() => {
        if (stoppingAt === undefined) return
        let confirmed = false
        if (child.pid === undefined && exited) confirmed = true
        else if (windows) {
          const report = launcherStatus(statusPath)
          if (report !== undefined) {
            confirmed = true
            if (report.outcome === 'stopped') exitCode = report.exit_code
            else failure = 'launcher_unavailable'
          }
        } else confirmed = child.pid === undefined || (exited && emptyGroup(child.pid))
        if (confirmed && closed) { complete(); return }
        if (Date.now() - stoppingAt >= 10_000 && !returned) {
          failure = 'process_stuck'
          stuck.add(id)
          notify()
          request.signal?.removeEventListener('abort', cancel)
          poll.unref()
          child.stdout.destroy()
          child.stderr.destroy()
          child.stdin.destroy()
          deliver()
        }
      }, 25)
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        bytes += Buffer.byteLength(chunk)
        if (bytes <= 16 * 1024 * 1024) stdout += chunk
        else stop('invalid_output')
      })
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        bytes += Buffer.byteLength(chunk)
        if (bytes <= 16 * 1024 * 1024) stderr += chunk
        else stop('invalid_output')
      })
      child.stdin.on('error', () => undefined)
      child.on('error', () => {
        exited = true
        stop(windows ? 'launcher_unavailable' : 'cli_missing')
      })
      child.on('exit', (code) => {
        exited = true
        exitCode = code
        stop(null)
      })
      child.on('close', () => { closed = true })
      request.signal?.addEventListener('abort', cancel, { once: true })
      if (request.signal?.aborted === true) cancel()
      if (windows) child.stdin.write(input)
      else child.stdin.end(input)
    })
  }
  return {
    run,
    status,
    subscribe: (listener: (snapshot: LaunchStatus) => void): (() => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

export type ProcessRunner = ReturnType<typeof createProcessRunner>
