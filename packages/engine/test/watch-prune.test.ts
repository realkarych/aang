import {
  type CollectedGap,
  CollectedRecord,
  type CollectorBatch,
  EpochNs,
  type RunId,
  type RunSnapshot,
  type Runtime,
  type SessionKey,
} from '@aang/contract'
import { contentHash, objectId, runId } from '@aang/contract/ids'
import { createEngine, createReadQueries, type Engine, InvalidPositionError } from '@aang/engine'
import type { Store } from '@aang/store'
import { describe, expect, test } from 'vitest'
import { batchOf, type HookDelivery, hookBatch, joinBatches, jsonlFile } from './batches.js'
import { adapters, factsOf, gapsOf, recordsOf, sessionKey, streamOf } from './harness.js'
import { createHome } from './home.js'
import { decisionRecord, otelRoot } from './otel-records.js'
import { claudeHook, claudeTranscript, codexHook, codexRollout } from './samples.js'
import { createWorkspace } from './workspace.js'

const prunedAt = EpochNs.parse(1_790_856_592_228_740_000n)

const engineAt = (store: Store, roots: readonly string[]): Engine =>
  createEngine({ store, adapters, watch: { all: false, roots: roots.map((path) => ({ path })) }, now: () => prunedAt })

const runOf = (store: Store, key: SessionKey): RunId | null => store.observations.getSession(objectId(key))?.run ?? null

const startPruned = (store: Store, run: RunId): boolean | null => {
  const entity = store.model.entity(run, { kind: 'run', id: run })
  return entity?.kind === 'run' ? entity.value.start_pruned : null
}

const readsOf = (store: Store) =>
  createReadQueries({ store, observer: () => ({ state: { state: 'ok' }, isolation_unverified: false }) })

const runtimeHook = (runtime: Runtime, name: string, session: string, cwd: string, file: string, arrival: number): HookDelivery =>
  runtime === 'claude'
    ? { file, payload: claudeHook(name, { session, cwd }), arrival }
    : { file, runtime, registration: 'user', payload: codexHook(name, { session, cwd }), arrival }

const hookAt = (file: string, payload: string, observedAt: bigint): CollectorBatch =>
  batchOf({
    records: [
      CollectedRecord.parse({
        channel: 'hook',
        runtime: 'claude',
        stream: null,
        position: { kind: 'spool', file },
        hook: { registration: 'plugin', env: {} },
        observed_at: observedAt,
        payload,
      }),
    ],
  })

describe('watch and prune through the engine', () => {
  test('rewatch admits sessions that enter the roots on reread and stops taking records of sessions that leave them', async ({
    onTestFinished,
  }) => {
    const workspace = await createWorkspace(onTestFinished)
    const store = (await createHome(onTestFinished)).open()
    const engine = engineAt(store, [workspace.repository])
    const inside = claudeTranscript({ session: 's-inside', cwd: workspace.repository })
    const outside = claudeTranscript({ session: 's-outside', cwd: workspace.otherRepository })
    const insideFile = jsonlFile({ runtime: 'claude', path: '/p/s-inside.jsonl', lines: inside, ino: 1n })
    const outsideFile = jsonlFile({ runtime: 'claude', path: '/p/s-outside.jsonl', lines: outside, ino: 2n })
    const insideStream = streamOf('claude', inside)
    const outsideStream = streamOf('claude', outside)
    await engine.ingest(insideFile.batch(1, inside.length - 2))
    await engine.ingest(outsideFile.batch(1, outside.length - 2))
    const stored = (): Record<string, number> => ({
      inside: recordsOf(store).filter(({ stream }) => stream === insideStream).length,
      outside: recordsOf(store).filter(({ stream }) => stream === outsideStream).length,
    })
    expect(stored()).toEqual({ inside: inside.length - 2, outside: 0 })

    const widened = await engine.rewatch(
      { all: false, roots: [{ path: workspace.repository }, { path: workspace.otherRepository }] },
      (transaction) => {
        transaction.settings.save('watch-probe', 'widened', prunedAt)
      },
    )
    const admitted = {
      session: store.scopes.ofSession(sessionKey('claude', 's-outside'))?.scope,
      stream: store.scopes.get(outsideStream)?.scope,
    }
    await engine.ingest(outsideFile.batch(1, outside.length - 2, outsideStream))
    const reread = stored()
    const narrowed = await engine.rewatch({ all: false, roots: [{ path: workspace.otherRepository }] }, () => undefined)
    await engine.ingest(insideFile.batch(inside.length - 1, inside.length, insideStream))
    await engine.ingest(outsideFile.batch(outside.length - 1, outside.length, outsideStream))

    expect(widened).toEqual({ rescan: [outsideStream] })
    expect(admitted).toEqual({ session: 'watched', stream: 'external' })
    expect(reread).toEqual({ inside: inside.length - 2, outside: outside.length - 2 })
    expect(store.scopes.get(outsideStream)?.scope).toBe('watched')
    expect(narrowed).toEqual({ rescan: [insideStream] })
    expect(store.scopes.ofSession(sessionKey('claude', 's-inside'))?.scope).toBe('external')
    expect(store.scopes.get(insideStream)?.scope).toBe('external')
    expect(stored()).toEqual({ inside: inside.length - 2, outside: outside.length })
    expect(store.observations.getSession(objectId(sessionKey('claude', 's-inside')))).not.toBeNull()
    expect(store.settings.get('watch-probe')).toBe('widened')
  })

  test('a session admitted by rewatch takes appended lines, OTel decisions and gaps while its discarded stream waits for a reread, and only the reread admits the stream', async ({
    onTestFinished,
  }) => {
    const workspace = await createWorkspace(onTestFinished)
    const store = (await createHome(onTestFinished)).open()
    const engine = engineAt(store, [])
    const lines = codexRollout({ thread: otelRoot, cwd: workspace.repository })
    const file = jsonlFile({ runtime: 'codex', path: '/r/resumed.jsonl', lines, ino: 1n })
    const stream = streamOf('codex', lines)
    const roots = { all: false, roots: [{ path: workspace.repository }] }
    const lost: CollectedGap = {
      key: { kind: 'gap', gap: 'source_lost', subject: stream },
      stream,
      details: 'the rollout went missing for a while',
      detected_at: prunedAt,
      closed_at: null,
    }
    await engine.ingest(file.batch(1, lines.length - 1))
    const discarded = recordsOf(store).length

    const admitted = await engine.rewatch(roots, () => undefined)
    await engine.ingest(
      joinBatches(file.batch(lines.length, lines.length, stream), batchOf({ records: [decisionRecord(otelRoot)], gaps: [lost] })),
    )
    const resumed = {
      lines: recordsOf(store).filter(({ channel }) => channel === 'rollout').length,
      decisions: factsOf(store).filter(({ kind }) => kind === 'permission_decision').length,
      lost: gapsOf(store).filter(({ key }) => key.gap === 'source_lost').length,
      stream: store.scopes.get(stream)?.scope,
    }
    const pending = await engine.rewatch(roots, () => undefined)
    await engine.ingest(file.batch(1, lines.length, stream))
    const reread = await engine.rewatch(roots, () => undefined)

    expect(discarded).toBe(0)
    expect(admitted).toEqual({ rescan: [stream] })
    expect(resumed).toEqual({ lines: 1, decisions: 1, lost: 1, stream: 'external' })
    expect(pending).toEqual({ rescan: [stream] })
    expect(reread).toEqual({ rescan: [] })
    expect(store.scopes.get(stream)?.scope).toBe('watched')
    expect(recordsOf(store).filter(({ channel }) => channel === 'rollout')).toHaveLength(lines.length)
  })

  test('prune removes every layer of a run, bounds its streams, drops earlier hooks and marks the run formed again', async ({
    onTestFinished,
  }) => {
    const workspace = await createWorkspace(onTestFinished)
    const store = (await createHome(onTestFinished)).open()
    const engine = engineAt(store, [workspace.repository])
    const claude = { session: 's-pruned', cwd: workspace.repository }
    const lines = claudeTranscript(claude)
    const file = jsonlFile({ runtime: 'claude', path: '/p/s-pruned.jsonl', lines, ino: 1n })
    const rollout = codexRollout({ thread: 't-kept', cwd: workspace.repository })
    const rolloutFile = jsonlFile({ runtime: 'codex', path: '/r/t-kept.jsonl', lines: rollout, ino: 2n })
    await engine.ingest(file.batch(1, lines.length))
    await engine.ingest(
      hookBatch(
        { file: 'a-000001.evt', payload: claudeHook('UserPromptSubmit.json', claude) },
        { file: 'a-000002.evt', payload: JSON.stringify({ hook_event_name: 'FutureEvent', session_id: 's-pruned' }) },
        {
          file: 'a-000003.evt',
          runtime: 'codex',
          registration: 'user',
          payload: codexHook('SessionStart.startup.json', { session: 't-hooks', cwd: workspace.repository }),
        },
      ),
    )
    await engine.ingest(rolloutFile.batch(1, rollout.length))
    const claudeKey = sessionKey('claude', 's-pruned')
    const run = runOf(store, claudeKey)
    const hooksRun = runOf(store, sessionKey('codex', 't-hooks'))
    const keptRun = runOf(store, sessionKey('codex', 't-kept'))
    expect([run, hooksRun, keptRun].every((value) => value !== null)).toBe(true)
    const kept = recordsOf(store).filter(({ stream }) => stream === streamOf('codex', rollout))
    const hashed: [string, number][] = []
    const held = store.changes.head()

    const outcome = await engine.prune({ scope: 'run', run: run ?? ('' as RunId) }, (path, offset) => {
      hashed.push([path, offset])
      return Promise.resolve(contentHash('the prefix'))
    })

    const stream = streamOf('claude', lines)
    expect(outcome).toEqual({
      runs: [run],
      boundaries: [
        {
          runtime: 'claude',
          stream,
          session: 's-pruned',
          offset: file.cursor(lines.length).offset,
          prefix_hash: contentHash('the prefix'),
          pruned_at: prunedAt,
        },
      ],
    })
    expect(hashed).toEqual([[file.path, file.cursor(lines.length).offset]])
    const remaining = recordsOf(store)
    expect(remaining.filter(({ stream: owner }) => owner === stream)).toEqual([])
    expect(remaining.filter(({ payload }) => payload.includes('s-pruned'))).toEqual([])
    expect(remaining.filter(({ stream: owner }) => owner === streamOf('codex', rollout))).toEqual(kept)
    expect(store.observations.getSession(objectId(claudeKey))).toBeNull()
    expect(store.facts.ofSession(claudeKey)).toEqual([])
    expect(run === null ? null : store.model.entity(run, { kind: 'run', id: run })).toBeNull()
    expect(store.pruned.ofSession(claudeKey)).toEqual(outcome.boundaries)
    expect(store.cursors.list().find(({ path }) => path === file.path)).toEqual(file.cursor(lines.length, stream))

    await engine.ingest(hookAt('b-000001.evt', claudeHook('UserPromptSubmit.json', claude), prunedAt - 1n))
    expect(store.observations.getSession(objectId(claudeKey))).toBeNull()
    await engine.ingest(hookAt('b-000002.evt', claudeHook('UserPromptSubmit.json', claude), prunedAt + 1n))
    expect(runOf(store, claudeKey)).toBe(run)
    expect(run === null ? null : startPruned(store, run)).toBe(true)
    const reformed = run ?? ('' as RunId)
    const reads = readsOf(store)
    const current = { version: store.model.head(reformed), change_seq: store.changes.head() }
    expect(() => reads.feed(reformed, held)).toThrow(InvalidPositionError)
    expect(() => reads.changes(reformed, { ...current, change_seq: held })).toThrow(InvalidPositionError)
    expect(reads.feed(reformed, current.change_seq)?.events).toEqual([])
    expect(reads.changes(reformed, current)?.to).toEqual(current)
    expect(recordsOf(store).flatMap(({ position }) => (position.kind === 'spool' ? [position.file] : []))).toEqual([
      'a-000003.evt',
      'b-000002.evt',
    ])

    const before = await engine.prune({ scope: 'before', before: EpochNs.parse(prunedAt * 2n) }, () =>
      Promise.resolve(null),
    )
    expect([...before.runs].sort()).toEqual([run, hooksRun, keptRun].sort())
    expect(before.boundaries.map((boundary) => [boundary.stream, boundary.runtime === 'codex' ? boundary.last_ordinal : boundary.offset]).sort()).toEqual(
      [
        [stream, file.cursor(lines.length).offset],
        [streamOf('codex', rollout), rolloutFile.cursor(rollout.length).last_ordinal],
        [streamOf('codex', [codexHook('SessionStart.startup.json', { session: 't-hooks', cwd: workspace.repository })]), 0],
      ].sort(),
    )
    expect(before.boundaries.find(({ stream: bounded }) => bounded === stream)).toMatchObject({
      prefix_hash: contentHash(''),
    })
    expect(recordsOf(store)).toEqual([])
    expect(store.observations.sessions()).toEqual([])
  })

  test.for(['claude', 'codex'] as const)(
    'a repeated prune of a %s run keeps its session that was resumed and moved to another run, also after a restart',
    async (runtime, { onTestFinished }) => {
      const workspace = await createWorkspace(onTestFinished)
      const home = await createHome(onTestFinished)
      const store = home.open()
      const engine = engineAt(store, [workspace.repository])
      const hook = (name: string, session: string, file: string, arrival: number): HookDelivery =>
        runtimeHook(runtime, name, session, workspace.repository, file, arrival)
      const moved = sessionKey(runtime, 'g10-moved')
      const host = sessionKey(runtime, 'g10-host')
      const [run, hostRun] = [runId(moved), runId(host)]
      await engine.ingest(
        hookBatch(
          hook('SessionStart.startup.json', moved.session, 'a-000001.evt', 0),
          hook('SessionStart.startup.json', host.session, 'a-000002.evt', 1),
        ),
      )
      const first = await engine.prune({ scope: 'run', run }, () => Promise.resolve(null))
      await engine.ingest(hookBatch(hook('UserPromptSubmit.json', moved.session, 'b-000001.evt', 2_000)))
      expect(runOf(store, moved)).toBe(run)
      await engine.bind({ kind: 'attach', session: objectId(moved), run: hostRun })
      store.close()
      const reopened = home.open()
      const kept = () => ({
        run: runOf(reopened, moved),
        member: reopened.model.entity(hostRun, { kind: 'session_membership', id: objectId(moved) }) !== null,
        facts: reopened.facts.ofSession(moved),
        records: recordsOf(reopened).filter(({ payload }) => payload.includes(moved.session)),
        boundaries: reopened.pruned.ofSession(moved),
      })
      const before = kept()

      const again = await engineAt(reopened, [workspace.repository]).prune({ scope: 'run', run }, () =>
        Promise.resolve(null),
      )

      expect(first.runs).toEqual([run])
      expect(before).toMatchObject({ run: hostRun, member: true, boundaries: first.boundaries })
      expect(before.facts.length).toBeGreaterThan(0)
      expect(before.records.map(({ position }) => position)).toEqual([{ kind: 'spool', file: 'b-000001.evt' }])
      expect(again).toEqual({ runs: [run], boundaries: [] })
      expect(kept()).toEqual(before)
      expect(reopened.model.entity(run, { kind: 'run', id: run })).toBeNull()
      expect(reopened.observations.getSession(objectId(host))?.run).toBe(hostRun)
    },
  )

  test.for(['claude', 'codex'] as const)(
    'a %s run formed again by revoking the move of its root session after its prune refuses positions taken before the prune, also after a restart',
    async (runtime, { onTestFinished }) => {
      const workspace = await createWorkspace(onTestFinished)
      const home = await createHome(onTestFinished)
      const store = home.open()
      const engine = engineAt(store, [workspace.repository])
      const hook = (name: string, session: string, file: string, arrival: number): HookDelivery =>
        runtimeHook(runtime, name, session, workspace.repository, file, arrival)
      const [root, host, member] = [
        sessionKey(runtime, 'g10-root'),
        sessionKey(runtime, 'g10-host'),
        sessionKey(runtime, 'g10-member'),
      ]
      const [run, hostRun] = [runId(root), runId(host)]
      await engine.ingest(
        hookBatch(
          hook('SessionStart.startup.json', root.session, 'a-000001.evt', 0),
          hook('SessionStart.startup.json', host.session, 'a-000002.evt', 1),
          hook('SessionStart.startup.json', member.session, 'a-000003.evt', 2),
          hook('PreToolUse.Bash.json', member.session, 'a-000004.evt', 3),
          hook('PostToolUse.Bash.json', member.session, 'a-000005.evt', 4),
        ),
      )
      await engine.bind({ kind: 'attach', session: objectId(member), run })
      const { binding } = await engine.bind({ kind: 'attach', session: objectId(root), run: hostRun })
      const held = readsOf(store).snapshot(run)

      const outcome = await engine.prune({ scope: 'run', run }, () => Promise.resolve(null))
      await engine.revokeBinding(binding.id)
      const reads = readsOf(store)
      const reread = reads.snapshot(run)
      if (held === null || reread === null) {
        throw new Error('the run must exist before and after the prune')
      }
      const sessionsOf = ({ objects }: RunSnapshot): string[] => objects.sessions.map(({ key }) => key.session).sort()
      const actorsOf = ({ objects }: RunSnapshot): string[] => objects.actions.map(({ key }) => key.session)
      const stale = held.change_seq
      const position = reread.change_seq
      const current = { version: store.model.head(run), change_seq: position }

      expect(sessionsOf(held)).toEqual([member.session])
      expect(actorsOf(held)).toContain(member.session)
      expect(outcome.runs).toEqual([run])
      expect(outcome.boundaries.map(({ session }) => session)).toEqual([member.session])
      expect(store.pruned.ofSession(root)).toEqual([])
      expect(runOf(store, root)).toBe(run)
      expect(startPruned(store, run)).toBe(false)
      expect(sessionsOf(reread)).toEqual([root.session])
      expect(actorsOf(reread)).not.toContain(member.session)
      expect(() => reads.feed(run, stale)).toThrow(InvalidPositionError)
      expect(() => reads.changes(run, { ...current, change_seq: stale })).toThrow(InvalidPositionError)
      expect(() => reads.feed(hostRun, stale)).toThrow(InvalidPositionError)
      expect(reads.feed(run, position)?.events).toEqual([])
      expect(reads.changes(run, current)?.to).toEqual(current)

      store.close()
      const reopened = readsOf(home.open())
      expect(() => reopened.feed(run, stale)).toThrow(InvalidPositionError)
      expect(reopened.snapshot(run)).toEqual(reread)
      expect(reopened.feed(run, position)?.events).toEqual([])
    },
  )
})
