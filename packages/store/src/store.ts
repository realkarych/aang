import { chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ChangeSeq } from '@aang/contract'
import { type ChangeFeed, createChangeFeed } from './changes.js'
import { prepareStatement, type WriteContext } from './context.js'
import { createCursors, type CursorReader, type CursorWriter } from './cursors.js'
import { createFacts, type FactReader, type FactWriter } from './facts.js'
import { createGaps, type GapReader, type GapWriter } from './gaps.js'
import { acquireWriterLock, type WriterLock } from './lock.js'
import { createRawRecords, type RawRecordReader, type RawRecordWriter } from './raw-records.js'
import { prepareSchema } from './schema.js'
import { createScopes, type ScopeReader, type ScopeWriter } from './scopes.js'
import { inTransaction } from './transaction.js'

export interface StoreOptions {
  readonly home: string
}

export interface Transaction {
  readonly nextChangeSeq: () => ChangeSeq
  readonly rawRecords: RawRecordWriter
  readonly facts: FactWriter
  readonly scopes: ScopeWriter
  readonly cursors: CursorWriter
  readonly gaps: GapWriter
}

type Synchronous<T> = T extends PromiseLike<unknown> ? never : T

export interface Store {
  readonly transaction: <T>(work: (transaction: Transaction) => Synchronous<T>) => T
  readonly rawRecords: RawRecordReader
  readonly facts: FactReader
  readonly scopes: ScopeReader
  readonly cursors: CursorReader
  readonly gaps: GapReader
  readonly changes: ChangeFeed
  readonly close: () => void
}

const createStore = (database: DatabaseSync, lock: WriterLock): Store => {
  const issueChangeSeq = prepareStatement(database, 'UPDATE change_counter SET value = value + 1 RETURNING value')
  const rawRecords = createRawRecords(database)
  const facts = createFacts(database)
  const scopes = createScopes(database)
  const cursors = createCursors(database)
  const gaps = createGaps(database)

  const beginTransaction = (): { transaction: Transaction; finish: () => void } => {
    let active = true
    const assertActive = (): void => {
      if (!active) {
        throw new Error('transaction has already finished')
      }
    }
    const context: WriteContext = {
      assertActive,
      nextChangeSeq: () => {
        assertActive()
        return ChangeSeq.parse(Number((issueChangeSeq.get() as { readonly value: bigint }).value))
      },
    }
    return {
      transaction: {
        nextChangeSeq: context.nextChangeSeq,
        rawRecords: rawRecords.writer(context),
        facts: facts.writer(context),
        scopes: scopes.writer(context),
        cursors: cursors.writer(context),
        gaps: gaps.writer(context),
      },
      finish: () => {
        active = false
      },
    }
  }

  let open = true
  return {
    transaction: (work) => {
      const { transaction, finish } = beginTransaction()
      try {
        return inTransaction(database, () => work(transaction))
      } finally {
        finish()
      }
    },
    rawRecords: rawRecords.reader,
    facts: facts.reader,
    scopes: scopes.reader,
    cursors: cursors.reader,
    gaps: gaps.reader,
    changes: createChangeFeed(database),
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
