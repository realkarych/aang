import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { chmod, mkdir, readdir, rename, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
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
import { readDaemonState, readSpoolState } from '@aang/contract/home'
import { objectId } from '@aang/contract/ids'
import { openStore, type Store } from '@aang/store'
import { invokeHook } from '@aang/testkit'
import { describe, type TestContext, test } from 'vitest'
import { bearer, createHome, type Home, spawnDaemon, startDaemon } from './daemon.js'

interface WatchedHome {
  readonly home: Home
  readonly workspace: string
}

const permissionsRestrict = process.platform !== 'win32' && process.getuid?.() !== 0

const samples = new URL('../../../docs/research/samples/', import.meta.url)

const hookBinary = fileURLToPath(
  new URL(`../../hook/bin/aang-hook${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url),
)

const sample = (path: string): string => readFileSync(new URL(path, samples), 'utf8')

const sampleObject = (path: string): Record<string, unknown> => JSON.parse(sample(path)) as Record<string, unknown>

const claudeHook = (name: string, session: string, cwd: string, changes: Record<string, unknown> = {}): string =>
  JSON.stringify({ ...sampleObject(`claude-code-hooks/${name}.json`), session_id: session, cwd, ...changes })

const transcriptLines = (session: string, cwd: string, count: number): string[] =>
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

const codexHook = (name: string, session: string, cwd: string): string => {
  const { stdin } = sampleObject(`codex-cli/hooks/${name}.json`) as { readonly stdin: Record<string, unknown> }
  return JSON.stringify({ ...stdin, session_id: session, cwd })
}

const rolloutLines = (cwd: string): string[] =>
  sample('codex-cli/rollout/rollout-real-exec-then-resume-with-compaction.jsonl')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const record = JSON.parse(line) as { readonly type: string; readonly payload: Record<string, unknown> }
      return record.type === 'session_meta' || record.type === 'turn_context'
        ? JSON.stringify({ ...record, payload: { ...record.payload, cwd } })
        : line
    })

const rolloutThread = '01a0f752-40a7-76b2-9df9-5b374f75f98f'

const claudeSession = (session: string): SessionKey => ({ kind: 'session', runtime: 'claude', session })

const watchedHome = async (
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

const waitUntil = async (condition: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error(`condition not met within ${String(timeoutMs)} ms`)
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const sleep = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds))

const queued = (home: Home): Promise<string[]> => readdir(home.paths.spoolReady)

const registrations: Readonly<Record<Runtime, RegistrationTag>> = { claude: 'plugin', codex: 'user' }

const spoolBytes = (runtime: Runtime, payload: string): Buffer =>
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

const enqueue = async (
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

const hookEvent = (home: Home, payload: string): Promise<void> =>
  invokeHook(
    { binary: hookBinary, spool: home.paths.spool },
    { runtime: 'claude', registration: 'plugin', env: { CLAUDE_CODE_ENTRYPOINT: 'cli' }, payload },
  )

const openFinished = (home: Home, onTestFinished: TestContext['onTestFinished']): Store => {
  const store = openStore({ home: home.paths.home })
  onTestFinished(() => {
    store.close()
  })
  return store
}

const rawRecords = (store: Store): RawRecord[] =>
  store.changes
    .after(ChangeSeq.parse(0), 1_000_000)
    .flatMap((change) => (change.layer === 'raw_record' ? [change.record] : []))

const spoolFilesOf = (store: Store): string[] =>
  rawRecords(store).flatMap(({ position }) => (position.kind === 'spool' ? [position.file] : []))

const restartUntil = async <T>(
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

const shutdownRequest = (base: string, headers: Record<string, string>): Promise<Response> =>
  fetch(`${base}/api/admin/shutdown`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: '{}',
  })

describe.concurrent('the daemon takes collected records through the engine and acknowledges them after the commit', () => {
  test('a transcript line and a hook event from the temporary HOME become one session with one merged action', async ({
    expect,
    onTestFinished,
  }) => {
    const { home, workspace } = await watchedHome(onTestFinished)
    const session = 'g3-transcript-and-hook'
    const toolUse = 'toolu_017B7FeHZ4yDzFdvKQMwDJB8'
    const daemon = await spawnDaemon(home, onTestFinished)
    const project = join(home.root, '.claude', 'projects', '-work')
    await mkdir(project, { recursive: true })
    const written = join(home.root, 'transcript.partial')
    await writeFile(written, `${transcriptLines(session, workspace, 22).join('\n')}\n`)
    await rename(written, join(project, `${session}.jsonl`))

    await hookEvent(home, claudeHook('PreToolUse.Bash', session, workspace, { tool_use_id: toolUse }))

    await waitUntil(async () => (await queued(home)).length === 0)
    expect(await daemon.shutdown()).toBe(0)
    const store = openFinished(home, onTestFinished)
    const sessionId = objectId(claudeSession(session))
    expect(store.observations.getSession(sessionId)).toMatchObject({ cwd: workspace, support_mode: 'full' })
    expect(store.observations.actions(sessionId).filter(({ key }) => key.call === toolUse)).toHaveLength(1)
    expect(new Set(rawRecords(store).map(({ channel }) => channel))).toEqual(new Set(['transcript', 'hook']))
  })

  test(
    'an authorized shutdown during ingestion finishes the current transaction, removes the lease, and the unacknowledged files are taken once after a restart',
    { timeout: 120_000 },
    async ({ expect, onTestFinished }) => {
      const { home, workspace } = await watchedHome(onTestFinished)
      const elsewhere = join(home.root, 'elsewhere')
      await mkdir(elsewhere)
      const session = 'g3-shutdown-during-ingestion'
      const outsiders = Array.from({ length: 200 }, (_, index) => `g3-elsewhere-${String(index)}`)
      const calls = Array.from({ length: 300 }, (_, index) => `toolu_g3_${String(index)}`)
      const [start = '', ...outside] = await enqueue(home, 'a', [
        claudeHook('SessionStart.startup', session, workspace),
        ...outsiders.map((outsider) => claudeHook('SessionStart.startup', outsider, elsewhere)),
      ])
      const daemon = await spawnDaemon(home, onTestFinished)
      await sleep(100)
      const later = await enqueue(
        home,
        'b',
        calls.map((call, index) =>
          claudeHook('PreToolUse.Bash', session, workspace, {
            tool_use_id: call,
            tool_input: { command: `echo ${String(index)}` },
          }),
        ),
      )

      expect(await daemon.shutdown()).toBe(0)

      expect((await readSpoolState(home.paths.spool)).leaseExpiresAt).toBeNull()
      const left = await queued(home)
      expect(left.filter((name) => outside.includes(name))).toEqual([])
      expect(left.length).toBeGreaterThan(0)
      const interrupted = openStore({ home: home.paths.home })
      const taken = spoolFilesOf(interrupted)
      const outsiderSessions = outsiders.map((outsider) =>
        interrupted.observations.getSession(objectId(claudeSession(outsider))),
      )
      interrupted.close()
      expect([...taken, ...left].sort()).toEqual([start, ...later].sort())
      expect(outsiderSessions.filter((found) => found !== null)).toEqual([])

      const restarted = await spawnDaemon(home, onTestFinished)
      await waitUntil(async () => (await queued(home)).length === 0, 60_000)
      expect(await restarted.shutdown()).toBe(0)

      const store = openFinished(home, onTestFinished)
      expect(spoolFilesOf(store).sort()).toEqual([start, ...later].sort())
      const sessionId = objectId(claudeSession(session))
      expect(store.observations.actions(sessionId).map(({ key }) => key.call).sort()).toEqual([...calls].sort())
    },
  )

  test('a shutdown without the token is refused with 401 and the daemon keeps taking records', async ({
    expect,
    onTestFinished,
  }) => {
    const { home, workspace } = await watchedHome(onTestFinished)
    const session = 'g3-refused-shutdown'
    const daemon = await spawnDaemon(home, onTestFinished)

    for (const headers of [{}, bearer('not-the-ui-token')]) {
      const refused = await shutdownRequest(daemon.base, headers)
      expect(refused.status).toBe(401)
      await refused.arrayBuffer()
    }

    await hookEvent(home, claudeHook('SessionStart.startup', session, workspace))
    await waitUntil(async () => (await queued(home)).length === 0)
    expect((await readSpoolState(home.paths.spool)).leaseExpiresAt).not.toBeNull()
    expect(await daemon.shutdown()).toBe(0)
    const store = openFinished(home, onTestFinished)
    expect(store.observations.getSession(objectId(claudeSession(session)))).toMatchObject({ cwd: workspace })
  })

  test('the OTel receiver listens on loopback with a token kept across restarts and stores codex.tool_decision', async ({
    expect,
    onTestFinished,
  }) => {
    const home = await createHome(onTestFinished)
    const first = await spawnDaemon(home, onTestFinished)
    expect(first.ready.otel.host).toBe('127.0.0.1')
    expect(await first.shutdown()).toBe(0)
    const before = openStore({ home: home.paths.home })
    const token = String(before.settings.get('otel_token'))
    before.close()
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)

    const daemon = await spawnDaemon(home, onTestFinished)
    const post = (secret: string): Promise<Response> =>
      fetch(`http://127.0.0.1:${String(daemon.ready.otel.port)}/otel/${secret}/v1/logs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: sample('codex-otel/logs.envelope.tool_decision.approved-user.app-server.json'),
      })
    const rejected = await post('not-the-receiver-token')
    expect(rejected.status).toBe(404)
    await rejected.arrayBuffer()
    const accepted = await post(token)
    expect(accepted.status).toBe(200)
    await accepted.arrayBuffer()

    const otelQueue = join(home.paths.spool, 'otel')
    await waitUntil(async () => (await readdir(otelQueue)).every((name) => !name.endsWith('.json')))
    expect(await daemon.shutdown()).toBe(0)
    const store = openFinished(home, onTestFinished)
    expect(store.settings.get('otel_token')).toBe(token)
    expect(rawRecords(store).filter(({ channel }) => channel === 'otel')).toHaveLength(1)
  })

  test('a running turn without new events turns quiet after the configured interval', async ({
    expect,
    onTestFinished,
  }) => {
    const { home, workspace } = await watchedHome(onTestFinished, { freshness: { quietAfterMs: 300 } })
    const session = 'g3-quiet-turn'
    const daemon = await spawnDaemon(home, onTestFinished)

    await enqueue(home, 'a', [
      claudeHook('SessionStart.startup', session, workspace),
      claudeHook('UserPromptSubmit', session, workspace),
    ])
    await waitUntil(async () => (await queued(home)).length === 0)
    await sleep(2_000)

    expect(await daemon.shutdown()).toBe(0)
    const store = openFinished(home, onTestFinished)
    expect(store.observations.getSession(objectId(claudeSession(session)))).toMatchObject({
      state: 'turn_running',
      freshness: 'quiet',
    })
  })

  test(
    'an open source_lost gap survives restarts and closes once the rollout reappears in the archive',
    { timeout: 120_000 },
    async ({ expect, onTestFinished }) => {
      const { home, workspace } = await watchedHome(onTestFinished)
      const lines = rolloutLines(workspace)
      const active = join(home.root, '.codex', 'sessions', '2026', '10', '01', 'rollout-g3.jsonl')
      const moved = join(home.root, 'rollout-g3.jsonl')
      const archived = join(home.root, '.codex', 'archived_sessions', 'rollout-g3.jsonl')
      await mkdir(dirname(active), { recursive: true })
      await writeFile(active, `${lines.join('\n')}\n`)
      await enqueue(home, 'a', [codexHook('PreToolUse.Bash', rolloutThread, workspace)], 'codex')
      const first = await spawnDaemon(home, onTestFinished)
      await waitUntil(async () => (await queued(home)).length === 0)
      expect(await first.shutdown()).toBe(0)
      const sessionId = objectId({ kind: 'session', runtime: 'codex', session: rolloutThread })

      await rename(active, moved)
      const lost = await restartUntil(home, onTestFinished, (store) => store.gaps.open('source_lost')[0] ?? null)
      const whileLost = openStore({ home: home.paths.home })
      const lostSession = whileLost.observations.getSession(sessionId)
      whileLost.close()
      expect(lost).toMatchObject({ session: sessionId, closed_at: null })
      expect(lostSession?.freshness).toBe('lost')

      await mkdir(dirname(archived), { recursive: true })
      await rename(moved, archived)
      const closed = await restartUntil(home, onTestFinished, (store) => {
        const gap = store.gaps.get(lost.id)
        return gap?.closed_at === null ? null : gap
      })

      expect(closed).toMatchObject({ key: lost.key, detected_at: lost.detected_at })
      const store = openFinished(home, onTestFinished)
      expect(store.gaps.open('source_lost')).toEqual([])
      expect(store.observations.getSession(sessionId)?.freshness).not.toBe('lost')
      expect(rawRecords(store).filter(({ channel }) => channel === 'rollout')).toHaveLength(lines.length)
    },
  )

  test('a busy OTel port fails the start and leaves the home free for the next start', async ({
    expect,
    onTestFinished,
  }) => {
    const blocker = createServer()
    blocker.listen(0, '127.0.0.1')
    await once(blocker, 'listening')
    onTestFinished(
      () =>
        new Promise<void>((resolve) => {
          blocker.close(() => {
            resolve()
          })
        }),
    )
    const { port } = blocker.address() as AddressInfo
    const home = await createHome(onTestFinished, { otel: { port } })

    await expect(startDaemon(home, onTestFinished)).rejects.toMatchObject({ code: 'EADDRINUSE' })

    expect((await readSpoolState(home.paths.spool)).leaseExpiresAt).toBeNull()
    expect(await readDaemonState(home.paths.daemonState)).toBeNull()
    await writeFile(join(home.paths.home, 'config.json'), JSON.stringify({ api: { port: 0 }, otel: { port: 0 } }))
    const daemon = await startDaemon(home, onTestFinished)
    expect(daemon.ready.otel.port).not.toBe(port)
  })

  test.runIf(permissionsRestrict)(
    'a spool that can no longer be listed stops the daemon with an error and removes the lease',
    async ({ expect, onTestFinished }) => {
      const home = await createHome(onTestFinished, { collector: { spoolScanIntervalMs: 50 } })
      const daemon = await spawnDaemon(home, onTestFinished)
      expect((await readSpoolState(home.paths.spool)).leaseExpiresAt).not.toBeNull()

      await chmod(home.paths.spoolReady, 0o000)
      const code = await daemon.exited()
      await chmod(home.paths.spoolReady, 0o700)

      expect(code).not.toBe(0)
      expect(daemon.errors()).toContain('EACCES')
      expect((await readSpoolState(home.paths.spool)).leaseExpiresAt).toBeNull()
      expect(await readDaemonState(home.paths.daemonState)).toBeNull()
    },
  )
})
