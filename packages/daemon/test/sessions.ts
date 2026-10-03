import { readFileSync } from 'node:fs'
import { mkdir, readdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ChangeSeq,
  type RawRecord,
  type RegistrationTag,
  type Runtime,
  type SessionKey,
  spoolFormat,
  spoolLayout,
} from '@aang/contract'
import { openStore, type Store } from '@aang/store'
import { invokeHook } from '@aang/testkit'
import type { TestContext } from 'vitest'
import { createHome, type Home, spawnDaemon } from './daemon.js'

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
): Promise<string[]> => {
  const temporary = join(home.paths.spool, spoolLayout.temporaryDirectory)
  await mkdir(temporary, { recursive: true })
  await mkdir(home.paths.spoolReady, { recursive: true })
  const names: string[] = []
  for (const [index, payload] of events.entries()) {
    const name = `${prefix}-${String(index).padStart(6, '0')}.evt`
    await writeFile(join(temporary, name), spoolBytes(runtime, payload))
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

export const claudeTranscript = async (home: Home, project: string, session: string, lines: readonly string[]): Promise<string> => {
  const directory = join(home.root, '.claude', 'projects', project)
  await mkdir(directory, { recursive: true })
  const path = join(directory, `${session}.jsonl`)
  const written = join(home.root, `${session}.partial`)
  await writeFile(written, `${lines.join('\n')}\n`)
  await rename(written, path)
  return path
}
