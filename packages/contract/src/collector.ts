import type { z } from 'zod'
import { Gap } from './observation.js'
import type { StreamKey } from './primitives.js'
import type { CollectedRecord, FileCursor } from './raw.js'

export const CollectedGap = Gap.pick({ key: true, stream: true, details: true, detected_at: true, closed_at: true })
export type CollectedGap = z.infer<typeof CollectedGap>

export interface CollectorBatch {
  readonly records: readonly CollectedRecord[]
  readonly cursors: readonly FileCursor[]
  readonly gaps: readonly CollectedGap[]
}

export interface Collector {
  start(cursors: readonly FileCursor[]): AsyncIterable<CollectorBatch>
  ack(batch: CollectorBatch): Promise<void>
  rescan(streams: readonly StreamKey[]): void
}
