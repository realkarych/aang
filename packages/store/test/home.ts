import { type ChildProcess, type ChildProcessByStdio, spawn } from 'node:child_process'
import { once } from 'node:events'
import { readdirSync, readFileSync } from 'node:fs'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { openStore, type Store } from '@aang/store'
import { expect } from 'vitest'

export type HoldMode = 'open' | 'transaction' | 'ingest'

export interface Holder {
  readonly kill: () => Promise<void>
}

export interface Home {
  readonly path: string
  readonly databaseFile: string
  readonly open: () => Store
  readonly database: (file?: string) => DatabaseSync
  readonly hold: (mode: HoldMode) => Promise<Holder>
}

type Awaitable<T> = T | Promise<T>

type Cleanup = () => Awaitable<void>

const holderScript = fileURLToPath(new URL('./hold-store.ts', import.meta.url))
const schemaDirectory = new URL('../schema/', import.meta.url)

export const schemaFiles = (): string[] =>
  readdirSync(schemaDirectory)
    .filter((name) => name.endsWith('.sql'))
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .map((name) => readFileSync(new URL(name, schemaDirectory), 'utf8'))

export const pragma = (database: DatabaseSync, name: string): unknown =>
  database.prepare(`PRAGMA ${name}`).get()?.[name]

const waitUntilReady = (child: ChildProcessByStdio<null, Readable, Readable>): Promise<void> =>
  new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk
      if (stdout.includes('ready\n')) {
        resolve()
      }
    })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      reject(new Error(`holder exited (${String(code ?? signal)}) before it was ready: ${stderr}`))
    })
  })

const killChild = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return
  }
  const exited = once(child, 'exit')
  child.kill('SIGKILL')
  await exited
}

export const createHome = async (register: (cleanup: Cleanup) => void): Promise<Home> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aang-store-')))
  const path = join(root, 'home')
  const cleanups: Cleanup[] = []
  register(async () => {
    for (const cleanup of cleanups.reverse()) {
      await cleanup()
    }
    await rm(root, { recursive: true, force: true, maxRetries: 5 })
  })
  return {
    path,
    databaseFile: join(path, 'aang.db'),
    open: () => {
      const store = openStore({ home: path })
      cleanups.push(() => {
        store.close()
      })
      return store
    },
    database: (file = 'aang.db') => {
      const database = new DatabaseSync(join(path, file))
      cleanups.push(() => {
        if (database.isOpen) {
          database.close()
        }
      })
      return database
    },
    hold: async (mode) => {
      const child = spawn(process.execPath, [holderScript, path, mode], { stdio: ['ignore', 'pipe', 'pipe'] })
      cleanups.push(() => killChild(child))
      await waitUntilReady(child)
      return { kill: () => killChild(child) }
    },
  }
}

export interface SchemaDatabase {
  readonly database: DatabaseSync
  readonly dispose: () => Promise<void>
}

export const createSchemaDatabase = async (): Promise<SchemaDatabase> => {
  const cleanups: Cleanup[] = []
  const home = await createHome((cleanup) => cleanups.push(cleanup))
  home.open().close()
  return {
    database: home.database(),
    dispose: async () => {
      for (const cleanup of cleanups) {
        await cleanup()
      }
    },
  }
}

export interface SchemaCase {
  readonly name: string
  readonly setup?: readonly string[]
  readonly statement: string
  readonly error?: RegExp
}

export const checkSchemaCase = (database: DatabaseSync, { setup = [], statement, error }: SchemaCase): void => {
  database.exec('SAVEPOINT schema_case')
  try {
    for (const prerequisite of setup) {
      database.exec(prerequisite)
    }
    const run = (): void => {
      database.exec(statement)
    }
    if (error === undefined) {
      expect(run).not.toThrow()
    } else {
      expect(run).toThrow(error)
    }
  } finally {
    database.exec('ROLLBACK TO schema_case; RELEASE schema_case')
  }
}

export type Row = Readonly<Record<string, string>>

export const insert = (table: string, ...parts: readonly Row[]): string => {
  const row = parts.reduce<Row>((merged, part) => ({ ...merged, ...part }), {})
  return `INSERT INTO ${table} (${Object.keys(row).join(', ')}) VALUES (${Object.values(row).join(', ')})`
}
