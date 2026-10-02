import type { DatabaseSync } from 'node:sqlite'
import {
  type DedupeKey,
  Fact,
  type FactDraft,
  type FactEntityKey,
  type FactId,
  type NormalizerVersion,
  type RawSeq,
  type SessionKey,
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
}

export interface FactWriter extends FactReader {
  readonly insert: (seq: RawSeq, normalizerVersion: NormalizerVersion, drafts: readonly FactDraft[]) => Fact[]
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
]

export const factColumns = columns.join(', ')

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
  const selectDedupeKey = prepareStatement(database, 'SELECT dedupe_key FROM raw_records WHERE seq = ?')
  const insertFact = prepareStatement(database, insertInto('facts', columns))

  const reader: FactReader = {
    get: (id) => {
      const row = selectById.get(id) as FactRow | undefined
      return row === undefined ? null : toFact(row)
    },
    ofRecord: (seq) => (selectByRecord.all(seq) as FactRow[]).map(toFact),
    ofSession: (key) => (selectBySession.all(key.runtime, key.session) as FactRow[]).map(toFact),
    ofEntity: (key) => (selectByEntity.all(canonicalJson(key)) as FactRow[]).map(toFact),
  }

  const writer = (context: WriteContext): FactWriter => ({
    ...reader,
    insert: (seq, normalizerVersion, drafts) => {
      context.assertActive()
      const record = selectDedupeKey.get(seq) as { readonly dedupe_key: DedupeKey } | undefined
      if (record === undefined) {
        throw new MissingRawRecordError(seq)
      }
      const ids = factIds(record.dedupe_key, drafts)
      return drafts.map((draft, index): Fact => {
        const fact = { ...draft, id: ids[index] as FactId, seq, normalizer_version: normalizerVersion }
        insertFact.run({
          id: fact.id,
          seq,
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
          normalizer_version: normalizerVersion,
          change_seq: context.nextChangeSeq(),
        })
        return fact
      })
    },
  })

  return { reader, writer }
}
