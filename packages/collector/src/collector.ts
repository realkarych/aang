import type { Collector, CollectorBatch, Config, FileCursor, Runtime } from '@aang/contract'
import { createSpoolSource, type SpoolStats } from './spool.js'
import { createTailSource, type ReadRetry, tailRoots } from './tail.js'
import { createWakeup } from './wakeup.js'

export interface CollectorOptions {
  readonly spool: string
  readonly runtimeRoots: Readonly<Record<Runtime, string>>
  readonly config: Pick<Config, 'collector' | 'spool'>
  readonly readRetry?: ReadRetry
}

export interface CollectorService extends Omit<Collector, 'rescan'> {
  spoolStats(): Promise<SpoolStats>
  close(): Promise<void>
}

const defaultReadRetry: ReadRetry = { pauseMs: 200, gapAfterMs: 5_000 }

type State = 'ready' | 'running' | 'closed'

export const createCollector = (options: CollectorOptions): CollectorService => {
  const wakeup = createWakeup()
  const { collector, spool: spoolConfig } = options.config
  const spool = createSpoolSource(
    {
      directory: options.spool,
      fsWatch: collector.fsWatch,
      scanIntervalMs: collector.spoolScanIntervalMs,
      maxAgeDays: spoolConfig.maxAgeDays,
    },
    wakeup,
  )
  const tail = createTailSource(
    {
      roots: tailRoots(options.runtimeRoots),
      fsWatch: collector.fsWatch,
      scanIntervalMs: collector.rootsScanIntervalMs,
      readRetry: options.readRetry ?? defaultReadRetry,
    },
    wakeup,
  )
  let state: State = 'ready'

  const running = (): boolean => state === 'running'

  const shutdown = async (): Promise<void> => {
    spool.close()
    await tail.close()
  }

  async function* batches(cursors: readonly FileCursor[]): AsyncGenerator<CollectorBatch> {
    try {
      await spool.open()
      tail.open(cursors)
      while (running()) {
        const batch = (await spool.take()) ?? (await tail.take())
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
    start: (cursors) => {
      if (state !== 'ready') {
        throw new Error('the collector can only be started once')
      }
      state = 'running'
      return batches(cursors)
    },
    ack: (batch) => spool.ack(batch),
    spoolStats: () => spool.stats(),
    close: async () => {
      state = 'closed'
      wakeup.notify()
      await shutdown()
    },
  }
}
