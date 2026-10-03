import type { DatabaseSync } from 'node:sqlite'
import { PruneBoundary, type SessionKey, type StreamKey } from '@aang/contract'
import { prepareStatement, upsertInto, type WriteContext } from './context.js'

export interface PrunedStreamReader {
  readonly list: () => PruneBoundary[]
  readonly ofStream: (stream: StreamKey) => PruneBoundary | null
  readonly ofSession: (session: SessionKey) => PruneBoundary[]
}

export interface PrunedStreamWriter extends PrunedStreamReader {
  readonly save: (boundary: PruneBoundary) => void
}

export interface PrunedStreamRepository {
  readonly reader: PrunedStreamReader
  readonly writer: (context: WriteContext) => PrunedStreamWriter
}

type PrunedStreamRow = {
  readonly stream: string
  readonly runtime: string
  readonly session: string
  readonly last_ordinal: bigint | null
  readonly byte_offset: bigint | null
  readonly prefix_hash: string | null
  readonly pruned_at: bigint
}

const columns = ['stream', 'runtime', 'session', 'last_ordinal', 'byte_offset', 'prefix_hash', 'pruned_at']

const toBoundary = (row: PrunedStreamRow): PruneBoundary =>
  PruneBoundary.parse(
    row.runtime === 'claude'
      ? {
          runtime: row.runtime,
          stream: row.stream,
          session: row.session,
          offset: row.byte_offset === null ? null : Number(row.byte_offset),
          prefix_hash: row.prefix_hash,
          pruned_at: row.pruned_at,
        }
      : {
          runtime: row.runtime,
          stream: row.stream,
          session: row.session,
          last_ordinal: row.last_ordinal === null ? null : Number(row.last_ordinal),
          pruned_at: row.pruned_at,
        },
  )

export const createPrunedStreams = (database: DatabaseSync): PrunedStreamRepository => {
  const selectAll = prepareStatement(database, `SELECT ${columns.join(', ')} FROM pruned_streams ORDER BY stream`)
  const selectByStream = prepareStatement(database, `SELECT ${columns.join(', ')} FROM pruned_streams WHERE stream = ?`)
  const selectBySession = prepareStatement(
    database,
    `SELECT ${columns.join(', ')} FROM pruned_streams WHERE runtime = ? AND session = ? ORDER BY stream`,
  )
  const upsertBoundary = prepareStatement(database, upsertInto('pruned_streams', 'stream', columns))

  const reader: PrunedStreamReader = {
    list: () => (selectAll.all() as PrunedStreamRow[]).map(toBoundary),
    ofStream: (stream) => {
      const row = selectByStream.get(stream) as PrunedStreamRow | undefined
      return row === undefined ? null : toBoundary(row)
    },
    ofSession: (session) =>
      (selectBySession.all(session.runtime, session.session) as PrunedStreamRow[]).map(toBoundary),
  }

  const writer = (context: WriteContext): PrunedStreamWriter => ({
    ...reader,
    save: (boundary) => {
      context.assertActive()
      upsertBoundary.run({
        stream: boundary.stream,
        runtime: boundary.runtime,
        session: boundary.session,
        last_ordinal: boundary.runtime === 'codex' ? boundary.last_ordinal : null,
        byte_offset: boundary.runtime === 'claude' ? boundary.offset : null,
        prefix_hash: boundary.runtime === 'claude' ? boundary.prefix_hash : null,
        pruned_at: boundary.pruned_at,
      })
    },
  })

  return { reader, writer }
}
