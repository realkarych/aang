import { chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ChangeSeq } from '@aang/contract'
import { type ArtifactReader, type ArtifactWriter, createArtifacts } from './artifacts.js'
import { type ChangeFeed, createChangeFeed } from './changes.js'
import { prepareStatement, type WriteContext } from './context.js'
import { createCursors, type CursorReader, type CursorWriter } from './cursors.js'
import { createFacts, type FactReader, type FactWriter } from './facts.js'
import { createGaps, type GapReader, type GapWriter } from './gaps.js'
import {
  createInterpretations,
  type InterpretationReader,
  type InterpretationWriter,
  recoverInterpretations,
} from './interpretations.js'
import { acquireWriterLock, type WriterLock } from './lock.js'
import { createModel, type ModelReader, type ModelWriter } from './model.js'
import { createObservations, type ObservationReader, type ObservationWriter } from './observations.js'
import { createObserverCalls, type ObserverCallReader, type ObserverCallWriter } from './observer-calls.js'
import { createPrunedStreams, type PrunedStreamReader, type PrunedStreamWriter } from './pruned.js'
import { createRawRecords, type RawRecordReader, type RawRecordWriter } from './raw-records.js'
import { prepareSchema } from './schema.js'
import { createScopes, type ScopeReader, type ScopeWriter } from './scopes.js'
import { createSettings, type SettingReader, type SettingWriter } from './settings.js'
import { inReadTransaction, inTransaction } from './transaction.js'
import { createViews, type ViewReader, type ViewWriter } from './views.js'

export interface StoreOptions {
  readonly home: string
}

export interface Transaction {
  readonly nextChangeSeq: () => ChangeSeq
  readonly observations: ObservationWriter
  readonly artifacts: ArtifactWriter
  readonly rawRecords: RawRecordWriter
  readonly facts: FactWriter
  readonly scopes: ScopeWriter
  readonly cursors: CursorWriter
  readonly pruned: PrunedStreamWriter
  readonly gaps: GapWriter
  readonly model: ModelWriter
  readonly settings: SettingWriter
  readonly observerCalls: ObserverCallWriter
  readonly interpretations: InterpretationWriter
  readonly views: ViewWriter
}

type Synchronous<T> = T extends PromiseLike<unknown> ? never : T

export interface StoreFile {
  readonly path: string
  readonly schemaVersion: number
}

export interface Store {
  readonly file: StoreFile
  readonly transaction: <T>(work: (transaction: Transaction) => Synchronous<T>) => T
  readonly read: <T>(work: () => Synchronous<T>) => T
  readonly observations: ObservationReader
  readonly artifacts: ArtifactReader
  readonly rawRecords: RawRecordReader
  readonly facts: FactReader
  readonly scopes: ScopeReader
  readonly cursors: CursorReader
  readonly pruned: PrunedStreamReader
  readonly gaps: GapReader
  readonly model: ModelReader
  readonly settings: SettingReader
  readonly observerCalls: ObserverCallReader
  readonly interpretations: InterpretationReader
  readonly views: ViewReader
  readonly changes: ChangeFeed
  readonly close: () => void
}

const createStore = (database: DatabaseSync, lock: WriterLock, file: StoreFile): Store => {
  const issueChangeSeq = prepareStatement(database, 'UPDATE change_counter SET value = value + 1 RETURNING value')
  const observations = createObservations(database)
  const artifacts = createArtifacts(database)
  const rawRecords = createRawRecords(database)
  const facts = createFacts(database)
  const scopes = createScopes(database)
  const cursors = createCursors(database)
  const pruned = createPrunedStreams(database)
  const gaps = createGaps(database)
  const model = createModel(database)
  const settings = createSettings(database)
  const observerCalls = createObserverCalls(database)
  const interpretations = createInterpretations(database)
  const views = createViews(database)
  inTransaction(database, () => {
    recoverInterpretations(database)
  })

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
        observations: observations.writer(context),
        artifacts: artifacts.writer(context),
        rawRecords: rawRecords.writer(context),
        facts: facts.writer(context),
        scopes: scopes.writer(context),
        cursors: cursors.writer(context),
        pruned: pruned.writer(context),
        gaps: gaps.writer(context),
        model: model.writer(context),
        settings: settings.writer(context),
        observerCalls: observerCalls.writer(context),
        interpretations: interpretations.writer(context),
        views: views.writer(context),
      },
      finish: () => {
        active = false
      },
    }
  }

  let open = true
  return {
    file,
    transaction: (work) => {
      const { transaction, finish } = beginTransaction()
      try {
        return inTransaction(database, () => work(transaction))
      } finally {
        finish()
      }
    },
    read: (work) => inReadTransaction(database, work),
    observations: observations.reader,
    artifacts: artifacts.reader,
    rawRecords: rawRecords.reader,
    facts: facts.reader,
    scopes: scopes.reader,
    cursors: cursors.reader,
    pruned: pruned.reader,
    gaps: gaps.reader,
    model: model.reader,
    settings: settings.reader,
    observerCalls: observerCalls.reader,
    interpretations: interpretations.reader,
    views: views.reader,
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
    const schemaVersion = prepareSchema(database, databaseFile)
    return createStore(database, lock, { path: databaseFile, schemaVersion })
  } catch (error) {
    database?.close()
    lock.release()
    throw error
  }
}
