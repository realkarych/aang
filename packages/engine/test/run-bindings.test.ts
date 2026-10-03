import {
  type ActionId,
  type AgentId,
  type AttentionItem,
  BindingId,
  type CollectorBatch,
  EpochNs,
  type Fact,
  type Link,
  LinkId,
  type ModelEntity,
  ModelVersion,
  ObserverCallId,
  type RunId,
  type Runtime,
  type SessionId,
  StageId,
} from '@aang/contract'
import { objectId, runId } from '@aang/contract/ids'
import {
  applyChangeSet,
  applyObserverResponse,
  beginObserverCall,
  beginObserverFollowUp,
  BindingError,
  type Engine,
} from '@aang/engine'
import type { Store } from '@aang/store'
import { describe, expect, onTestFinished, test } from 'vitest'
import { claudeHooks, millisecond } from './attention-fixtures.js'
import { hookBatch, jsonlFile } from './batches.js'
import { factsOf, sessionKey, startEngine } from './harness.js'
import { createHome, type Home } from './home.js'
import { inputFor } from './observer-fixtures.js'
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

const queueOf = (store: Store, run: RunId) =>
  store.interpretations.ofRun(run).map(({ fact, status, attempts }) => ({ fact, status, attempts }))

const firstFactOf = (store: Store, session: string): Fact => {
  const fact = factsOf(store).find(({ entity_key: key }) => key.session === session)
  if (fact === undefined) {
    throw new Error(`the session ${session} has no facts`)
  }
  return fact
}

const callAt = EpochNs.parse(1_790_000_000_000_000_000n)

const beginCall = (store: Store, id: string, run: RunId, facts: readonly Fact[]): ObserverCallId => {
  const call = ObserverCallId.parse(id)
  store.transaction((transaction) => {
    beginObserverCall(transaction, {
      id: call,
      backend: 'claude',
      crossVendor: false,
      input: inputFor(store, [...facts], run),
      at: callAt,
    })
  })
  return call
}

const answerCall = (store: Store, call: ObserverCallId): string => {
  try {
    return store.transaction((transaction) => applyObserverResponse(transaction, { call, output: {}, at: callAt }))
      .status
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

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

  test.for(['detach', 'revoke'] as const)(
    'the rule attention items of the session move with it without run marks and come back on %s',
    async (move) => {
      const { store, engine } = await started([])
      const [root, asker] = [claudeHooks('root'), claudeHooks('asker')]
      const [run, own, session] = [runOf('root'), runOf('asker'), sessionOf('asker')]
      const question = 'Which database should the parser use?'
      const ask = { questions: [{ question, header: 'Database', options: [{ label: 'SQLite' }, { label: 'Postgres' }] }] }
      const answer = { questions: [{ question }], answers: { [question]: 'SQLite' } }
      const ruleItems = (target: RunId): AttentionItem[] =>
        store.model
          .entities(target)
          .flatMap((entity) => (entity.kind === 'attention_item' && entity.value.question !== null ? [entity.value] : []))
      await engine.ingest(hookBatch({ ...root.start(), file: 'root-start.evt' }, { ...asker.start(), file: 'asker-start.evt' }))
      await engine.ingest(hookBatch(asker.pre('ask.evt', 'ask', millisecond, ask, 'AskUserQuestion')))
      const [item, ...others] = ruleItems(own)
      if (item === undefined) {
        throw new Error('the question must have a rule attention item')
      }
      expect(others).toEqual([])
      const ref = { kind: 'attention_item', id: item.id } as const
      const opsOf = (target: RunId) =>
        store.model.entityChanges(target, ref, ModelVersion.parse(0)).map(({ op, after }) => [op, after?.kind ?? null])
      seedStage(store, own, 'asker')
      store.transaction((transaction) => {
        applyChangeSet(transaction, {
          run: own,
          author: 'rule',
          at: item.opened_at,
          changes: [
            {
              op: 'attention.priority',
              basis: observed,
              evidence: [],
              put: {
                kind: 'attention_item',
                value: {
                  ...item,
                  stage,
                  likely_resolved: { basis: observed, evidence: [] },
                  priority: { value: 'high', call: ObserverCallId.parse('marks-call') },
                },
              },
            },
          ],
        })
      })

      const attached = await engine.bind({ kind: 'attach', session, run })
      expect(ruleItems(own)).toEqual([])
      expect(ruleItems(run)).toEqual([{ ...item, run, change_seq: expect.any(Number) as unknown }])
      expect(opsOf(own).at(-1)).toEqual(['session.move', null])
      expect(opsOf(run)).toEqual([['session.move', 'attention_item']])
      await engine.ingest(hookBatch(asker.post('answer.evt', 'ask', 2 * millisecond, 'AskUserQuestion', answer)))
      expect(ruleItems(run)).toMatchObject([{ id: item.id, resolution: 'answered' }])

      await (move === 'detach' ? engine.bind({ kind: 'detach', session }) : engine.revokeBinding(attached.binding.id))
      expect(ruleItems(run)).toEqual([])
      expect(ruleItems(own)).toMatchObject([{ id: item.id, run: own, resolution: 'answered' }])
      expect(opsOf(run).at(-1)).toEqual(['session.move', null])
    },
  )

  test('a fork attached to the run of its original joins it with its history still inherited', async () => {
    const { store, engine } = await started([transcript('original', 1n), forkTranscript('fork', 2n)])

    await engine.bind({ kind: 'attach', session: sessionOf('fork'), run: runOf('original') })

    expect(runsOfObjects(store, 'fork')).toEqual([runOf('original')])
    expect(store.observations.actions(sessionOf('fork')).every(({ inherited }) => inherited)).toBe(true)
    expect(membersOf(store, runOf('original'))).toEqual([sessionOf('fork'), sessionOf('original')].sort())
    expect(linkOfKind(store, runOf('fork'), 'common_origin')?.sessions).toEqual([sessionOf('original')])
  })
})

describe('moving a session during an observer call', () => {
  test('ends the call of the source run and keeps the moved facts out of its queue, also after a restart', async () => {
    const { home, store, engine } = await started([
      transcript('first', 1n),
      transcript('second', 2n),
      transcript('third', 3n),
    ])
    const [firstRun, secondRun] = [runOf('first'), runOf('second')]
    await engine.bind({ kind: 'attach', session: sessionOf('third'), run: firstRun })
    const [own, moving] = [firstFactOf(store, 'first'), firstFactOf(store, 'third')]
    const call = beginCall(store, 'call-before-move', firstRun, [own, moving])

    await engine.bind({ kind: 'attach', session: sessionOf('third'), run: secondRun })

    expect(store.observerCalls.get(call)).toMatchObject({
      verdict: 'rejected',
      reasons: [{ op_index: null, cause: 'scope', message: expect.stringContaining(sessionOf('third')) as unknown }],
      finished_at: expect.any(BigInt) as unknown,
    })
    expect(answerCall(store, call)).toBe(`observer call ${call} is missing or already finished`)
    const queues = [
      [{ fact: own.id, status: 'pending', attempts: 1 }],
      factsOfSession(store, 'third').map((fact) => ({ fact, status: 'pending', attempts: 0 })),
    ]
    expect([queueOf(store, firstRun), queueOf(store, secondRun)]).toEqual(queues)
    store.close()

    const reopened = home.open()
    expect([queueOf(reopened, firstRun), queueOf(reopened, secondRun)]).toEqual(queues)
    const retry = beginCall(reopened, 'call-after-move', secondRun, [moving])
    expect(reopened.interpretations.ofCall(retry).map(({ run, fact }) => [run, fact])).toEqual([[secondRun, moving.id]])
  })

  test('ends an exchange that waits for its follow-up and refuses the follow-up', async () => {
    const { store, engine } = await started([
      transcript('first', 1n),
      transcript('second', 2n),
      transcript('third', 3n),
    ])
    const [firstRun, secondRun] = [runOf('first'), runOf('second')]
    await engine.bind({ kind: 'attach', session: sessionOf('third'), run: firstRun })
    const [own, moving] = [firstFactOf(store, 'first'), firstFactOf(store, 'third')]
    const call = beginCall(store, 'call-before-move', firstRun, [own, moving])
    const needs = [{ kind: 'action', action: bashOf('first') }]
    const output = { base_version: store.model.head(firstRun), ops: [], needs }
    const requested = store.transaction((transaction) =>
      applyObserverResponse(transaction, { call, output, at: callAt }),
    )
    expect(requested.status).toBe('needs_requested')

    await engine.bind({ kind: 'attach', session: sessionOf('third'), run: secondRun })

    expect(store.observerCalls.get(call)).toMatchObject({ verdict: 'needs_requested', finished_at: callAt })
    const followUp = ObserverCallId.parse('call-follow-up')
    expect(() =>
      store.transaction((transaction) =>
        beginObserverFollowUp(transaction, { previous: call, id: followUp, at: callAt, crossVendor: false }),
      ),
    ).toThrow(`fact ${moving.id} is not in run ${firstRun}`)
    expect(store.observerCalls.get(followUp)).toBeNull()
    expect([queueOf(store, firstRun), queueOf(store, secondRun)]).toEqual([
      [{ fact: own.id, status: 'pending', attempts: 1 }],
      factsOfSession(store, 'third').map((fact) => ({ fact, status: 'pending', attempts: 0 })),
    ])
  })

  test('returns the facts of a session moved back to the source run to its queue without the ended call', async () => {
    const { store, engine } = await started([transcript('first', 1n), transcript('second', 2n)])
    const [firstRun, secondRun] = [runOf('first'), runOf('second')]
    const moving = firstFactOf(store, 'first')
    const call = beginCall(store, 'call-before-move', firstRun, [moving])

    await engine.bind({ kind: 'attach', session: sessionOf('first'), run: secondRun })
    await engine.bind({ kind: 'detach', session: sessionOf('first') })

    expect(answerCall(store, call)).toBe(`observer call ${call} is missing or already finished`)
    expect(queueOf(store, firstRun)).toEqual(
      factsOfSession(store, 'first').map((fact) => ({ fact, status: 'pending', attempts: 0 })),
    )
    expect(pending(store, secondRun)).toEqual([])
    const retry = beginCall(store, 'call-after-return', firstRun, [moving])
    expect(store.interpretations.ofCall(retry).map(({ run, fact }) => [run, fact])).toEqual([[firstRun, moving.id]])
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

  test('follows the parent session moved to another run whether it is named before or after the move', async () => {
    const run = runOf('fork')
    const links = await Promise.all(
      [true, false].map(async (namedFirst) => {
        const { store, engine } = await started([
          transcript('original', 1n),
          transcript('other', 2n),
          forkTranscript('fork', 3n),
        ])
        const naming = () => engine.bind({ kind: 'fork_parent', run, parent: sessionOf('original') })
        if (namedFirst) {
          await naming()
        }
        const { binding } = await engine.bind({ kind: 'attach', session: sessionOf('original'), run: runOf('other') })
        if (!namedFirst) {
          await naming()
        }
        const moved = linkOfKind(store, run, 'forked_from')
        await engine.revokeBinding(binding.id)
        return [moved, linkOfKind(store, run, 'forked_from')]
      }),
    )

    expect(links[0]).toEqual(links[1])
    expect(links[0]).toMatchObject([{ parent: runOf('other') }, { parent: runOf('original') }])
  })

  test('of a Codex fork follows its moved parent thread whether the fork is read before or after the move', async () => {
    const forkMeta = { forked_from_id: 'codex-parent', forked_from_ordinal_exclusive: 3 }
    const fork = rollout('codex-fork', 3n, forkMeta)
    const run = runOf('codex-fork', 'codex')
    const links = await Promise.all(
      [true, false].map(async (forkFirst) => {
        const { store, engine } = await started([rollout('codex-parent', 1n), rollout('codex-other', 2n)])
        if (forkFirst) {
          await engine.ingest(fork)
        }
        const { binding } = await engine.bind({
          kind: 'attach',
          session: sessionOf('codex-parent', 'codex'),
          run: runOf('codex-other', 'codex'),
        })
        if (!forkFirst) {
          await engine.ingest(fork)
        }
        const moved = linkOfKind(store, run, 'forked_from')
        await engine.revokeBinding(binding.id)
        return [moved, linkOfKind(store, run, 'forked_from')]
      }),
    )

    expect(links[0]).toEqual(links[1])
    expect(links[0]).toMatchObject([
      { parent: runOf('codex-other', 'codex') },
      { parent: runOf('codex-parent', 'codex') },
    ])
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
