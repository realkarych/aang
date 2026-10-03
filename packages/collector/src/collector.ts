import { join } from 'node:path'
import type { AdapterRegistry, CollectedGap, Collector, CollectorBatch, Config, FileCursor, Listener, Runtime, StreamKey } from '@aang/contract'
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
}

export interface CollectorService extends Collector {
  requestAttachment(path: string, stream: StreamKey): void
  listenOtel(options: OtelReceiverOptions): Promise<Listener>
  setOtelToken(token: string): void
  spoolStats(): Promise<SpoolStats>
  close(): Promise<void>
}

const defaultReadRetry: ReadRetry = { pauseMs: 200, gapAfterMs: 5_000 }

type State = 'ready' | 'running' | 'closed'

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
  const snapshots = createSnapshotSource({ roots: roots.snapshots, retrier }, wakeup)
  const tail = createTailSource({
    roots: roots.tail,
    retrier,
    adapters: options.adapters,
    lookbackDays: options.config.watch.lookbackDays,
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
    try {
      await spool.open()
      await otel.open()
      tail.open(cursors, options.openGaps ?? [])
      tree.open()
      while (running()) {
        const batch = await take()
        if (batch === null) {
          await wakeup.wait()
        } else if (running()) {
          yield batch
        }
      }
    } finally {
      await shutdown()
    }
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
    rescan: (streams) => {
      tail.rescan(streams)
      tree.requestScan()
    },
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
