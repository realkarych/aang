import type { StreamKey } from './primitives.js'
import type { CollectedRecord, FileCursor } from './raw.js'

export interface CollectorBatch {
  readonly records: readonly CollectedRecord[]
  readonly cursors: readonly FileCursor[]
}

export interface Collector {
  start(cursors: readonly FileCursor[]): AsyncIterable<CollectorBatch>
  ack(batch: CollectorBatch): Promise<void>
  rescan(streams: readonly StreamKey[]): void
}
