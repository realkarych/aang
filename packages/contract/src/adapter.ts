import type { FactDraft } from './facts.js'
import type { DedupeKey, EpochNs, NormalizerVersion, Runtime, StreamKey } from './primitives.js'
import type { CollectedRecord } from './raw.js'

export type ParseResult =
  | {
      readonly parse_state: 'parsed'
      readonly source_ts: EpochNs | null
      readonly facts: readonly FactDraft[]
    }
  | {
      readonly parse_state: 'unknown'
      readonly source_ts: EpochNs | null
    }
  | {
      readonly parse_state: 'invalid'
      readonly reason: string
    }

export interface Adapter {
  readonly runtime: Runtime
  readonly normalizerVersion: NormalizerVersion
  streamKey(firstLines: readonly string[]): StreamKey | null
  rawKey(record: CollectedRecord): DedupeKey
  parse(record: CollectedRecord): ParseResult
}

export type AdapterRegistry = ReadonlyMap<Runtime, Adapter>
