import { chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { acquireWriterLock, type WriterLock } from './lock.js'
import { prepareSchema } from './schema.js'
import { inTransaction } from './transaction.js'

export interface StoreOptions {
  readonly home: string
}

export interface Transaction {
  readonly nextChangeSeq: () => number
}

type Synchronous<T> = T extends PromiseLike<unknown> ? never : T

export interface Store {
  readonly transaction: <T>(work: (transaction: Transaction) => Synchronous<T>) => T
  readonly close: () => void
}

const beginTransaction = (issueChangeSeq: StatementSync): { transaction: Transaction; finish: () => void } => {
  let active = true
  return {
    transaction: {
      nextChangeSeq: () => {
        if (!active) {
          throw new Error('transaction has already finished')
        }
        return (issueChangeSeq.get() as { value: number }).value
      },
    },
    finish: () => {
      active = false
    },
  }
}

const createStore = (database: DatabaseSync, lock: WriterLock): Store => {
  const issueChangeSeq = database.prepare('UPDATE change_counter SET value = value + 1 RETURNING value')
  let open = true
  return {
    transaction: (work) => {
      const { transaction, finish } = beginTransaction(issueChangeSeq)
      try {
        return inTransaction(database, () => work(transaction))
      } finally {
        finish()
      }
    },
    close: () => {
      if (!open) {
        return
      }
      open = false
      database.close()
      lock.release()
    },
  }
}

const preparePrivateHome = (home: string): void => {
  mkdirSync(home, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') {
    chmodSync(home, 0o700)
  }
}

export const openStore = ({ home }: StoreOptions): Store => {
  preparePrivateHome(home)
  const lock = acquireWriterLock(home)
  let database: DatabaseSync | undefined
  try {
    const databaseFile = join(home, 'aang.db')
    database = new DatabaseSync(databaseFile)
    prepareSchema(database, databaseFile)
    return createStore(database, lock)
  } catch (error) {
    database?.close()
    lock.release()
    throw error
  }
}
