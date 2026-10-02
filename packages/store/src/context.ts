import type { DatabaseSync, StatementSync } from 'node:sqlite'
import type { ChangeSeq } from '@aang/contract'

export interface WriteContext {
  readonly assertActive: () => void
  readonly nextChangeSeq: () => ChangeSeq
}

export const prepareStatement = (database: DatabaseSync, sql: string): StatementSync => {
  const statement = database.prepare(sql)
  statement.setReadBigInts(true)
  return statement
}

export const insertInto = (table: string, columns: readonly string[]): string =>
  `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((column) => `:${column}`).join(', ')})`

export const upsertInto = (table: string, key: string, columns: readonly string[]): string =>
  `${insertInto(table, columns)} ON CONFLICT (${key}) DO UPDATE SET ${columns
    .filter((column) => column !== key)
    .map((column) => `${column} = excluded.${column}`)
    .join(', ')}`
