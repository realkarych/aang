import type { DatabaseSync } from 'node:sqlite'

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === 'object' && value !== null && 'then' in value && typeof value.then === 'function'

const ignoreSettlement = (thenable: PromiseLike<unknown>): void => {
  void thenable.then(undefined, () => undefined)
}

const runIn = <T>(database: DatabaseSync, begin: string, work: () => T): T => {
  database.exec(begin)
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

export const inTransaction = <T>(database: DatabaseSync, work: () => T): T => runIn(database, 'BEGIN IMMEDIATE', work)

export const inReadTransaction = <T>(database: DatabaseSync, work: () => T): T => runIn(database, 'BEGIN', work)
