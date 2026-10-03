import {
  type ActionId,
  type AgentId,
  BindingId,
  type CollectorBatch,
  EpochNs,
  type Link,
  LinkId,
  type ModelEntity,
  ModelVersion,
  type RunId,
  type Runtime,
  type SessionId,
  StageId,
} from '@aang/contract'
import { objectId, runId } from '@aang/contract/ids'
import { applyChangeSet, BindingError, type Engine } from '@aang/engine'
import type { Store } from '@aang/store'
import { describe, expect, onTestFinished, test } from 'vitest'
import { jsonlFile } from './batches.js'
import { factsOf, sessionKey, startEngine } from './harness.js'
import { createHome, type Home } from './home.js'
import { claudeForkTranscript, claudeTranscript, codexRollout } from './samples.js'

const cwd = '/work/project'
const projects = '/home/.claude/projects/-work-project'
const codexSessions = '/home/.codex/sessions'
const bashCall = 'toolu_017B7FeHZ4yDzFdvKQMwDJB8'
const subagentId = 'aad616394e806288d'
const stage = StageId.parse('stage-build')
const observed = { kind: 'observed' } as const

const sessionOf = (session: string, runtime: Runtime = 'claude'): SessionId => objectId(sessionKey(runtime, session))
const runOf = (session: string, runtime: Runtime = 'claude'): RunId => runId(sessionKey(runtime, session))
const bashOf = (session: string): ActionId =>
  objectId({ kind: 'action', runtime: 'claude', session, call: bashCall })
const subagentOf = (session: string): AgentId =>
  objectId({ kind: 'agent', runtime: 'claude', session, agent: { kind: 'subagent', agent_id: subagentId } })

const claudeFile = (session: string, ino: bigint) => {
  const lines = claudeTranscript({ session, cwd })
  const file = jsonlFile({ runtime: 'claude', path: `${projects}/${session}.jsonl`, lines, ino })
  return { file, length: lines.length }
}

const transcript = (session: string, ino: bigint): CollectorBatch => {
  const { file, length } = claudeFile(session, ino)
  return file.batch(1, length)
}

const forkTranscript = (session: string, ino: bigint): CollectorBatch => {
  const lines = claudeForkTranscript({ session, cwd })
  return jsonlFile({ runtime: 'claude', path: `${projects}/${session}.jsonl`, lines, ino }).batch(1, lines.length)
}

const rollout = (thread: string, ino: bigint, sessionMeta = {}): CollectorBatch => {
  const lines = codexRollout({ thread, cwd, sessionMeta })
  return jsonlFile({ runtime: 'codex', path: `${codexSessions}/${thread}.jsonl`, lines, ino }).batch(1, lines.length)
}

interface Started {
  readonly home: Home
  readonly store: Store
  readonly engine: Engine
}

const started = async (batches: readonly CollectorBatch[]): Promise<Started> => {
  const home = await createHome(onTestFinished)
  const store = home.open()
  const engine = startEngine(store, { all: true })
  for (const batch of batches) {
    await engine.ingest(batch)
  }
  return { home, store, engine }
}

const runsOfObjects = (store: Store, session: string): RunId[] => {
  const id = sessionOf(session)
  return [
    ...new Set(
      [store.observations.getSession(id), ...store.observations.agents(id), ...store.observations.actions(id)].map(
        (object) => object?.run ?? null,
      ),
    ),
  ].flatMap((run) => (run === null ? [] : [run]))
}

const membersOf = (store: Store, run: RunId): string[] =>
  store.model
    .entities(run)
    .flatMap((entity) => (entity.kind === 'session_membership' ? [entity.value.session] : []))
    .sort()

const linksOf = (store: Store, run: RunId): Link[] =>
  store.model.entities(run).flatMap((entity) => (entity.kind === 'link' ? [entity.value] : []))

const spawnedIn = (store: Store, run: RunId): string[] =>
  linksOf(store, run).flatMap((link) => (link.kind === 'spawn' ? [link.child] : []))

type LinkOf<K extends Link['kind']> = Extract<Link, { kind: K }>

const linkOfKind = <K extends Link['kind']>(store: Store, run: RunId, kind: K): LinkOf<K> | undefined =>
  linksOf(store, run).find((link): link is LinkOf<K> => link.kind === kind)

const sessionMoved = (store: Store, run: RunId): boolean | undefined => {
  const entity = store.model.entity(run, { kind: 'stage', id: stage })
  return entity?.kind === 'stage' ? entity.value.session_moved : undefined
}

const journalSince = (store: Store, run: RunId, version: ModelVersion): [string, string, string][] =>
  store.model.changes(run, version).map(({ author, op, target }) => [author, op, target.kind])

const pending = (store: Store, run: RunId): string[] =>
  store.interpretations
    .ofRun(run)
    .flatMap(({ fact, status }) => (status === 'pending' ? [fact] : []))
    .sort()

const factsOfSession = (store: Store, session: string): string[] =>
  factsOf(store)
    .filter(({ entity_key: key }) => key.session === session)
    .map(({ id }) => id)
    .sort()

const bindingsOf = (store: Store, run: RunId): ModelEntity[] =>
  store.model.entities(run).filter((entity) => entity.kind === 'binding')

const seedStage = (store: Store, run: RunId, session: string): void => {
  store.transaction((transaction) => {
    applyChangeSet(transaction, {
      run,
      author: 'rule',
      at: EpochNs.parse(1_790_000_000_000_000_000n),
      changes: [
        {
          op: 'stage.create',
          basis: observed,
          evidence: [],
          put: {
            kind: 'stage',
            value: {
              id: stage,
              run,
              title: 'Build',
              expected_result: null,
              summary: null,
              parent: null,
              origin: 'inferred',
              lifecycle: { state: 'active' },
              execution: { value: { state: 'running' }, basis: observed, evidence: [] },
              execution_claim: null,
              decision: { value: 'none', basis: observed, evidence: [] },
              session_moved: false,
              basis: observed,
              evidence: [],
            },
          },
        },
        {
          op: 'actions.assign',
          basis: observed,
          evidence: [],
          put: {
            kind: 'link',
            value: {
              id: LinkId.parse('assign-bash'),
              run,
              kind: 'assignment',
              action: bashOf(session),
              stage,
              basis: observed,
              evidence: [],
            },
          },
        },
        {
          op: 'agents.participate',
          basis: observed,
          evidence: [],
          put: {
            kind: 'link',
            value: {
              id: LinkId.parse('subagent-builds'),
              run,
              kind: 'participation',
              agent: subagentOf(session),
              stage,
              basis: observed,
              evidence: [],
            },
          },
        },
      ],
    })
  })
}

describe('moving a session between runs', () => {
  test('attaching moves the session with its objects and spawn links, marks left stages, queues its facts', async () => {
    const { store, engine } = await started([transcript('first', 1n), transcript('second', 2n)])
    const [firstRun, secondRun] = [runOf('first'), runOf('second')]
    seedStage(store, firstRun, 'first')
    const versions = [store.model.head(firstRun), store.model.head(secondRun)] as const

    const { binding, head } = await engine.bind({ kind: 'attach', session: sessionOf('first'), run: secondRun })

    expect(head).toBe(store.changes.head())
    expect(binding).toMatchObject({ kind: 'attach', session: sessionOf('first'), run: secondRun, revoked_at: null })
    expect(runsOfObjects(store, 'first')).toEqual([secondRun])
    expect(membersOf(store, secondRun)).toEqual([sessionOf('first'), sessionOf('second')].sort())
    expect(membersOf(store, firstRun)).toEqual([])
    expect(spawnedIn(store, secondRun).sort()).toEqual([subagentOf('first'), subagentOf('second')].sort())
    expect(spawnedIn(store, firstRun)).toEqual([])
    expect(sessionMoved(store, firstRun)).toBe(true)
    expect(journalSince(store, firstRun, versions[0])).toEqual([
      ['rule', 'session.move', 'session_membership'],
      ['rule', 'session.move', 'link'],
      ['rule', 'session.move', 'stage'],
    ])
    expect(journalSince(store, secondRun, versions[1])).toEqual([
      ['user', 'binding.add', 'binding'],
      ['rule', 'session.move', 'session_membership'],
      ['rule', 'session.move', 'link'],
    ])
    expect(pending(store, secondRun)).toEqual(factsOfSession(store, 'first'))
    expect(pending(store, firstRun)).toEqual([])
  })

  test('revoking the binding returns the session, its links, stage marks and queued facts to its own run', async () => {
    const { store, engine } = await started([transcript('first', 1n), transcript('second', 2n)])
    const [firstRun, secondRun] = [runOf('first'), runOf('second')]
    seedStage(store, firstRun, 'first')
    const structure = () => store.model.entities(firstRun).filter(({ kind }) => kind !== 'binding' && kind !== 'stage')
    const before = structure()
    const { binding } = await engine.bind({ kind: 'attach', session: sessionOf('first'), run: secondRun })
    const version = store.model.head(secondRun)

    const revoked = await engine.revokeBinding(binding.id)

    expect(revoked.binding).toEqual({ ...binding, revoked_at: expect.any(BigInt) as unknown })
    expect(runsOfObjects(store, 'first')).toEqual([firstRun])
    expect(membersOf(store, secondRun)).toEqual([sessionOf('second')])
    expect(spawnedIn(store, secondRun)).toEqual([subagentOf('second')])
    expect(structure()).toEqual(before)
    expect(sessionMoved(store, firstRun)).toBe(false)
    expect(journalSince(store, secondRun, version)).toEqual([
      ['user', 'binding.revoke', 'binding'],
      ['rule', 'session.move', 'session_membership'],
      ['rule', 'session.move', 'link'],
    ])
    expect(pending(store, firstRun)).toEqual(factsOfSession(store, 'first'))
    expect(pending(store, secondRun)).toEqual([])
    expect((await engine.revokeBinding(binding.id)).binding).toEqual(revoked.binding)
  })

  test('the moved session stays in its target run after a restart, further reading and a journal replay', async () => {
    const { file, length } = claudeFile('first', 1n)
    const { home, store, engine } = await started([file.batch(1, 30), transcript('second', 2n)])
    await engine.bind({ kind: 'attach', session: sessionOf('first'), run: runOf('second') })
    store.close()

    const reopened = home.open()
    await startEngine(reopened, { all: true }).ingest(file.batch(31, length))

    expect(runsOfObjects(reopened, 'first')).toEqual([runOf('second')])
    expect(membersOf(reopened, runOf('second'))).toEqual([sessionOf('first'), sessionOf('second')].sort())
    const entities = reopened.model.entities(runOf('second'))
    reopened.transaction((transaction) => {
      transaction.model.replay()
    })
    expect(reopened.model.entities(runOf('second'))).toEqual(entities)
  })

  test('a new binding supersedes the active one, and revoking it returns the session to its own run', async () => {
    const { store, engine } = await started([
      transcript('first', 1n),
      transcript('second', 2n),
      transcript('third', 3n),
    ])
    const first = await engine.bind({ kind: 'attach', session: sessionOf('first'), run: runOf('second') })
    const second = await engine.bind({ kind: 'attach', session: sessionOf('first'), run: runOf('third') })

    expect(bindingsOf(store, runOf('second'))).toEqual([
      { kind: 'binding', value: { ...first.binding, revoked_at: second.binding.created_at } },
    ])
    expect(runsOfObjects(store, 'first')).toEqual([runOf('third')])
    expect(membersOf(store, runOf('second'))).toEqual([sessionOf('second')])

    await engine.revokeBinding(second.binding.id)
    expect(runsOfObjects(store, 'first')).toEqual([runOf('first')])
    expect(membersOf(store, runOf('first'))).toEqual([sessionOf('first')])
    expect(membersOf(store, runOf('third'))).toEqual([sessionOf('third')])
  })

  test('detaching returns an attached session to its own run, and revoking the detachment keeps it there', async () => {
    const { store, engine } = await started([transcript('first', 1n), transcript('second', 2n)])
    const attached = await engine.bind({ kind: 'attach', session: sessionOf('first'), run: runOf('second') })
    const detached = await engine.bind({ kind: 'detach', session: sessionOf('first') })

    expect(detached.binding).toMatchObject({ kind: 'detach', session: sessionOf('first'), revoked_at: null })
    expect(runsOfObjects(store, 'first')).toEqual([runOf('first')])
    expect(bindingsOf(store, runOf('second'))).toEqual([
      { kind: 'binding', value: { ...attached.binding, revoked_at: detached.binding.created_at } },
    ])
    expect(bindingsOf(store, runOf('first'))).toEqual([{ kind: 'binding', value: detached.binding }])

    await engine.revokeBinding(detached.binding.id)
    expect(runsOfObjects(store, 'first')).toEqual([runOf('first')])
    expect(membersOf(store, runOf('first'))).toEqual([sessionOf('first')])
  })

  test('a fork attached to the run of its original joins it with its history still inherited', async () => {
    const { store, engine } = await started([transcript('original', 1n), forkTranscript('fork', 2n)])

    await engine.bind({ kind: 'attach', session: sessionOf('fork'), run: runOf('original') })

    expect(runsOfObjects(store, 'fork')).toEqual([runOf('original')])
    expect(store.observations.actions(sessionOf('fork')).every(({ inherited }) => inherited)).toBe(true)
    expect(membersOf(store, runOf('original'))).toEqual([sessionOf('fork'), sessionOf('original')].sort())
    expect(linkOfKind(store, runOf('fork'), 'common_origin')?.sessions).toEqual([sessionOf('original')])
  })
})

describe('fork parent', () => {
  test('is set only by an explicit binding and removed when the binding is revoked', async () => {
    const { store, engine } = await started([transcript('original', 1n), forkTranscript('fork', 2n)])
    const run = runOf('fork')
    const origin = linkOfKind(store, run, 'common_origin')

    expect(linkOfKind(store, run, 'forked_from')).toBeUndefined()
    const { binding } = await engine.bind({ kind: 'fork_parent', run, parent: sessionOf('original') })

    expect(binding).toMatchObject({ kind: 'fork_parent', run, parent: sessionOf('original'), revoked_at: null })
    expect(linkOfKind(store, run, 'forked_from')).toMatchObject({ parent: runOf('original'), evidence: [] })
    expect(linkOfKind(store, run, 'common_origin')).toEqual(origin)
    expect(runsOfObjects(store, 'fork')).toEqual([run])

    await engine.revokeBinding(binding.id)
    expect(linkOfKind(store, run, 'forked_from')).toBeUndefined()
    expect(linkOfKind(store, run, 'common_origin')).toEqual(origin)
  })

  test('overrides the parent named by a Codex fork until the binding is revoked', async () => {
    const forkMeta = { forked_from_id: 'codex-parent', forked_from_ordinal_exclusive: 3 }
    const { store, engine } = await started([
      rollout('codex-parent', 1n),
      rollout('codex-other', 2n),
      rollout('codex-fork', 3n, forkMeta),
    ])
    const run = runOf('codex-fork', 'codex')
    const runtimeLink = linkOfKind(store, run, 'forked_from')

    expect(runtimeLink).toMatchObject({ parent: runOf('codex-parent', 'codex') })
    const { binding } = await engine.bind({ kind: 'fork_parent', run, parent: sessionOf('codex-other', 'codex') })
    expect(linkOfKind(store, run, 'forked_from')).toMatchObject({ parent: runOf('codex-other', 'codex'), evidence: [] })

    await engine.revokeBinding(binding.id)
    expect(linkOfKind(store, run, 'forked_from')).toEqual(runtimeLink)
  })
})

describe('rejected bindings', () => {
  test('name what is missing or invalid and change nothing', async () => {
    const { store, engine } = await started([transcript('original', 1n), forkTranscript('fork', 2n)])
    const head = store.changes.head()
    const unknownSession = sessionOf('unknown')
    const unknownRun = runOf('unknown')
    const rejections = [
      engine.bind({ kind: 'attach', session: unknownSession, run: runOf('original') }),
      engine.bind({ kind: 'attach', session: sessionOf('fork'), run: unknownRun }),
      engine.bind({ kind: 'detach', session: unknownSession }),
      engine.bind({ kind: 'fork_parent', run: unknownRun, parent: sessionOf('original') }),
      engine.bind({ kind: 'fork_parent', run: runOf('fork'), parent: unknownSession }),
      engine.bind({ kind: 'fork_parent', run: runOf('original'), parent: sessionOf('fork') }),
      engine.bind({ kind: 'fork_parent', run: runOf('fork'), parent: sessionOf('fork') }),
      engine.revokeBinding(BindingId.parse('missing')),
    ]

    const codes = await Promise.all(
      rejections.map((rejection) =>
        rejection.then(
          () => 'accepted',
          (error: unknown) => (error instanceof BindingError ? error.code : String(error)),
        ),
      ),
    )
    expect(codes).toEqual([
      'not_found',
      'not_found',
      'not_found',
      'not_found',
      'not_found',
      'invalid_request',
      'invalid_request',
      'not_found',
    ])
    expect(store.changes.head()).toBe(head)
  })
})
