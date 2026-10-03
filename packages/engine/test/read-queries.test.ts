import {
  BindingId,
  ChangeSeq,
  ChangesResponse,
  CriterionId,
  type Fact,
  ModelVersion,
  type ObserverCall,
  ObserverCallsResponse,
  type ObserverOp,
  type RunId,
  RunSnapshot,
  RunsResponse,
  StageId,
  StageInspector,
  TempId,
} from '@aang/contract'
import { objectId, runId } from '@aang/contract/ids'
import { applyChangeSet, createReadQueries, InvalidPositionError, type RunFeed } from '@aang/engine'
import { describe, expect, test } from 'vitest'
import { sessionKey } from './harness.js'
import { createHome } from './home.js'
import { at, observed } from './model.js'
import { createStage, existing, temporary } from './observer-fixtures.js'
import {
  actionOf,
  expectFeedReproduces,
  hook,
  mainAgentOf,
  openScene,
  type Scene,
  type Source,
  testRun,
  toolResult,
  toolUse,
} from './read-scene.js'
import { claudeTranscript } from './samples.js'
import { filesReplay, startScenario } from './scenarios.js'
import { clockedEngine, hook as sessionHook, sessionId, source as stateSource } from './session-fixtures.js'

const fileAgent = 'aworker-0123456789abcdef'

const time = (second: number): string => new Date(Date.UTC(2026, 9, 1, 12, 0, second)).toISOString()

const todo = (source: Source, call: string, second: number, items: readonly string[]): string[] => [
  toolUse(source, call, time(second), 'TodoWrite', {
    todos: items.map((content) => ({ content, status: 'pending' })),
  }),
  toolResult(source, call, time(second + 1), 'Todos have been modified successfully'),
]

const read = (source: Source, call: string, second: number): string[] => [
  toolUse(source, call, time(second), 'Read', { file_path: '/project/README.md' }),
  toolResult(source, call, time(second + 1), 'readme'),
]

const factsOfCall = (scene: Scene, source: Source, call: string): Fact[] =>
  scene.factsOf(source).filter(({ entity_key: key }) => key.kind === 'action' && key.call === call)

const startOf = (scene: Scene, source: Source, call: string): Fact => {
  const start = factsOfCall(scene, source, call).find(({ kind }) => kind === 'action_start')
  if (start === undefined) {
    throw new Error(`the action ${call} has no start`)
  }
  return start
}

const okObserver = () => ({ state: { state: 'ok' }, isolation_unverified: false }) as const

const snapshotOf = (scene: Scene, session: string): RunSnapshot => {
  const snapshot = scene.reads.snapshot(scene.runOf(session))
  if (snapshot === null) {
    throw new Error(`the run of ${session} must exist`)
  }
  expect(RunSnapshot.safeParse(snapshot).error).toBeUndefined()
  return snapshot
}

const buildStage = (scene: Scene, source: Source): ObserverOp[] => {
  const evidence = [startOf(scene, source, 'check-1').id]
  const grounds = { evidence, rationale: 'The tests run inside the parser work' }
  return [
    { ...createStage(evidence, 'build'), title: 'Build the parser' },
    { ...grounds, op: 'actions.assign', actions: [actionOf(source, 'check-1')], stage: temporary('build') },
    { ...grounds, op: 'agents.participate', agents: [mainAgentOf(source)], stage: temporary('build') },
    {
      ...grounds,
      op: 'criterion.add',
      temp_id: TempId.parse('tests'),
      stage: temporary('build'),
      text: 'The tests pass',
      source: 'task',
    },
    {
      ...grounds,
      op: 'attention.add',
      temp_id: TempId.parse('review'),
      kind: 'review_request',
      text: 'Review the parser',
      stage: temporary('build'),
    },
  ]
}

const playScene = (scene: Scene) => {
  const source = scene.source('session-a')
  const other = scene.source('session-b')
  const run = scene.runOf('session-a')
  const transcript = claudeTranscript(source)
  return {
    source,
    other,
    run,
    start: () => scene.transcript(source, transcript.slice(0, 20)),
    steps: [
      () =>
        scene.hooks(
          hook(source, '1-start.evt', 'SessionStart.startup.json'),
          hook(source, '2-agent.evt', 'SubagentStart.json', { agent_id: fileAgent, agent_type: 'researcher' }),
        ),
      () => scene.teammateMeta(source, fileAgent, 'worker', 'crew'),
      () =>
        scene.transcript(source, [
          ...transcript.slice(20),
          ...todo(source, 'todo-1', 0, ['Write the parser', 'Run the tests']),
          ...testRun(source, 'check-1', time(3), time(5), false),
        ]),
      () => scene.observe(run, 'call-1', factsOfCall(scene, source, 'check-1'), buildStage(scene, source), { at: 10 }),
      async () => {
        await scene.transcript(other, claudeTranscript(other).slice(0, 20))
        await scene.transcript(source, testRun(source, 'check-2', time(7), time(9), true))
      },
      () =>
        scene.store.transaction((transaction) =>
          applyChangeSet(transaction, {
            run,
            author: 'user',
            at: at(15),
            changes: [
              {
                op: 'binding.add',
                basis: observed,
                evidence: [],
                put: {
                  kind: 'binding',
                  value: {
                    id: BindingId.parse('attach-session-c'),
                    kind: 'attach',
                    session: objectId(sessionKey('claude', 'session-c')),
                    run,
                    created_at: at(15),
                    revoked_at: null,
                  },
                },
              },
            ],
          }),
        ),
      () =>
        scene.observe(
          run,
          'call-2',
          factsOfCall(scene, source, 'check-2'),
          [{ ...createStage([startOf(scene, source, 'check-2').id], 'late'), title: 'Late work' }],
          { at: 20, base: 99 },
        ),
    ],
  }
}

describe('read queries of the model', () => {
  test('a snapshot and the change feed after it give the next snapshot of the run at every step', async ({
    onTestFinished,
  }) => {
    const scene = await openScene(onTestFinished)
    const { source, other, run, start, steps } = playScene(scene)
    await start()
    let snapshot = snapshotOf(scene, 'session-a')
    const feeds: RunFeed[] = []
    for (const step of steps) {
      const before = snapshot.change_seq
      await step()
      const feed = scene.reads.feed(run, before)
      if (feed !== null) {
        feeds.push(feed)
      }
      snapshot = expectFeedReproduces(scene.reads, run, snapshot)
    }
    const [joined, refined, continued, interpreted, passed, bound, rejected] = feeds
    expect(joined?.events.some(({ event, data }) => event === 'facts' && data.objects.gaps.length > 0)).toBe(true)
    expect(refined?.events.flatMap((event) => (event.event === 'facts' ? event.data.removed : []))).toEqual([
      {
        kind: 'agent',
        id: objectId({
          kind: 'agent',
          runtime: 'claude',
          session: 'session-a',
          agent: { kind: 'subagent', agent_id: fileAgent },
        }),
        replaced_by: objectId({
          kind: 'agent',
          runtime: 'claude',
          session: 'session-a',
          agent: { kind: 'teammate', name: 'worker', team: 'crew' },
        }),
      },
    ])
    expect(
      continued?.events.flatMap((event) => (event.event === 'model' ? event.data.changes.map(({ op }) => op) : [])),
    ).toContain('attention.open')
    expect(
      continued?.events.flatMap((event) => (event.event === 'facts' ? event.data.facts.map(({ kind }) => kind) : [])),
    ).toEqual(['plan_update'])
    expect(
      interpreted?.events.flatMap((event) => (event.event === 'model' ? [event.data.version.author] : [])),
    ).toContain('observer')
    expect(passed?.events.some(({ event }) => event === 'model')).toBe(true)
    expect(bound?.run.bindings.map(({ id }) => id)).toEqual(['attach-session-c'])
    expect(rejected?.events).toEqual([])
    expect(rejected?.run.summary.observer.pending_facts).toBe(factsOfCall(scene, source, 'check-2').length)

    expect(snapshot.objects.sessions.map(({ id }) => id)).toEqual([
      objectId({ kind: 'session', runtime: 'claude', session: 'session-a' }),
    ])
    expect(snapshot.objects.agents.map(({ role }) => role)).toContain('teammate')
    expect(snapshot.objects.actions.every(({ session }) => session === snapshot.run.root_session)).toBe(true)
    expect(snapshot.plan_facts.map(({ kind }) => kind)).toEqual(['plan_update'])
    expect(snapshot.objects.gaps.find(({ kind }) => kind === 'hooks_inactive')?.closed_at).not.toBeNull()
    expect(snapshot.model.stages.map(({ title }) => title)).toEqual(['Build the parser'])
    expect(snapshot.attention.items.map(({ kind, resolution }) => [kind, resolution]).sort()).toEqual([
      ['failed_check', 'answered'],
      ['review_request', 'open'],
    ])
    expect(snapshot.bindings.map(({ kind }) => kind)).toEqual(['attach'])
    expect(scene.reads.snapshot(scene.runOf(other.session))?.objects.sessions).toHaveLength(1)
    expect(scene.reads.snapshot(scene.runOf('missing'))).toBeNull()
    expect(scene.reads.feed(scene.runOf('missing'), snapshot.change_seq)).toBeNull()
  })

  test('lists every run with the summary of its snapshot, the latest activity first', async ({ onTestFinished }) => {
    const scene = await openScene(onTestFinished)
    const { source, run, start, steps } = playScene(scene)
    await start()
    for (const step of steps) {
      await step()
    }
    const listed = scene.reads.runs()
    expect(RunsResponse.safeParse(listed).error).toBeUndefined()
    expect(listed.runs.map(({ id }) => id)).toEqual([run, scene.runOf('session-b')])
    expect(listed.change_seq).toBe(scene.store.changes.head())
    for (const summary of listed.runs) {
      expect(scene.reads.snapshot(summary.id)?.summary).toEqual(summary)
    }
    const [own, other] = listed.runs
    expect(own).toMatchObject({
      runtime: 'claude',
      root_session: objectId({ kind: 'session', runtime: 'claude', session: 'session-a' }),
      support_modes: ['full'],
      sessions: 1,
      attention: {
        open: 1,
        waiting_for_human: 0,
        by_kind: { question: 0, permission: 0, review_request: 1, blocker: 0, failed_check: 0 },
      },
      observer: {
        state: { state: 'ok' },
        pending_facts: factsOfCall(scene, source, 'check-2').length,
        deferred_facts: 0,
        not_interpreted_facts: 0,
        oldest_pending_at: startOf(scene, source, 'check-2').at,
        last_success_at: at(10),
        isolation_unverified: false,
      },
      forked_from: null,
    })
    expect(own?.agents).toBe(scene.reads.snapshot(run)?.objects.agents.length)
    expect(own?.execution).toEqual(scene.reads.snapshot(run)?.objects.sessions[0]?.execution)
    expect(own?.freshness).toBe(scene.reads.snapshot(run)?.objects.sessions[0]?.freshness)
    expect(own?.last_event_at).toBe(scene.reads.snapshot(run)?.objects.sessions[0]?.last_event_at)
    expect(other).toMatchObject({ freshness: 'hooks_inactive', support_modes: ['files_only'], sessions: 1 })
  })

  test.for(['claude', 'codex'] as const)(
    'a %s run follows its session through the turn to done',
    async (runtime, { onTestFinished }) => {
      const store = (await createHome(onTestFinished)).open()
      const { engine } = clockedEngine(store)
      const reads = createReadQueries({ store, observer: okObserver })
      const run = runId(sessionKey(runtime, stateSource.session))
      const lifecycle = [
        ['SessionStart', {}],
        ['UserPromptSubmit', { prompt: 'Start' }],
        ['Stop', {}],
        ['SessionEnd', { reason: 'other' }],
      ] as const
      const shown: string[] = []
      for (const [index, [event, fields]] of lifecycle.entries()) {
        await engine.ingest(sessionHook(event, index, fields, runtime))
        const summary = reads.snapshot(run)?.summary
        expect(reads.runs().runs).toEqual([summary])
        expect(summary?.execution).toEqual(store.observations.getSession(sessionId(runtime))?.execution)
        shown.push(summary?.execution.state ?? 'missing')
      }
      expect(shown).toEqual(['unknown', 'running', 'waiting', 'done'])
    },
  )

  test('a dependency or an assignment alone changes the stages it links and appears in their inspectors', async ({
    onTestFinished,
  }) => {
    const scene = await openScene(onTestFinished)
    const { source, run, start, steps } = playScene(scene)
    await start()
    for (const step of steps.slice(0, 4)) {
      await step()
    }
    await scene.transcript(source, read(source, 'read-1', 30))
    const facts = factsOfCall(scene, source, 'read-1')
    const evidence = [startOf(scene, source, 'read-1').id]
    const grounds = { evidence, rationale: 'The docs describe the parser' }
    const accept = (id: string, ops: ObserverOp[], second: number) => {
      const marked = snapshotOf(scene, 'session-a')
      const applied = scene.observe(run, id, facts, ops, { at: second })
      if (applied.status !== 'accepted') {
        throw new Error(`the call ${id} must be accepted`)
      }
      const changes = scene.reads.changes(run, { version: marked.summary.version, change_seq: marked.change_seq })
      expect(ChangesResponse.safeParse(changes).error).toBeUndefined()
      return { version: applied.version, stages: changes?.stages, current: snapshotOf(scene, 'session-a').model.stages }
    }
    accept('call-docs', [{ ...createStage(evidence, 'docs'), title: 'Write the docs' }], 40)
    const stages = snapshotOf(scene, 'session-a').model.stages
    const build = stages.find(({ title }) => title === 'Build the parser')
    const docs = stages.find(({ title }) => title === 'Write the docs')
    if (build === undefined || docs === undefined) {
      throw new Error('both stages must exist')
    }
    const depended = accept(
      'call-depends',
      [{ ...grounds, op: 'stage.depends', stage: existing(docs.id), depends_on: existing(build.id), via: null }],
      50,
    )
    expect(depended.stages).toEqual(
      depended.current.map((stage) => ({
        before: stage,
        after: stage,
        changes: [{ version: depended.version, index: 0 }],
      })),
    )
    expect(depended.current).toEqual(stages)
    const assigned = accept(
      'call-assign',
      [{ ...grounds, op: 'actions.assign', actions: [actionOf(source, 'read-1')], stage: existing(docs.id) }],
      60,
    )
    const unchanged = assigned.current.find(({ id }) => id === docs.id)
    expect(assigned.stages).toEqual([
      { before: unchanged, after: unchanged, changes: [{ version: assigned.version, index: 0 }] },
    ])
    const ofDocs = scene.reads.inspector(run, docs.id)
    expect(ofDocs?.actions.map(({ id }) => id)).toEqual([actionOf(source, 'read-1')])
    expect(ofDocs?.history.map(({ op, observer_call: call }) => [op, call])).toEqual([
      ['stage.create', 'call-docs'],
      ['stage.depends', 'call-depends'],
      ['actions.assign', 'call-assign'],
    ])
    expect(ofDocs?.observer_calls.map(({ id }) => id)).toEqual(['call-docs', 'call-depends', 'call-assign'])
    const ofBuild = scene.reads.inspector(run, build.id)
    const history = ofBuild?.history ?? []
    expect(history).toEqual(history.toSorted((left, right) => left.version - right.version || left.index - right.index))
    expect(history.map(({ op }) => op)).toEqual(
      expect.arrayContaining([
        'stage.create',
        'actions.assign',
        'agents.participate',
        'criterion.add',
        'attention.add',
        'attention.open',
        'stage.depends',
      ]),
    )
    expect(ofBuild?.observer_calls.map(({ id }) => id)).toEqual(['call-1', 'call-depends'])
  })

  test('the inspector shows the work, grounds, successors and observer calls of a stage', async ({
    onTestFinished,
  }) => {
    const scene = await openScene(onTestFinished)
    const { source, run, start, steps } = playScene(scene)
    await start()
    for (const step of steps.slice(0, 4)) {
      await step()
    }
    const build = scene.reads.snapshot(run)?.model.stages[0]
    if (build === undefined) {
      throw new Error('the observer must create a stage')
    }
    await scene.transcript(source, read(source, 'read-1', 30))
    const evidence = [startOf(scene, source, 'read-1').id]
    expect(
      scene.observe(
        run,
        'call-stale',
        factsOfCall(scene, source, 'read-1'),
        [
          {
            op: 'stage.update',
            stage: existing(build.id),
            title: 'Stale',
            expected_result: null,
            summary: null,
            evidence,
            rationale: 'Late',
          },
        ],
        { at: 40, base: 0 },
      ).status,
    ).toBe('rejected')
    expect(
      scene.observe(
        run,
        'call-replace',
        factsOfCall(scene, source, 'read-1'),
        [
          { ...createStage(evidence, 'release'), title: 'Release the parser' },
          {
            op: 'stage.replace',
            stage: existing(build.id),
            by: [temporary('release')],
            evidence,
            rationale: 'Replanned',
          },
          {
            op: 'stage.depends',
            stage: temporary('release'),
            depends_on: existing(build.id),
            via: null,
            evidence,
            rationale: 'Builds on it',
          },
        ],
        { at: 50 },
      ).status,
    ).toBe('accepted')
    const release = scene.reads.snapshot(run)?.model.stages.find(({ title }) => title === 'Release the parser')
    const inspected = scene.reads.inspector(run, build.id)
    if (release === undefined || inspected === null) {
      throw new Error('both stages must be readable')
    }
    expect(StageInspector.safeParse(inspected).error).toBeUndefined()
    const check = startOf(scene, source, 'check-1')
    expect(inspected).toMatchObject({
      run,
      stage: { id: build.id, lifecycle: { state: 'replaced', by: [release.id] } },
      successors: [release.id],
      predecessors: [],
      children: [],
      actions: [{ id: actionOf(source, 'check-1') }],
      agents: [{ id: mainAgentOf(source) }],
      criteria: [{ criterion: { text: 'The tests pass', stage: build.id }, snapshots: [] }],
      dependencies: [{ kind: 'dependency', stage: release.id, depends_on: build.id }],
      time: { started_at: check.at, ended_at: check.at + 2_000_000_000n, active_ms: 2000 },
      change_seq: scene.store.changes.head(),
    })
    expect(inspected.attention.map(({ kind }) => kind).sort()).toEqual(['failed_check', 'review_request'])
    expect(inspected.evidence.map(({ id }) => id)).toContain(check.id)
    expect(inspected.history.map(({ op }) => op)).toEqual(expect.arrayContaining(['stage.create', 'stage.replace']))
    expect(inspected.observer_calls.map(({ id, outcome }) => [id, outcome])).toEqual([
      ['call-1', 'accepted'],
      ['call-stale', 'rejected'],
      ['call-replace', 'accepted'],
    ])
    expect(scene.reads.inspector(run, release.id)).toMatchObject({ predecessors: [build.id], successors: [] })
    const reread = factsOfCall(scene, source, 'read-1')
    const restructure = (id: string, ops: ObserverOp[], second: number): void => {
      expect(scene.observe(run, id, reread, ops, { at: second }).status).toBe('accepted')
    }
    restructure(
      'call-split',
      [
        { ...createStage(evidence, 'parser'), title: 'Parser part' },
        { ...createStage(evidence, 'docs'), title: 'Docs part' },
        {
          op: 'stage.split',
          stage: existing(release.id),
          into: [temporary('parser'), temporary('docs')],
          evidence,
          rationale: 'Split',
        },
      ],
      60,
    )
    const parts = scene.reads.inspector(run, release.id)?.successors ?? []
    expect(parts).toHaveLength(2)
    restructure(
      'call-merge',
      [
        { ...createStage(evidence, 'whole'), title: 'Whole release' },
        {
          op: 'stage.merge',
          stages: parts.map((part) => existing(part)),
          into: temporary('whole'),
          evidence,
          rationale: 'Merge',
        },
      ],
      70,
    )
    const whole = scene.reads.snapshot(run)?.model.stages.find(({ title }) => title === 'Whole release')
    expect(parts.map((part) => scene.reads.inspector(run, part)?.successors)).toEqual([[whole?.id], [whole?.id]])
    expect(scene.reads.inspector(run, whole?.id ?? StageId.parse('missing'))?.predecessors).toEqual(parts.toSorted())
    expect(scene.reads.inspector(run, StageId.parse('missing'))).toBeNull()
    expect(scene.reads.inspector(scene.runOf('missing'), build.id)).toBeNull()
  })

  test('the changes since a model version and change position show transitions, new results and new work', async ({
    onTestFinished,
  }) => {
    const scene = await openScene(onTestFinished)
    const { source, run, start, steps } = playScene(scene)
    await start()
    for (const step of steps.slice(0, 4)) {
      await step()
    }
    await scene.transcript(source, [toolUse(source, 'long-1', time(20), 'Bash', { command: 'pnpm build' })])
    const marked = scene.reads.snapshot(run)
    if (marked === null) {
      throw new Error('the run must exist')
    }
    const mark = { version: marked.summary.version, change_seq: marked.change_seq }
    const [build] = marked.model.stages
    const [criterion] = marked.model.criteria
    const final = scene
      .factsOf(source, 'message')
      .find((fact) => fact.kind === 'message' && fact.speaker === 'solver' && fact.payload.final)
    if (build === undefined || criterion === undefined || final?.kind !== 'message') {
      throw new Error('the scene must have a stage, a criterion and a final message')
    }
    await scene.transcript(source, [
      toolResult(source, 'long-1', time(25), 'built'),
      ...read(source, 'read-1', 30),
      ...read(source, 'read-2', 32),
      ...todo(source, 'todo-2', 34, ['Release the parser']),
      ...testRun(source, 'check-3', time(36), time(38), true),
    ])
    const evidence = [startOf(scene, source, 'read-1').id]
    const fragment = final.payload.text.slice(0, 12)
    expect(
      scene.observe(
        run,
        'call-replace',
        [...factsOfCall(scene, source, 'read-1'), final],
        [
          { ...createStage(evidence, 'release'), title: 'Release the parser' },
          {
            op: 'stage.replace',
            stage: existing(build.id),
            by: [temporary('release')],
            evidence,
            rationale: 'Replanned',
          },
          {
            op: 'criterion.assess',
            criterion: { kind: 'existing', id: CriterionId.parse(criterion.id) },
            status: 'partial',
            evidence,
            rationale: 'Only some tests ran',
          },
          {
            op: 'card.add',
            stages: [temporary('release')],
            text: fragment,
            source: { fact: final.id, start: 0, end: fragment.length },
            evidence: [final.id],
            rationale: 'The final answer',
          },
          {
            op: 'attention.add',
            temp_id: TempId.parse('blocker'),
            kind: 'blocker',
            text: 'The release is blocked',
            stage: temporary('release'),
            evidence,
            rationale: 'Missing credentials',
          },
        ],
        { at: 60 },
      ).status,
    ).toBe('accepted')
    const changes = scene.reads.changes(run, mark)
    const current = scene.reads.snapshot(run)
    if (changes === null || current === null) {
      throw new Error('the run must exist')
    }
    expect(ChangesResponse.safeParse(changes).error).toBeUndefined()
    const release = current.model.stages.find(({ title }) => title === 'Release the parser')
    expect(changes.from).toEqual(mark)
    expect(changes.to).toEqual({ version: current.summary.version, change_seq: current.change_seq })
    expect(
      Object.fromEntries(
        changes.stages.map(({ before, after }) => [after.id, [before?.lifecycle.state ?? null, after.lifecycle.state]]),
      ),
    ).toEqual({ [build.id]: ['active', 'replaced'], [release?.id ?? 'release']: [null, 'active'] })
    expect(changes.stages.map(({ after }) => after.id)).toEqual(current.model.stages.map(({ id }) => id))
    expect(
      changes.stages.every(
        ({ changes: refs }) => refs.length > 0 && refs.every(({ version }) => version > mark.version),
      ),
    ).toBe(true)
    expect(changes.criteria.map(({ before, after }) => [before?.status.value, after.status.value])).toEqual([
      ['not_checked', 'partial'],
    ])
    expect(changes.cards.map(({ text }) => text)).toEqual([fragment])
    expect(changes.plan_facts).toHaveLength(1)
    expect(changes.plan_facts[0]?.payload).toMatchObject({ items: [{ text: 'Release the parser' }] })
    expect(changes.attention.opened.map(({ kind }) => kind)).toEqual(['blocker'])
    expect(changes.attention.closed.map(({ kind }) => kind)).toEqual(['failed_check'])
    expect(changes.activity).toEqual([
      {
        agent: mainAgentOf(source),
        actions: 4,
        tools: [
          { tool: 'Read', count: 2 },
          { tool: 'Bash', count: 1 },
          { tool: 'TodoWrite', count: 1 },
        ],
      },
    ])
    expect(() =>
      scene.reads.changes(run, { version: ModelVersion.parse(mark.version + 100), change_seq: mark.change_seq }),
    ).toThrow(InvalidPositionError)
    expect(() => scene.reads.feed(run, ChangeSeq.parse(current.change_seq + 1))).toThrow(InvalidPositionError)
    expect(scene.reads.changes(scene.runOf('missing'), mark)).toBeNull()
  })

  test('observer calls of a run show attempts, outcomes, rejections and the version they produced', async ({
    onTestFinished,
  }) => {
    const scene = await openScene(onTestFinished)
    const { source, run, start, steps } = playScene(scene)
    await start()
    for (const step of steps.slice(0, 4)) {
      await step()
    }
    const interpreted = scene.store.model.head(run)
    await scene.transcript(source, [...read(source, 'read-1', 30), ...read(source, 'read-2', 32)])
    const retried = factsOfCall(scene, source, 'read-1')
    const grounds = { evidence: [startOf(scene, source, 'read-1').id], rationale: 'Reading' }
    const ops: ObserverOp[] = [{ ...createStage(grounds.evidence, 'docs'), title: 'Read the docs' }]
    const heads: number[] = []
    heads.push(scene.store.model.head(run))
    expect(scene.observe(run, 'call-2', retried, ops, { at: 20, base: 0 }).status).toBe('rejected')
    heads.push(scene.store.model.head(run))
    const applied = scene.observe(run, 'call-3', retried, ops, { at: 30 })
    if (applied.status !== 'accepted') {
      throw new Error('the retried call must be accepted')
    }
    heads.push(scene.store.model.head(run))
    const running = factsOfCall(scene, source, 'read-2')
    scene.begin(run, 'call-4', running, 40)
    const listed = scene.reads.observerCalls(run)
    expect(ObserverCallsResponse.safeParse(listed).error).toBeUndefined()
    const versions = scene.store.model.versions(run, ChangeSeq.parse(0))
    const summary = ({
      id,
      kind,
      vendor,
      attempt,
      outcome,
      base_version: base,
      result_version: result,
      latency_ms: latency,
    }: ObserverCall) => ({
      id,
      kind,
      vendor,
      attempt,
      outcome,
      base,
      result,
      latency,
    })
    const [first, ...later] = listed?.calls ?? []
    expect(first && summary(first)).toMatchObject({
      id: 'call-1',
      attempt: 1,
      outcome: 'accepted',
      result: interpreted,
    })
    expect(versions.find(({ version }) => version === interpreted)?.author).toBe('rule')
    expect((first?.base_version ?? Infinity) < (first?.result_version ?? 0)).toBe(true)
    expect(later.map(summary)).toEqual([
      {
        id: 'call-2',
        kind: 'batch',
        vendor: 'claude',
        attempt: 1,
        outcome: 'rejected',
        base: heads[0],
        result: null,
        latency: 1000,
      },
      {
        id: 'call-3',
        kind: 'batch',
        vendor: 'claude',
        attempt: 2,
        outcome: 'accepted',
        base: heads[1],
        result: applied.version,
        latency: 1000,
      },
      {
        id: 'call-4',
        kind: 'batch',
        vendor: 'claude',
        attempt: 1,
        outcome: 'running',
        base: heads[2],
        result: null,
        latency: null,
      },
    ])
    expect(listed?.calls[1]?.rejections.map(({ cause }) => cause)).toEqual(['version'])
    expect(listed?.calls[3]).toMatchObject({ ended_at: null, facts: running.map(({ id }) => id) })
    expect(scene.reads.runs().runs.find(({ id }) => id === run)?.observer).toMatchObject({
      pending_facts: running.length,
      oldest_pending_at: startOf(scene, source, 'read-2').at,
      last_success_at: at(30),
    })
    expect(scene.reads.observerCalls(scene.runOf('missing'))).toBeNull()
  })

  test.for([
    ['claude-fork', 2],
    ['codex-resume-compaction', 1],
  ] as const)(
    'the %s sample scenario played through the real collector keeps each next snapshot reproducible from the feed',
    async ([name, runs]) => {
      const scenario = await startScenario(name)
      const replay = filesReplay(scenario)
      const reads = createReadQueries({ store: scenario.store, observer: okObserver })
      const snapshots = new Map<RunId, RunSnapshot>()
      const labels = scenario.manifest.steps.flatMap(({ label }) => (label === undefined ? [] : [label]))
      for (const until of [...labels, null]) {
        await replay.play(until === null ? {} : { until })
        for (const { id } of reads.runs().runs) {
          const previous = snapshots.get(id)
          const next = previous === undefined ? reads.snapshot(id) : expectFeedReproduces(reads, id, previous)
          if (next !== null) {
            snapshots.set(id, next)
          }
        }
      }
      expect(snapshots.size).toBe(runs)
      expect([...snapshots.values()].every(({ objects }) => objects.actions.length > 0)).toBe(true)
    },
  )
})
