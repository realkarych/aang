import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { StoreLockedError } from './errors.js'

export interface WriterLock {
  readonly release: () => void
}

const sqliteBusy = 5

const isBusy = (error: unknown): boolean => error instanceof Error && 'errcode' in error && error.errcode === sqliteBusy

export const acquireWriterLock = (home: string): WriterLock => {
  const lock = new DatabaseSync(join(home, 'aang.lock'))
  try {
    lock.exec('BEGIN EXCLUSIVE')
  } catch (error) {
    lock.close()
    throw isBusy(error) ? new StoreLockedError(home) : error
  }
  return {
    release: () => {
      lock.exec('ROLLBACK')
      lock.close()
    },
  }
}
