import { once } from 'node:events'
import { chmod, mkdir, open, rename, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import { readDaemonState, readSpoolState } from '@aang/contract/home'
import { objectId } from '@aang/contract/ids'
import { openStore } from '@aang/store'
import { describe, test } from 'vitest'
import { bearer, createHome, missingCli, spawnDaemon, startDaemon } from './daemon.js'
import {
  claudeHook,
  claudeSession,
  claudeTranscript,
  codexHook,
  enqueue,
  hookEvent,
  openFinished,
  permissionsRestrict,
  queued,
  queuedOtel,
  rawRecords,
  restartUntil,
  rolloutLines,
  rolloutThread,
  sample,
  sleep,
  spoolFilesOf,
  storedCount,
  transcriptLines,
  waitUntil,
  watchedHome,
} from './sessions.js'

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
    expect(await daemon.shutdown()).toBe(0)

    const restarted = await spawnDaemon(home, onTestFinished)
    await waitUntil(async () => (await queuedOtel(home)).length === 0)
    expect(await restarted.shutdown()).toBe(0)
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

  test('a command appended to a rollout that Codex holds open is taken within seconds while the roots scan waits a minute', async ({
    expect,
    onTestFinished,
  }) => {
    const { home, workspace } = await watchedHome(onTestFinished, { collector: {} })
    const lines = rolloutLines(workspace)
    const commandAt = lines.findIndex((line) => (JSON.parse(line) as { readonly payload: { readonly type?: string } }).payload.type === 'custom_tool_call')
    const rollout = join(home.root, '.codex', 'sessions', '2026', '10', '01', 'rollout-q4-held.jsonl')
    const taken = "SELECT count(*) AS count FROM raw_records WHERE channel = 'rollout'"
    await mkdir(dirname(rollout), { recursive: true })
    const daemon = await spawnDaemon(home, onTestFinished)
    const writer = await open(rollout, 'a')
    let lagMs: number
    try {
      await writer.write(`${lines.slice(0, commandAt).join('\n')}\n`)
      await waitUntil(() => storedCount(home, taken) === commandAt)
      const appendedAt = performance.now()
      await writer.write(`${lines[commandAt] ?? ''}\n`)
      await waitUntil(() => storedCount(home, taken) === commandAt + 1)
      lagMs = performance.now() - appendedAt
    } finally {
      await writer.close()
    }
    expect(await daemon.shutdown()).toBe(0)

    expect(lagMs).toBeLessThanOrEqual(3_000)
    const store = openFinished(home, onTestFinished)
    const sessionId = objectId({ kind: 'session', runtime: 'codex', session: rolloutThread })
    expect(store.observations.actions(sessionId).map(({ key, execution }) => ({ call: key.call, execution }))).toEqual([
      { call: 'call_MxHF39QIUjLqImvlqfhdfE2y', execution: { state: 'running' } },
    ])
  })

  test('the first Claude and Codex sessions of a profile without runtime roots are taken within seconds of their files while the roots scan waits a minute', async ({
    expect,
    onTestFinished,
  }) => {
    const { home, workspace } = await watchedHome(onTestFinished, { collector: {} })
    const session = 'q4-6-first-session'
    const rollout = join(home.root, '.codex', 'sessions', '2026', '10', '08', 'rollout-q4-6.jsonl')
    const taken = (channel: string): number => storedCount(home, 'SELECT count(*) AS count FROM raw_records WHERE channel = ?', channel)
    const lagUntilTaken = async (channel: string, write: () => Promise<unknown>): Promise<number> => {
      const writtenAt = performance.now()
      await write()
      await waitUntil(() => taken(channel) > 0)
      return performance.now() - writtenAt
    }
    const daemon = await spawnDaemon(home, onTestFinished)

    const transcriptLagMs = await lagUntilTaken('transcript', () =>
      claudeTranscript(home, '-work', session, transcriptLines(session, workspace, 22)),
    )
    const rolloutLagMs = await lagUntilTaken('rollout', async () => {
      await mkdir(dirname(rollout), { recursive: true })
      await writeFile(rollout, `${rolloutLines(workspace).join('\n')}\n`)
    })
    expect(await daemon.shutdown()).toBe(0)

    expect(transcriptLagMs).toBeLessThanOrEqual(5_000)
    expect(rolloutLagMs).toBeLessThanOrEqual(5_000)
    const store = openFinished(home, onTestFinished)
    expect(store.observations.getSession(objectId(claudeSession(session)))).toMatchObject({ cwd: workspace })
    expect(store.observations.getSession(objectId({ kind: 'session', runtime: 'codex', session: rolloutThread }))).toMatchObject({
      cwd: workspace,
    })
  })

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
    await writeFile(
      join(home.paths.home, 'config.json'),
      JSON.stringify({ api: { port: 0 }, otel: { port: 0 }, cli: missingCli(home.root) }),
    )
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
