import type { DatabaseSync } from 'node:sqlite'
import { RawRecord, type RawRecordDraft, RawSeq } from '@aang/contract'
import { decodeJson, decodeText, encodeJson, encodeText } from './codec.js'
import { insertInto, prepareStatement, type WriteContext } from './context.js'

export interface RawInsertResult {
  readonly status: 'inserted' | 'duplicate'
  readonly seq: RawSeq
}

export interface RawRecordReader {
  readonly get: (seq: RawSeq) => RawRecord | null
}

export interface RawRecordWriter extends RawRecordReader {
  readonly insert: (draft: RawRecordDraft) => RawInsertResult
}

export interface RawRecordRepository {
  readonly reader: RawRecordReader
  readonly writer: (context: WriteContext) => RawRecordWriter
}

export type RawRecordRow = {
  readonly seq: bigint
  readonly dedupe_key: string
  readonly channel: string
  readonly runtime: string | null
  readonly stream: string | null
  readonly position: string
  readonly hook: string | null
  readonly observed_at: bigint
  readonly source_ts: bigint | null
  readonly payload: Uint8Array
  readonly parse_state: string
  readonly change_seq: bigint
}

const insertedColumns = [
  'dedupe_key',
  'channel',
  'runtime',
  'stream',
  'position',
  'hook',
  'observed_at',
  'source_ts',
  'payload',
  'parse_state',
  'change_seq',
]

export const rawRecordColumns = ['seq', ...insertedColumns].join(', ')

export const toRawRecord = (row: RawRecordRow): RawRecord =>
  RawRecord.parse({
    seq: Number(row.seq),
    dedupe_key: row.dedupe_key,
    channel: row.channel,
    runtime: row.runtime,
    stream: row.stream,
    position: decodeJson(row.position),
    hook: row.hook === null ? null : decodeJson(row.hook),
    observed_at: row.observed_at,
    source_ts: row.source_ts,
    payload: decodeText(row.payload),
    parse_state: row.parse_state,
  })

export const createRawRecords = (database: DatabaseSync): RawRecordRepository => {
  const selectBySeq = prepareStatement(database, `SELECT ${rawRecordColumns} FROM raw_records WHERE seq = ?`)
  const selectSeqByKey = prepareStatement(database, 'SELECT seq FROM raw_records WHERE dedupe_key = ?')
  const insertRecord = prepareStatement(database, `${insertInto('raw_records', insertedColumns)} RETURNING seq`)

  const reader: RawRecordReader = {
    get: (seq) => {
      const row = selectBySeq.get(seq) as RawRecordRow | undefined
      return row === undefined ? null : toRawRecord(row)
    },
  }

  const writer = (context: WriteContext): RawRecordWriter => ({
    ...reader,
    insert: (draft) => {
      context.assertActive()
      const existing = selectSeqByKey.get(draft.dedupe_key) as Pick<RawRecordRow, 'seq'> | undefined
      if (existing !== undefined) {
        return { status: 'duplicate', seq: RawSeq.parse(Number(existing.seq)) }
      }
      const inserted = insertRecord.get({
        dedupe_key: draft.dedupe_key,
        channel: draft.channel,
        runtime: draft.runtime,
        stream: draft.stream,
        position: encodeJson(draft.position),
        hook: draft.hook === null ? null : encodeJson(draft.hook),
        observed_at: draft.observed_at,
        source_ts: draft.source_ts,
        payload: encodeText(draft.payload),
        parse_state: draft.parse_state,
        change_seq: context.nextChangeSeq(),
      }) as Pick<RawRecordRow, 'seq'>
      return { status: 'inserted', seq: RawSeq.parse(Number(inserted.seq)) }
    },
  })

  return { reader, writer }
}
