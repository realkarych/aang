import { type CollectedGap, EpochNs } from '@aang/contract'
import { createEngine } from '@aang/engine'
import { describe, expect, test } from 'vitest'
import { batchOf, hookBatch, joinBatches, jsonlFile } from './batches.js'
import {
  adapters,
  draftFacts,
  expectedOf,
  gapsOf,
  noObservationRows,
  observationRows,
  recordsOf,
  sessionKey,
  startEngine,
  storedFacts,
  streamOf,
} from './harness.js'
import { createHome } from './home.js'
import { claudeHook, claudeHookEnv, claudeHookWithoutCwd, claudeTranscript, codexRollout } from './samples.js'
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

    const result = await engine.ingest(file.batch(1, lines.length))

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
    expect(result).toEqual({
      head: store.changes.head(),
      inserted: lines.length,
      duplicates: 0,
      discarded: 0,
      waiting: 0,
    })
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

    await engine.ingest(joinBatches(hooks, batch))

    expect(recordsOf(store)).toHaveLength(lines.length + 1)
    expect(store.cursors.list()).toEqual([file.cursor(lines.length, streamOf('claude', lines))])
    expect(store.scopes.ofSession(sessionKey('claude', 's-main'))?.scope).toBe('watched')
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

    expect(early).toEqual({ head: 0, inserted: 0, duplicates: 0, discarded: 0, waiting: 2 })
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

  test('are committed together with the hook event that decides their session', async ({ onTestFinished }) => {
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
        file: 'h-pre.evt',
        payload: claudeHook('PreToolUse.Bash.json', { session: 's-main', cwd: workspace.repository }),
        env: claudeHookEnv,
      }),
    )

    expect(decided).toMatchObject({ inserted: 3, waiting: 0 })
    expect(recordsOf(store).map((record) => [record.channel, record.stream])).toEqual([
      ['hook', null],
      ['transcript', stream],
      ['transcript', stream],
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

    expect(again).toEqual({ head, inserted: 0, duplicates: lines.length + 1, discarded: 0, waiting: 0 })
    expect(afterRestart).toEqual(again)
    expect(recordsOf(reopened)).toEqual(records)
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
    expect(again.head).toBe(result.head)
    expect(recordsOf(store)).toEqual([])
    expect(gapsOf(store)).toEqual([
      expect.objectContaining({
        key: { kind: 'gap', gap: 'unknown_records', subject: 'record:["claude","hook","h-broken.evt"]' },
        stream: null,
        session: null,
        run: null,
        detected_at: batch.records[0]?.observed_at,
        closed_at: null,
      }),
    ])
  })
})

describe('a hook record of a session that has no scope decision and names no cwd', () => {
  test('is discarded with a gap, and the session stays undecided', async ({ onTestFinished }) => {
    const workspace = await createWorkspace(onTestFinished)
    const home = await createHome(onTestFinished)
    const store = home.open()
    const engine = startEngine(store, { roots: [workspace.repository] })

    const result = await engine.ingest(
      hookBatch({
        file: 'h-no-cwd.evt',
        payload: claudeHookWithoutCwd('PreToolUse.Bash.json', 's-main'),
        env: claudeHookEnv,
      }),
    )

    expect(result).toMatchObject({ inserted: 0, discarded: 1 })
    expect(recordsOf(store)).toEqual([])
    expect(gapsOf(store).map((gap) => [gap.key.gap, gap.details])).toEqual([
      ['unknown_records', 'claude hook record (parsed) discarded: its session has no scope decision'],
    ])
    expect(store.scopes.ofSession(sessionKey('claude', 's-main'))).toBeNull()
  })
})

describe('gaps reported by the collector', () => {
  test('are saved unless they belong to a stream outside the watched roots', async ({ onTestFinished }) => {
    const workspace = await createWorkspace(onTestFinished)
    const home = await createHome(onTestFinished)
    const store = home.open()
    const engine = startEngine(store, { roots: [workspace.repository] })
    const watchedLines = claudeTranscript({ session: 's-main', cwd: workspace.repository })
    const externalLines = claudeTranscript({ session: 's-other', cwd: workspace.outside })
    const watched = jsonlFile({ runtime: 'claude', path: claudePath, lines: watchedLines, ino: 10n })
    const external = jsonlFile({ runtime: 'claude', path: '/p/s-other.jsonl', lines: externalLines, ino: 11n })
    await engine.ingest(joinBatches(watched.batch(1, watchedLines.length), external.batch(1, externalLines.length)))
    const gap = (subject: string, stream: CollectedGap['stream']): CollectedGap => ({
      key: { kind: 'gap', gap: 'read_failed', subject },
      stream,
      details: 'EBUSY',
      detected_at: EpochNs.parse(1_790_856_000_000_000_000n),
      closed_at: null,
    })

    await engine.ingest(
      batchOf({
        gaps: [
          gap('/spool-less/file.jsonl', null),
          gap(watched.path, streamOf('claude', watchedLines)),
          gap(external.path, streamOf('claude', externalLines)),
        ],
      }),
    )

    expect(gapsOf(store).map((saved) => saved.key.subject)).toEqual(['/spool-less/file.jsonl', watched.path])
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
