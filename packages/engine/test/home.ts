import { type ChildProcessByStdio, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import type { RunId } from '@aang/contract'
import { openStore, type Store } from '@aang/store'

type Awaitable<T> = T | Promise<T>

type Cleanup = () => Awaitable<void>

type Child = ChildProcessByStdio<null, Readable, Readable>

export interface ObserverCallRow {
  readonly id: string
  readonly run: RunId
  readonly base_version: number
}

export interface Writer {
  readonly kill: () => Promise<void>
}

export interface Home {
  readonly path: string
  readonly open: () => Store
  readonly database: () => DatabaseSync
  readonly recordObserverCalls: (calls: readonly ObserverCallRow[]) => void
  readonly startWriter: () => Promise<Writer>
  readonly startObserverWriter: (phase: 'started' | 'applying' | 'accepted') => Promise<Writer>
  readonly startReparse: () => Promise<Writer>
}

const writerScript = fileURLToPath(new URL('./model-writer.ts', import.meta.url))
const observerWriterScript = fileURLToPath(new URL('./observer-writer.ts', import.meta.url))
const reparseScript = fileURLToPath(new URL('./reparse-process.ts', import.meta.url))

const waitUntilReady = (child: Child): Promise<void> =>
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
      reject(new Error(`writer exited (${String(code ?? signal)}) before it was ready: ${stderr}`))
    })
  })

const killChild = async (child: Child): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return
  }
  const exited = once(child, 'exit')
  child.kill('SIGKILL')
  await exited
}

export const createHome = async (register: (cleanup: Cleanup) => void): Promise<Home> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aang-engine-')))
  const path = join(root, 'home')
  const cleanups: Cleanup[] = []
  register(async () => {
    for (const cleanup of cleanups.reverse()) {
      await cleanup()
    }
    await rm(root, { recursive: true, force: true, maxRetries: 5 })
  })

  const database = (): DatabaseSync => {
    const connection = new DatabaseSync(join(path, 'aang.db'))
    cleanups.push(() => {
      if (connection.isOpen) {
        connection.close()
      }
    })
    return connection
  }

  const startWriter = async (script: string, args: string[] = []): Promise<Writer> => {
    const child = spawn(process.execPath, [script, path, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    cleanups.push(() => killChild(child))
    await waitUntilReady(child)
    return { kill: () => killChild(child) }
  }

  return {
    path,
    open: () => {
      const store = openStore({ home: path })
      cleanups.push(() => {
        store.close()
      })
      return store
    },
    database,
    recordObserverCalls: (calls) => {
      const connection = database()
      const insertCall = connection.prepare(
        `INSERT INTO observer_calls (id, run_id, backend, base_version, input, started_at, change_seq)
         VALUES (?, ?, 'claude', ?, '{}', 1759370000000000000, 1)`,
      )
      for (const call of calls) {
        insertCall.run(call.id, call.run, call.base_version)
      }
      connection.close()
    },
    startWriter: () => startWriter(writerScript),
    startObserverWriter: (phase) => startWriter(observerWriterScript, [phase]),
    startReparse: () => startWriter(reparseScript),
  }
}
