import type { DatabaseSync } from 'node:sqlite'
import { claudeAdapter } from '@aang/adapter-claude'
import { codexAdapter } from '@aang/adapter-codex'
import {
  type Adapter,
  type AdapterRegistry,
  ChangeSeq,
  type CollectedRecord,
  type CollectorBatch,
  type Fact,
  type FactDraft,
  type Gap,
  type ParseResult,
  type RawRecord,
  type Runtime,
  type SessionKey,
  type StreamKey,
} from '@aang/contract'
import { createEngine, type Engine, type HoldingLimits, type IngestResult } from '@aang/engine'
import type { Store } from '@aang/store'

export const adapters: AdapterRegistry = new Map<Runtime, Adapter>([
  ['claude', claudeAdapter],
  ['codex', codexAdapter],
])

export interface WatchSettings {
  readonly roots?: readonly string[]
  readonly all?: boolean
  readonly holding?: Partial<HoldingLimits>
}

export const startEngine = (store: Store, { roots = [], all = false, holding = {} }: WatchSettings = {}): Engine =>
  createEngine({ store, adapters, watch: { all, roots: roots.map((path) => ({ path })) }, holding })

export const countsOf = ({ inserted, duplicates, discarded, waiting, deferred }: IngestResult) => ({
  inserted,
  duplicates,
  discarded,
  waiting,
  deferred,
})

export const settledOf = (result: IngestResult, batches: readonly CollectorBatch[]): number[] =>
  result.settled.map((batch) => batches.indexOf(batch))

const everything = 1_000_000

const changesOf = (store: Store) => store.changes.after(ChangeSeq.parse(0), everything)

export const recordsOf = (store: Store): RawRecord[] =>
  changesOf(store).flatMap((change) => (change.layer === 'raw_record' ? [change.record] : []))

export const factsOf = (store: Store): Fact[] =>
  changesOf(store).flatMap((change) => (change.layer === 'fact' ? [change.fact] : []))

export const gapsOf = (store: Store): Gap[] =>
  changesOf(store).flatMap((change) => (change.layer === 'gap' ? [change.gap] : []))

export const sessionKey = (runtime: Runtime, session: string): SessionKey => ({ kind: 'session', runtime, session })

const observationTables = ['raw_records', 'facts', 'gaps', 'runs', 'objects', 'links'] as const

export const observationRows = (database: DatabaseSync): Record<string, number> =>
  Object.fromEntries(
    observationTables.map((table) => {
      const row = database.prepare(`SELECT count(*) AS rows FROM ${table}`).get() as { readonly rows: number }
      return [table, row.rows]
    }),
  )

export const noObservationRows = Object.fromEntries(observationTables.map((table) => [table, 0]))

const adapterOf = (runtime: Runtime): Adapter => (runtime === 'claude' ? claudeAdapter : codexAdapter)

export const streamOf = (runtime: Runtime, lines: readonly string[]): StreamKey => {
  const stream = adapterOf(runtime).streamKey(lines)
  if (stream === null) {
    throw new Error('the sample lines do not name a stream')
  }
  return stream
}

export interface Expected {
  readonly key: string
  readonly parse: ParseResult
  readonly facts: readonly FactDraft[]
}

export const expectedOf = (records: readonly CollectedRecord[]): Expected[] =>
  records.map((record) => {
    const adapter = adapterOf(record.runtime)
    const parse = adapter.parse(record)
    return { key: adapter.rawKey(record), parse, facts: parse.parse_state === 'parsed' ? parse.facts : [] }
  })

export const storedFacts = (store: Store): unknown[] =>
  factsOf(store).map((fact) => [fact.kind, fact.entity_key, fact.payload])

export const draftFacts = (expected: readonly Expected[]): unknown[] =>
  expected.flatMap(({ facts }) => facts.map((fact) => [fact.kind, fact.entity_key, fact.payload]))
