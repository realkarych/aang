import type { DatabaseSync } from 'node:sqlite'
import { FileCursor } from '@aang/contract'
import { prepareStatement, upsertInto, type WriteContext } from './context.js'

export interface CursorReader {
  readonly list: () => FileCursor[]
}

export interface CursorWriter extends CursorReader {
  readonly save: (cursor: FileCursor) => void
}

export interface CursorRepository {
  readonly reader: CursorReader
  readonly writer: (context: WriteContext) => CursorWriter
}

type CursorRow = {
  readonly path: string
  readonly stream: string | null
  readonly dev: string
  readonly inode: string
  readonly byte_offset: bigint
  readonly line_number: bigint
  readonly size: bigint
  readonly last_ordinal: bigint | null
}

const toCursor = (row: CursorRow): FileCursor =>
  FileCursor.parse({
    path: row.path,
    dev: BigInt(row.dev),
    ino: BigInt(row.inode),
    stream: row.stream,
    offset: Number(row.byte_offset),
    line: Number(row.line_number),
    size: Number(row.size),
    last_ordinal: row.last_ordinal === null ? null : Number(row.last_ordinal),
  })

const columns = ['path', 'stream', 'dev', 'inode', 'byte_offset', 'line_number', 'size', 'last_ordinal']

export const createCursors = (database: DatabaseSync): CursorRepository => {
  const selectAll = prepareStatement(database, `SELECT ${columns.join(', ')} FROM cursors ORDER BY path`)
  const upsertCursor = prepareStatement(database, upsertInto('cursors', 'path', columns))

  const reader: CursorReader = {
    list: () => (selectAll.all() as CursorRow[]).map(toCursor),
  }

  const writer = (context: WriteContext): CursorWriter => ({
    ...reader,
    save: (cursor) => {
      context.assertActive()
      upsertCursor.run({
        path: cursor.path,
        stream: cursor.stream,
        dev: cursor.dev.toString(),
        inode: cursor.ino.toString(),
        byte_offset: cursor.offset,
        line_number: cursor.line,
        size: cursor.size,
        last_ordinal: cursor.last_ordinal,
      })
    },
  })

  return { reader, writer }
}
