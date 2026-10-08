import { expect, onTestFinished, test } from 'vitest'
import { EpochNs, type GapId, type JsonValue, type Runtime } from '@aang/contract'
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

const iso = (milliseconds: number): string => new Date(Number(at(milliseconds) / 1_000_000n)).toISOString()

const lineAt = (milliseconds: number): EpochNs => EpochNs.parse(BigInt(Date.parse(iso(milliseconds))) * 1_000_000n)

const claudeLine = (record: Record<string, JsonValue>): string =>
  JSON.stringify({ sessionId: source.session, cwd: source.cwd, ...record })

const claudeTurn = (turn: string, milliseconds: number, content = `Turn ${turn}`): string[] => [
  claudeLine({
    type: 'user', uuid: `${turn}-prompt`, promptId: turn, timestamp: iso(milliseconds), promptSource: 'typed',
    message: { role: 'user', content },
  }),
  claudeLine({
    type: 'assistant', uuid: `${turn}-reply`, timestamp: iso(milliseconds + 10),
    message: { id: `${turn}-message`, role: 'assistant', content: [{ type: 'text', text: 'Done' }], stop_reason: 'end_turn' },
  }),
]

const retimed = (lines: readonly string[], milliseconds: number): string[] =>
  lines.map((line) => {
    const record = JSON.parse(line) as Record<string, JsonValue>
    const payload = record['payload']
    const millis = Date.parse(iso(milliseconds))
    const timing = typeof payload === 'object' && payload !== null && !Array.isArray(payload) && 'started_at_ms' in payload
      ? { payload: { ...payload, started_at_ms: millis, completed_at_ms: millis } }
      : {}
    return JSON.stringify({ ...record, timestamp: iso(milliseconds), ...timing })
  })

const codexTurns = codexRollout({ thread: source.session, cwd: source.cwd })

const turnScript = (runtime: Runtime, second = 1_000) => runtime === 'claude'
  ? { field: 'prompt_id', turn: 'first', next: 'second', first: claudeTurn('first', 10), second: claudeTurn('second', second) }
  : {
    field: 'turn_id',
    turn: '01a0f752-4102-7740-9432-0533263c2dc1',
    next: '01a0f755-c3a7-75a1-acf1-7d0839bc2d5c',
    first: retimed(codexTurns.slice(0, 20), 10),
    second: retimed(codexTurns.slice(20), second),
  }

const silenceGap = (runtime: Runtime, from: EpochNs): GapId =>
  objectId({ kind: 'gap', gap: 'hooks_inactive', subject: `${sessionId(runtime)}/${String(from)}` })

test.each(['claude', 'codex'] as const)('a turn in the files without hook events after active hooks makes the session files-only until the next hook event: %s', async (runtime) => {
  const store = (await createHome(onTestFinished)).open()
  const { engine, advance } = clockedEngine(store)
  const script = turnScript(runtime)
  const file = jsonlFile({ runtime, path: '/silence.jsonl', lines: [...script.first, ...script.second], ino: 1n })
  await engine.ingest(joinBatches(
    hook('SessionStart', 0, {}, runtime),
    hook('UserPromptSubmit', 11, { prompt: 'First', [script.field]: script.turn }, runtime),
    file.batch(1, script.first.length),
  ))
  expect(store.observations.getSession(sessionId(runtime))).toMatchObject({ support_mode: 'full', freshness: 'ok' })
  advance(1_100)
  await engine.ingest(file.batch(script.first.length + 1, file.lines.length))
  advance(30_999)
  await engine.refreshFreshness()
  expect(store.observations.getSession(sessionId(runtime))?.support_mode).toBe('full')
  expect(store.gaps.open('hooks_inactive')).toEqual([])
  advance(31_000)
  await engine.refreshFreshness()
  expect(store.observations.getSession(sessionId(runtime))).toMatchObject({
    support_mode: 'files_only', freshness: 'hooks_inactive',
  })
  const gap = silenceGap(runtime, lineAt(1_000))
  expect(store.gaps.open('hooks_inactive')).toEqual([expect.objectContaining({
    id: gap, session: sessionId(runtime), detected_at: lineAt(1_000), closed_at: null,
  })])
  const head = store.changes.head()
  await engine.refreshFreshness()
  expect(store.changes.head()).toBe(head)
  advance(40_000)
  await engine.ingest(hook('UserPromptSubmit', 40_000, { prompt: 'Third', [script.field]: 'third' }, runtime))
  expect(store.observations.getSession(sessionId(runtime))).toMatchObject({ support_mode: 'full', freshness: 'ok' })
  expect(store.gaps.get(gap)).toMatchObject({ detected_at: lineAt(1_000), closed_at: at(40_000) })
  expect(store.gaps.get(objectId({ kind: 'gap', gap: 'hooks_inactive', subject: sessionId(runtime) }))).toBeNull()
})

test.each([
  ['claude', 'live'],
  ['claude', 'together'],
  ['codex', 'live'],
  ['codex', 'together'],
] as const)('a hook of the silent turn itself after the threshold closes its gap with its own time: %s %s', async (runtime, order) => {
  const store = (await createHome(onTestFinished)).open()
  const { engine, advance } = clockedEngine(store)
  const script = turnScript(runtime)
  const file = jsonlFile({ runtime, path: '/late.jsonl', lines: [...script.first, ...script.second], ino: 1n })
  const opening = joinBatches(
    hook('SessionStart', 0, {}, runtime),
    hook('UserPromptSubmit', 11, { prompt: 'First', [script.field]: script.turn }, runtime),
    file.batch(1, file.lines.length),
  )
  const stop = hook('Stop', 40_000, { [script.field]: script.next }, runtime)
  const gap = silenceGap(runtime, lineAt(1_000))
  if (order === 'live') {
    advance(1_100)
    await engine.ingest(opening)
    advance(31_000)
    await engine.refreshFreshness()
    expect(store.gaps.open('hooks_inactive')).toEqual([expect.objectContaining({ id: gap, closed_at: null })])
    advance(40_100)
    await engine.ingest(stop)
  } else {
    advance(40_100)
    await engine.ingest(joinBatches(opening, stop))
  }
  expect(store.observations.getSession(sessionId(runtime))).toMatchObject({ support_mode: 'full', freshness: 'ok' })
  expect(store.gaps.open('hooks_inactive')).toEqual([])
  expect(store.gaps.get(gap)).toMatchObject({ detected_at: lineAt(1_000), closed_at: at(40_000) })
})

test.each(['claude', 'codex'] as const)('a late hook of the silent turn next to a newer file turn closes the gap with the hook time: %s', async (runtime) => {
  const store = (await createHome(onTestFinished)).open()
  const { engine, advance } = clockedEngine(store)
  const script = turnScript(runtime, 50_000)
  const file = jsonlFile({ runtime, path: '/newer.jsonl', lines: [...script.first, ...script.second], ino: 1n })
  advance(100)
  await engine.ingest(joinBatches(hook('SessionStart', 0, {}, runtime), file.batch(1, script.first.length)))
  advance(31_000)
  await engine.refreshFreshness()
  const silent = silenceGap(runtime, lineAt(10))
  expect(store.gaps.open('hooks_inactive')).toEqual([expect.objectContaining({ id: silent, closed_at: null })])
  advance(50_100)
  await engine.ingest(joinBatches(
    hook('Stop', 40_000, { [script.field]: script.turn }, runtime),
    file.batch(script.first.length + 1, file.lines.length),
  ))
  expect(store.observations.getSession(sessionId(runtime))?.support_mode).toBe('full')
  expect(store.gaps.get(silent)).toMatchObject({ detected_at: lineAt(10), closed_at: at(40_000) })
  advance(80_000)
  await engine.refreshFreshness()
  expect(store.observations.getSession(sessionId(runtime))?.support_mode).toBe('files_only')
  expect(store.gaps.open('hooks_inactive')).toEqual([
    expect.objectContaining({ id: silenceGap(runtime, lineAt(50_000)), closed_at: null }),
  ])
})

test('a hook delivered after the deadline with an earlier time closes the open gap with its own time', async () => {
  const store = (await createHome(onTestFinished)).open()
  const { engine, advance } = clockedEngine(store)
  const file = jsonlFile({
    runtime: 'claude', path: '/delayed.jsonl', ino: 1n,
    lines: [...claudeTurn('first', 10), ...claudeTurn('second', 1_000), ...claudeTurn('third', 50_000)],
  })
  advance(1_100)
  await engine.ingest(joinBatches(
    hook('SessionStart', 0),
    hook('UserPromptSubmit', 11, { prompt: 'First', prompt_id: 'first' }),
    file.batch(1, 4),
  ))
  advance(31_000)
  await engine.refreshFreshness()
  const gap = silenceGap('claude', lineAt(1_000))
  expect(store.gaps.open('hooks_inactive')).toEqual([expect.objectContaining({ id: gap, closed_at: null })])
  advance(50_100)
  await engine.ingest(joinBatches(hook('Stop', 20_000, { prompt_id: 'second' }), file.batch(5, 6)))
  expect(store.observations.getSession(sessionId())?.support_mode).toBe('full')
  expect(store.gaps.get(gap)).toMatchObject({ detected_at: lineAt(1_000), closed_at: at(20_000) })
})

test('hooks of a turn count by its id before the file prompt, a command opens no turn and a short silence leaves no gap', async () => {
  const store = (await createHome(onTestFinished)).open()
  const { engine, advance } = clockedEngine(store)
  const command = claudeLine({
    type: 'user', uuid: 'command-prompt', timestamp: iso(2_000),
    message: { role: 'user', content: '<command-name>/model</command-name>' },
  })
  const file = jsonlFile({
    runtime: 'claude', path: '/turns.jsonl', ino: 1n,
    lines: [...claudeTurn('first', 10), ...claudeTurn('second', 1_000), command, ...claudeTurn('fourth', 50_000)],
  })
  await engine.ingest(joinBatches(
    hook('SessionStart', 0),
    hook('UserPromptSubmit', 11, { prompt: 'First', prompt_id: 'first' }),
    file.batch(1, 2),
  ))
  advance(1_100)
  await engine.ingest(joinBatches(hook('UserPromptSubmit', 990, { prompt: 'Second', prompt_id: 'second' }), file.batch(3, 4)))
  advance(2_100)
  await engine.ingest(file.batch(5, 5))
  advance(45_000)
  await engine.refreshFreshness()
  expect(store.observations.getSession(sessionId())).toMatchObject({ support_mode: 'full', freshness: 'ok' })
  advance(50_100)
  await engine.ingest(file.batch(6, 7))
  advance(55_000)
  await engine.ingest(hook('UserPromptSubmit', 55_000, { prompt: 'Fifth', prompt_id: 'fifth' }))
  advance(200_000)
  await engine.refreshFreshness()
  expect(store.observations.getSession(sessionId())?.support_mode).toBe('full')
  expect(store.gaps.open('hooks_inactive')).toEqual([])
  expect(store.gaps.get(silenceGap('claude', lineAt(50_000)))).toBeNull()
})

test('turns without hook events in a row make one gap that a restart before its deadline and a reparse keep', async () => {
  const home = await createHome(onTestFinished)
  let store = home.open()
  const first = clockedEngine(store)
  const file = jsonlFile({
    runtime: 'claude', path: '/restart.jsonl', ino: 1n,
    lines: [...claudeTurn('first', 10), ...claudeTurn('second', 1_000), ...claudeTurn('third', 2_000)],
  })
  await first.engine.ingest(joinBatches(
    hook('SessionStart', 0),
    hook('UserPromptSubmit', 11, { prompt: 'First', prompt_id: 'first' }),
    file.batch(1, 2),
  ))
  first.advance(2_100)
  await first.engine.ingest(file.batch(3, 6))
  await first.engine.close()
  store.close()
  store = home.open()
  const { engine, advance } = clockedEngine(store)
  await engine.refreshFreshness()
  expect(store.observations.getSession(sessionId())?.support_mode).toBe('full')
  advance(31_000)
  await engine.refreshFreshness()
  expect(store.observations.getSession(sessionId())).toMatchObject({ support_mode: 'files_only', freshness: 'hooks_inactive' })
  const silent = [expect.objectContaining({ id: silenceGap('claude', lineAt(1_000)), closed_at: null })]
  expect(store.gaps.open('hooks_inactive')).toEqual(silent)
  await engine.reparse()
  expect(store.observations.getSession(sessionId())?.support_mode).toBe('files_only')
  expect(store.gaps.open('hooks_inactive')).toEqual(silent)
  advance(40_000)
  await engine.ingest(hook('Stop', 40_000))
  expect(store.observations.getSession(sessionId())?.support_mode).toBe('full')
  expect(store.gaps.get(silenceGap('claude', lineAt(1_000)))?.closed_at).toBe(at(40_000))
})

test('a finished turn waiting for hooks at shutdown opens its gap after a restart with a shorter threshold and a later session', async () => {
  const home = await createHome(onTestFinished)
  let store = home.open()
  const first = clockedEngine(store)
  const file = jsonlFile({
    runtime: 'claude', path: '/shorter.jsonl', ino: 1n, lines: [...claudeTurn('first', 10), ...claudeTurn('second', 1_000)],
  })
  await first.engine.ingest(joinBatches(
    hook('SessionStart', 0),
    hook('UserPromptSubmit', 11, { prompt: 'First', prompt_id: 'first' }),
    file.batch(1, 2),
  ))
  first.advance(1_100)
  await first.engine.ingest(file.batch(3, 4))
  first.advance(20_100)
  await first.engine.ingest(joinBatches(hook('SessionStart', 20_000, {}, 'codex'), hook('UserPromptSubmit', 20_010, { prompt: 'Other' }, 'codex')))
  first.advance(25_000)
  await first.engine.refreshFreshness()
  expect(store.observations.getSession(sessionId())).toMatchObject({ support_mode: 'full', state: 'turn_done' })
  await first.engine.close()
  store.close()
  store = home.open()
  const { engine, advance } = clockedEngine(store, 300_000, 1_000)
  advance(26_000)
  await engine.refreshFreshness()
  expect(store.observations.getSession(sessionId())).toMatchObject({ support_mode: 'files_only', freshness: 'hooks_inactive' })
  expect(store.observations.getSession(sessionId('codex'))?.support_mode).toBe('hooks_only')
  expect(store.gaps.open('hooks_inactive')).toEqual([
    expect.objectContaining({ id: silenceGap('claude', lineAt(1_000)), closed_at: null }),
  ])
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
