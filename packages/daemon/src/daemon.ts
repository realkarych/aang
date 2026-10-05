import { rm } from 'node:fs/promises'
import type { Config, Listener, OperatingSystem, Placement, Runtime, StatusResponse, SupportMatrix } from '@aang/contract'
import { type ConfigEnvironment, loadConfig } from '@aang/contract/config-file'
import { type AangHomePaths, aangHomePaths, writeDaemonState } from '@aang/contract/home'
import { readSupportMatrix } from '@aang/contract/support-file'
import { createReadQueries } from '@aang/engine'
import { openStore, type Store, StoreLockedError } from '@aang/store'
import { createAuthenticator } from './auth.js'
import { chatRoutes } from './chat.js'
import { type HookChecks, startHookChecks } from './hooks.js'
import { startIngestion } from './ingestion.js'
import { resolveListener } from './listener.js'
import { startObserver } from './observer.js'
import { otelEndpoint, otelToken, rotateOtelToken } from './otel-token.js'
import { readRoutes } from './reads.js'
import { type RunningServer, startServer } from './server.js'
import { createSpoolSupervisor, epochNow, type OverThreshold, prepareSpool, type SpoolSupervisor } from './spool.js'
import { createStatus, type SupportHost } from './status.js'
import { createStreams } from './stream.js'

export interface DaemonReady {
  readonly pid: number
  readonly api: Listener
  readonly otel: Listener
}

export type DaemonStopReason = 'shutdown' | 'stop_marker' | 'signal'

export interface DaemonOptions {
  readonly version: string
  readonly environment: ConfigEnvironment
  readonly bind: string | null
  readonly staticRoot: string | null
  readonly supportMatrix: string
  readonly placement: Placement
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

const hostOs = (): OperatingSystem =>
  process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'

const notifying = (store: Store, listeners: ReadonlySet<() => void>): Store => ({
  ...store,
  transaction: (work) => {
    const result = store.transaction(work)
    for (const listener of listeners) {
      listener()
    }
    return result
  },
})

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

type StopCause = { readonly reason: DaemonStopReason } | { readonly error: unknown }

interface Session {
  readonly options: DaemonOptions
  readonly config: Config
  readonly runtimeRoots: Readonly<Record<Runtime, string>>
  readonly paths: AangHomePaths
  readonly listener: Listener
  readonly store: Store
  readonly matrix: SupportMatrix
}

const serve = async ({
  options,
  config,
  runtimeRoots,
  paths,
  listener,
  store: opened,
  matrix,
}: Session): Promise<DaemonStopReason> => {
  await prepareSpool(paths)
  const committed = new Set<() => void>()
  const store = notifying(opened, committed)
  const stop = Promise.withResolvers<StopCause>()
  const stopRequest = { made: false }
  const settle = (cause: StopCause): void => {
    if (!stopRequest.made) {
      stopRequest.made = true
      stop.resolve(cause)
    } else if ('error' in cause) {
      report(cause.error)
    }
  }
  const requestStop = (reason: DaemonStopReason): void => {
    settle({ reason })
  }
  const auth = createAuthenticator(paths)
  const observer = startObserver({
    store,
    config,
    aangHome: paths.home,
    claudeConfigDir: runtimeRoots.claude,
    environment: options.environment.env,
  })
  void observer.failure.then((error) => {
    settle({ error })
  })
  const reads = createReadQueries({ store: opened, observer: observer.run })
  const status = Promise.withResolvers<() => Promise<StatusResponse>>()
  const streams = createStreams({
    reads,
    head: opened.changes.head,
    status: () => status.promise.then((read) => read()),
    onError: report,
  })
  committed.add(streams.changed)
  observer.subscribe(() => {
    streams.changed()
    streams.statusChanged()
  })
  const ingestion = await startIngestion({
    store,
    config,
    spool: paths.spool,
    runtimeRoots,
    otelToken: otelToken(store),
    onIngested: observer.wake,
  }).catch(async (error: unknown) => {
    await observer.close()
    throw error
  })
  void ingestion.failure.then((error) => {
    settle({ error })
  })
  const worker = createWorker()
  const timers: NodeJS.Timeout[] = []
  const running: { server: RunningServer | null; spool: SpoolSupervisor | null; hooks: HookChecks | null } = {
    server: null,
    spool: null,
    hooks: null,
  }
  const startedAt = epochNow()
  const host: SupportHost = { os: hostOs(), placement: config.placement ?? options.placement }
  try {
    const hooks = startHookChecks({ aangHome: paths.home, config, runtimeRoots })
    running.hooks = hooks
    const server = await startServer({
      listener,
      auth,
      staticRoot: options.staticRoot,
      routes: (api) => {
        const daemon = { version: options.version, pid: process.pid, started_at: startedAt, api, otel: ingestion.otel }
        const read = createStatus({
          daemon,
          store,
          config,
          runtimeRoots,
          paths,
          hooks: hooks.installations,
          matrix,
          host,
          observer: observer.backends,
        })
        status.resolve(read)
        return [...readRoutes({ store, reads, status: read }), ...chatRoutes({ reads, ask: observer.ask })]
      },
      streams,
      reparse: ingestion.reparse,
      admin: ingestion.admin,
      otelConfig: ({ rotate }) => {
        if (rotate) {
          ingestion.setOtelToken(rotateOtelToken(store))
        }
        return { endpoint: otelEndpoint(ingestion.otel, otelToken(store)) }
      },
      hooksCheck: async () => {
        await hooks.check()
        return (await status.promise)()
      },
      onShutdown: () => {
        requestStop('shutdown')
      },
    })
    running.server = server
    const publishState = (over: OverThreshold | null): Promise<void> =>
      writeDaemonState(paths.daemonState, {
        pid: process.pid,
        started_at: startedAt,
        api: server.address,
        spool_over_threshold: over,
      })
    const spool = createSpoolSupervisor({ paths, settings: config.spool, store, onThresholdChange: publishState })
    running.spool = spool
    const tick = async (renew: boolean): Promise<void> => {
      if (!(await spool.reconcile(renew))) {
        requestStop('stop_marker')
      }
    }
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
      options.onReady({ pid: process.pid, api: server.address, otel: ingestion.otel })
    }
    const cause = await stop.promise
    if ('error' in cause) {
      throw cause.error
    }
    return cause.reason
  } finally {
    for (const timer of timers) {
      clearInterval(timer)
    }
    await runAll([
      ingestion.stop,
      observer.close,
      async () => {
        await worker.drained()
        await running.spool?.release()
      },
      async () => {
        await running.server?.close()
      },
      async () => {
        await running.hooks?.close()
      },
      () => rm(paths.daemonState, { force: true }),
    ])
  }
}

export const runDaemon = async (options: DaemonOptions): Promise<DaemonStopReason> => {
  const { aangHome, config, runtimeRoots } = await loadConfig(options.environment)
  const paths = aangHomePaths(aangHome)
  const listener = resolveListener(config.api, options.bind)
  const matrix = await readSupportMatrix(options.supportMatrix)
  const store = openExclusive(aangHome)
  try {
    return await serve({ options, config, runtimeRoots, paths, listener, store, matrix })
  } finally {
    store.close()
  }
}
