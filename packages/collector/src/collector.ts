import { join } from 'node:path'
import type {
  AdapterRegistry,
  CollectedGap,
  Collector,
  CollectorBatch,
  Config,
  FileCursor,
  Listener,
  PruneBoundary,
  Runtime,
  StreamKey,
} from '@aang/contract'
import { createAttachmentSource } from './attachments.js'
import { createOtelReceiver, type OtelReceiverOptions } from './otel.js'
import { createRetrier, type ReadRetry } from './retry.js'
import { collectorRoots } from './roots.js'
import { createSnapshotSource } from './snapshot.js'
import { createSpoolSource, type SpoolStats } from './spool.js'
import { createTailSource } from './tail.js'
import { createTree } from './tree.js'
import { createWakeup } from './wakeup.js'

export interface CollectorOptions {
  readonly spool: string
  readonly runtimeRoots: Readonly<Record<Runtime, string>>
  readonly config: Pick<Config, 'collector' | 'spool' | 'watch'>
  readonly adapters: AdapterRegistry
  readonly readRetry?: ReadRetry
  readonly openGaps?: readonly CollectedGap[]
  readonly prunedStreams?: readonly PruneBoundary[]
}

export interface CollectorService extends Collector {
  requestAttachment(path: string, stream: StreamKey): void
  backfill(lookbackDays: number): void
  prune(boundaries: readonly PruneBoundary[]): void
  paused<T>(work: () => Promise<T>): Promise<T>
  listenOtel(options: OtelReceiverOptions): Promise<Listener>
  setOtelToken(token: string): void
  spoolStats(): Promise<SpoolStats>
  close(): Promise<void>
}

const defaultReadRetry: ReadRetry = { pauseMs: 200, gapAfterMs: 5_000 }

type State = 'ready' | 'running' | 'closed'

interface Pause {
  readonly parked: PromiseWithResolvers<void>
  readonly resumed: PromiseWithResolvers<void>
}

export const createCollector = (options: CollectorOptions): CollectorService => {
  const wakeup = createWakeup()
  const { collector, spool: spoolConfig } = options.config
  const roots = collectorRoots(options.runtimeRoots)
  const retrier = createRetrier(options.readRetry ?? defaultReadRetry, collector.rootsScanIntervalMs)
  const attachments = createAttachmentSource(join(options.runtimeRoots.claude, 'projects'), retrier, wakeup, options.openGaps ?? [])
  const spool = createSpoolSource(
    {
      directory: options.spool,
      fsWatch: collector.fsWatch,
      scanIntervalMs: collector.spoolScanIntervalMs,
      maxAgeDays: spoolConfig.maxAgeDays,
    },
    wakeup,
  )
  const otel = createOtelReceiver(options.spool, wakeup)
  const snapshots = createSnapshotSource(
    { roots: roots.snapshots, retrier, processCheckIntervalMs: collector.processCheckIntervalMs },
    wakeup,
  )
  const tail = createTailSource({
    roots: roots.tail,
    retrier,
    adapters: options.adapters,
    lookbackDays: options.config.watch.lookbackDays,
    prunedStreams: options.prunedStreams ?? [],
  }, wakeup)
  const tree = createTree(
    { roots: roots.tree, fsWatch: collector.fsWatch, scanIntervalMs: collector.rootsScanIntervalMs },
    {
      changed: (root, path) => {
        snapshots.changed(root, path)
        tail.changed(root, path)
      },
      listed: async (root, paths) => {
        await snapshots.listed(root, paths)
        await tail.listed(root, paths)
      },
    },
    wakeup,
  )
  let state: State = 'ready'
  let generating = false
  let pause: Pause | null = null
  let pausing: Promise<unknown> = Promise.resolve()

  const running = (): boolean => state === 'running'

  const shutdown = async (): Promise<void> => {
    attachments.close()
    spool.close()
    await tree.close()
    snapshots.close()
    await tail.close()
    await otel.close()
  }

  const take = async (): Promise<CollectorBatch | null> => {
    const queued = (await spool.take()) ?? (await otel.take())
    if (queued !== null) {
      return queued
    }
    await tree.scan()
    return (await attachments.take()) ?? (await snapshots.take()) ?? (await tail.take())
  }

  async function* batches(cursors: readonly FileCursor[]): AsyncGenerator<CollectorBatch> {
    generating = true
    try {
      await spool.open()
      await otel.open()
      tail.open(cursors, options.openGaps ?? [])
      snapshots.open()
      tree.open()
      while (running()) {
        if (pause !== null) {
          const { parked, resumed } = pause
          parked.resolve()
          await resumed.promise
          continue
        }
        const batch = await take()
        if (batch === null) {
          await wakeup.wait()
        } else if (running()) {
          yield batch
        }
      }
    } finally {
      generating = false
      pause?.parked.resolve()
      await shutdown()
    }
  }

  const paused = <T>(work: () => Promise<T>): Promise<T> => {
    const result = pausing.then(async () => {
      const current: Pause = { parked: Promise.withResolvers(), resumed: Promise.withResolvers() }
      pause = current
      try {
        if (generating) {
          wakeup.notify()
          await current.parked.promise
        }
        return await work()
      } finally {
        pause = null
        current.resumed.resolve()
      }
    })
    pausing = result.then(() => undefined, () => undefined)
    return result
  }

  return {
    requestAttachment: attachments.request,
    start: (cursors) => {
      if (state !== 'ready') {
        throw new Error('the collector can only be started once')
      }
      state = 'running'
      return batches(cursors)
    },
    rescan: (streams, lookbackDays) => {
      tail.rescan(streams, lookbackDays)
      tree.requestScan()
    },
    backfill: (lookbackDays) => {
      tail.backfill(lookbackDays)
      tree.requestScan()
    },
    prune: tail.prune,
    paused,
    ack: async (batch) => {
      await spool.ack(batch)
      await otel.ack(batch)
    },
    listenOtel: (otelOptions) => {
      if (state === 'closed') {
        return Promise.reject(new Error('the collector is closed'))
      }
      return otel.listen(otelOptions)
    },
    setOtelToken: otel.setToken,
    spoolStats: () => spool.stats(),
    close: async () => {
      state = 'closed'
      wakeup.notify()
      await shutdown()
    },
  }
}
