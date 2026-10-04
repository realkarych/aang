import { readdirSync, readFileSync, rmSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { StoreVersionError } from './errors.js'
import { inTransaction } from './transaction.js'

const schemaDirectory = new URL('../schema/', import.meta.url)

const compareNames = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)

const loadMigrations = (): string[] =>
  readdirSync(schemaDirectory)
    .filter((name) => name.endsWith('.sql'))
    .sort(compareNames)
    .map((name) => readFileSync(new URL(name, schemaDirectory), 'utf8'))

const userVersion = (database: DatabaseSync): number =>
  (database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version

const backUp = (database: DatabaseSync, target: string): void => {
  rmSync(target, { force: true })
  database.prepare('VACUUM INTO ?').run(target)
}

export const prepareSchema = (database: DatabaseSync, databaseFile: string): number => {
  const migrations = loadMigrations()
  const current = userVersion(database)
  if (current > migrations.length) {
    throw new StoreVersionError(current, migrations.length)
  }
  database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON')
  if (current === migrations.length) {
    return current
  }
  if (current > 0) {
    backUp(database, `${databaseFile}.v${String(current)}.bak`)
  }
  inTransaction(database, () => {
    for (const migration of migrations.slice(current)) {
      database.exec(migration)
    }
    database.exec(`PRAGMA user_version = ${String(migrations.length)}`)
  })
  return migrations.length
}
