import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { errorCode } from './process.js'

interface DatabaseEvidence {
  readonly path: string
  readonly exists: boolean
  readonly rows: Readonly<Record<string, number>>
  readonly error: string | null
}

const inspectDatabase = (home: string, name: string, state: boolean): DatabaseEvidence => {
  const path = join(home, name)
  if (!existsSync(path)) return { path, exists: false, rows: {}, error: null }
  let database: DatabaseSync | undefined
  try {
    database = new DatabaseSync(path, { readOnly: true })
    const tables = database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all()
      .map((row) => String(row.name)).filter((table) => table !== '_sqlx_migrations' && !table.startsWith('sqlite_'))
    const required = state ? ['threads'] : ['thread_turns', 'thread_items']
    if (!required.every((table) => tables.includes(table))) throw new Error(`missing session tables in ${name}`)
    const rows: Record<string, number> = {}
    for (const table of state ? required : tables) {
      rows[table] = Number(database.prepare(`SELECT COUNT(*) AS count FROM "${table.replaceAll('"', '""')}"`).get()?.count)
    }
    return { path, exists: true, rows, error: null }
  } catch (error) {
    return { path, exists: true, rows: {}, error: errorCode(error) }
  } finally {
    database?.close()
  }
}

export const inspectCodexPersistence = (home: string): { readonly clean: boolean; readonly databases: readonly DatabaseEvidence[] } => {
  const databases = [inspectDatabase(home, 'state_5.sqlite', true), inspectDatabase(home, 'thread_history_1.sqlite', false)]
  return { clean: databases.every(({ rows, error }) => error === null && Object.values(rows).every((count) => count === 0)), databases }
}
