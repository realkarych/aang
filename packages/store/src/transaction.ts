import type { DatabaseSync } from 'node:sqlite'

export const inTransaction = <T>(database: DatabaseSync, work: () => T): T => {
  database.exec('BEGIN IMMEDIATE')
  try {
    const result = work()
    if (result instanceof Promise) {
      throw new TypeError('transaction work must be synchronous')
    }
    database.exec('COMMIT')
    return result
  } catch (error) {
    if (database.isTransaction) {
      database.exec('ROLLBACK')
    }
    throw error
  }
}
