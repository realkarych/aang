import type {
  Adapter,
  CollectedRecord,
  DedupeKey,
  FactDraft,
  NormalizerVersion,
  ParseResult,
  RawRecordDraft,
  RecordOwner,
  Runtime,
  SessionKey,
} from '@aang/contract'

export type Adapters = Readonly<Record<Runtime, Adapter>>

export interface Owned {
  readonly record: CollectedRecord
  readonly owner: RecordOwner | null
  readonly bytes: number
}

export interface Parsed {
  readonly record: CollectedRecord
  readonly key: DedupeKey
  readonly result: ParseResult
  readonly normalizerVersion: NormalizerVersion
}

export const ownedRecord = (adapters: Adapters, record: CollectedRecord): Owned => ({
  record,
  owner: adapters[record.runtime].owner(record),
  bytes: Buffer.byteLength(record.payload),
})

export const parseRecord = (adapters: Adapters, record: CollectedRecord): Parsed => {
  const adapter = adapters[record.runtime]
  return {
    record,
    key: adapter.rawKey(record),
    result: adapter.parse(record),
    normalizerVersion: adapter.normalizerVersion,
  }
}

export const factsOf = ({ result }: Parsed): readonly FactDraft[] =>
  result.parse_state === 'parsed' ? result.facts : []

export const draftOf = ({ record, key, result }: Parsed): RawRecordDraft => ({
  dedupe_key: key,
  channel: record.channel,
  runtime: record.runtime,
  stream: record.stream,
  position: record.position,
  hook: record.hook,
  observed_at: record.observed_at,
  source_ts: result.parse_state === 'invalid' ? null : result.source_ts,
  payload: record.payload,
  parse_state: result.parse_state,
})

export const sessionName = ({ runtime, session }: SessionKey): string => `${runtime}\0${session}`
