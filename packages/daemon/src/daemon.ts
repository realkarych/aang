import { rm } from 'node:fs/promises'
import type { Config, Listener } from '@aang/contract'
import { type ConfigEnvironment, loadConfig } from '@aang/contract/config-file'
import { type AangHomePaths, aangHomePaths, writeDaemonState } from '@aang/contract/home'
import { openStore, type Store, StoreLockedError } from '@aang/store'
import { createAuthenticator } from './auth.js'
import { resolveListener } from './listener.js'
import { type RunningServer, startServer } from './server.js'
import { createSpoolSupervisor, epochNow, type OverThreshold, prepareSpool } from './spool.js'

export interface DaemonReady {
  readonly pid: number
  readonly api: Listener
}

export type DaemonStopReason = 'shutdown' | 'stop_marker' | 'signal'

export interface DaemonOptions {
  readonly environment: ConfigEnvironment
  readonly bind: string | null
  readonly staticRoot: string | null
  readonly signal: AbortSignal
  readonly onReady: (ready: DaemonReady) => void
}

export class DaemonAlreadyRunningError extends Error {
  override readonly name = 'DaemonAlreadyRunningError'

  constructor(readonly home: string) {
    super(`an aang daemon is already running for ${home}`)
  }
}

const openExclusive = (home: string): Store => {
  try {
    return openStore({ home })
  } catch (error) {
    throw error instanceof StoreLockedError ? new DaemonAlreadyRunningError(home) : error
  }
}

const report = (error: unknown): void => {
  process.stderr.write(`aang daemon: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
}

const runAll = async (steps: readonly (() => Promise<void>)[]): Promise<void> => {
  const failures: unknown[] = []
  for (const step of steps) {
    await step().catch((error: unknown) => {
      failures.push(error)
    })
  }
  const [first, ...rest] = failures
  rest.forEach(report)
  if (failures.length > 0) {
    throw first
  }
}

interface Worker {
  readonly enqueue: (key: string, task: () => Promise<void>) => void
  readonly drained: () => Promise<void>
}

const createWorker = (): Worker => {
  let tail = Promise.resolve()
  const queued = new Set<string>()
  return {
    enqueue: (key, task) => {
      if (queued.has(key)) {
        return
      }
      queued.add(key)
      tail = tail
        .then(() => {
          queued.delete(key)
          return task()
        })
        .catch(report)
    },
    drained: () => tail,
  }
}

interface Session {
  readonly options: DaemonOptions
  readonly config: Config
  readonly paths: AangHomePaths
  readonly listener: Listener
  readonly store: Store
}

const serve = async ({ options, config, paths, listener, store }: Session): Promise<DaemonStopReason> => {
  await prepareSpool(paths)
  const stop = Promise.withResolvers<DaemonStopReason>()
  const stopRequest = { made: false }
  const requestStop = (reason: DaemonStopReason): void => {
    if (!stopRequest.made) {
      stopRequest.made = true
      stop.resolve(reason)
    }
  }
  const auth = createAuthenticator(paths)
  const server: RunningServer = await startServer({
    listener,
    auth,
    staticRoot: options.staticRoot,
    onShutdown: () => {
      requestStop('shutdown')
    },
  })
  const startedAt = epochNow()
  const publishState = (over: OverThreshold | null): Promise<void> =>
    writeDaemonState(paths.daemonState, {
      pid: process.pid,
      started_at: startedAt,
      api: server.address,
      spool_over_threshold: over,
    })
  const spool = createSpoolSupervisor({ paths, settings: config.spool, store, onThresholdChange: publishState })
  const tick = async (renew: boolean): Promise<void> => {
    if (!(await spool.reconcile(renew))) {
      requestStop('stop_marker')
    }
  }
  const worker = createWorker()
  const timers: NodeJS.Timeout[] = []
  try {
    await auth.pruneExpiredCodes()
    await tick(true)
    await publishState(spool.overThreshold())
    timers.push(
      setInterval(() => {
        worker.enqueue('renew', () => tick(true))
      }, config.spool.leaseRenewIntervalMs),
      setInterval(() => {
        worker.enqueue('check', () => tick(false))
      }, config.spool.checkIntervalMs),
    )
    options.signal.addEventListener(
      'abort',
      () => {
        requestStop('signal')
      },
      { once: true },
    )
    if (options.signal.aborted) {
      requestStop('signal')
    }
    if (!stopRequest.made) {
      options.onReady({ pid: process.pid, api: server.address })
    }
    return await stop.promise
  } finally {
    for (const timer of timers) {
      clearInterval(timer)
    }
    await runAll([
      async () => {
        await worker.drained()
        await spool.release()
      },
      server.close,
      () => rm(paths.daemonState, { force: true }),
    ])
  }
}

export const runDaemon = async (options: DaemonOptions): Promise<DaemonStopReason> => {
  const { aangHome, config } = await loadConfig(options.environment)
  const paths = aangHomePaths(aangHome)
  const listener = resolveListener(config.api, options.bind)
  const store = openExclusive(aangHome)
  try {
    return await serve({ options, config, paths, listener, store })
  } finally {
    store.close()
  }
}
