import { DatabaseSync } from 'node:sqlite'

export interface UnknownRecord {
  readonly channel: string
  readonly kind: string
}

export interface RawCount {
  readonly channel: string
  readonly parse_state: string
  readonly records: number
}

const readOnly = <T>(path: string, query: (database: DatabaseSync) => T): T => {
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    return query(database)
  } finally {
    database.close()
  }
}

const kindOf = (payload: Uint8Array): string => {
  const text = Buffer.from(payload).toString('utf8')
  try {
    const value = JSON.parse(text) as Record<string, unknown>
    const attachment = value['attachment'] as Record<string, unknown> | undefined
    return [value['type'], value['subtype'], attachment?.['type'], value['hook_event_name']]
      .filter((part): part is string => typeof part === 'string')
      .join('/')
  } catch {
    return text.slice(0, 60)
  }
}

export interface StoredCursor {
  readonly path: string
  readonly inode: string
  readonly offset: number
}

export const storedCursors = (path: string): StoredCursor[] =>
  readOnly(path, (database) =>
    database
      .prepare('SELECT path, inode, byte_offset FROM cursors')
      .all()
      .map((row) => ({ path: String(row['path']), inode: String(row['inode']), offset: Number(row['byte_offset']) })),
  )

export const unknownRecords = (path: string): UnknownRecord[] =>
  readOnly(path, (database) =>
    database
      .prepare("SELECT channel, payload FROM raw_records WHERE parse_state <> 'parsed' ORDER BY seq")
      .all()
      .map((row) => ({ channel: String(row['channel']), kind: kindOf(row['payload'] as Uint8Array) })),
  )

export const rawCounts = (path: string): RawCount[] =>
  readOnly(path, (database) =>
    database
      .prepare('SELECT channel, parse_state, COUNT(*) AS records FROM raw_records GROUP BY channel, parse_state ORDER BY channel, parse_state')
      .all()
      .map((row) => ({
        channel: String(row['channel']),
        parse_state: String(row['parse_state']),
        records: Number(row['records']),
      })),
  )
