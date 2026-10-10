import { claudeAdapter } from '@aang/adapter-claude'
import { codexAdapter } from '@aang/adapter-codex'
import { createCollector, prefixHash } from '@aang/collector'
import type {
  Adapter,
  AdapterRegistry,
  Binding,
  BindingId,
  CollectedGap,
  Config,
  CreateBindingRequest,
  Gap,
  Listener,
  PruneRequest,
  PruneResponse,
  ReparseResponse,
  RunId,
  Runtime,
  UnwatchRequest,
  UnwatchResponse,
  WatchRequest,
  WatchResponse,
  WatchState,
} from '@aang/contract'
import { createEngine } from '@aang/engine'
import type { Store } from '@aang/store'
import { AdminError } from './admin-error.js'
import { loadWatch, rootOf, saveWatch, watchedDirectory, watchedRoots } from './watch.js'

export interface IngestionOptions {
  readonly store: Store
  readonly config: Config
  readonly spool: string
  readonly runtimeRoots: Readonly<Record<Runtime, string>>
  readonly otelToken: string
  readonly onIngested: () => void
  readonly onBound: () => void
}

export interface Admin {
  readonly watch: (request: WatchRequest) => Promise<WatchResponse>
  readonly unwatch: (request: UnwatchRequest) => Promise<UnwatchResponse>
  readonly prune: (request: PruneRequest) => Promise<PruneResponse>
}

export interface Bindings {
  readonly bind: (request: CreateBindingRequest) => Promise<Binding | null>
  readonly revoke: (id: BindingId) => Promise<Binding | null>
}

export interface Ingestion {
  readonly otel: Listener
  readonly retainBases: (runs: readonly RunId[]) => void
  readonly reparse: () => Promise<ReparseResponse | null>
  readonly bindings: Bindings
  readonly admin: Admin
  readonly setOtelToken: (token: string) => void
  readonly failure: Promise<unknown>
  readonly stop: () => Promise<void>
}

const adapters: AdapterRegistry = new Map<Runtime, Adapter>([
  ['claude', claudeAdapter],
  ['codex', codexAdapter],
])

const freshnessRefreshCeilingMs = 5_000

const tallyOf = ({ records, facts_added, facts_kept, facts_missing }: ReparseResponse): ReparseResponse => ({
  records,
  facts_added,
  facts_kept,
  facts_missing,
})

const collectedGap = ({ key, stream, details, detected_at, closed_at }: Gap): CollectedGap => ({
  key,
  stream,
  details,
  detected_at,
  closed_at,
})

export const startIngestion = async ({
  store,
  config,
  spool,
  runtimeRoots,
  otelToken,
  onIngested,
  onBound,
}: IngestionOptions): Promise<Ingestion> => {
  let watching = loadWatch(store, config)
  const engine = createEngine({
    store,
    adapters,
    watch: watchedRoots(watching, config),
    quietAfterMs: config.freshness.quietAfterMs,
    hooksInactiveAfterMs: config.freshness.hooksInactiveAfterMs,
    fsWatch: config.collector.fsWatch,
  })
  const collector = createCollector({
    spool,
    runtimeRoots,
    config: { ...config, watch: { ...config.watch, lookbackDays: watching.lookback_days } },
    adapters,
    openGaps: [...store.gaps.open('source_lost'), ...store.gaps.open('stream_changed_after_prune')].map(collectedGap),
    prunedStreams: store.pruned.list(),
  })
  const otel = await collector.listenOtel({ port: config.otel.port, token: otelToken }).catch(async (error: unknown) => {
    await collector.close()
    await engine.close()
    throw error
  })
  const failure = Promise.withResolvers<unknown>()
  const restoring = engine.refreshCriteria().catch(failure.resolve)
  const retaining = new Set<Promise<unknown>>()
  const retain = (runs?: readonly RunId[]): void => {
    const work = engine.retainBases(runs).catch(failure.resolve)
    retaining.add(work)
    void work.finally(() => retaining.delete(work))
  }
  retain()

  const pump = async (): Promise<void> => {
    for await (const batch of collector.start(store.cursors.list())) {
      const { settled, rescan } = await engine.ingest(batch)
      onIngested()
      for (const acknowledged of settled) {
        await collector.ack(acknowledged)
      }
      if (rescan.length > 0) {
        collector.rescan(rescan)
      }
    }
  }

  const pumping = pump().catch(failure.resolve)
  let refreshing: Promise<unknown> = Promise.resolve()
  const refresh = setInterval(() => {
    refreshing = engine.refreshFreshness().catch(failure.resolve)
  }, Math.min(config.freshness.quietAfterMs, config.freshness.hooksInactiveAfterMs, freshnessRefreshCeilingMs))

  let stopping = false
  let reparsing: Promise<unknown> = Promise.resolve()
  const reparse = async (): Promise<ReparseResponse | null> => {
    if (stopping) {
      return null
    }
    const result = engine.reparse()
    reparsing = result.catch(() => undefined)
    return tallyOf(await result)
  }

  let binding: Promise<unknown> = Promise.resolve()
  const bound = async (work: () => Promise<{ readonly binding: Binding }>): Promise<Binding | null> => {
    if (stopping) {
      return null
    }
    const result = work()
    binding = result.catch(() => undefined)
    const outcome = await result
    onBound()
    return outcome.binding
  }

  const bindings: Bindings = {
    bind: (request) => bound(() => engine.bind(request)),
    revoke: (id) => bound(() => engine.revokeBinding(id)),
  }

  let administering: Promise<unknown> = Promise.resolve()
  const serially = <T>(work: () => Promise<T>): Promise<T> => {
    const result = administering.then(work)
    administering = result.then(() => undefined, () => undefined)
    return result
  }

  const rewatch = async (next: WatchState) => {
    const change = await engine.rewatch(watchedRoots(next, config), saveWatch(next))
    watching = next
    return change
  }

  const admin: Admin = {
    watch: (request) =>
      serially(async () => {
        const next =
          request.scope === 'all'
            ? { ...watching, all: true }
            : await watchedDirectory(request.path).then((path) => ({
                ...watching,
                roots: watching.roots.includes(path) ? watching.roots : [...watching.roots, path],
              }))
        const { rescan } = await rewatch(next)
        const lookbackDays = request.lookback_days ?? next.lookback_days
        collector.rescan(rescan, lookbackDays)
        collector.backfill(lookbackDays)
        return { watch: next, rescanned_streams: rescan.length }
      }),
    unwatch: (request) =>
      serially(async () => {
        const next =
          request.scope === 'all'
            ? { ...watching, all: false }
            : await rootOf(watching, request.path).then((root) => ({
                ...watching,
                roots: watching.roots.filter((path) => path !== root),
              }))
        await rewatch(next)
        return { watch: next }
      }),
    prune: (request) =>
      serially(async () => {
        const { runs, boundaries } = await collector.paused(async () => {
          const outcome = await engine.prune(request, prefixHash)
          collector.prune(outcome.boundaries)
          return outcome
        })
        if (request.scope === 'run' && runs.length === 0) {
          throw new AdminError('not_found', `no run ${request.run}`)
        }
        if (runs.length > 0) {
          store.vacuum()
        }
        return { runs: [...runs], streams: boundaries.length }
      }),
  }

  return {
    otel,
    retainBases: (runs) => {
      if (!stopping) {
        retain(runs)
      }
    },
    reparse,
    bindings,
    admin,
    setOtelToken: (token) => {
      collector.setOtelToken(token)
    },
    failure: failure.promise,
    stop: async () => {
      clearInterval(refresh)
      stopping = true
      await reparsing
      await binding
      await administering
      await collector.close()
      await pumping
      await refreshing
      await restoring
      await Promise.all(retaining)
      await engine.close()
    },
  }
}
