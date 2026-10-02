import type { DatabaseSync } from 'node:sqlite'

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === 'object' && value !== null && 'then' in value && typeof value.then === 'function'

const ignoreSettlement = (thenable: PromiseLike<unknown>): void => {
  void thenable.then(undefined, () => undefined)
}

export const inTransaction = <T>(database: DatabaseSync, work: () => T): T => {
  database.exec('BEGIN IMMEDIATE')
  try {
    const result = work()
    if (isThenable(result)) {
      ignoreSettlement(result)
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
