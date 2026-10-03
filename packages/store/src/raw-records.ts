import type { DatabaseSync } from 'node:sqlite'
import {
  type EpochNs,
  type NormalizerVersion,
  type ParseState,
  RawRecord,
  type RawRecordDraft,
  RawSeq,
  type Runtime,
  type StreamKey,
} from '@aang/contract'
import { decodeJson, decodeText, encodeJson, encodeText } from './codec.js'
import { insertInto, prepareStatement, type WriteContext } from './context.js'

export interface RawInsertResult {
  readonly status: 'inserted' | 'duplicate'
  readonly seq: RawSeq
}

export interface RawRecordReader {
  readonly ofStream: (stream: StreamKey, after: RawSeq | null, limit: number) => RawRecord[]
  readonly pendingOtel: (after: RawSeq | null, limit: number) => RawRecord[]
  readonly outdated: (runtime: Runtime, version: NormalizerVersion, after: RawSeq | null, limit: number) => RawRecord[]
  readonly get: (seq: RawSeq) => RawRecord | null
}

export interface RawRecordWriter extends RawRecordReader {
  readonly markParsed: (seq: RawSeq, stream: StreamKey, sourceTs: EpochNs | null) => void
  readonly setParse: (seq: RawSeq, parseState: ParseState, sourceTs: EpochNs | null) => void
  readonly discardUnparsed: (seq: RawSeq) => void
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
  const selectStream = prepareStatement(database, `SELECT ${rawRecordColumns} FROM raw_records WHERE stream = ? AND seq > ? ORDER BY seq LIMIT ?`)
  const selectBySeq = prepareStatement(database, `SELECT ${rawRecordColumns} FROM raw_records WHERE seq = ?`)
  const selectSeqByKey = prepareStatement(database, 'SELECT seq FROM raw_records WHERE dedupe_key = ?')
  const insertRecord = prepareStatement(database, `${insertInto('raw_records', insertedColumns)} RETURNING seq`)

  const selectPending = prepareStatement(database, `SELECT ${rawRecordColumns} FROM raw_records WHERE channel = 'otel' AND parse_state = 'unknown' AND seq > ? ORDER BY seq LIMIT ?`)
  const markParsed = prepareStatement(database, "UPDATE raw_records SET parse_state = 'parsed', stream = ?, source_ts = ?, change_seq = ? WHERE seq = ? AND parse_state = 'unknown'")
  const discard = prepareStatement(database, "DELETE FROM raw_records WHERE seq = ? AND parse_state = 'unknown' AND NOT EXISTS (SELECT 1 FROM facts WHERE facts.seq = raw_records.seq)")
  const selectOutdated = prepareStatement(database, `SELECT ${rawRecordColumns} FROM raw_records WHERE runtime = ? AND channel NOT IN ('snapshot', 'context') AND seq > ? AND NOT EXISTS (SELECT 1 FROM facts WHERE facts.seq = raw_records.seq AND facts.normalizer_version = ?) ORDER BY seq LIMIT ?`)
  const updateParse = prepareStatement(database, 'UPDATE raw_records SET parse_state = ?, source_ts = ?, change_seq = ? WHERE seq = ?')
  const pageLimit = (limit: number): number => {
    if (!Number.isSafeInteger(limit) || limit < 1) { throw new RangeError('record page limit must be positive') }
    return limit
  }
  const reader: RawRecordReader = {
    ofStream: (stream, after, limit) => (selectStream.all(stream, after ?? 0, pageLimit(limit)) as RawRecordRow[]).map(toRawRecord),
    pendingOtel: (after, limit) => (selectPending.all(after ?? 0, pageLimit(limit)) as RawRecordRow[]).map(toRawRecord),
    outdated: (runtime, version, after, limit) =>
      (selectOutdated.all(runtime, after ?? 0, version, pageLimit(limit)) as RawRecordRow[]).map(toRawRecord),
    get: (seq) => {
      const row = selectBySeq.get(seq) as RawRecordRow | undefined
      return row === undefined ? null : toRawRecord(row)
    },
  }

  const writer = (context: WriteContext): RawRecordWriter => ({
    ...reader,
    markParsed: (seq, stream, sourceTs) => {
      context.assertActive()
      markParsed.run(stream, sourceTs, context.nextChangeSeq(), seq)
    },
    setParse: (seq, parseState, sourceTs) => {
      context.assertActive()
      updateParse.run(parseState, sourceTs, context.nextChangeSeq(), seq)
    },
    discardUnparsed: (seq) => {
      context.assertActive()
      if (Number(discard.run(seq).changes) > 0) {
        context.nextChangeSeq()
      }
    },
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
