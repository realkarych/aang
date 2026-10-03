import { z } from 'zod'
import { Gap } from './observation.js'
import { ContentHash, EpochNs, StreamKey } from './primitives.js'
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
  rescan(streams: readonly StreamKey[], lookbackDays?: number): void
}

const prunedSession = z.string().min(1)

export const PruneBoundary = z.discriminatedUnion('runtime', [
  z.strictObject({
    runtime: z.literal('claude'),
    stream: StreamKey,
    session: prunedSession,
    offset: z.int().nonnegative(),
    prefix_hash: ContentHash,
    pruned_at: EpochNs,
  }),
  z.strictObject({
    runtime: z.literal('codex'),
    stream: StreamKey,
    session: prunedSession,
    last_ordinal: z.int().nonnegative(),
    pruned_at: EpochNs,
  }),
])
export type PruneBoundary = z.infer<typeof PruneBoundary>
