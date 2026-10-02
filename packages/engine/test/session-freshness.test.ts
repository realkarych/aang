import { expect, onTestFinished, test } from 'vitest'
import { objectId } from '@aang/contract/ids'
import { batchOf, joinBatches, jsonlFile } from './batches.js'
import { createHome } from './home.js'
import { streamOf } from './harness.js'
import { claudeTranscript, codexRollout } from './samples.js'
import { at, clockedEngine, hook, registry, sessionId, source } from './session-fixtures.js'

test.each(['claude', 'codex'] as const)('files without hooks expose inactive hooks and later become full: %s', async (runtime) => {
  const store = (await createHome(onTestFinished)).open()
  const { engine } = clockedEngine(store)
  const lines = runtime === 'claude' ? claudeTranscript(source).slice(0, 5) : codexRollout({ thread: source.session, cwd: source.cwd }).slice(0, 2)
  const file = jsonlFile({ runtime, path: '/session.jsonl', lines, ino: 1n })
  await engine.ingest(file.batch(1, lines.length))
  expect(store.observations.getSession(sessionId(runtime))).toMatchObject({
    support_mode: 'files_only', freshness: 'hooks_inactive',
  })
  const gapId = objectId({ kind: 'gap', gap: 'hooks_inactive', subject: sessionId(runtime) })
  expect(store.gaps.get(gapId)).toMatchObject({ session: sessionId(runtime), closed_at: null })
  await engine.ingest(hook('UserPromptSubmit', 100, { prompt: 'Continue' }, runtime))
  expect(store.observations.getSession(sessionId(runtime))).toMatchObject({ support_mode: 'full', freshness: 'ok' })
  expect(store.gaps.get(gapId)?.closed_at).not.toBeNull()
})

test('quiet changes only freshness at the threshold and survives restart without duplicate changes', async () => {
  const home = await createHome(onTestFinished)
  let store = home.open()
  const { engine, advance } = clockedEngine(store)
  await engine.ingest(joinBatches(hook('SessionStart', 0), hook('UserPromptSubmit', 1)))
  expect(store.observations.getSession(sessionId())?.support_mode).toBe('hooks_only')
  advance(300_000)
  await engine.refreshFreshness()
  expect(store.observations.getSession(sessionId())?.freshness).toBe('ok')
  advance(300_001)
  await engine.refreshFreshness()
  expect(store.observations.getSession(sessionId())).toMatchObject({ freshness: 'quiet', execution: { state: 'running' } })
  const head = store.changes.head()
  await engine.refreshFreshness()
  expect(store.changes.head()).toBe(head)
  store.close()
  store = home.open()
  const restarted = clockedEngine(store)
  restarted.advance(600_000)
  await restarted.engine.refreshFreshness()
  expect(store.changes.head()).toBe(head)
  await restarted.engine.ingest(hook('Stop', 600_001))
  expect(store.observations.getSession(sessionId())).toMatchObject({ freshness: 'ok', state: 'turn_done' })
  restarted.advance(1_200_000)
  await restarted.engine.refreshFreshness()
  expect(store.observations.getSession(sessionId())?.freshness).toBe('ok')
})

test('a running session turns quiet on a later empty batch after a restart', async () => {
  const home = await createHome(onTestFinished)
  let store = home.open()
  await clockedEngine(store).engine.ingest(joinBatches(hook('SessionStart', 0), hook('UserPromptSubmit', 1)))
  store.close()
  store = home.open()
  const { engine, advance } = clockedEngine(store)
  advance(300_000)
  await engine.ingest(batchOf({}))
  expect(store.observations.getSession(sessionId())?.freshness).toBe('ok')
  advance(300_001)
  await engine.ingest(batchOf({}))
  expect(store.observations.getSession(sessionId())).toMatchObject({ freshness: 'quiet', execution: { state: 'running' } })
})

test('a custom quiet interval does not change a known human wait', async () => {
  const store = (await createHome(onTestFinished)).open()
  const { engine, advance } = clockedEngine(store, 1000)
  await engine.ingest(joinBatches(hook('SessionStart', 0), hook('PermissionRequest', 1, {
    tool_name: 'Bash', tool_input: { command: 'pwd' },
  })))
  advance(1001)
  await engine.refreshFreshness()
  expect(store.observations.getSession(sessionId())).toMatchObject({
    freshness: 'quiet', execution: { state: 'waiting', reason: 'human' },
  })
})

test('a registry entry waits for session scope and does not claim transcript support', async () => {
  const home = await createHome(onTestFinished)
  let store = home.open()
  const { engine } = clockedEngine(store)
  await engine.ingest(registry('busy', 0))
  expect(store.observations.getSession(sessionId())).toBeNull()
  await engine.ingest(hook('SessionStart', -1))
  expect(store.observations.getSession(sessionId())).toMatchObject({ support_mode: 'hooks_only', freshness: 'ok', state: 'turn_running' })
  store.close()
  store = home.open()
  await clockedEngine(store).engine.ingest(hook('UserPromptSubmit', 1))
  expect(store.observations.getSession(sessionId())).toMatchObject({ support_mode: 'hooks_only', freshness: 'ok' })
})

test('source loss is independent of execution and hooks do not repair a lost file', async () => {
  const store = (await createHome(onTestFinished)).open()
  const { engine } = clockedEngine(store)
  const lines = claudeTranscript(source).slice(0, 5)
  const file = jsonlFile({ runtime: 'claude', path: '/lost.jsonl', lines, ino: 1n })
  await engine.ingest(joinBatches(file.batch(1, lines.length), hook('UserPromptSubmit', 100)))
  const before = store.observations.getSession(sessionId())
  const gap = {
    key: { kind: 'gap', gap: 'source_lost', subject: file.path },
    stream: streamOf('claude', lines), details: 'file missing', detected_at: at(200), closed_at: null,
  } as const
  await engine.ingest(batchOf({ gaps: [gap] }))
  expect(store.observations.getSession(sessionId())).toMatchObject({ freshness: 'lost', execution: before?.execution })
  await engine.ingest(hook('UserPromptSubmit', 300))
  expect(store.observations.getSession(sessionId())?.freshness).toBe('lost')
  await engine.ingest(batchOf({ gaps: [{ ...gap, closed_at: at(400) }] }))
  expect(store.observations.getSession(sessionId())?.freshness).toBe('ok')
})

test('unrecognised records count once, including records without facts, and survive restart', async () => {
  const home = await createHome(onTestFinished)
  let store = home.open()
  let engine = clockedEngine(store).engine
  const lines = [
    JSON.stringify({ type: 'future_record', sessionId: source.session, cwd: source.cwd }),
    JSON.stringify({ type: 'assistant', sessionId: source.session, uuid: 'broken', message: false }),
    '{bad json',
  ]
  const file = jsonlFile({ runtime: 'claude', path: '/future.jsonl', lines, ino: 2n })
  await engine.ingest(file.batch(1, 3))
  expect(store.observations.getSession(sessionId())).toMatchObject({
    unknown_records: 3, support_mode: 'files_only', freshness: 'hooks_inactive', state: 'unknown',
  })
  const head = store.changes.head()
  store.close()
  store = home.open()
  engine = clockedEngine(store).engine
  await engine.ingest(file.batch(1, 3))
  expect(store.changes.head()).toBe(head)
  await engine.ingest(hook('FutureHook', 10))
  expect(store.observations.getSession(sessionId())).toMatchObject({ unknown_records: 4, support_mode: 'full', freshness: 'ok' })
})

test.each(['separate', 'together'] as const)('source loss opens and closes for a session without facts across restart: %s', async (order) => {
  const home = await createHome(onTestFinished)
  let store = home.open()
  const { engine } = clockedEngine(store)
  const lines = [JSON.stringify({ type: 'future_record', sessionId: source.session, cwd: source.cwd })]
  const file = jsonlFile({ runtime: 'claude', path: '/unrecognised.jsonl', lines, ino: 3n })
  const gap = {
    key: { kind: 'gap', gap: 'source_lost', subject: file.path },
    stream: streamOf('claude', lines), details: 'file missing', detected_at: at(200), closed_at: null,
  } as const
  if (order === 'separate') {
    await engine.ingest(file.batch(1, 1))
    expect(store.observations.getSession(sessionId())).toMatchObject({ unknown_records: 1, state: 'unknown', freshness: 'hooks_inactive' })
    await engine.ingest(batchOf({ gaps: [gap] }))
  } else {
    await engine.ingest(joinBatches(file.batch(1, 1), batchOf({ gaps: [gap] })))
  }
  expect(store.observations.getSession(sessionId())).toMatchObject({ unknown_records: 1, freshness: 'lost' })
  store.close()
  store = home.open()
  const restarted = clockedEngine(store).engine
  await restarted.ingest(batchOf({ gaps: [{ ...gap, closed_at: at(400) }] }))
  expect(store.observations.getSession(sessionId())).toMatchObject({ unknown_records: 1, freshness: 'hooks_inactive' })
  await restarted.ingest(batchOf({ gaps: [{ ...gap, key: { ...gap.key, subject: '/reopened.jsonl' } }] }))
  expect(store.observations.getSession(sessionId())?.freshness).toBe('lost')
})

const percentile95 = (samples: readonly number[]): number =>
  samples.toSorted((left, right) => left - right)[Math.ceil(samples.length * 0.95) - 1] ?? Infinity

test('freshness work does not grow with finished sessions and their gaps', { tags: ['benchmark'], timeout: 600_000 }, async () => {
  const store = (await createHome(onTestFinished)).open()
  const history = 5000
  store.transaction((transaction) => {
    for (let index = 0; index < history; index += 1) {
      const key = { kind: 'session', runtime: 'claude', session: `history-${String(index)}` } as const
      const id = objectId(key)
      transaction.observations.save({
        id, key, run: null, surface: null, version: null, cwd: source.cwd, git_branch: null, git_common_dir: null,
        launches: [], state: 'ended', execution: { state: 'done' }, freshness: 'ok', support_mode: 'full',
        double_registration: false, unknown_records: 0, cost_state: null, started_at: at(0), last_event_at: at(1),
      })
      transaction.gaps.save({
        key: { kind: 'gap', gap: 'hooks_inactive', subject: id }, session: id, run: null, stream: null,
        details: 'Session files are available without hook events', detected_at: at(0), closed_at: at(1),
      })
    }
  })
  const { engine } = clockedEngine(store)
  await engine.ingest(joinBatches(hook('SessionStart', 0), hook('UserPromptSubmit', 1)))
  const elapsed = async (work: () => Promise<unknown>): Promise<number> => {
    const started = performance.now()
    await work()
    return performance.now() - started
  }
  const empty: number[] = []
  const refresh: number[] = []
  const live: number[] = []
  for (let index = 0; index < 50; index += 1) {
    empty.push(await elapsed(() => engine.ingest(batchOf({}))))
    refresh.push(await elapsed(() => engine.refreshFreshness()))
    live.push(await elapsed(() => engine.ingest(hook('PreToolUse', 10 + index, {
      tool_use_id: `call-${String(index)}`, tool_name: 'Bash', tool_input: { command: 'pwd' },
    }))))
  }
  expect(store.observations.sessions()).toHaveLength(history + 1)
  expect(percentile95(empty)).toBeLessThanOrEqual(2)
  expect(percentile95(refresh)).toBeLessThanOrEqual(2)
  expect(percentile95(live)).toBeLessThanOrEqual(20)
})
