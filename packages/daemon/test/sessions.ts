import { readFileSync } from 'node:fs'
import { appendFile, mkdir, readdir, rename, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import {
  ChangeSeq,
  type RawRecord,
  type RegistrationTag,
  type RunId,
  type Runtime,
  type SessionKey,
  spoolFormat,
  type StreamKey,
  spoolLayout,
} from '@aang/contract'
import { claudeAdapter } from '@aang/adapter-claude'
import { runId } from '@aang/contract/ids'
import { openStore, type Store } from '@aang/store'
import { invokeHook } from '@aang/testkit'
import type { TestContext } from 'vitest'
import { bearer, createHome, type Home, spawnDaemon } from './daemon.js'

export interface WatchedHome {
  readonly home: Home
  readonly workspace: string
}

export const permissionsRestrict = process.platform !== 'win32' && process.getuid?.() !== 0

export const samples = new URL('../../../docs/research/samples/', import.meta.url)

export const hookBinary = fileURLToPath(
  new URL(`../../hook/bin/aang-hook${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url),
)

export const sample = (path: string): string => readFileSync(new URL(path, samples), 'utf8')

export const sampleObject = (path: string): Record<string, unknown> => JSON.parse(sample(path)) as Record<string, unknown>

export const claudeHook = (name: string, session: string, cwd: string, changes: Record<string, unknown> = {}): string =>
  JSON.stringify({ ...sampleObject(`claude-code-hooks/${name}.json`), session_id: session, cwd, ...changes })

export const transcriptLines = (session: string, cwd: string, count: number): string[] =>
  sample('claude-code-transcripts/session-86f93ed5-main-full.jsonl')
    .split('\n')
    .filter((line) => line !== '')
    .slice(0, count)
    .map((line) => {
      const record = JSON.parse(line) as Record<string, unknown>
      return JSON.stringify({
        ...record,
        ...('sessionId' in record ? { sessionId: session } : {}),
        ...('cwd' in record ? { cwd } : {}),
      })
    })

export const codexHook = (name: string, session: string, cwd: string): string => {
  const { stdin } = sampleObject(`codex-cli/hooks/${name}.json`) as { readonly stdin: Record<string, unknown> }
  return JSON.stringify({ ...stdin, session_id: session, cwd })
}

export const rolloutLines = (cwd: string): string[] =>
  sample('codex-cli/rollout/rollout-real-exec-then-resume-with-compaction.jsonl')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const record = JSON.parse(line) as { readonly type: string; readonly payload: Record<string, unknown> }
      return record.type === 'session_meta' || record.type === 'turn_context'
        ? JSON.stringify({ ...record, payload: { ...record.payload, cwd } })
        : line
    })

export const rolloutThread = '01a0f752-40a7-76b2-9df9-5b374f75f98f'

export const claudeSession = (session: string): SessionKey => ({ kind: 'session', runtime: 'claude', session })

export const watchedHome = async (
  onTestFinished: TestContext['onTestFinished'],
  config: Record<string, unknown> = {},
): Promise<WatchedHome> => {
  const home = await createHome(onTestFinished)
  const workspace = join(home.root, 'work')
  await mkdir(workspace)
  await writeFile(
    join(home.paths.home, 'config.json'),
    JSON.stringify({
      api: { port: 0 },
      otel: { port: 0 },
      collector: { rootsScanIntervalMs: 200 },
      watch: { roots: [{ path: workspace }] },
      ...config,
    }),
  )
  return { home, workspace }
}

export const waitUntil = async (condition: () => boolean | Promise<boolean>, timeoutMs = 20_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error(`condition not met within ${String(timeoutMs)} ms`)
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

export const sleep = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds))

export const queued = (home: Home): Promise<string[]> => readdir(home.paths.spoolReady)

export const queuedOtel = async (home: Home): Promise<string[]> =>
  (await readdir(join(home.paths.spool, 'otel'))).filter((name) => name.endsWith('.json'))

export const registrations: Readonly<Record<Runtime, RegistrationTag>> = { claude: 'plugin', codex: 'user' }

export const spoolBytes = (runtime: Runtime, payload: string): Buffer =>
  Buffer.concat([
    Buffer.from(
      [spoolFormat.magic, runtime, registrations[runtime]].join(spoolFormat.headerFieldSeparator) +
        spoolFormat.headerLineTerminator,
    ),
    ...(runtime === 'claude'
      ? [Buffer.from(`CLAUDE_CODE_ENTRYPOINT${spoolFormat.envAssignment}cli${spoolFormat.envEntryTerminator}`)]
      : []),
    Buffer.from(spoolFormat.envEntryTerminator),
    Buffer.from(payload),
  ])

export const enqueue = async (
  home: Home,
  prefix: string,
  events: readonly string[],
  runtime: Runtime = 'claude',
  writtenAt: Date | null = null,
): Promise<string[]> => {
  const temporary = join(home.paths.spool, spoolLayout.temporaryDirectory)
  await mkdir(temporary, { recursive: true })
  await mkdir(home.paths.spoolReady, { recursive: true })
  const names: string[] = []
  for (const [index, payload] of events.entries()) {
    const name = `${prefix}-${String(index).padStart(6, '0')}.evt`
    await writeFile(join(temporary, name), spoolBytes(runtime, payload))
    if (writtenAt !== null) {
      await utimes(join(temporary, name), writtenAt, writtenAt)
    }
    await rename(join(temporary, name), join(home.paths.spoolReady, name))
    names.push(name)
  }
  return names
}

export const hookEvent = (home: Home, payload: string): Promise<void> =>
  invokeHook(
    { binary: hookBinary, spool: home.paths.spool },
    { runtime: 'claude', registration: 'plugin', env: { CLAUDE_CODE_ENTRYPOINT: 'cli' }, payload },
  )

export const openFinished = (home: Home, onTestFinished: TestContext['onTestFinished']): Store => {
  const store = openStore({ home: home.paths.home })
  onTestFinished(() => {
    store.close()
  })
  return store
}

export const rawRecords = (store: Store): RawRecord[] =>
  store.changes
    .after(ChangeSeq.parse(0), 1_000_000)
    .flatMap((change) => (change.layer === 'raw_record' ? [change.record] : []))

export const spoolFilesOf = (store: Store): string[] =>
  rawRecords(store).flatMap(({ position }) => (position.kind === 'spool' ? [position.file] : []))

export const restartUntil = async <T>(
  home: Home,
  onTestFinished: TestContext['onTestFinished'],
  probe: (store: Store) => T | null,
): Promise<T> => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const daemon = await spawnDaemon(home, onTestFinished)
    await sleep(300)
    const code = await daemon.shutdown()
    if (code !== 0) {
      throw new Error(`the daemon stopped with ${String(code)}`)
    }
    const store = openStore({ home: home.paths.home })
    try {
      const found = probe(store)
      if (found !== null) {
        return found
      }
    } finally {
      store.close()
    }
  }
  throw new Error('the store did not reach the expected state after 20 restarts')
}

export const daysAgo = (days: number): Date => new Date(Date.now() - days * 86_400_000)

export const stored = <T>(home: Home, read: (database: DatabaseSync) => T, fallback: T): T => {
  try {
    const database = new DatabaseSync(join(home.paths.home, 'aang.db'), { readOnly: true })
    try {
      return read(database)
    } finally {
      database.close()
    }
  } catch {
    return fallback
  }
}

export const storedCount = (home: Home, sql: string, ...parameters: string[]): number =>
  stored(home, (database) => (database.prepare(sql).get(...parameters) as { readonly count: number }).count, 0)

export interface AdminAnswer {
  readonly status: number
  readonly body: unknown
}

export const admin = async (home: Home, base: string, action: string, body: unknown): Promise<AdminAnswer> => {
  const response = await fetch(`${base}/api/admin/${action}`, {
    method: 'POST',
    headers: { ...bearer(home.token), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

export const claudeTranscript = async (home: Home, project: string, session: string, lines: readonly string[]): Promise<string> => {
  const directory = join(home.root, '.claude', 'projects', project)
  await mkdir(directory, { recursive: true })
  const path = join(directory, `${session}.jsonl`)
  const written = join(home.root, `${session}.partial`)
  await writeFile(written, `${lines.join('\n')}\n`)
  await rename(written, path)
  return path
}

export const claudeStream = (session: string): StreamKey => {
  const stream = claudeAdapter.streamKey([JSON.stringify({ sessionId: session })])
  if (stream === null) {
    throw new Error(`no Claude stream for ${session}`)
  }
  return stream
}

export interface LiveTranscript {
  readonly run: RunId
  readonly append: (lines: readonly string[]) => Promise<void>
  readonly call: (call: string, tool?: string, input?: Record<string, unknown>) => string[]
  readonly plan: (call: string, items: readonly string[]) => string[]
}

export const liveTranscript = async (home: Home, workspace: string, session: string): Promise<LiveTranscript> => {
  const project = join(home.root, '.claude', 'projects', '-work')
  await mkdir(project, { recursive: true })
  const file = join(project, `${session}.jsonl`)
  await writeFile(file, '')
  const line = (record: Record<string, unknown>): string =>
    JSON.stringify({ sessionId: session, cwd: workspace, timestamp: new Date().toISOString(), ...record })
  const call = (id: string, tool = 'Bash', input: Record<string, unknown> = { command: `echo ${id}` }): string[] => [
    line({
      type: 'assistant',
      uuid: `${id}-use`,
      message: { id: `${id}-message`, role: 'assistant', content: [{ type: 'tool_use', id, name: tool, input }] },
    }),
    line({
      type: 'user',
      uuid: `${id}-result`,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', is_error: false }] },
    }),
  ]
  return {
    run: runId(claudeSession(session)),
    append: (lines) => appendFile(file, lines.map((entry) => `${entry}\n`).join('')),
    call,
    plan: (id, items) => call(id, 'TodoWrite', { todos: items.map((content) => ({ content, status: 'pending' })) }),
  }
}
