import { claudeAdapter } from '@aang/adapter-claude'
import { codexAdapter } from '@aang/adapter-codex'
import { createCollector } from '@aang/collector'
import type { Adapter, AdapterRegistry, CollectedGap, Config, Gap, Listener, Runtime } from '@aang/contract'
import { createEngine } from '@aang/engine'
import type { Store } from '@aang/store'

export interface IngestionOptions {
  readonly store: Store
  readonly config: Config
  readonly spool: string
  readonly runtimeRoots: Readonly<Record<Runtime, string>>
  readonly otelToken: string
  readonly onIngested: () => void
}

export interface Ingestion {
  readonly otel: Listener
  readonly failure: Promise<unknown>
  readonly stop: () => Promise<void>
}

const adapters: AdapterRegistry = new Map<Runtime, Adapter>([
  ['claude', claudeAdapter],
  ['codex', codexAdapter],
])

const freshnessRefreshCeilingMs = 5_000

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
}: IngestionOptions): Promise<Ingestion> => {
  const engine = createEngine({ store, adapters, watch: config.watch, quietAfterMs: config.freshness.quietAfterMs })
  const collector = createCollector({
    spool,
    runtimeRoots,
    config,
    adapters,
    openGaps: store.gaps.open('source_lost').map(collectedGap),
  })
  const otel = await collector.listenOtel({ port: config.otel.port, token: otelToken }).catch(async (error: unknown) => {
    await collector.close()
    throw error
  })
  const failure = Promise.withResolvers<unknown>()

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
  }, Math.min(config.freshness.quietAfterMs, freshnessRefreshCeilingMs))

  return {
    otel,
    failure: failure.promise,
    stop: async () => {
      clearInterval(refresh)
      await collector.close()
      await pumping
      await refreshing
    },
  }
}
