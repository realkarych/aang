import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { openStore, StoreLockedError, StoreVersionError } from '@aang/store'
import { expect, test } from 'vitest'
import { createHome, type Home, pragma, schemaFiles } from './home.js'

const describeHome = (home: Home): unknown => {
  const files = readdirSync(home.path).sort()
  const bytes = readFileSync(home.databaseFile)
  const database = home.database()
  const description = {
    files,
    bytes,
    version: pragma(database, 'user_version'),
    schema: database.prepare('SELECT type, name, sql FROM sqlite_schema ORDER BY name').all(),
  }
  database.close()
  return description
}

test('opening a new home creates a private directory with a WAL database at the latest schema version', async ({
  onTestFinished,
}) => {
  const home = await createHome(onTestFinished)

  home.open().close()

  if (process.platform !== 'win32') {
    expect(statSync(home.path).mode & 0o777).toBe(0o700)
  }
  expect(readdirSync(home.path).sort()).toEqual(['aang.db', 'aang.lock'])
  const database = home.database()
  expect(pragma(database, 'journal_mode')).toBe('wal')
  expect(pragma(database, 'user_version')).toBe(schemaFiles().length)
})

test('reopening an up-to-date home changes nothing', async ({ onTestFinished }) => {
  const home = await createHome(onTestFinished)
  home.open().close()
  const before = describeHome(home)

  home.open().close()

  expect(describeHome(home)).toEqual(before)
})

test('a second writer in the same process is refused until the first one closes', async ({ onTestFinished }) => {
  const home = await createHome(onTestFinished)
  const first = home.open()

  expect(() => openStore({ home: home.path })).toThrow(StoreLockedError)

  first.close()
  expect(() => {
    home.open().close()
  }).not.toThrow()
})

test('a writer in another process keeps the home locked until it is killed', async ({ onTestFinished }) => {
  const home = await createHome(onTestFinished)
  const holder = await home.hold('open')

  expect(() => openStore({ home: home.path })).toThrow(StoreLockedError)

  await holder.kill()
  expect(() => {
    home.open().close()
  }).not.toThrow()
})

test('change sequence numbers grow across transactions and continue after reopening', async ({ onTestFinished }) => {
  const home = await createHome(onTestFinished)
  const store = home.open()

  expect(store.transaction((transaction) => [transaction.nextChangeSeq(), transaction.nextChangeSeq()])).toEqual([
    1, 2,
  ])
  expect(store.transaction((transaction) => transaction.nextChangeSeq())).toBe(3)
  store.close()

  expect(home.open().transaction((transaction) => transaction.nextChangeSeq())).toBe(4)
})

test('a failed transaction is rolled back and its change sequence numbers are issued again', async ({
  onTestFinished,
}) => {
  const home = await createHome(onTestFinished)
  const store = home.open()
  store.transaction((transaction) => transaction.nextChangeSeq())

  expect(() =>
    store.transaction((transaction) => {
      transaction.nextChangeSeq()
      throw new Error('ingestion failed')
    }),
  ).toThrow('ingestion failed')

  expect(store.transaction((transaction) => transaction.nextChangeSeq())).toBe(2)
})

test('a writer killed inside a transaction leaves only its committed changes', async ({ onTestFinished }) => {
  const home = await createHome(onTestFinished)
  const holder = await home.hold('transaction')

  await holder.kill()

  expect(home.open().transaction((transaction) => transaction.nextChangeSeq())).toBe(2)
})

test('asynchronous transaction work is refused and rolled back', async ({ onTestFinished }) => {
  const home = await createHome(onTestFinished)
  const store = home.open()

  expect(() =>
    store.transaction((transaction) => {
      transaction.nextChangeSeq()
      return Promise.resolve()
    }),
  ).toThrow('transaction work must be synchronous')

  expect(store.transaction((transaction) => transaction.nextChangeSeq())).toBe(1)
})

test('a transaction cannot issue change sequence numbers after it has finished', async ({ onTestFinished }) => {
  const home = await createHome(onTestFinished)
  const store = home.open()
  const finished = store.transaction((transaction) => transaction)

  expect(() => finished.nextChangeSeq()).toThrow('transaction has already finished')

  expect(store.transaction((transaction) => transaction.nextChangeSeq())).toBe(1)
})

test('a database written by a newer schema is refused and left untouched', async ({ onTestFinished }) => {
  const home = await createHome(onTestFinished)
  mkdirSync(home.path, { recursive: true })
  const newer = home.database()
  newer.exec('PRAGMA user_version = 1000')
  newer.close()
  const bytes = readFileSync(home.databaseFile)

  expect(() => openStore({ home: home.path })).toThrow(StoreVersionError)
  expect(() => openStore({ home: home.path })).toThrow(
    `aang store schema version 1000 is newer than the supported version ${String(schemaFiles().length)}`,
  )

  expect(readFileSync(home.databaseFile)).toEqual(bytes)
})

test('upgrading an older database first copies it next to the original and keeps its data', async ({
  onTestFinished,
}) => {
  const home = await createHome(onTestFinished)
  const [first] = schemaFiles()
  mkdirSync(home.path, { recursive: true })
  const older = home.database()
  older.exec(first ?? '')
  older.exec('UPDATE change_counter SET value = 41; PRAGMA user_version = 1')
  older.close()

  expect(home.open().transaction((transaction) => transaction.nextChangeSeq())).toBe(42)

  const backup = home.database('aang.db.v1.bak')
  expect(pragma(backup, 'user_version')).toBe(1)
  expect(backup.prepare('SELECT value FROM change_counter').get()).toEqual({ value: 41 })
  expect(pragma(home.database(), 'user_version')).toBe(schemaFiles().length)
})
