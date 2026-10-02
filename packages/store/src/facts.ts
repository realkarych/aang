import type { DatabaseSync } from 'node:sqlite'
import {
  type DedupeKey,
  Fact,
  type FactDraft,
  type FactEntityKey,
  type FactId,
  type NormalizerVersion,
  type RawSeq,
  SessionKey,
} from '@aang/contract'
import { canonicalJson, factIds } from '@aang/contract/ids'
import { decodeJson, encodeFlag, encodeJson } from './codec.js'
import { insertInto, prepareStatement, type WriteContext } from './context.js'
import { MissingRawRecordError } from './errors.js'

export interface FactReader {
  readonly get: (id: FactId) => Fact | null
  readonly ofRecord: (seq: RawSeq) => Fact[]
  readonly ofSession: (key: SessionKey) => Fact[]
  readonly ofEntity: (key: FactEntityKey) => Fact[]
  readonly sessions: () => SessionKey[]
}

export interface FactRevision {
  readonly kept: readonly Fact[]
  readonly added: readonly Fact[]
  readonly removed: readonly Fact[]
}

export interface FactWriter extends FactReader {
  readonly insert: (seq: RawSeq, normalizerVersion: NormalizerVersion, drafts: readonly FactDraft[]) => Fact[]
  readonly replace: (seq: RawSeq, normalizerVersion: NormalizerVersion, drafts: readonly FactDraft[]) => FactRevision
}

export interface FactRepository {
  readonly reader: FactReader
  readonly writer: (context: WriteContext) => FactWriter
}

export type FactRow = {
  readonly id: string
  readonly seq: bigint
  readonly kind: string
  readonly entity_key: string
  readonly speaker: string
  readonly urgent: bigint
  readonly occurred_at: bigint
  readonly runtime_ids: string
  readonly runtime_env: string
  readonly format_verified: bigint
  readonly redelivery_key: string | null
  readonly payload: string
  readonly normalizer_version: bigint
  readonly change_seq: bigint
}

const columns = [
  'id',
  'seq',
  'record_index',
  'kind',
  'entity_key',
  'speaker',
  'urgent',
  'occurred_at',
  'runtime_ids',
  'runtime_env',
  'format_verified',
  'redelivery_key',
  'payload',
  'normalizer_version',
  'change_seq',
] as const

export const factColumns = columns.join(', ')

type FactColumn = (typeof columns)[number]

type FactColumns = Readonly<Record<FactColumn, string | number | bigint | null>>

type StoredFactRow = FactRow & FactColumns

const identityColumns: ReadonlySet<FactColumn> = new Set(['id', 'seq', 'record_index', 'change_seq'])

const contentColumns = columns.filter((column) => !identityColumns.has(column))

const columnText = (value: string | number | bigint | null): string | null => (value === null ? null : String(value))

const sameContent = (stored: FactColumns, row: FactColumns): boolean =>
  contentColumns.every((column) => columnText(stored[column]) === columnText(row[column]))

const columnsOf = (fact: Fact, index: number, changeSeq: number): FactColumns => ({
  id: fact.id,
  seq: fact.seq,
  record_index: index,
  kind: fact.kind,
  entity_key: canonicalJson(fact.entity_key),
  speaker: fact.speaker,
  urgent: encodeFlag(fact.urgent),
  occurred_at: fact.at,
  runtime_ids: encodeJson(fact.runtime_ids),
  runtime_env: encodeJson(fact.runtime_env),
  format_verified: encodeFlag(fact.format_verified),
  redelivery_key: fact.redelivery_key,
  payload: encodeJson(fact.payload),
  normalizer_version: fact.normalizer_version,
  change_seq: changeSeq,
})

export const toFact = (row: FactRow): Fact =>
  Fact.parse({
    id: row.id,
    seq: Number(row.seq),
    normalizer_version: Number(row.normalizer_version),
    kind: row.kind,
    entity_key: decodeJson(row.entity_key),
    speaker: row.speaker,
    urgent: row.urgent === 1n,
    at: row.occurred_at,
    runtime_ids: decodeJson(row.runtime_ids),
    runtime_env: decodeJson(row.runtime_env),
    format_verified: row.format_verified === 1n,
    redelivery_key: row.redelivery_key,
    payload: decodeJson(row.payload),
  })

export const createFacts = (database: DatabaseSync): FactRepository => {
  const selectById = prepareStatement(database, `SELECT ${factColumns} FROM facts WHERE id = ?`)
  const selectByRecord = prepareStatement(
    database,
    `SELECT ${factColumns} FROM facts WHERE seq = ? ORDER BY record_index`,
  )
  const selectByEntity = prepareStatement(
    database,
    `SELECT ${factColumns} FROM facts WHERE entity_key = ? ORDER BY seq, record_index`,
  )
  const selectBySession = prepareStatement(database,
    `SELECT ${factColumns} FROM facts WHERE json_extract(entity_key, '$.runtime') = ? AND json_extract(entity_key, '$.session') = ? ORDER BY seq, record_index`,
  )
  const selectSessions = prepareStatement(database,
    "SELECT DISTINCT json_extract(entity_key, '$.runtime') AS runtime, json_extract(entity_key, '$.session') AS session FROM facts ORDER BY runtime, session",
  )
  const selectDedupeKey = prepareStatement(database, 'SELECT dedupe_key FROM raw_records WHERE seq = ?')
  const insertFact = prepareStatement(database, insertInto('facts', columns))
  const deleteByRecord = prepareStatement(database, 'DELETE FROM facts WHERE seq = ?')

  const reader: FactReader = {
    get: (id) => {
      const row = selectById.get(id) as FactRow | undefined
      return row === undefined ? null : toFact(row)
    },
    ofRecord: (seq) => (selectByRecord.all(seq) as FactRow[]).map(toFact),
    ofSession: (key) => (selectBySession.all(key.runtime, key.session) as FactRow[]).map(toFact),
    ofEntity: (key) => (selectByEntity.all(canonicalJson(key)) as FactRow[]).map(toFact),
    sessions: () =>
      (selectSessions.all() as { readonly runtime: string; readonly session: string }[]).map(({ runtime, session }) =>
        SessionKey.parse({ kind: 'session', runtime, session }),
      ),
  }

  const factsOf = (seq: RawSeq, normalizerVersion: NormalizerVersion, drafts: readonly FactDraft[]): Fact[] => {
    const record = selectDedupeKey.get(seq) as { readonly dedupe_key: DedupeKey } | undefined
    if (record === undefined) {
      throw new MissingRawRecordError(seq)
    }
    const ids = factIds(record.dedupe_key, drafts)
    return drafts.map((draft, index): Fact => ({
      ...draft,
      id: ids[index] as FactId,
      seq,
      normalizer_version: normalizerVersion,
    }))
  }

  const writer = (context: WriteContext): FactWriter => ({
    ...reader,
    insert: (seq, normalizerVersion, drafts) => {
      context.assertActive()
      const facts = factsOf(seq, normalizerVersion, drafts)
      facts.forEach((fact, index) => {
        insertFact.run(columnsOf(fact, index, context.nextChangeSeq()))
      })
      return facts
    },
    replace: (seq, normalizerVersion, drafts) => {
      context.assertActive()
      const facts = factsOf(seq, normalizerVersion, drafts)
      const stored = selectByRecord.all(seq) as StoredFactRow[]
      const previous = new Map(stored.map((row) => [row.id, row]))
      const rows = facts.map((fact, index) => columnsOf(fact, index, 0))
      const unchanged =
        rows.length === stored.length &&
        rows.every((row) => {
          const before = previous.get(String(row.id))
          return before !== undefined && Number(before.record_index) === row.record_index && sameContent(before, row)
        })
      if (unchanged) {
        return { kept: stored.map(toFact), added: [], removed: [] }
      }
      deleteByRecord.run(seq)
      for (const row of rows) {
        insertFact.run({ ...row, change_seq: context.nextChangeSeq() })
      }
      const current = new Set(facts.map(({ id }) => id))
      return {
        kept: facts.filter(({ id }) => previous.has(id)),
        added: facts.filter(({ id }) => !previous.has(id)),
        removed: stored.filter(({ id }) => !current.has(id as FactId)).map(toFact),
      }
    },
  })

  return { reader, writer }
}
