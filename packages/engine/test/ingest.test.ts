import { type CollectedGap, EpochNs } from '@aang/contract'
import { createEngine } from '@aang/engine'
import { describe, expect, test } from 'vitest'
import { batchOf, hookBatch, joinBatches, jsonlFile } from './batches.js'
import {
  adapters,
  countsOf,
  draftFacts,
  expectedOf,
  gapsOf,
  noObservationRows,
  observationRows,
  recordsOf,
  sessionKey,
  settledOf,
  startEngine,
  storedFacts,
  streamOf,
} from './harness.js'
import { createHome } from './home.js'
import {
  claudeHook,
  claudeHookEnv,
  claudeHookWithoutCwd,
  claudeSubagentTranscript,
  claudeTranscript,
  codexHook,
  codexRollout,
} from './samples.js'
import { createWorkspace } from './workspace.js'

const claudePath = '/home/u/.claude/projects/-work-watched/s-main.jsonl'
const codexPath = '/home/u/.codex/sessions/2026/10/01/rollout-2026-10-01T14-55-58-t-main.jsonl'

describe('a batch of a watched session', () => {
  test('commits raw records, facts, the scope decision and the cursor together', async ({ onTestFinished }) => {
    const workspace = await createWorkspace(onTestFinished)
    const home = await createHome(onTestFinished)
    const store = home.open()
    const engine = startEngine(store, { roots: [workspace.repository] })
    const lines = claudeTranscript({ session: 's-main', cwd: workspace.repository })
    const file = jsonlFile({ runtime: 'claude', path: claudePath, lines, ino: 10n })
    const stream = streamOf('claude', lines)
    const expected = expectedOf(file.batch(1, lines.length, stream).records)
    const batch = file.batch(1, lines.length)

    const result = await engine.ingest(batch)

    expect(recordsOf(store).map((record) => [record.dedupe_key, record.stream, record.parse_state])).toEqual(
      expected.map(({ key, parse }) => [key, stream, parse.parse_state]),
    )
    expect(storedFacts(store)).toEqual(draftFacts(expected))
    expect(store.scopes.get(stream)).toEqual({ stream, runtime: 'claude', scope: 'watched' })
    expect(store.scopes.ofSession(sessionKey('claude', 's-main'))).toEqual({
      session: sessionKey('claude', 's-main'),
      scope: 'watched',
    })
    expect(store.cursors.list()).toEqual([file.cursor(lines.length, stream)])
    expect(countsOf(result)).toEqual({ inserted: lines.length, duplicates: 0, discarded: 0, waiting: 0, deferred: 0 })
    expect(settledOf(result, [batch])).toEqual([0])
    expect(result.rescan).toEqual([])
    expect(result.head).toBe(store.changes.head())
    expect(store.changes.head()).toBe(lines.length + draftFacts(expected).length)
  })

  test('of Codex resolves the thread stream from session_meta and keeps the last ordinal', async ({
    onTestFinished,
  }) => {
    const workspace = await createWorkspace(onTestFinished)
    const home = await createHome(onTestFinished)
    const store = home.open()
    const engine = startEngine(store, { roots: [workspace.repository] })
    const lines = codexRollout({ thread: 't-main', cwd: workspace.nested })
    const file = jsonlFile({ runtime: 'codex', path: codexPath, lines, ino: 20n })
    const stream = streamOf('codex', lines)
    const expected = expectedOf(file.batch(1, lines.length, stream).records)

    await engine.ingest(file.batch(1, lines.length))

    expect(recordsOf(store).map((record) => [record.dedupe_key, record.stream, record.parse_state])).toEqual(
      expected.map(({ key, parse }) => [key, stream, parse.parse_state]),
    )
    expect(storedFacts(store)).toEqual(draftFacts(expected))
    expect(store.scopes.ofSession(sessionKey('codex', 't-main'))?.scope).toBe('watched')
    expect(store.cursors.list()).toEqual([file.cursor(lines.length, stream)])
    expect(store.cursors.list()[0]?.last_ordinal).toBe(lines.length - 1)
  })

  test('keeps unknown and invalid lines of the stream as raw records without facts', async ({ onTestFinished }) => {
    const workspace = await createWorkspace(onTestFinished)
    const home = await createHome(onTestFinished)
    const store = home.open()
    const transcript = claudeTranscript({ session: 's-main', cwd: workspace.repository })
    const lines = [
      ...transcript.slice(0, 5),
      '[]',
      '{"type":"future-line","sessionId":"s-main"}',
      ...transcript.slice(5),
    ]
    const file = jsonlFile({ runtime: 'claude', path: claudePath, lines, ino: 10n })

    await startEngine(store, { roots: [workspace.repository] }).ingest(file.batch(1, lines.length))

    const stored = recordsOf(store)
    expect(stored).toHaveLength(lines.length)
    expect([stored[5], stored[6]].map((record) => [record?.parse_state, record?.source_ts])).toEqual([
      ['invalid', null],
      ['unknown', null],
    ])
    expect(
      [stored[5], stored[6]].flatMap((record) => (record === undefined ? [] : store.facts.ofRecord(record.seq))),
    ).toEqual([])
  })

  test('keeps nothing when the store rejects the batch, and the same batch commits once it is valid', async ({
    onTestFinished,
  }) => {
    const workspace = await createWorkspace(onTestFinished)
    const home = await createHome(onTestFinished)
    const store = home.open()
    const engine = startEngine(store, { roots: [workspace.repository] })
    const lines = claudeTranscript({ session: 's-main', cwd: workspace.repository })
    const file = jsonlFile({ runtime: 'claude', path: claudePath, lines, ino: 10n })
    const batch = file.batch(1, lines.length)
    const hooks = hookBatch({
      file: 'h-pre.evt',
      payload: claudeHook('PreToolUse.Bash.json', { session: 's-main', cwd: workspace.repository }),
      env: claudeHookEnv,
    })
    const broken = joinBatches(
      hooks,
      batchOf({ records: batch.records, cursors: [{ ...file.cursor(lines.length), size: 0 }] }),
    )

    await expect(engine.ingest(broken)).rejects.toThrow(/CHECK constraint failed/)

    expect(observationRows(home.database())).toEqual(noObservationRows)
    expect(store.cursors.list()).toEqual([])
    expect(store.scopes.ofSession(sessionKey('claude', 's-main'))).toBeNull()

    const retried = joinBatches(hooks, batch)
    const result = await engine.ingest(retried)

    expect(recordsOf(store)).toHaveLength(lines.length + 1)
    expect(store.cursors.list()).toEqual([file.cursor(lines.length, streamOf('claude', lines))])
    expect(store.scopes.ofSession(sessionKey('claude', 's-main'))?.scope).toBe('watched')
    expect(settledOf(result, [retried])).toEqual([0])
  })
})

describe('records that precede the first cwd of their session', () => {
  test('wait in memory without a cursor and are committed in file order once the scope is decided', async ({
    onTestFinished,
  }) => {
    const workspace = await createWorkspace(onTestFinished)
    const home = await createHome(onTestFinished)
    const store = home.open()
    const engine = startEngine(store, { roots: [workspace.repository] })
    const lines = claudeTranscript({ session: 's-main', cwd: workspace.repository })
    const file = jsonlFile({ runtime: 'claude', path: claudePath, lines, ino: 10n })
    const stream = streamOf('claude', lines)

    const early = await engine.ingest(file.batch(1, 2))

    expect(countsOf(early)).toEqual({ inserted: 0, duplicates: 0, discarded: 0, waiting: 2, deferred: 0 })
    expect(early.head).toBe(0)
    expect(observationRows(home.database())).toEqual(noObservationRows)
    expect(store.cursors.list()).toEqual([])
    expect(store.scopes.get(stream)).toBeNull()

    const rest = await engine.ingest(file.batch(3, lines.length))

    expect(rest).toMatchObject({ inserted: lines.length, waiting: 0 })
    expect(recordsOf(store).map((record) => record.position)).toEqual(
      file.batch(1, lines.length).records.map((record) => record.position),
    )
    expect(store.cursors.list()).toEqual([file.cursor(lines.length, stream)])
  })

  test('are committed together with the SessionStart hook that opens their session', async ({ onTestFinished }) => {
    const workspace = await createWorkspace(onTestFinished)
    const home = await createHome(onTestFinished)
    const store = home.open()
    const engine = startEngine(store, { roots: [workspace.repository] })
    const lines = claudeTranscript({ session: 's-main', cwd: workspace.repository })
    const file = jsonlFile({ runtime: 'claude', path: claudePath, lines, ino: 10n })
    const stream = streamOf('claude', lines)

    await engine.ingest(file.batch(1, 2))
    const decided = await engine.ingest(
      hookBatch({
        file: 'h-start.evt',
        payload: claudeHook('SessionStart.startup.json', { session: 's-main', cwd: workspace.repository }),
        env: claudeHookEnv,
      }),
    )

    expect(decided).toMatchObject({ inserted: 3, waiting: 0 })
    expect(recordsOf(store).map((record) => [record.channel, record.stream])).toEqual([
      ['transcript', stream],
      ['transcript', stream],
      ['hook', null],
    ])
    expect(store.cursors.list()).toEqual([file.cursor(2, stream)])
  })

  test('may start with a read of empty lines only', async ({ onTestFinished }) => {
    const workspace = await createWorkspace(onTestFinished)
    const home = await createHome(onTestFinished)
    const store = home.open()
    const engine = startEngine(store, { roots: [workspace.repository] })
    const lines = ['', ...claudeTranscript({ session: 's-main', cwd: workspace.repository })]
    const file = jsonlFile({ runtime: 'claude', path: claudePath, lines, ino: 10n })

    const empty = await engine.ingest(batchOf({ cursors: [file.cursor(1)] }))
    const rest = await engine.ingest(file.batch(2, lines.length))

    expect(empty).toMatchObject({ inserted: 0, waiting: 0 })
    expect(rest).toMatchObject({ inserted: lines.length - 1, waiting: 0 })
    expect(store.cursors.list()).toEqual([file.cursor(lines.length, streamOf('claude', lines.slice(1)))])
  })

  test('are read again from the start of the file after a restart', async ({ onTestFinished }) => {
    const workspace = await createWorkspace(onTestFinished)
    const home = await createHome(onTestFinished)
    const lines = claudeTranscript({ session: 's-main', cwd: workspace.repository })
    const file = jsonlFile({ runtime: 'claude', path: claudePath, lines, ino: 10n })
    const first = home.open()
    await startEngine(first, { roots: [workspace.repository] }).ingest(file.batch(1, 2))
    first.close()

    const store = home.open()
    await startEngine(store, { roots: [workspace.repository] }).ingest(file.batch(1, lines.length))

    expect(recordsOf(store).map((record) => record.position)).toEqual(
      file.batch(1, lines.length).records.map((record) => record.position),
    )
  })
})

describe('a hook event that waits for the scope of its session', () => {
  test('keeps its batch unsettled until it is committed, and a batch without such records settles at once', async ({
    onTestFinished,
  }) => {
    const workspace = await createWorkspace(onTestFinished)
    const home = await createHome(onTestFinished)
    const store = home.open()
    const engine = startEngine(store, { roots: [workspace.repository] })
    const lines = claudeTranscript({ session: 's-main', cwd: workspace.repository })
    const file = jsonlFile({ runtime: 'claude', path: claudePath, lines, ino: 10n })
    const hooks = hookBatch({
      file: 'h-no-cwd.evt',
      payload: claudeHookWithoutCwd('PreToolUse.Bash.json', 's-main'),
      env: claudeHookEnv,
    })
    const unrelated = hookBatch({
      file: 'h-other.evt',
      payload: claudeHook('SessionStart.startup.json', { session: 's-other', cwd: workspace.outside }),
      env: claudeHookEnv,
    })
    const transcript = file.batch(1, lines.length)
    const batches = [hooks, unrelated, transcript]

    const held = await engine.ingest(hooks)
    const other = await engine.ingest(unrelated)

    expect(countsOf(held)).toEqual({ inserted: 0, duplicates: 0, discarded: 0, waiting: 1, deferred: 0 })
    expect(settledOf(held, batches)).toEqual([])
    expect(settledOf(other, batches)).toEqual([1])
    expect(observationRows(home.database())).toEqual(noObservationRows)

    const decided = await engine.ingest(transcript)

    expect(countsOf(decided)).toEqual({
      inserted: lines.length + 1,
      duplicates: 0,
      discarded: 0,
      waiting: 0,
      deferred: 0,
    })
    expect(settledOf(decided, batches)).toEqual([0, 2])
    expect(gapsOf(store)).toEqual([])
  })
})

describe('a repeated delivery', () => {
  test('adds no rows and no changes, before and after a restart', async ({ onTestFinished }) => {
    const workspace = await createWorkspace(onTestFinished)
    const home = await createHome(onTestFinished)
    const store = home.open()
    const engine = startEngine(store, { roots: [workspace.repository] })
    const lines = claudeTranscript({ session: 's-main', cwd: workspace.repository })
    const file = jsonlFile({ runtime: 'claude', path: claudePath, lines, ino: 10n })
    const batch = joinBatches(
      hookBatch({
        file: 'h-permission.evt',
        payload: claudeHook('PermissionRequest.Bash.json', { session: 's-main', cwd: workspace.repository }),
        env: claudeHookEnv,
      }),
      file.batch(1, lines.length),
    )
    await engine.ingest(batch)
    const head = store.changes.head()
    const records = recordsOf(store)

    const again = await engine.ingest(batch)
    store.close()
    const reopened = home.open()
    const afterRestart = await startEngine(reopened, { roots: [workspace.repository] }).ingest(batch)

    expect(countsOf(again)).toEqual({
      inserted: 0,
      duplicates: lines.length + 1,
      discarded: 0,
      waiting: 0,
      deferred: 0,
    })
    expect(again.head).toBe(head)
    expect(countsOf(afterRestart)).toEqual(countsOf(again))
    expect(afterRestart.head).toBe(head)
    expect(recordsOf(reopened)).toEqual(records)
  })
})

describe('a hook event that the adapter does not turn into facts', () => {
  const unknownEvent = (session: string, cwd: string) =>
    codexHook('SessionStart.startup.json', { session, cwd }, { hook_event_name: 'FutureEvent' })

  test('of a watched session is kept as a raw record, also when it arrives again and after a restart', async ({
    onTestFinished,
  }) => {
    const workspace = await createWorkspace(onTestFinished)
    const home = await createHome(onTestFinished)
    const store = home.open()
    const engine = startEngine(store, { roots: [workspace.repository] })
    const codex = jsonlFile({
      runtime: 'codex',
      path: codexPath,
      lines: codexRollout({ thread: 't-main', cwd: workspace.repository }),
      ino: 20n,
    })
    const invalidClaude = claudeHook(
      'PreToolUse.Bash.json',
      { session: 's-main', cwd: workspace.repository },
      { tool_use_id: null },
    )
    const unknownCodex = hookBatch({
      file: 'h-future.evt',
      payload: unknownEvent('t-main', workspace.outside),
      runtime: 'codex',
    })
    const startup = hookBatch({
      file: 'h-start.evt',
      payload: claudeHook('SessionStart.startup.json', { session: 's-main', cwd: workspace.repository }),
      env: claudeHookEnv,
    })
    const invalid = hookBatch({ file: 'h-invalid.evt', payload: invalidClaude, env: claudeHookEnv })

    await engine.ingest(codex.batch(1, 1))
    const first = await engine.ingest(joinBatches(unknownCodex, startup, invalid))
    const again = await engine.ingest(joinBatches(unknownCodex, invalid))
    store.close()
    const reopened = home.open()
    const afterRestart = await startEngine(reopened, { roots: [workspace.repository] }).ingest(
      hookBatch({ file: 'h-future-2.evt', payload: unknownEvent('t-main', workspace.outside), runtime: 'codex' }),
    )

    expect(countsOf(first)).toMatchObject({ inserted: 3, discarded: 0, waiting: 0 })
    expect(countsOf(again)).toMatchObject({ inserted: 0, duplicates: 2 })
    expect(countsOf(afterRestart)).toMatchObject({ inserted: 1, discarded: 0, waiting: 0 })
    expect(
      recordsOf(reopened).flatMap((record) =>
        record.position.kind === 'spool' && record.position.file !== 'h-start.evt'
          ? [[record.position.file, record.parse_state, reopened.facts.ofRecord(record.seq).length]]
          : [],
      ),
    ).toEqual([
      ['h-future.evt', 'unknown', 0],
      ['h-invalid.evt', 'invalid', 0],
      ['h-future-2.evt', 'unknown', 0],
    ])
    expect(gapsOf(reopened)).toEqual([])
  })

  test.for([
    { name: 'outside the watched roots', env: {}, cwd: 'outside', scope: 'external' },
    {
      name: 'of the observer',
      env: { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'aang_observer' },
      cwd: 'repository',
      scope: 'observer',
    },
  ] as const)('of a session $name leaves no rows and no gaps', async ({ env, cwd, scope }, { onTestFinished }) => {
    const workspace = await createWorkspace(onTestFinished)
    const home = await createHome(onTestFinished)
    const store = home.open()
    const engine = startEngine(store, { roots: [workspace.repository] })
    const start = codexHook('SessionStart.startup.json', { session: 't-other', cwd: workspace[cwd] })
    const batch = hookBatch(
      { file: 'h-start.evt', payload: start, runtime: 'codex', env },
      { file: 'h-future.evt', payload: unknownEvent('t-other', workspace[cwd]), runtime: 'codex', env },
    )

    const result = await engine.ingest(batch)
    const again = await engine.ingest(batch)

    expect(countsOf(result)).toEqual({ inserted: 0, duplicates: 0, discarded: 2, waiting: 0, deferred: 0 })
    expect(settledOf(result, [batch])).toEqual([0])
    expect(countsOf(again)).toMatchObject({ discarded: 2 })
    expect(observationRows(home.database())).toEqual(noObservationRows)
    expect(store.changes.head()).toBe(0)
    expect(store.scopes.ofSession(sessionKey('codex', 't-other'))?.scope).toBe(scope)
  })
})

describe('a hook record that names no session', () => {
  test('is discarded with a gap that names the record', async ({ onTestFinished }) => {
    const workspace = await createWorkspace(onTestFinished)
    const home = await createHome(onTestFinished)
    const store = home.open()
    const engine = startEngine(store, { roots: [workspace.repository] })
    const batch = hookBatch({ file: 'h-broken.evt', payload: 'not json', env: claudeHookEnv, arrival: 7 })

    const result = await engine.ingest(batch)
    const again = await engine.ingest(batch)

    expect(result).toMatchObject({ inserted: 0, discarded: 1 })
    expect(settledOf(result, [batch])).toEqual([0])
    expect(again.head).toBe(result.head)
    expect(recordsOf(store)).toEqual([])
    expect(gapsOf(store)).toEqual([
      expect.objectContaining({
        key: { kind: 'gap', gap: 'unknown_records', subject: 'record:["claude","hook","h-broken.evt"]' },
        stream: null,
        session: null,
        run: null,
        details: 'claude hook record (invalid) discarded: it names no session',
        detected_at: batch.records[0]?.observed_at,
        closed_at: null,
      }),
    ])
  })
})

describe('a file whose stream the adapter cannot name', () => {
  test('is skipped with a gap, and its later lines are skipped after a restart', async ({ onTestFinished }) => {
    const workspace = await createWorkspace(onTestFinished)
    const home = await createHome(onTestFinished)
    const store = home.open()
    const lines = codexRollout({ thread: 't-main', cwd: workspace.repository }).slice(1)
    const file = jsonlFile({ runtime: 'codex', path: codexPath, lines, ino: 20n })

    const result = await startEngine(store, { roots: [workspace.repository] }).ingest(file.batch(1, 30))
    store.close()
    const reopened = home.open()
    const appended = await startEngine(reopened, { roots: [workspace.repository] }).ingest(file.batch(31, lines.length))

    expect(result).toMatchObject({ inserted: 0, discarded: 30, waiting: 0 })
    expect(appended).toMatchObject({ inserted: 0, discarded: lines.length - 30, waiting: 0 })
    expect(recordsOf(reopened)).toEqual([])
    expect(gapsOf(reopened).map((gap) => [gap.key, gap.stream, gap.closed_at])).toEqual([
      [{ kind: 'gap', gap: 'unknown_stream_layout', subject: codexPath }, null, null],
    ])
    expect(reopened.cursors.list()).toEqual([file.cursor(lines.length)])
  })

  test('waits while it has too few lines to tell', async ({ onTestFinished }) => {
    const workspace = await createWorkspace(onTestFinished)
    const home = await createHome(onTestFinished)
    const store = home.open()
    const engine = startEngine(store, { roots: [workspace.repository] })
    const lines = codexRollout({ thread: 't-main', cwd: workspace.repository }).slice(1)
    const file = jsonlFile({ runtime: 'codex', path: codexPath, lines, ino: 20n })

    const early = await engine.ingest(file.batch(1, 3))

    expect(early).toMatchObject({ inserted: 0, discarded: 0, waiting: 3 })
    expect(observationRows(home.database())).toEqual(noObservationRows)
    expect(store.cursors.list()).toEqual([])

    const rest = await engine.ingest(file.batch(4, lines.length))

    expect(rest).toMatchObject({ inserted: 0, discarded: lines.length, waiting: 0 })
    expect(gapsOf(store).map((gap) => gap.key.gap)).toEqual(['unknown_stream_layout'])
    expect(store.cursors.list()).toEqual([file.cursor(lines.length)])
  })
})

describe('a file read again from its start', () => {
  test('that now holds another session is named anew and its lines are not taken for duplicates', async ({
    onTestFinished,
  }) => {
    const workspace = await createWorkspace(onTestFinished)
    const home = await createHome(onTestFinished)
    const store = home.open()
    const engine = startEngine(store, { roots: [workspace.repository] })
    const oldLines = codexRollout({ thread: 't-old', cwd: workspace.repository })
    const newLines = codexRollout({ thread: 't-new', cwd: workspace.repository }).slice(0, 20)
    const before = jsonlFile({ runtime: 'codex', path: codexPath, lines: oldLines, ino: 20n })
    const after = jsonlFile({ runtime: 'codex', path: codexPath, lines: newLines, ino: 20n })
    await engine.ingest(before.batch(1, oldLines.length))

    const rewritten = await engine.ingest(after.batch(1, newLines.length))

    const newStream = streamOf('codex', newLines)
    expect(countsOf(rewritten)).toEqual({
      inserted: newLines.length,
      duplicates: 0,
      discarded: 0,
      waiting: 0,
      deferred: 0,
    })
    expect(recordsOf(store).filter((record) => record.stream === newStream)).toHaveLength(newLines.length)
    expect(store.scopes.ofSession(sessionKey('codex', 't-new'))?.scope).toBe('watched')
    expect(store.cursors.list()).toEqual([after.cursor(newLines.length, newStream)])
  })

  test('with the same content is deduplicated and keeps its stream, also after a restart', async ({
    onTestFinished,
  }) => {
    const workspace = await createWorkspace(onTestFinished)
    const home = await createHome(onTestFinished)
    const lines = claudeTranscript({ session: 's-main', cwd: workspace.repository })
    const file = jsonlFile({ runtime: 'claude', path: claudePath, lines, ino: 10n })
    const first = home.open()
    await startEngine(first, { roots: [workspace.repository] }).ingest(file.batch(1, lines.length))
    first.close()
    const store = home.open()

    const reread = await startEngine(store, { roots: [workspace.repository] }).ingest(file.batch(1, lines.length))

    expect(countsOf(reread)).toEqual({ inserted: 0, duplicates: lines.length, discarded: 0, waiting: 0, deferred: 0 })
    expect(store.cursors.list()).toEqual([file.cursor(lines.length, streamOf('claude', lines))])
  })
})

describe('gaps reported by the collector', () => {
  const gapOf = (subject: string, closed = false): CollectedGap => ({
    key: { kind: 'gap', gap: 'read_failed', subject },
    stream: null,
    details: 'EACCES: permission denied',
    detected_at: EpochNs.parse(1_790_856_000_000_000_000n),
    closed_at: closed ? EpochNs.parse(1_790_856_100_000_000_000n) : null,
  })

  test('name the stream of the file they concern and are dropped for a stream outside the watched roots', async ({
    onTestFinished,
  }) => {
    const workspace = await createWorkspace(onTestFinished)
    const home = await createHome(onTestFinished)
    const store = home.open()
    const engine = startEngine(store, { roots: [workspace.repository] })
    const watchedLines = claudeTranscript({ session: 's-main', cwd: workspace.repository })
    const externalLines = claudeTranscript({ session: 's-other', cwd: workspace.outside })
    const watched = jsonlFile({ runtime: 'claude', path: claudePath, lines: watchedLines, ino: 10n })
    const external = jsonlFile({ runtime: 'claude', path: '/p/s-other.jsonl', lines: externalLines, ino: 11n })
    await engine.ingest(joinBatches(watched.batch(1, watchedLines.length), external.batch(1, externalLines.length)))
    const head = store.changes.head()

    await engine.ingest(batchOf({ gaps: [gapOf(external.path), gapOf(external.path, true)] }))

    expect(store.changes.head()).toBe(head)
    expect(gapsOf(store)).toEqual([])

    await engine.ingest(batchOf({ gaps: [gapOf('/p/unknown.jsonl'), gapOf(watched.path)] }))

    expect(gapsOf(store).map((gap) => [gap.key.subject, gap.stream])).toEqual([
      ['/p/unknown.jsonl', null],
      [watched.path, streamOf('claude', watchedLines)],
    ])
  })

  test.for([
    ['outside', 'external'],
    ['repository', 'watched'],
  ] as const)(
    'of a file that waits for its scope wait with it, and are kept when its session lies in %s',
    async ([place, scope], { onTestFinished }) => {
      const workspace = await createWorkspace(onTestFinished)
      const home = await createHome(onTestFinished)
      const store = home.open()
      const engine = startEngine(store, { roots: [workspace.repository] })
      const subagentLines = claudeSubagentTranscript({ session: 's-parent', cwd: workspace.repository })
      const mainLines = claudeTranscript({ session: 's-parent', cwd: workspace[place] })
      const subagent = jsonlFile({
        runtime: 'claude',
        path: '/p/s-parent/agent-a.jsonl',
        lines: subagentLines,
        ino: 2n,
      })
      const main = jsonlFile({ runtime: 'claude', path: '/p/s-parent.jsonl', lines: mainLines, ino: 1n })
      await engine.ingest(subagent.batch(1, 5))

      await engine.ingest(batchOf({ gaps: [gapOf(subagent.path)] }))
      await engine.ingest(subagent.batch(1, subagentLines.length))

      expect(gapsOf(store)).toEqual([])

      await engine.ingest(main.batch(1, mainLines.length))

      expect(store.scopes.ofSession(sessionKey('claude', 's-parent'))?.scope).toBe(scope)
      expect(gapsOf(store).map((gap) => [gap.key.subject, gap.stream])).toEqual(
        scope === 'watched' ? [[subagent.path, streamOf('claude', subagentLines)]] : [],
      )
    },
  )

  test('of a file that turns out to have no stream are kept', async ({ onTestFinished }) => {
    const workspace = await createWorkspace(onTestFinished)
    const home = await createHome(onTestFinished)
    const store = home.open()
    const engine = startEngine(store, { roots: [workspace.repository] })
    const lines = codexRollout({ thread: 't-main', cwd: workspace.repository }).slice(1)
    const file = jsonlFile({ runtime: 'codex', path: codexPath, lines, ino: 20n })
    await engine.ingest(file.batch(1, 3))

    await engine.ingest(batchOf({ gaps: [gapOf(codexPath)] }))
    await engine.ingest(file.batch(4, lines.length))

    expect(gapsOf(store).map((gap) => [gap.key.gap, gap.stream])).toEqual([
      ['unknown_stream_layout', null],
      ['read_failed', null],
    ])
  })
})

describe('waiting records', () => {
  test('stay within the limit of a file, while another session is ingested', async ({ onTestFinished }) => {
    const workspace = await createWorkspace(onTestFinished)
    const home = await createHome(onTestFinished)
    const store = home.open()
    const subagentLines = claudeSubagentTranscript({ session: 's-parent', cwd: workspace.repository }, 5)
    const mainLines = claudeTranscript({ session: 's-parent', cwd: workspace.repository })
    const otherLines = codexRollout({ thread: 't-other', cwd: workspace.repository })
    const fileBytes = subagentLines.slice(0, 10).reduce((total, line) => total + Buffer.byteLength(line), 0)
    const engine = startEngine(store, { roots: [workspace.repository], holding: { fileBytes } })
    const subagent = jsonlFile({ runtime: 'claude', path: '/p/s-parent/agent-a.jsonl', lines: subagentLines, ino: 2n })
    const main = jsonlFile({ runtime: 'claude', path: '/p/s-parent.jsonl', lines: mainLines, ino: 1n })
    const other = jsonlFile({ runtime: 'codex', path: codexPath, lines: otherLines, ino: 3n })
    const subagentStream = streamOf('claude', subagentLines)

    const held = await engine.ingest(joinBatches(subagent.batch(1, 30), other.batch(1, otherLines.length)))
    const more = await engine.ingest(subagent.batch(31, 40))

    expect(countsOf(held)).toEqual({
      inserted: otherLines.length,
      duplicates: 0,
      discarded: 0,
      waiting: 10,
      deferred: 20,
    })
    expect(countsOf(more)).toEqual({ inserted: 0, duplicates: 0, discarded: 0, waiting: 10, deferred: 10 })

    const decided = await engine.ingest(main.batch(1, mainLines.length))
    const lagging = await engine.ingest(subagent.batch(41, subagentLines.length))

    expect(countsOf(decided)).toEqual({
      inserted: mainLines.length + 10,
      duplicates: 0,
      discarded: 0,
      waiting: 0,
      deferred: 0,
    })
    expect(decided.rescan).toEqual([subagentStream])
    expect(countsOf(lagging)).toEqual({
      inserted: 0,
      duplicates: 0,
      discarded: 0,
      waiting: 0,
      deferred: subagentLines.length - 40,
    })
    expect(store.cursors.list().map((cursor) => cursor.path)).toEqual([codexPath, main.path])

    const reread = await engine.ingest(subagent.batch(1, subagentLines.length))

    expect(countsOf(reread)).toEqual({
      inserted: subagentLines.length - 10,
      duplicates: 10,
      discarded: 0,
      waiting: 0,
      deferred: 0,
    })
    expect(reread.rescan).toEqual([])
    expect(recordsOf(store).filter((record) => record.stream === subagentStream)).toHaveLength(subagentLines.length)
    expect(store.cursors.list()).toContainEqual(subagent.cursor(subagentLines.length, subagentStream))
  })

  test('beyond the total limit leave their hook events to the spool, and the batch is never settled', async ({
    onTestFinished,
  }) => {
    const workspace = await createWorkspace(onTestFinished)
    const home = await createHome(onTestFinished)
    const lines = claudeTranscript({ session: 's-main', cwd: workspace.repository })
    const file = jsonlFile({ runtime: 'claude', path: claudePath, lines, ino: 10n })
    const first = claudeHook('PreToolUse.Bash.json', { session: 's-main', cwd: workspace.repository })
    const second = claudeHook('PostToolUse.Bash.json', { session: 's-main', cwd: workspace.repository })
    const store = home.open()
    const engine = startEngine(store, {
      roots: [workspace.repository],
      holding: { totalBytes: Buffer.byteLength(first) },
    })
    const kept = hookBatch({ file: 'h-pre.evt', payload: first, env: claudeHookEnv })
    const dropped = hookBatch({ file: 'h-post.evt', payload: second, env: claudeHookEnv })
    const transcript = file.batch(1, lines.length)
    const batches = [kept, dropped, transcript]

    const results = [await engine.ingest(kept), await engine.ingest(dropped), await engine.ingest(transcript)]

    expect(results.map(countsOf)).toEqual([
      { inserted: 0, duplicates: 0, discarded: 0, waiting: 1, deferred: 0 },
      { inserted: 0, duplicates: 0, discarded: 0, waiting: 1, deferred: 1 },
      { inserted: lines.length + 1, duplicates: 0, discarded: 0, waiting: 0, deferred: 0 },
    ])
    expect(results.map((result) => settledOf(result, batches))).toEqual([[], [], [0, 2]])

    store.close()
    const reopened = home.open()
    const redelivered = await startEngine(reopened, { roots: [workspace.repository] }).ingest(dropped)

    expect(countsOf(redelivered)).toMatchObject({ inserted: 1, waiting: 0 })
    expect(settledOf(redelivered, [dropped])).toEqual([0])
  })
})

describe('an inconsistent input', () => {
  test('a registry without an adapter for every runtime is rejected', async ({ onTestFinished }) => {
    const home = await createHome(onTestFinished)
    const store = home.open()
    const claudeOnly = new Map([...adapters].filter(([runtime]) => runtime === 'claude'))
    const misfiled = new Map([...adapters].map(([runtime, adapter]) => [runtime, adapters.get('claude') ?? adapter]))

    expect(() => createEngine({ store, adapters: claudeOnly, watch: { all: true, roots: [] } })).toThrow(
      'the adapter registry has no codex adapter',
    )
    expect(() => createEngine({ store, adapters: misfiled, watch: { all: true, roots: [] } })).toThrow(
      'the adapter registry has no codex adapter',
    )
  })

  test('lines without the cursor of their file are rejected and leave nothing behind', async ({ onTestFinished }) => {
    const workspace = await createWorkspace(onTestFinished)
    const home = await createHome(onTestFinished)
    const store = home.open()
    const lines = claudeTranscript({ session: 's-main', cwd: workspace.repository })
    const file = jsonlFile({ runtime: 'claude', path: claudePath, lines, ino: 10n })

    await expect(
      startEngine(store, { roots: [workspace.repository] }).ingest(
        batchOf({ records: file.batch(1, lines.length).records }),
      ),
    ).rejects.toThrow(`the batch has lines of ${claudePath} without the cursor of the file`)
    expect(observationRows(home.database())).toEqual(noObservationRows)
  })
})

describe('concurrent calls', () => {
  test('are applied one after another', async ({ onTestFinished }) => {
    const workspace = await createWorkspace(onTestFinished)
    const home = await createHome(onTestFinished)
    const store = home.open()
    const engine = startEngine(store, { roots: [workspace.repository] })
    const lines = claudeTranscript({ session: 's-main', cwd: workspace.repository })
    const file = jsonlFile({ runtime: 'claude', path: claudePath, lines, ino: 10n })

    const results = await Promise.all([engine.ingest(file.batch(1, 2)), engine.ingest(file.batch(3, lines.length))])

    expect(results.map(({ inserted, waiting }) => [inserted, waiting])).toEqual([
      [0, 2],
      [lines.length, 0],
    ])
    expect(store.cursors.list()).toEqual([file.cursor(lines.length, streamOf('claude', lines))])
  })
})
