import { appendFile, mkdir, rename, utimes, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { RunId, Runtime } from '@aang/contract'
import { objectId, runId } from '@aang/contract/ids'
import { openStore, type Store } from '@aang/store'
import { describe, test } from 'vitest'
import { type Home, missingCli, spawnDaemon } from './daemon.js'
import {
  admin,
  claudeHook,
  claudeSession,
  claudeStream,
  claudeTranscript,
  enqueue,
  openFinished,
  queued,
  rawRecords,
  rolloutLines,
  rolloutThread,
  sleep,
  spoolFilesOf,
  stored,
  storedCount,
  transcriptLines,
  waitUntil,
  watchedHome,
} from './sessions.js'

const streamRecords = 'SELECT count(*) AS count FROM raw_records WHERE stream = ?'

const runSessions = "SELECT count(*) AS count FROM objects WHERE kind = 'session' AND run_id = ?"

const changedGaps = "SELECT count(*) AS count FROM gaps WHERE kind = 'stream_changed_after_prune' AND closed_at IS NULL"

const runOf = (home: Home, runtime: Runtime, session: string): RunId => {
  const store = openStore({ home: home.paths.home })
  try {
    const run = store.observations.getSession(objectId({ kind: 'session', runtime, session }))?.run ?? null
    if (run === null) {
      throw new Error(`the ${runtime} session ${session} has no run`)
    }
    return run
  } finally {
    store.close()
  }
}

const startPruned = (store: Store, run: RunId): boolean | null => {
  const entity = store.model.entity(run, { kind: 'run', id: run })
  return entity?.kind === 'run' ? entity.value.start_pruned : null
}

const linesOf = (store: Store): (number | null)[] =>
  rawRecords(store).map(({ position }) => (position.kind === 'line' ? position.line : null))

const appendLines = (path: string, lines: readonly string[]): Promise<void> => appendFile(path, `${lines.join('\n')}\n`)

const renumbered = (line: string, ordinal: number): string =>
  JSON.stringify({ ...(JSON.parse(line) as Record<string, unknown>), ordinal, timestamp: `2026-10-01T12:30:${String(ordinal).padStart(2, '0')}.000Z` })

describe.concurrent('aang prune deletes runs and keeps the deleted history from coming back', () => {
  test(
    'prune, a Claude relocation and a restart: the pruned lines do not return, and the continuation forms the run again marked start pruned',
    { timeout: 60_000 },
    async ({ expect, onTestFinished }) => {
      const { home, workspace } = await watchedHome(onTestFinished)
      const session = 'g10-relocated'
      const stream = claudeStream(session)
      const lines = transcriptLines(session, workspace, 32)
      const path = await claudeTranscript(home, '-work', session, lines.slice(0, 22))
      const first = await spawnDaemon(home, onTestFinished)
      await waitUntil(() => storedCount(home, streamRecords, stream) === 22)
      expect(await first.shutdown()).toBe(0)
      const run = runOf(home, 'claude', session)

      const second = await spawnDaemon(home, onTestFinished)
      const pruned = await admin(home, second.base, 'prune', { scope: 'run', run })
      const left = storedCount(home, streamRecords, stream)
      const freelist = stored(home, (database) => database.prepare('PRAGMA freelist_count').get(), null)
      expect(await second.shutdown()).toBe(0)
      const moved = join(home.root, '.claude', 'projects', '-moved', `${session}.jsonl`)
      await mkdir(dirname(moved), { recursive: true })
      await rename(path, moved)
      await appendFile(moved, `${lines.slice(22).join('\n')}\n`)
      const third = await spawnDaemon(home, onTestFinished)
      await waitUntil(() => storedCount(home, streamRecords, stream) === 10)
      await sleep(500)
      expect(await third.shutdown()).toBe(0)

      expect(pruned).toEqual({ status: 200, body: { runs: [run], streams: 1 } })
      expect(left).toBe(0)
      expect(freelist).toEqual({ freelist_count: 0 })
      const store = openFinished(home, onTestFinished)
      expect(rawRecords(store).map(({ position }) => (position.kind === 'line' ? position.line : null))).toEqual([23, 24, 25, 26, 27, 28, 29, 30, 31, 32])
      expect(startPruned(store, run)).toBe(true)
      expect(store.pruned.ofStream(stream)).toMatchObject({ runtime: 'claude', session })
      expect(store.gaps.open('stream_changed_after_prune')).toEqual([])
    },
  )

  test(
    'prune, codex archive and a restart: the pruned rollout does not return, and the continuation forms the run again marked start pruned',
    { timeout: 60_000 },
    async ({ expect, onTestFinished }) => {
      const { home, workspace } = await watchedHome(onTestFinished)
      const lines = rolloutLines(workspace)
      const active = join(home.root, '.codex', 'sessions', '2026', '10', '01', 'rollout-g10.jsonl')
      const archived = join(home.root, '.codex', 'archived_sessions', 'rollout-g10.jsonl')
      const rollout = "SELECT count(*) AS count FROM raw_records WHERE channel = 'rollout'"
      await mkdir(dirname(active), { recursive: true })
      await writeFile(active, `${lines.join('\n')}\n`)
      const first = await spawnDaemon(home, onTestFinished)
      await waitUntil(() => storedCount(home, rollout) === lines.length)
      expect(await first.shutdown()).toBe(0)
      const run = runOf(home, 'codex', rolloutThread)

      const second = await spawnDaemon(home, onTestFinished)
      const pruned = await admin(home, second.base, 'prune', { scope: 'run', run })
      expect(await second.shutdown()).toBe(0)
      await mkdir(dirname(archived), { recursive: true })
      await rename(active, archived)
      const continued = lines.slice(-2).map((line, index) => renumbered(line, lines.length + index))
      await appendFile(archived, `${continued.join('\n')}\n`)
      const third = await spawnDaemon(home, onTestFinished)
      await waitUntil(() => storedCount(home, rollout) === 2)
      await sleep(500)
      expect(await third.shutdown()).toBe(0)

      expect(pruned).toEqual({ status: 200, body: { runs: [run], streams: 1 } })
      const store = openFinished(home, onTestFinished)
      expect(rawRecords(store).map(({ payload }) => payload)).toEqual(continued)
      expect(startPruned(store, run)).toBe(true)
    },
  )

  test.for([
    { change: 'shrunk', lines: (all: readonly string[]) => all.slice(0, 10) },
    {
      change: 'replaced',
      lines: (all: readonly string[]) => [all[1] ?? '', all[0] ?? '', ...all.slice(2)],
    },
  ])(
    'prune, then the Claude file with the same session is $change: the stream stops with a gap instead of dropping records silently',
    { timeout: 60_000 },
    async ({ lines: changed }, { expect, onTestFinished }) => {
      const { home, workspace } = await watchedHome(onTestFinished)
      const session = 'g10-changed'
      const stream = claudeStream(session)
      const lines = transcriptLines(session, workspace, 24)
      const path = await claudeTranscript(home, '-work', session, lines.slice(0, 22))
      const first = await spawnDaemon(home, onTestFinished)
      await waitUntil(() => storedCount(home, streamRecords, stream) === 22)
      expect(await first.shutdown()).toBe(0)
      const run = runOf(home, 'claude', session)

      const daemon = await spawnDaemon(home, onTestFinished)
      expect(await admin(home, daemon.base, 'prune', { scope: 'run', run })).toMatchObject({ status: 200 })
      const replacement = changed(lines)
      if (replacement.length < 22) {
        await writeFile(path, `${replacement.join('\n')}\n`)
      } else {
        await claudeTranscript(home, '-work', session, replacement)
      }
      await waitUntil(() => storedCount(home, changedGaps) === 1)
      await sleep(500)
      expect(await daemon.shutdown()).toBe(0)

      const store = openFinished(home, onTestFinished)
      expect(rawRecords(store)).toEqual([])
      expect(store.gaps.open('stream_changed_after_prune')).toMatchObject([{ stream, closed_at: null }])
      expect(store.observations.getSession(objectId(claudeSession(session)))).toBeNull()
    },
  )

  test.for([
    { change: 'shrunk', lines: (all: readonly string[]) => all.slice(0, 10) },
    {
      change: 'replaced',
      lines: (all: readonly string[]) => [all[1] ?? '', all[0] ?? '', ...all.slice(2)],
    },
  ])(
    'after the Claude file with the same session is $change, pruning the run again takes the whole changed stream after a restart and drops the gap',
    { timeout: 60_000 },
    async ({ lines: changed }, { expect, onTestFinished }) => {
      const { home, workspace } = await watchedHome(onTestFinished)
      const session = 'g10-taken-again'
      const stream = claudeStream(session)
      const lines = transcriptLines(session, workspace, 24)
      const path = await claudeTranscript(home, '-work', session, lines.slice(0, 22))
      const run = runId(claudeSession(session))
      const daemon = await spawnDaemon(home, onTestFinished)
      await waitUntil(() => storedCount(home, streamRecords, stream) === 22)
      const first = await admin(home, daemon.base, 'prune', { scope: 'run', run })
      const replacement = changed(lines)
      if (replacement.length < 22) {
        await writeFile(path, `${replacement.join('\n')}\n`)
      } else {
        await claudeTranscript(home, '-work', session, replacement)
      }
      await waitUntil(() => storedCount(home, changedGaps) === 1)
      expect(await daemon.shutdown()).toBe(0)

      const restarted = await spawnDaemon(home, onTestFinished)
      const again = await admin(home, restarted.base, 'prune', { scope: 'run', run })
      await waitUntil(() => storedCount(home, streamRecords, stream) === replacement.length)
      await sleep(500)
      expect(await restarted.shutdown()).toBe(0)

      expect(first).toEqual({ status: 200, body: { runs: [run], streams: 1 } })
      expect(again).toEqual({ status: 200, body: { runs: [run], streams: 1 } })
      const store = openFinished(home, onTestFinished)
      expect(rawRecords(store).map(({ payload }) => payload)).toEqual(replacement)
      expect(store.gaps.open('stream_changed_after_prune')).toEqual([])
      expect(store.pruned.ofStream(stream)).toMatchObject({ offset: 0 })
      expect(startPruned(store, run)).toBe(true)
    },
  )

  test(
    'watch, unwatch, prune and watch again: the pruned lines, including those without facts, do not return, and later lines are taken in place and after a relocation and a restart',
    { timeout: 60_000 },
    async ({ expect, onTestFinished }) => {
      const { home, workspace } = await watchedHome(onTestFinished)
      const session = 'g10-unwatched'
      const stream = claudeStream(session)
      const lines = transcriptLines(session, workspace, 32)
      const path = await claudeTranscript(home, '-work', session, lines.slice(0, 22))
      const run = runId(claudeSession(session))
      const daemon = await spawnDaemon(home, onTestFinished)
      await waitUntil(() => storedCount(home, streamRecords, stream) === 22)
      const unwatched = await admin(home, daemon.base, 'unwatch', { scope: 'path', path: workspace })
      const pruned = await admin(home, daemon.base, 'prune', { scope: 'run', run })
      const left = storedCount(home, 'SELECT count(*) AS count FROM raw_records')
      const watched = await admin(home, daemon.base, 'watch', { scope: 'path', path: workspace, lookback_days: null })
      await sleep(500)
      const reread = storedCount(home, 'SELECT count(*) AS count FROM raw_records')
      await appendLines(path, lines.slice(22, 27))
      await waitUntil(() => storedCount(home, streamRecords, stream) === 5)
      expect(await daemon.shutdown()).toBe(0)
      const moved = join(home.root, '.claude', 'projects', '-moved', `${session}.jsonl`)
      await mkdir(dirname(moved), { recursive: true })
      await rename(path, moved)
      await appendLines(moved, lines.slice(27))
      const restarted = await spawnDaemon(home, onTestFinished)
      await waitUntil(() => storedCount(home, streamRecords, stream) === 10)
      await sleep(500)
      expect(await restarted.shutdown()).toBe(0)

      expect(unwatched).toMatchObject({ status: 200 })
      expect(pruned).toEqual({ status: 200, body: { runs: [run], streams: 1 } })
      expect(watched).toMatchObject({ status: 200 })
      expect({ left, reread }).toEqual({ left: 0, reread: 0 })
      const store = openFinished(home, onTestFinished)
      expect(linesOf(store)).toEqual([23, 24, 25, 26, 27, 28, 29, 30, 31, 32])
      expect(startPruned(store, run)).toBe(true)
      expect(store.pruned.ofStream(stream)).toMatchObject({ runtime: 'claude', session })
      expect(store.gaps.open('stream_changed_after_prune')).toEqual([])
    },
  )

  test(
    'prune, then unwatch: lines appended to the excluded session are discarded, also after a restart',
    { timeout: 60_000 },
    async ({ expect, onTestFinished }) => {
      const { home, workspace } = await watchedHome(onTestFinished)
      const session = 'g10-excluded'
      const stream = claudeStream(session)
      const lines = transcriptLines(session, workspace, 32)
      const path = await claudeTranscript(home, '-work', session, lines.slice(0, 22))
      const run = runId(claudeSession(session))
      const cursorAt = 'SELECT count(*) AS count FROM cursors WHERE stream = ? AND line_number = CAST(? AS INTEGER)'
      const daemon = await spawnDaemon(home, onTestFinished)
      await waitUntil(() => storedCount(home, streamRecords, stream) === 22)
      const pruned = await admin(home, daemon.base, 'prune', { scope: 'run', run })
      const unwatched = await admin(home, daemon.base, 'unwatch', { scope: 'path', path: workspace })
      await appendLines(path, lines.slice(22, 27))
      await waitUntil(() => storedCount(home, cursorAt, stream, '27') === 1)
      await sleep(300)
      expect(await daemon.shutdown()).toBe(0)
      await appendLines(path, lines.slice(27))
      const restarted = await spawnDaemon(home, onTestFinished)
      await waitUntil(() => storedCount(home, cursorAt, stream, '32') === 1)
      await sleep(300)
      expect(await restarted.shutdown()).toBe(0)

      expect(pruned).toEqual({ status: 200, body: { runs: [run], streams: 1 } })
      expect(unwatched).toMatchObject({ status: 200 })
      const store = openFinished(home, onTestFinished)
      expect(rawRecords(store)).toEqual([])
      expect(store.scopes.ofSession(claudeSession(session))?.scope).toBe('external')
      expect(store.scopes.get(stream)?.scope).toBe('external')
      expect(store.observations.getSession(objectId(claudeSession(session)))).toBeNull()
    },
  )

  test(
    'prune while a relocated Claude file is being reread: the pruned lines do not come back, also after a restart',
    { timeout: 60_000 },
    async ({ expect, onTestFinished }) => {
      const { home, workspace } = await watchedHome(onTestFinished)
      const session = 'g10-racing'
      const stream = claudeStream(session)
      const path = await claudeTranscript(home, '-work', session, transcriptLines(session, workspace, 22))
      const run = runId(claudeSession(session))
      const daemon = await spawnDaemon(home, onTestFinished)
      await waitUntil(() => storedCount(home, streamRecords, stream) === 22)
      const moved = join(home.root, '.claude', 'projects', '-moved', `${session}.jsonl`)
      await mkdir(dirname(moved), { recursive: true })
      await rename(path, moved)
      const pruned = await admin(home, daemon.base, 'prune', { scope: 'run', run })
      await sleep(1_000)
      const after = storedCount(home, streamRecords, stream)
      expect(await daemon.shutdown()).toBe(0)
      const restarted = await spawnDaemon(home, onTestFinished)
      await sleep(1_000)
      expect(await restarted.shutdown()).toBe(0)

      expect(pruned).toEqual({ status: 200, body: { runs: [run], streams: 1 } })
      expect(after).toBe(0)
      const store = openFinished(home, onTestFinished)
      expect(rawRecords(store)).toEqual([])
      expect(store.observations.getSession(objectId(claudeSession(session)))).toBeNull()
    },
  )

  test(
    'spool files of a pruned session written before the prune are discarded, later ones form the run again',
    { timeout: 60_000 },
    async ({ expect, onTestFinished }) => {
      const { home, workspace } = await watchedHome(onTestFinished)
      const session = 'g10-spool'
      const stream = claudeStream(session)
      await claudeTranscript(home, '-work', session, transcriptLines(session, workspace, 22))
      const first = await spawnDaemon(home, onTestFinished)
      await waitUntil(() => storedCount(home, streamRecords, stream) === 22)
      expect(await first.shutdown()).toBe(0)
      const run = runOf(home, 'claude', session)

      const daemon = await spawnDaemon(home, onTestFinished)
      expect(await admin(home, daemon.base, 'prune', { scope: 'run', run })).toMatchObject({ status: 200 })
      const [before = ''] = await enqueue(
        home,
        'before',
        [claudeHook('UserPromptSubmit', session, workspace)],
        'claude',
        new Date(Date.now() - 3_600_000),
      )
      const [after = ''] = await enqueue(home, 'after', [claudeHook('UserPromptSubmit', session, workspace)])
      await waitUntil(async () => (await queued(home)).length === 0)
      await sleep(300)
      expect(await daemon.shutdown()).toBe(0)

      const store = openFinished(home, onTestFinished)
      expect(rawRecords(store).flatMap(({ position }) => (position.kind === 'spool' ? [position.file] : []))).toEqual([after])
      expect(before).not.toBe('')
      expect(store.observations.getSession(objectId(claudeSession(session)))).not.toBeNull()
      expect(startPruned(store, run)).toBe(true)
    },
  )

  test(
    'a Claude session known only from hooks: prune bounds its stream, an earlier hook delivered after a restart is discarded and a later one forms the run again marked start pruned',
    { timeout: 60_000 },
    async ({ expect, onTestFinished }) => {
      const { home, workspace } = await watchedHome(onTestFinished)
      const session = 'g10-hooks-only'
      const run = runId(claudeSession(session))
      const daemon = await spawnDaemon(home, onTestFinished)
      await enqueue(home, 'start', [claudeHook('SessionStart.startup', session, workspace)])
      await waitUntil(() => storedCount(home, runSessions, run) === 1)
      const pruned = await admin(home, daemon.base, 'prune', { scope: 'run', run })
      expect(await daemon.shutdown()).toBe(0)
      const [before = ''] = await enqueue(
        home,
        'before',
        [claudeHook('UserPromptSubmit', session, workspace)],
        'claude',
        new Date(Date.now() - 3_600_000),
      )
      const restarted = await spawnDaemon(home, onTestFinished)
      await waitUntil(async () => (await queued(home)).length === 0)
      await sleep(300)
      const between = storedCount(home, runSessions, run)
      const [after = ''] = await enqueue(home, 'after', [claudeHook('UserPromptSubmit', session, workspace)])
      await waitUntil(() => storedCount(home, runSessions, run) === 1)
      await sleep(300)
      expect(await restarted.shutdown()).toBe(0)

      expect(pruned).toEqual({ status: 200, body: { runs: [run], streams: 1 } })
      expect(before).not.toBe('')
      expect(between).toBe(0)
      const store = openFinished(home, onTestFinished)
      expect(spoolFilesOf(store)).toEqual([after])
      expect(store.pruned.ofSession(claudeSession(session))).toMatchObject([{ runtime: 'claude', stream: claudeStream(session), offset: 0 }])
      expect(startPruned(store, run)).toBe(true)
    },
  )

  test(
    'prune --before deletes the runs whose activity ended before the date and keeps later ones; an unknown run is not found',
    { timeout: 60_000 },
    async ({ expect, onTestFinished }) => {
      const workspace = 'work'
      const { home } = await watchedHome(onTestFinished)
      const root = join(home.root, workspace)
      await writeFile(
        join(home.paths.home, 'config.json'),
        JSON.stringify({
          api: { port: 0 },
          otel: { port: 0 },
          cli: missingCli(home.root),
          collector: { rootsScanIntervalMs: 200 },
          watch: { roots: [{ path: root }], lookbackDays: 3650 },
        }),
      )
      const old = 'g10-old'
      const recent = 'g10-recent'
      const oldPath = await claudeTranscript(
        home,
        '-work',
        old,
        transcriptLines(old, root, 22).map((line) => line.replaceAll('2026-10-01T', '2025-01-01T')),
      )
      const longAgo = new Date('2025-01-01T12:00:00Z')
      await utimes(oldPath, longAgo, longAgo)
      await claudeTranscript(home, '-work', recent, transcriptLines(recent, root, 22))
      const first = await spawnDaemon(home, onTestFinished)
      await waitUntil(() => storedCount(home, 'SELECT count(*) AS count FROM raw_records') === 44)
      expect(await first.shutdown()).toBe(0)
      const oldRun = runOf(home, 'claude', old)
      const recentRun = runOf(home, 'claude', recent)

      const daemon = await spawnDaemon(home, onTestFinished)
      const pruned = await admin(home, daemon.base, 'prune', { scope: 'before', before: '1748736000000000000' })
      const missing = await admin(home, daemon.base, 'prune', { scope: 'run', run: runId(claudeSession('g10-never-seen')) })
      expect(await daemon.shutdown()).toBe(0)

      expect(pruned).toEqual({ status: 200, body: { runs: [oldRun], streams: 1 } })
      expect(missing).toMatchObject({ status: 404, body: { error: { code: 'not_found' } } })
      const store = openFinished(home, onTestFinished)
      expect(store.observations.getSession(objectId(claudeSession(old)))).toBeNull()
      expect(store.observations.getSession(objectId(claudeSession(recent)))).toMatchObject({ run: recentRun })
      expect(new Set(rawRecords(store).map(({ stream }) => stream))).toEqual(new Set([claudeStream(recent)]))
    },
  )
})
