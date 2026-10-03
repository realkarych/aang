import {
  type CollectorBatch,
  EpochNs,
  type Fact,
  type Link,
  type RunId,
  type Runtime,
  type SessionId,
} from '@aang/contract'
import { objectId, runId } from '@aang/contract/ids'
import type { Store } from '@aang/store'
import { describe, expect, onTestFinished, test } from 'vitest'
import { hookBatch, jsonlFile } from './batches.js'
import { factsOf, sessionKey, startEngine } from './harness.js'
import { createHome } from './home.js'
import { claudeForkTranscript, claudeHook, claudeTranscript, codexRollout } from './samples.js'

const cwd = '/work/project'
const projects = '/home/.claude/projects/-work-project'
const codexSessions = '/home/.codex/sessions'
const original = 'original'
const fork = 'fork'
const sibling = 'sibling'
const bashCall = 'toolu_017B7FeHZ4yDzFdvKQMwDJB8'
const agentCall = 'toolu_01D254DDPoZEYPvJBjampKox'
const firstPromptUuid = 'e86fb492-94be-494b-b626-838a04fd355f'

const epochOf = (iso: string): EpochNs => EpochNs.parse(BigInt(Date.parse(iso)) * 1_000_000n)

const launch = epochOf('2026-10-01T11:53:35.336Z')

const sessionOf = (runtime: Runtime, session: string): SessionId => objectId(sessionKey(runtime, session))
const runOf = (runtime: Runtime, session: string): RunId => runId(sessionKey(runtime, session))

const withoutCounters = (value: object): object =>
  Object.fromEntries(Object.entries(value).filter(([field]) => field !== 'change_seq' && field !== 'version'))

const linksOf = (store: Store, run: RunId): Link[] =>
  store.model.entities(run).flatMap((entity) => (entity.kind === 'link' ? [entity.value] : []))

const stateOf = (store: Store, runtime: Runtime, session: string) => {
  const id = sessionOf(runtime, session)
  return {
    session: withoutCounters(store.observations.getSession(id) ?? {}),
    agents: store.observations.agents(id).map(withoutCounters),
    actions: store.observations.actions(id).map(withoutCounters),
    model: store.model.entities(runOf(runtime, session)).map(({ kind, value }) => [kind, withoutCounters(value)]),
  }
}

const claudeFile = (session: string, lines: readonly string[], ino: bigint) =>
  jsonlFile({ runtime: 'claude', path: `${projects}/${session}.jsonl`, lines, ino })

const originalFile = () => {
  const lines = claudeTranscript({ session: original, cwd })
  return claudeFile(original, lines, 1n).batch(1, lines.length)
}

const forkFile = (session = fork, own = '', ino = 2n) => {
  const lines = claudeForkTranscript({ session, cwd }, own)
  return { file: claudeFile(session, lines, ino), length: lines.length }
}

const wholeFork = (session = fork, own = '', ino = 2n): CollectorBatch => {
  const { file, length } = forkFile(session, own, ino)
  return file.batch(1, length)
}

const ingested = async (batches: readonly CollectorBatch[]): Promise<Store> => {
  const store = (await createHome(onTestFinished)).open()
  const engine = startEngine(store, { all: true })
  for (const batch of batches) {
    await engine.ingest(batch)
  }
  return store
}

const factsWith = (store: Store, session: string, match: (fact: Fact) => boolean): Fact[] =>
  factsOf(store).filter((fact) => fact.entity_key.session === session && match(fact))

const launchFact = (store: Store, session: string): Fact | undefined =>
  factsWith(store, session, ({ kind, at }) => kind === 'queue_operation' && at === launch)[0]

const firstPrompt = (store: Store, session: string): Fact | undefined =>
  factsWith(store, session, ({ kind, runtime_ids: ids }) => kind === 'prompt' && ids.record_uuid === firstPromptUuid)[0]

const commonOrigin = (store: Store, session: string): Extract<Link, { kind: 'common_origin' }> | undefined =>
  linksOf(store, runOf('claude', session)).find((link) => link.kind === 'common_origin')

const ids = (...facts: (Fact | undefined)[]): string[] => facts.map((fact) => fact?.id ?? 'missing').sort()

describe('Claude fork', () => {
  test.each([
    ['after the original', () => [originalFile(), wholeFork()]],
    ['before the original', () => [wholeFork(), originalFile()]],
    [
      'in pieces before the original',
      () => {
        const { file } = forkFile()
        return [file.batch(1, 4), file.batch(5, 20), file.batch(21, 40), file.batch(41, 49), originalFile()]
      },
    ],
  ])('starts its own run from the launch and keeps the copied history inherited when read %s', async (_, batches) => {
    const store = await ingested(batches())
    const run = runOf('claude', fork)
    const session = sessionOf('claude', fork)

    expect(store.observations.getSession(session)).toMatchObject({ run, started_at: launch })
    expect(store.model.entity(run, { kind: 'run', id: run })?.value).toMatchObject({
      root_session: session,
      created_at: launch,
    })
    expect(
      store.observations.actions(session).map(({ key, inherited, run: owner }) => [key.call, inherited, owner]),
    ).toEqual(
      expect.arrayContaining([
        [bashCall, true, run],
        [agentCall, true, run],
      ]),
    )
    expect(store.observations.actions(session)).toHaveLength(2)
    expect(store.observations.agents(session).map(({ role }) => role)).toEqual(['main'])
    expect(linksOf(store, run)).toEqual([
      {
        id: expect.any(String) as unknown,
        run,
        kind: 'common_origin',
        sessions: [sessionOf('claude', original)],
        parent_candidate: sessionOf('claude', original),
        basis: { kind: 'observed' },
        evidence: ids(launchFact(store, fork), firstPrompt(store, original)),
      },
    ])
    expect(store.observations.actions(sessionOf('claude', original)).every(({ inherited }) => !inherited)).toBe(true)
    expect(linksOf(store, runOf('claude', original)).map(({ kind }) => kind)).toEqual(['spawn'])
  })

  test('gives the same objects and links whichever of the fork and the original is read first', async () => {
    const after = await ingested([originalFile(), wholeFork()])
    const before = await ingested([wholeFork(), originalFile()])

    expect(stateOf(before, 'claude', fork)).toEqual(stateOf(after, 'claude', fork))
    expect(stateOf(before, 'claude', original)).toEqual(stateOf(after, 'claude', original))
  })

  test('without the original keeps the same inherited history and lists no visible origin', async () => {
    const alone = await ingested([wholeFork()])
    const withOriginal = await ingested([wholeFork(), originalFile()])
    const { model: aloneModel, ...aloneObjects } = stateOf(alone, 'claude', fork)
    const { model: fullModel, ...fullObjects } = stateOf(withOriginal, 'claude', fork)

    expect(aloneObjects).toEqual(fullObjects)
    expect(aloneModel.filter(([kind]) => kind !== 'link')).toEqual(fullModel.filter(([kind]) => kind !== 'link'))
    expect(commonOrigin(alone, fork)).toMatchObject({
      sessions: [],
      parent_candidate: null,
      evidence: ids(launchFact(alone, fork)),
    })
  })

  test.each([
    ['original first', () => [originalFile(), wholeFork(), wholeFork(sibling, sibling, 3n)]],
    ['forks first', () => [wholeFork(sibling, sibling, 3n), wholeFork(), originalFile()]],
  ])('lists every visible session of the same history and names no candidate among several: %s', async (_, batches) => {
    const store = await ingested(batches())
    const both = [sessionOf('claude', original), sessionOf('claude', sibling)].sort()

    expect(commonOrigin(store, fork)).toMatchObject({ sessions: both, parent_candidate: null })
    expect(commonOrigin(store, sibling)).toMatchObject({
      sessions: [sessionOf('claude', original), sessionOf('claude', fork)].sort(),
      parent_candidate: null,
    })
    expect(commonOrigin(store, original)).toBeUndefined()
  })

  test('shows the only other visible fork of the same history as the parent candidate', async () => {
    const store = await ingested([wholeFork(), wholeFork(sibling, sibling, 3n)])

    expect(commonOrigin(store, fork)).toMatchObject({
      sessions: [sessionOf('claude', sibling)],
      parent_candidate: sessionOf('claude', sibling),
    })
  })

  test('is recognized by the SessionStart fork hook before its transcript, then lists the original', async () => {
    const hook = hookBatch({
      file: 'fork.evt',
      payload: claudeHook('SessionStart.fork.json', { session: fork, cwd }),
    })
    const store = (await createHome(onTestFinished)).open()
    const engine = startEngine(store, { all: true })
    await engine.ingest(hook)
    const start = factsWith(store, fork, ({ kind }) => kind === 'session_start')[0]

    expect(store.observations.getSession(sessionOf('claude', fork))?.launches.map(({ launch: kind }) => kind)).toEqual([
      'fork',
    ])
    expect(commonOrigin(store, fork)).toMatchObject({ sessions: [], parent_candidate: null, evidence: ids(start) })

    await engine.ingest(originalFile())
    await engine.ingest(wholeFork())
    expect(commonOrigin(store, fork)).toMatchObject({
      sessions: [sessionOf('claude', original)],
      parent_candidate: sessionOf('claude', original),
      evidence: ids(start, launchFact(store, fork), firstPrompt(store, original)),
    })
  })

  test('never treats a resumed session as a fork', async () => {
    const store = await ingested([originalFile()])
    const session = sessionOf('claude', original)

    expect(store.observations.getSession(session)?.started_at).toBe(epochOf('2026-10-01T11:49:30.942Z'))
    expect(store.observations.actions(session).some(({ inherited }) => inherited)).toBe(false)
    expect(commonOrigin(store, original)).toBeUndefined()
  })
})

describe('Codex fork', () => {
  const parent = 'codex-parent'
  const forked = 'codex-fork'

  const rollout = (thread: string, ino: bigint, sessionMeta = {}) => {
    const lines = codexRollout({ thread, cwd, sessionMeta })
    return jsonlFile({ runtime: 'codex', path: `${codexSessions}/${thread}.jsonl`, lines, ino }).batch(1, lines.length)
  }
  const parentRollout = () => rollout(parent, 1n)
  const forkRollout = () => rollout(forked, 2n, { forked_from_id: parent, forked_from_ordinal_exclusive: 3 })

  test.each([
    ['after the parent', () => [parentRollout(), forkRollout()]],
    ['before the parent', () => [forkRollout(), parentRollout()]],
    ['without the parent', () => [forkRollout()]],
  ])('starts its own run branched from the run of its parent thread when read %s', async (_, batches) => {
    const store = await ingested(batches())
    const run = runOf('codex', forked)
    const start = factsWith(
      store,
      forked,
      (fact) => fact.kind === 'session_start' && fact.payload.forked_from?.session === parent,
    )

    expect(store.observations.getSession(sessionOf('codex', forked))?.run).toBe(run)
    expect(linksOf(store, run)).toEqual([
      {
        id: expect.any(String) as unknown,
        run,
        kind: 'forked_from',
        parent: runOf('codex', parent),
        basis: { kind: 'observed' },
        evidence: ids(start.sort((left, right) => (left.at < right.at ? -1 : left.at > right.at ? 1 : 0))[0]),
      },
    ])
  })
})
