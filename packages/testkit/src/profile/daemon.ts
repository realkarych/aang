import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { endpoints, type Listener, ShutdownResponse } from '@aang/contract'
import { type AangHomePaths, type DaemonState, readDaemonState, readUiToken } from '@aang/contract/home'
import type { Environment } from './environment.js'

export interface DaemonLaunch {
  readonly entry: string
  readonly args?: readonly string[]
  readonly readyTimeoutMs?: number
}

export interface DaemonExit {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
}

export interface RunningDaemon {
  readonly pid: number
  readonly api: Listener
  readonly url: string
  readonly token: string
  readonly exited: Promise<DaemonExit>
  readonly running: () => boolean
  readonly output: () => string
  readonly request: (path: string, init?: RequestInit) => Promise<Response>
  readonly stop: () => Promise<DaemonExit>
  readonly kill: () => Promise<DaemonExit>
}

export class DaemonLaunchError extends Error {
  override readonly name = 'DaemonLaunchError'
}

const defaultReadyTimeoutMs = 60_000
const shutdownTimeoutMs = 5_000
const exitTimeoutMs = 15_000
const pollIntervalMs = 25

const loopbackOf: Readonly<Record<string, string>> = { '0.0.0.0': '127.0.0.1', '::': '::1' }

const urlOf = ({ host, port }: Listener): string => {
  const reachable = loopbackOf[host] ?? host
  return `http://${reachable.includes(':') ? `[${reachable}]` : reachable}:${String(port)}`
}

const stateOf = async (paths: AangHomePaths): Promise<DaemonState | null> => {
  try {
    return await readDaemonState(paths.daemonState)
  } catch {
    return null
  }
}

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, failure: () => Error): Promise<T> => {
  const timeout = new AbortController()
  try {
    return await Promise.race([
      promise,
      sleep(timeoutMs, undefined, { signal: timeout.signal }).then(() => {
        throw failure()
      }),
    ])
  } finally {
    timeout.abort()
  }
}

export const launchDaemon = async (
  paths: AangHomePaths,
  env: Environment,
  { entry, args = [], readyTimeoutMs = defaultReadyTimeoutMs }: DaemonLaunch,
): Promise<RunningDaemon> => {
  const child = spawn(process.execPath, [entry, 'start', '--foreground', ...args], {
    cwd: paths.home,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let output = ''
  const capture = (chunk: string): void => {
    output += chunk
  }
  child.stdout.setEncoding('utf8').on('data', capture)
  child.stderr.setEncoding('utf8').on('data', capture)
  const exited = new Promise<DaemonExit>((resolve) => {
    child.on('close', (code, signal) => {
      resolve({ code, signal })
    })
  })
  const spawned = new Promise<void>((resolve, reject) => {
    child.on('spawn', resolve).on('error', reject)
  })
  const running = (): boolean => child.exitCode === null && child.signalCode === null
  const kill = async (): Promise<DaemonExit> => {
    if (running()) {
      child.kill('SIGKILL')
    }
    return exited
  }
  const failed = async (reason: string): Promise<never> => {
    await kill()
    throw new DaemonLaunchError(`the daemon in ${paths.home} ${reason}\n${output}`)
  }

  const ready = async (): Promise<DaemonState> => {
    await spawned
    const deadline = performance.now() + readyTimeoutMs
    for (;;) {
      const current = await stateOf(paths)
      if (current !== null && current.pid === child.pid) {
        return current
      }
      if (!running()) {
        return failed(`exited before it was ready (${JSON.stringify(await exited)})`)
      }
      if (performance.now() > deadline) {
        return failed(`was not ready within ${String(readyTimeoutMs)} ms`)
      }
      await sleep(pollIntervalMs)
    }
  }

  const state = await ready()
  const token = await readUiToken(paths.uiToken)
  if (token === null) {
    return failed(`is ready but there is no UI token in ${paths.uiToken}`)
  }

  const url = urlOf(state.api)
  const request = (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers)
    headers.set('authorization', `Bearer ${token}`)
    return fetch(`${url}${path}`, { ...init, headers })
  }
  const awaitExit = (): Promise<DaemonExit> =>
    withTimeout(
      exited,
      exitTimeoutMs,
      () => new DaemonLaunchError(`the daemon ${String(child.pid)} did not exit after shutdown`),
    )
  const stop = async (): Promise<DaemonExit> => {
    if (!running()) {
      return exited
    }
    const response = await request(endpoints.shutdown.path, {
      method: endpoints.shutdown.method,
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(shutdownTimeoutMs),
    })
    const answer: unknown = await response.json()
    if (!response.ok || !ShutdownResponse.safeParse(answer).success) {
      throw new DaemonLaunchError(
        `the daemon refused to shut down: ${String(response.status)} ${JSON.stringify(answer)}`,
      )
    }
    return awaitExit()
  }

  return {
    pid: state.pid,
    api: state.api,
    url,
    token,
    exited,
    running,
    output: () => output,
    request,
    stop,
    kill,
  }
}
