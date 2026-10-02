import type {
  Adapter,
  CollectedRecord,
  DedupeKey,
  EpochNs,
  FactDraft,
  NormalizerVersion,
  ParseResult,
  RawRecordDraft,
  Runtime,
  SessionKey,
} from '@aang/contract'

export type Adapters = Readonly<Record<Runtime, Adapter>>

export interface Parsed {
  readonly record: CollectedRecord
  readonly key: DedupeKey
  readonly result: ParseResult
  readonly normalizerVersion: NormalizerVersion
}

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

export const sessionOf = ({ entity_key: key }: FactDraft): SessionKey => ({
  kind: 'session',
  runtime: key.runtime,
  session: key.session,
})

export const firstSession = (parsed: readonly Parsed[]): SessionKey | null => {
  const [fact] = parsed.flatMap(factsOf)
  return fact === undefined ? null : sessionOf(fact)
}

export const sessionName = ({ runtime, session }: SessionKey): string => `${runtime}\0${session}`

const observerEntrypoint = 'aang-observer'
const observerOriginator = 'aang_observer'

const marksObserver = (fact: FactDraft): boolean =>
  fact.runtime_env.entrypoint === observerEntrypoint ||
  fact.runtime_env.originator === observerOriginator ||
  (fact.kind === 'session_start' && fact.payload.observer_marker)

export interface Evidence {
  readonly observer: boolean
  readonly cwd: { readonly path: string; readonly at: EpochNs } | null
}

export const withFact = (evidence: Evidence, fact: FactDraft): Evidence => {
  const path = fact.runtime_env.cwd
  const earlier = path !== null && path !== '' && (evidence.cwd === null || fact.at < evidence.cwd.at)
  return {
    observer: evidence.observer || marksObserver(fact),
    cwd: earlier ? { path, at: fact.at } : evidence.cwd,
  }
}
