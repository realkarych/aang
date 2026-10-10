import type { DatabaseSync } from 'node:sqlite'
import {
  type AgentId,
  type AgentRef,
  type Basis,
  type CollectorBatch,
  EpochNs,
  type Link,
  LinkId,
  ModelVersion,
  type RunId,
  type Runtime,
  type StageId,
} from '@aang/contract'
import { objectId, runId } from '@aang/contract/ids'
import { applyChangeSet } from '@aang/engine'
import type { Store } from '@aang/store'
import { expect, onTestFinished, test } from 'vitest'
import { hookBatch, jsonlFile, snapshotBatch } from './batches.js'
import { factsOf, removalsOf, sessionKey, startEngine } from './harness.js'
import { createHome } from './home.js'
import { drafts, put, stages } from './model.js'
import {
  claudeAgentMeta,
  claudeAgentTranscript,
  claudeHook,
  claudeSubagentTranscript,
  claudeTranscript,
  codexChildRollout,
  codexGuardianRollout,
  codexHook,
  codexRollout,
  codexSpawnLines,
} from './samples.js'

const cwd = '/work/project'
const projects = '/home/.claude/projects/-work-project'
const codexSessions = '/home/.codex/sessions'

const claudeGoal = 'Step 1: run `echo hi` with the Bash tool. Step 2: use the Agent tool with subagent_type "pinger" and prompt "ping". Step 3: reply with exactly: OK'

const codexGoal = 'Run the shell command `echo hi` exactly once, then reply with just: OK'

const sessionOf = (runtime: Runtime, session: string) => objectId(sessionKey(runtime, session))
const runOf = (runtime: Runtime, session: string) => runId(sessionKey(runtime, session))
const agentOf = (runtime: Runtime, session: string, agent: AgentRef) =>
  objectId({ kind: 'agent', runtime, session, agent })
const mainOf = (runtime: Runtime, session: string) => agentOf(runtime, session, { kind: 'main' })
const actionOf = (runtime: Runtime, session: string, call: string) =>
  objectId({ kind: 'action', runtime, session, call })

const linksOf = (store: Store, run: RunId): Link[] =>
  store.model.entities(run).flatMap((entity) => (entity.kind === 'link' ? [entity.value] : []))

const membersOf = (store: Store, run: RunId): string[] =>
  store.model.entities(run).flatMap((entity) => (entity.kind === 'session_membership' ? [entity.value.session] : []))

const runRows = (database: DatabaseSync): string[] =>
  (database.prepare("SELECT id FROM model_entities WHERE kind = 'run' ORDER BY id").all() as { id: string }[]).map(
    ({ id }) => id,
  )

const withoutCounters = (value: object): object =>
  Object.fromEntries(Object.entries(value).filter(([field]) => field !== 'change_seq' && field !== 'version'))

const questionsOf = (store: Store, runtime: Runtime, session: string) =>
  store.observations.questions(sessionOf(runtime, session))

const stateOf = (store: Store, runtime: Runtime, session: string) => {
  const id = sessionOf(runtime, session)
  return {
    session: withoutCounters(store.observations.getSession(id) ?? {}),
    agents: store.observations.agents(id).map(withoutCounters),
    actions: store.observations.actions(id).map(withoutCounters),
    questions: questionsOf(store, runtime, session).map(withoutCounters),
    model: store.model.entities(runOf(runtime, session)).map(({ kind, value }) => [kind, withoutCounters(value)]),
  }
}

const startFacts = (store: Store, agent: string): string[] =>
  factsOf(store)
    .filter(({ kind, entity_key: key }) => kind === 'agent_start' && key.kind === 'agent' && objectId(key) === agent)
    .map(({ id }) => id)
    .sort()

const recordLine = (session: string, record: object): string => JSON.stringify({ sessionId: session, cwd, ...record })

interface ToolCall {
  readonly agent: string | null
  readonly call: string
  readonly at: string
}

const sidechainOf = (agent: string | null) => (agent === null ? {} : { isSidechain: true, agentId: agent })

const toolUse = ({ agent, call, at }: ToolCall, tool: string, input: object) => ({
  type: 'assistant',
  ...sidechainOf(agent),
  uuid: `${call}-use`,
  timestamp: at,
  message: { id: `${call}-message`, role: 'assistant', content: [{ type: 'tool_use', id: call, name: tool, input }] },
})

const toolResult = ({ agent, call, at }: ToolCall, content: string, result?: object) => ({
  type: 'user',
  ...sidechainOf(agent),
  uuid: `${call}-result`,
  timestamp: at,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: call, content }] },
  ...(result === undefined ? {} : { toolUseResult: result }),
})

const expectOwnedObjects = (store: Store, runtime: Runtime, session: string): void => {
  const id = sessionOf(runtime, session)
  const owners = [...store.observations.actions(id), ...questionsOf(store, runtime, session)].map(({ agent }) => agent)
  expect(owners.length).toBeGreaterThan(0)
  for (const owner of owners) {
    expect(owner === null ? null : store.observations.getAgent(owner)?.session).toBe(id)
  }
  for (const { parent } of store.observations.agents(id)) {
    expect(parent === null ? id : store.observations.getAgent(parent)?.session).toBe(id)
  }
}

const ingestEach = async (store: Store, batches: readonly CollectorBatch[]): Promise<void> => {
  const engine = startEngine(store, { all: true })
  for (const batch of batches) {
    await engine.ingest(batch)
  }
}

test('keeps every launch of a root session in its own run regardless of delivery order', async () => {
  const session = 'resumed'
  const source = { session, cwd }
  const run = runOf('claude', session)
  const id = sessionOf('claude', session)
  const startup = hookBatch({ file: 'startup.evt', payload: claudeHook('SessionStart.startup.json', source) })
  const resume = hookBatch({ file: 'resume.evt', arrival: 1, payload: claudeHook('SessionStart.resume.json', source) })
  const lines = claudeTranscript(source)
  const transcript = jsonlFile({ runtime: 'claude', path: `${projects}/${session}.jsonl`, lines, ino: 1n }).batch(
    1,
    lines.length,
  )
  const states = []
  for (const batches of [
    [startup, transcript, resume],
    [resume, transcript, startup],
  ]) {
    const home = await createHome(onTestFinished)
    const store = home.open()
    await ingestEach(store, batches)
    const earliest = factsOf(store)
      .map(({ at }) => at)
      .reduce((left, right) => (right < left ? right : left))
    expect(store.observations.getSession(id)).toMatchObject({ run, launches: [{ launch: 'startup' }, { launch: 'resume' }] })
    expect(
      new Set([...store.observations.agents(id), ...store.observations.actions(id)].map((object) => object.run)),
    ).toEqual(new Set([run]))
    expect(store.model.entity(run, { kind: 'run', id: run })?.value).toMatchObject({
      id: run,
      runtime: 'claude',
      root_session: id,
      goal: { text: claudeGoal },
      brief: null,
      start_pruned: false,
      created_at: earliest,
    })
    expect(membersOf(store, run)).toEqual([id])
    expect(
      store.model.changes(run, ModelVersion.parse(0)).filter(({ target }) => target.kind === 'session_membership'),
    ).toHaveLength(1)
    expect(runRows(home.database())).toEqual([run])
    states.push(stateOf(store, 'claude', session))
    const head = store.model.head(run)
    await ingestEach(store, [transcript])
    expect(store.model.head(run)).toBe(head)
    store.close()
    const reopened = home.open()
    await ingestEach(reopened, [
      hookBatch({ file: 'resume-again.evt', arrival: 2, payload: claudeHook('SessionStart.resume.json', source) }),
    ])
    expect(reopened.model.head(run)).toBe(head)
    expect(reopened.observations.getSession(id)?.launches.map(({ launch }) => launch)).toEqual([
      'startup',
      'resume',
      'resume',
    ])
  }
  expect(states[1]).toEqual(states[0])
})

test('keeps a resumed Codex thread in the run of its root thread', async () => {
  const thread = 'codex-root'
  const home = await createHome(onTestFinished)
  const store = home.open()
  const lines = codexRollout({ thread, cwd })
  await ingestEach(store, [
    jsonlFile({ runtime: 'codex', path: `${codexSessions}/${thread}.jsonl`, lines, ino: 1n }).batch(1, lines.length),
    hookBatch({
      runtime: 'codex',
      file: 'resume.evt',
      payload: codexHook('SessionStart.resume.json', { session: thread, cwd }),
    }),
  ])
  const run = runOf('codex', thread)
  expect(store.observations.sessions().map(({ id, run: owner }) => [id, owner])).toEqual([
    [sessionOf('codex', thread), run],
  ])
  expect(runRows(home.database())).toEqual([run])
  expect(membersOf(store, run)).toEqual([sessionOf('codex', thread)])
  expect(store.model.entity(run, { kind: 'run', id: run })?.value).toMatchObject({ goal: { text: codexGoal } })
})

test('takes the goal of a run from the first human prompt of its root session as an observed change', async () => {
  const session = 'goal'
  const source = { session, cwd }
  const run = runOf('claude', session)
  const home = await createHome(onTestFinished)
  const store = home.open()
  const goalOf = () => {
    const entity = store.model.entity(run, { kind: 'run', id: run })
    return entity?.kind === 'run' ? entity.value.goal : undefined
  }
  await ingestEach(store, [hookBatch({ file: 'startup.evt', payload: claudeHook('SessionStart.startup.json', source) })])
  expect(goalOf()).toBeNull()

  const lines = claudeTranscript(source)
  const transcript = jsonlFile({ runtime: 'claude', path: `${projects}/${session}.jsonl`, lines, ino: 1n })
  await ingestEach(store, [transcript.batch(1, lines.length)])
  const goal = goalOf()
  if (goal === null || goal === undefined) {
    throw new Error('the run has no goal')
  }
  expect(goal.text).toBe(claudeGoal)
  expect(store.facts.get(goal.fact)).toMatchObject({ kind: 'prompt', speaker: 'human' })
  expect(store.model.changes(run, ModelVersion.parse(0)).filter(({ op }) => op === 'run.goal')).toMatchObject([
    { author: 'rule', basis: { kind: 'observed' }, evidence: [goal.fact] },
  ])

  const head = store.model.head(run)
  await ingestEach(store, [transcript.batch(1, lines.length)])
  expect(store.model.head(run)).toBe(head)
  expect(goalOf()).toEqual(goal)
})

test('takes the goal from the earliest of two prompts with the same text regardless of delivery order', async () => {
  const thread = 'codex-goal'
  const run = runOf('codex', thread)
  const lines = codexRollout({ thread, cwd })
  const rollout = jsonlFile({ runtime: 'codex', path: `${codexSessions}/${thread}.jsonl`, lines, ino: 1n }).batch(
    1,
    lines.length,
  )
  const submit = hookBatch(
    { runtime: 'codex', file: 'start.evt', payload: codexHook('SessionStart.startup.json', { session: thread, cwd }) },
    {
      runtime: 'codex',
      file: 'prompt.evt',
      arrival: 1,
      payload: codexHook('UserPromptSubmit.json', { session: thread, cwd }, { prompt: codexGoal }),
    },
  )
  const firsts = []
  const models = []
  for (const [early, late] of [
    [submit, rollout],
    [rollout, submit],
  ] as const) {
    const home = await createHome(onTestFinished)
    const store = home.open()
    const goalOf = () => {
      const entity = store.model.entity(run, { kind: 'run', id: run })
      return entity?.kind === 'run' ? entity.value.goal : null
    }
    const engine = startEngine(store, { all: true })
    await engine.ingest(early)
    const first = goalOf()
    await engine.ingest(late)
    const [earliest, ...later] = factsOf(store)
      .flatMap((fact) => (fact.kind === 'prompt' && fact.payload.text === codexGoal ? [fact] : []))
      .toSorted((left, right) => (left.at < right.at ? -1 : left.at > right.at ? 1 : left.id < right.id ? -1 : 1))
    if (first === null || earliest === undefined) {
      throw new Error('the run has no goal')
    }
    expect(later.length).toBeGreaterThan(0)
    expect(goalOf()).toEqual({ text: codexGoal, fact: earliest.id })
    expect(
      store.model
        .changes(run, ModelVersion.parse(0))
        .filter(({ op }) => op === 'run.goal')
        .map(({ author, basis, evidence }) => ({ author, basis, evidence })),
    ).toEqual(
      [...new Set([first.fact, earliest.id])].map((fact) => ({ author: 'rule', basis: { kind: 'observed' }, evidence: [fact] })),
    )
    firsts.push(first.fact)
    models.push(store.model.entities(run).map(({ kind, value }) => [kind, withoutCounters(value)]))
  }
  expect(new Set(firsts).size).toBe(2)
  expect(models[1]).toEqual(models[0])
})

test('never links sessions that share a directory without runtime identifiers', async () => {
  const home = await createHome(onTestFinished)
  const store = home.open()
  const claudeFile = (session: string, ino: bigint) => {
    const lines = claudeTranscript({ session, cwd })
    return jsonlFile({ runtime: 'claude', path: `${projects}/${session}.jsonl`, lines, ino }).batch(1, lines.length)
  }
  const codexFile = (thread: string, ino: bigint) => {
    const lines = codexRollout({ thread, cwd })
    return jsonlFile({ runtime: 'codex', path: `${codexSessions}/${thread}.jsonl`, lines, ino }).batch(1, lines.length)
  }
  await ingestEach(store, [
    claudeFile('first', 1n),
    hookBatch(
      { file: 'first.evt', payload: claudeHook('SessionStart.startup.json', { session: 'first', cwd }) },
      {
        file: 'cleared.evt',
        arrival: 1,
        payload: claudeHook('SessionStart.startup.json', { session: 'cleared', cwd }, { source: 'clear' }),
      },
    ),
    claudeFile('second', 2n),
    codexFile('thread-one', 3n),
    codexFile('thread-two', 4n),
  ])
  const sessions = [
    ['claude', 'first'],
    ['claude', 'second'],
    ['claude', 'cleared'],
    ['codex', 'thread-one'],
    ['codex', 'thread-two'],
  ] as const
  expect(runRows(home.database())).toEqual(sessions.map(([runtime, session]) => runOf(runtime, session)).sort())
  for (const [runtime, session] of sessions) {
    const run = runOf(runtime, session)
    const id = sessionOf(runtime, session)
    expect(store.observations.getSession(id)?.run).toBe(run)
    expect(membersOf(store, run)).toEqual([id])
    expect(store.observations.agents(id).every((agent) => agent.run === run)).toBe(true)
    for (const link of linksOf(store, run)) {
      expect(link.kind === 'spawn' ? store.observations.getAgent(link.child)?.session : link.kind).toBe(id)
    }
  }
  expect(store.observations.getSession(sessionOf('claude', 'cleared'))?.launches.map(({ launch }) => launch)).toEqual(
    ['clear'],
  )
})

test.each(['in delivery order', 'with the stop ahead of PreCompact'])(
  'treats the false SubagentStop of compaction as a compaction event, not an agent: %s',
  async (order) => {
    const session = 'compacted'
    const source = { session, cwd }
    const hook = (file: string, name: string, arrival: number) => ({
      file,
      arrival,
      payload: claudeHook(name, source),
    })
    const startup = hook('1-startup.evt', 'SessionStart.startup.json', 0)
    const preCompact = hook('2-pre-compact.evt', 'PreCompact.manual.json', 1)
    const falseStop = hook('3-false-stop.evt', 'SubagentStop.internal-compaction.json', 2)
    const compactStart = hook('4-compact.evt', 'SessionStart.compact.json', 3)
    const postCompact = hook('5-post-compact.evt', 'PostCompact.manual.json', 4)
    const subagentStart = hook('6-subagent-start.evt', 'SubagentStart.json', 5)
    const subagentStop = hook('7-subagent-stop.evt', 'SubagentStop.json', 6)
    const id = sessionOf('claude', session)
    const compaction = agentOf('claude', session, { kind: 'subagent', agent_id: 'aba57616e9a18e7bc' })
    const subagent = agentOf('claude', session, { kind: 'subagent', agent_id: 'a0885622b68c3d0f1' })
    const store = (await createHome(onTestFinished)).open()
    const engine = startEngine(store, { all: true })
    if (order === 'in delivery order') {
      await engine.ingest(
        hookBatch(startup, preCompact, falseStop, compactStart, postCompact, subagentStart, subagentStop),
      )
    } else {
      await engine.ingest(hookBatch(startup, falseStop))
      expect(store.observations.agents(id).map(({ role }) => role)).toEqual(['main'])
      await engine.ingest(hookBatch(subagentStop))
      expect(store.observations.agents(id)).toHaveLength(2)
      expect(store.observations.getAgent(subagent)).toMatchObject({
        role: 'subagent',
        agent_type: 'echoer',
        started_at: null,
        execution: { state: 'done' },
      })
      await engine.ingest(hookBatch(preCompact, compactStart, postCompact, subagentStart))
    }
    expect(store.observations.agents(id).map(({ id: agent, role, agent_type }) => [agent, role, agent_type])).toEqual(
      expect.arrayContaining([
        [mainOf('claude', session), 'main', null],
        [subagent, 'subagent', 'echoer'],
      ]),
    )
    expect(store.observations.agents(id)).toHaveLength(2)
    expect(store.observations.getAgent(subagent)?.started_at).not.toBeNull()
    expect(store.observations.getAgent(compaction)).toBeNull()
    const facts = factsOf(store)
    expect(
      facts.filter(({ kind, entity_key: key }) => kind === 'agent_end' && key.kind === 'agent' && objectId(key) === compaction),
    ).toMatchObject([{ payload: { agent_type: '' } }])
    expect(facts.flatMap((fact) => (fact.kind === 'compaction' ? [fact.payload.phase] : []))).toEqual([
      'started',
      'completed',
    ])
    expect(store.observations.getSession(id)?.launches.map(({ launch }) => launch)).toEqual(['startup'])
    expect(linksOf(store, runOf('claude', session))).toEqual([])
  },
)

test('links a Claude subagent to its spawning call by meta.toolUseId and toolUseResult.agentId in any order', async () => {
  const session = 'spawner'
  const source = { session, cwd }
  const subagentId = 'aad616394e806288d'
  const call = 'toolu_01D254DDPoZEYPvJBjampKox'
  const run = runOf('claude', session)
  const main = mainOf('claude', session)
  const subagent = agentOf('claude', session, { kind: 'subagent', agent_id: subagentId })
  const via = actionOf('claude', session, call)
  const mainLines = claudeTranscript(source)
  const mainFile = jsonlFile({ runtime: 'claude', path: `${projects}/${session}.jsonl`, lines: mainLines, ino: 1n })
  const ownLines = claudeSubagentTranscript(source)
  const own = jsonlFile({
    runtime: 'claude',
    path: `${projects}/${session}/subagents/agent-${subagentId}.jsonl`,
    lines: ownLines,
    ino: 2n,
  }).batch(1, ownLines.length)
  const meta = snapshotBatch({
    path: `${projects}/${session}/subagents/agent-${subagentId}.meta.json`,
    content: JSON.parse(claudeAgentMeta()),
  })
  const callLine = mainLines.findIndex((line) => line.includes(`"id":"${call}"`)) + 1
  expect(callLine).toBeGreaterThan(0)
  const beforeResult = mainFile.batch(1, callLine)
  const afterResult = mainFile.batch(callLine + 1, mainLines.length)
  const states = []
  for (const batches of [
    [mainFile.batch(1, mainLines.length), own, meta],
    [meta, own, mainFile.batch(1, mainLines.length)],
    [beforeResult, meta, own, afterResult],
  ]) {
    const store = (await createHome(onTestFinished)).open()
    const engine = startEngine(store, { all: true })
    for (const batch of batches) {
      await engine.ingest(batch)
      if (batch === own && batches[0] === beforeResult) {
        const spawn = factsOf(store).find(
          (fact) => fact.kind === 'action_start' && fact.entity_key.kind === 'action' && fact.entity_key.call === call,
        )
        expect(store.observations.getAgent(subagent)).toMatchObject({ parent: main, spawned_by: via, run })
        expect(linksOf(store, run)).toMatchObject([
          { kind: 'spawn', parent: main, child: subagent, via, evidence: [...startFacts(store, subagent), spawn?.id].sort() },
        ])
      }
    }
    expect(store.observations.getAgent(subagent)).toMatchObject({
      run,
      role: 'subagent',
      agent_type: 'pinger',
      parent: main,
      spawned_by: via,
    })
    const starts = startFacts(store, subagent)
    expect(starts).toHaveLength(2)
    expect(linksOf(store, run)).toMatchObject([
      {
        run,
        kind: 'spawn',
        parent: main,
        child: subagent,
        via,
        basis: { kind: 'observed' },
        evidence: starts,
      },
    ])
    states.push(stateOf(store, 'claude', session))
  }
  expect(states[1]).toEqual(states[0])
  expect(states[2]).toEqual(states[0])
})

test('keeps Codex subagents and the guardian in the run of their root thread', async () => {
  const root = 'root-thread'
  const child = 'child-thread'
  const guardian = 'guardian-thread'
  const call = 'spawn-call'
  const run = runOf('codex', root)
  const main = mainOf('codex', root)
  const childAgent = agentOf('codex', root, { kind: 'thread', thread_id: child })
  const guardianAgent = agentOf('codex', root, { kind: 'thread', thread_id: guardian })
  const file = (name: string, lines: readonly string[], ino: bigint) =>
    jsonlFile({ runtime: 'codex', path: `${codexSessions}/${name}.jsonl`, lines, ino }).batch(1, lines.length)
  const rootLines = [...codexRollout({ thread: root, cwd }), ...codexSpawnLines({ root, child, call, ordinal: 41 })]
  const rootFile = file('root', rootLines, 1n)
  const childFile = file('child', codexChildRollout({ root, thread: child, cwd }).slice(0, 1), 2n)
  const guardianFile = file('guardian', codexGuardianRollout({ root, thread: guardian, cwd }), 3n)
  const states = []
  for (const batches of [
    [rootFile, childFile, guardianFile],
    [guardianFile, childFile, rootFile],
  ]) {
    const home = await createHome(onTestFinished)
    const store = home.open()
    await ingestEach(store, batches)
    expect(store.observations.sessions().map(({ id }) => id)).toEqual([sessionOf('codex', root)])
    expect(runRows(home.database())).toEqual([run])
    expect(store.observations.getAgent(childAgent)).toMatchObject({
      run,
      role: 'subagent',
      parent: main,
      spawned_by: actionOf('codex', root, call),
    })
    expect(store.observations.getAgent(guardianAgent)).toMatchObject({
      run,
      role: 'service',
      service: 'guardian',
      parent: main,
      spawned_by: null,
    })
    expect(store.observations.getAction(actionOf('codex', root, call))).toMatchObject({ run, agent: main })
    expect(
      linksOf(store, run)
        .map((link) => (link.kind === 'spawn' ? [link.parent, link.child, link.via, link.evidence] : []))
        .sort(),
    ).toEqual(
      [
        [main, childAgent, actionOf('codex', root, call), startFacts(store, childAgent)],
        [main, guardianAgent, null, startFacts(store, guardianAgent)],
      ].sort(),
    )
    expect(startFacts(store, childAgent)).toHaveLength(2)
    states.push(stateOf(store, 'codex', root))
  }
  expect(states[1]).toEqual(states[0])
})

test('joins the transcript of an in-process teammate to its name@team agent in any order', async () => {
  const session = 'lead'
  const source = { session, cwd }
  const transcriptAgent = 'aworker-0123456789abcdef'
  const spawnCall = 'spawn-teammate'
  const teammateCall = 'teammate-call'
  const run = runOf('claude', session)
  const main = mainOf('claude', session)
  const teammate = agentOf('claude', session, { kind: 'teammate', name: 'worker', team: 'crew' })
  const line = (record: object) => recordLine(session, record)
  const mainLines = [
    ...claudeTranscript(source).slice(0, 5),
    line({
      type: 'assistant',
      uuid: 'spawn-use',
      timestamp: '2026-10-01T11:50:00.000Z',
      message: {
        id: 'spawn-message',
        role: 'assistant',
        content: [{ type: 'tool_use', id: spawnCall, name: 'Agent', input: { name: 'worker', team_name: 'crew' } }],
      },
    }),
    line({
      type: 'user',
      uuid: 'spawn-result',
      timestamp: '2026-10-01T11:50:01.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: spawnCall, content: 'Spawned worker' }] },
      toolUseResult: {
        status: 'teammate_spawned',
        name: 'worker',
        team_name: 'crew',
        agent_id: 'worker@crew',
        agent_type: 'researcher',
      },
    }),
  ]
  const ownLines = [
    ...claudeAgentTranscript(source, transcriptAgent),
    line({
      type: 'assistant',
      isSidechain: true,
      agentId: transcriptAgent,
      uuid: 'teammate-use',
      timestamp: '2026-10-01T11:51:00.000Z',
      message: {
        id: 'teammate-message',
        role: 'assistant',
        content: [{ type: 'tool_use', id: teammateCall, name: 'Bash', input: { command: 'pnpm test' } }],
      },
    }),
    line({
      type: 'user',
      isSidechain: true,
      agentId: transcriptAgent,
      uuid: 'teammate-result',
      timestamp: '2026-10-01T11:51:01.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: teammateCall, content: 'ok' }] },
    }),
  ]
  const mainFile = jsonlFile({ runtime: 'claude', path: `${projects}/${session}.jsonl`, lines: mainLines, ino: 1n })
  const leadBatch = mainFile.batch(1, mainLines.length)
  const ownBatch = jsonlFile({
    runtime: 'claude',
    path: `${projects}/${session}/subagents/agent-${transcriptAgent}.jsonl`,
    lines: ownLines,
    ino: 2n,
  }).batch(1, ownLines.length)
  const meta = snapshotBatch({
    path: `${projects}/${session}/subagents/agent-${transcriptAgent}.meta.json`,
    content: {
      agentType: 'researcher',
      name: 'worker',
      teamName: 'crew',
      taskKind: 'in_process_teammate',
      requestShape: 'background',
      spawnDepth: 1,
    },
  })
  const team = snapshotBatch({
    path: '/home/.claude/teams/crew/config.json',
    content: {
      name: 'crew',
      leadSessionId: session,
      members: [{ agentId: 'worker@crew', name: 'worker', agentType: 'researcher', backendType: 'in-process' }],
    },
  })
  const states = []
  for (const batches of [
    [leadBatch, ownBatch, meta, team],
    [leadBatch, meta, team, ownBatch],
    [ownBatch, team, meta, leadBatch],
  ]) {
    const home = await createHome(onTestFinished)
    const store = home.open()
    await ingestEach(store, batches)
    const id = sessionOf('claude', session)
    expect(store.observations.agents(id).map(({ role }) => role).sort()).toEqual(['main', 'teammate'])
    expect(store.observations.getAgent(teammate)).toMatchObject({
      run,
      role: 'teammate',
      name: 'worker',
      agent_type: 'researcher',
      parent: main,
      spawned_by: actionOf('claude', session, spawnCall),
    })
    expect(store.observations.getAgent(agentOf('claude', session, { kind: 'subagent', agent_id: transcriptAgent }))).toBeNull()
    expect(store.observations.getAction(actionOf('claude', session, teammateCall))).toMatchObject({
      run,
      agent: teammate,
      tool: 'Bash',
    })
    expect(linksOf(store, run)).toMatchObject([
      { kind: 'spawn', parent: main, child: teammate, via: actionOf('claude', session, spawnCall) },
    ])
    expect(runRows(home.database())).toEqual([run])
    states.push(stateOf(store, 'claude', session))
  }
  expect(states[1]).toEqual(states[0])
  expect(states[2]).toEqual(states[0])
})

test('projects a subagent known only from its transcript, actions, question and stop, and completes it once its start arrives', async () => {
  const session = 'unannounced'
  const source = { session, cwd }
  const subagentId = 'aad616394e806288d'
  const spawnCall = 'toolu_01D254DDPoZEYPvJBjampKox'
  const bash: ToolCall = { agent: subagentId, call: 'subagent-bash', at: '2026-10-01T11:49:36.500Z' }
  const run = runOf('claude', session)
  const id = sessionOf('claude', session)
  const main = mainOf('claude', session)
  const subagent = agentOf('claude', session, { kind: 'subagent', agent_id: subagentId })
  const ownPath = `${projects}/${session}/subagents/agent-${subagentId}.jsonl`
  const ownLines = [
    ...claudeSubagentTranscript(source),
    recordLine(session, toolUse(bash, 'Bash', { command: 'pnpm test' })),
    recordLine(session, toolResult({ ...bash, at: '2026-10-01T11:49:36.900Z' }, 'ok')),
  ]
  const own = jsonlFile({ runtime: 'claude', path: ownPath, lines: ownLines, ino: 2n }).batch(1, ownLines.length)
  const hook = (file: string, name: string, arrival: number, changes: Record<string, string>) =>
    hookBatch({ file, arrival, payload: claudeHook(name, source, { agent_id: subagentId, ...changes }) })
  const startup = hookBatch({ file: '0-startup.evt', payload: claudeHook('SessionStart.startup.json', source) })
  const permission = hook('2-permission.evt', 'PermissionRequest.Bash.json', 2, {})
  const stop = hook('3-stop.evt', 'SubagentStop.json', 3, { agent_type: 'pinger', agent_transcript_path: ownPath })
  const start = hook('1-start.evt', 'SubagentStart.json', 1, { agent_type: 'pinger' })
  const mainLines = claudeTranscript(source)
  const lead = jsonlFile({ runtime: 'claude', path: `${projects}/${session}.jsonl`, lines: mainLines, ino: 1n }).batch(
    1,
    mainLines.length,
  )
  const meta = snapshotBatch({ path: `${projects}/${session}/subagents/agent-${subagentId}.meta.json`, content: JSON.parse(claudeAgentMeta()) })
  const states = []
  const deliveries: [CollectorBatch[], CollectorBatch[]][] = [
    [[startup, own, permission, stop], [lead, meta, start]],
    [[startup, lead, meta, start, own, permission, stop], []],
  ]
  for (const [early, late] of deliveries) {
    const store = (await createHome(onTestFinished)).open()
    await ingestEach(store, early)
    if (late.length > 0) {
      expect(store.observations.agents(id).map(({ id: agent }) => agent).sort()).toEqual([main, subagent].sort())
      expect(store.observations.getAgent(subagent)).toMatchObject({
        run,
        role: 'subagent',
        agent_type: 'pinger',
        parent: null,
        spawned_by: null,
        started_at: null,
        execution: { state: 'done' },
      })
      expect(store.observations.getAction(actionOf('claude', session, bash.call))).toMatchObject({ run, agent: subagent })
      expect(questionsOf(store, 'claude', session)).toMatchObject([{ run, agent: subagent, kind: 'permission' }])
      expectOwnedObjects(store, 'claude', session)
      expect(linksOf(store, run)).toEqual([])
      await ingestEach(store, late)
    }
    expect(store.observations.getAgent(subagent)).toMatchObject({
      run,
      role: 'subagent',
      agent_type: 'pinger',
      parent: main,
      spawned_by: actionOf('claude', session, spawnCall),
      execution: { state: 'done' },
    })
    expect(store.observations.getAgent(subagent)?.started_at).toBe(
      factsOf(store)
        .filter(({ kind, entity_key: key }) => kind === 'agent_start' && key.kind === 'agent' && objectId(key) === subagent)
        .map(({ at }) => at)
        .reduce((left, right) => (right < left ? right : left)),
    )
    expectOwnedObjects(store, 'claude', session)
    expect(linksOf(store, run)).toMatchObject([{ kind: 'spawn', parent: main, child: subagent }])
    expect(removalsOf(store)).toEqual([])
    states.push(stateOf(store, 'claude', session))
  }
  expect(states[1]).toEqual(states[0])
})

test('replaces the subagent known by its file id with its name@team teammate in one transaction, regardless of order and restarts', async () => {
  const session = 'crew-lead'
  const source = { session, cwd }
  const fileAgent = 'aworker-0123456789abcdef'
  const run = runOf('claude', session)
  const id = sessionOf('claude', session)
  const main = mainOf('claude', session)
  const subagent = agentOf('claude', session, { kind: 'subagent', agent_id: fileAgent })
  const teammate = agentOf('claude', session, { kind: 'teammate', name: 'worker', team: 'crew' })
  const hook = (file: string, name: string, arrival: number, changes: Record<string, string> = {}) =>
    hookBatch({ file, arrival, payload: claudeHook(name, source, changes) })
  const startup = hook('0-startup.evt', 'SessionStart.startup.json', 0)
  const start = hook('1-start.evt', 'SubagentStart.json', 1, { agent_id: fileAgent, agent_type: 'researcher' })
  const stop = hook('3-stop.evt', 'SubagentStop.json', 3, { agent_id: fileAgent, agent_type: 'researcher' })
  const meta = snapshotBatch({
    path: `${projects}/${session}/subagents/agent-${fileAgent}.meta.json`,
    arrival: 2,
    content: { agentType: 'researcher', name: 'worker', teamName: 'crew', taskKind: 'in_process_teammate' },
  })
  const states = []
  for (const order of [
    [startup, start, meta, stop],
    [startup, meta, start, stop],
  ]) {
    const home = await createHome(onTestFinished)
    const store = home.open()
    const engine = startEngine(store, { all: true })
    for (const batch of order) {
      const before = store.changes.head()
      await engine.ingest(batch)
      if (batch === start && order[2] === meta) {
        expect(store.observations.getAgent(subagent)).toMatchObject({ role: 'subagent', execution: { state: 'running' } })
      }
      if (batch === meta && order[1] === start) {
        const removal = store.observations.getRemoval({ kind: 'agent', id: subagent })
        const replacement = store.observations.getAgent(teammate)
        expect(removal).toMatchObject({ kind: 'agent', id: subagent, replaced_by: teammate, run })
        expect(replacement).toMatchObject({ role: 'teammate', name: 'worker', run })
        expect(replacement?.change_seq).toBeGreaterThan(before)
        expect(removal?.change_seq).toBeGreaterThan(before)
        expect(removalsOf(store)).toEqual([removal])
      }
    }
    expect(store.observations.getAgent(subagent)).toBeNull()
    expect(store.observations.agents(id).map(({ id: agent }) => agent).sort()).toEqual([main, teammate].sort())
    expect(store.observations.getAgent(teammate)).toMatchObject({
      run,
      role: 'teammate',
      name: 'worker',
      agent_type: 'researcher',
      execution: { state: 'done' },
    })
    store.close()
    const reopened = home.open()
    await ingestEach(reopened, [hook('4-resume.evt', 'SessionStart.resume.json', 4)])
    expect(reopened.observations.getAgent(subagent)).toBeNull()
    expect(reopened.observations.agents(id).map(({ id: agent }) => agent).sort()).toEqual([main, teammate].sort())
    expect(reopened.observations.getAgent(teammate)?.execution).toEqual({ state: 'done' })
    expect(removalsOf(reopened).map(({ id: removed, replaced_by: replacement }) => [removed, replacement])).toEqual(
      order[1] === start ? [[subagent, teammate]] : [],
    )
    states.push(stateOf(reopened, 'claude', session))
  }
  expect(states[1]).toEqual(states[0])
})

test('retargets the model links of a replaced subagent to its teammate through the journal', async () => {
  const session = 'crew-links'
  const source = { session, cwd }
  const fileAgent = 'aworker-fedcba9876543210'
  const childAgent = 'achild-0123456789abcdef'
  const spawnTeammate: ToolCall = { agent: null, call: 'spawn-teammate', at: '2026-10-01T11:50:00.000Z' }
  const work: ToolCall = { agent: fileAgent, call: 'teammate-bash', at: '2026-10-01T11:51:00.000Z' }
  const spawnChild: ToolCall = { agent: fileAgent, call: 'teammate-spawn', at: '2026-10-01T11:52:00.000Z' }
  const run = runOf('claude', session)
  const main = mainOf('claude', session)
  const subagent = agentOf('claude', session, { kind: 'subagent', agent_id: fileAgent })
  const teammate = agentOf('claude', session, { kind: 'teammate', name: 'worker', team: 'crew' })
  const child = agentOf('claude', session, { kind: 'subagent', agent_id: childAgent })
  const line = (record: object) => recordLine(session, record)
  const leadLines = [
    ...claudeTranscript(source).slice(0, 5),
    line(toolUse(spawnTeammate, 'Agent', { name: 'worker', team_name: 'crew' })),
    line(
      toolResult({ ...spawnTeammate, at: '2026-10-01T11:50:01.000Z' }, 'Spawned worker', {
        status: 'teammate_spawned',
        name: 'worker',
        team_name: 'crew',
        agent_id: 'worker@crew',
        agent_type: 'researcher',
      }),
    ),
  ]
  const ownLines = [
    ...claudeAgentTranscript(source, fileAgent),
    line(toolUse(work, 'Bash', { command: 'pnpm test' })),
    line(toolResult({ ...work, at: '2026-10-01T11:51:01.000Z' }, 'ok')),
    line(toolUse(spawnChild, 'Agent', { description: 'Check the parser', prompt: 'Run the parser checks' })),
    line(
      toolResult({ ...spawnChild, at: '2026-10-01T11:52:01.000Z' }, 'Checked', {
        agentId: childAgent,
        agentType: 'pinger',
        status: 'completed',
      }),
    ),
  ]
  const lead = jsonlFile({ runtime: 'claude', path: `${projects}/${session}.jsonl`, lines: leadLines, ino: 1n }).batch(
    1,
    leadLines.length,
  )
  const own = jsonlFile({
    runtime: 'claude',
    path: `${projects}/${session}/subagents/agent-${fileAgent}.jsonl`,
    lines: ownLines,
    ino: 2n,
  }).batch(1, ownLines.length)
  const meta = snapshotBatch({
    path: `${projects}/${session}/subagents/agent-${fileAgent}.meta.json`,
    content: { agentType: 'researcher', name: 'worker', teamName: 'crew', taskKind: 'in_process_teammate' },
  })
  const stageRule: Basis = { kind: 'interpreted', interpreter: { kind: 'rule', rule: 'stage-execution' } }
  const participation = (link: string, agent: AgentId, stage: StageId): Link => ({
    id: LinkId.parse(link),
    run,
    kind: 'participation',
    agent,
    stage,
    basis: stageRule,
    evidence: [],
  })
  const assign = (store: Store, participants: readonly Link[]): void => {
    store.transaction((transaction) => {
      applyChangeSet(transaction, {
        run,
        author: 'rule',
        at: EpochNs.parse(1n),
        changes: [
          put('stage.create', { kind: 'stage', value: { ...drafts.build, run } }, stageRule, []),
          put('stage.create', { kind: 'stage', value: { ...drafts.testing, run } }, stageRule, []),
          ...participants.map((link) => put('link.add', { kind: 'link', value: link }, stageRule, [])),
        ],
      })
    })
  }
  const stageLinks = (store: Store) =>
    linksOf(store, run)
      .flatMap((link) => (link.kind === 'participation' ? [[link.stage, link.agent]] : []))
      .sort()
  const spawnLinks = (store: Store) => linksOf(store, run).filter((link) => link.kind === 'spawn').map(withoutCounters)
  const replaced = (await createHome(onTestFinished)).open()
  const engine = startEngine(replaced, { all: true })
  await engine.ingest(lead)
  await engine.ingest(own)
  expect(replaced.observations.getAgent(subagent)).toMatchObject({ role: 'subagent', run })
  expect(replaced.observations.getAgent(child)).toMatchObject({ parent: subagent })
  expect(replaced.observations.getAction(actionOf('claude', session, work.call))?.agent).toBe(subagent)
  const childLink = linksOf(replaced, run).find((link) => link.kind === 'spawn' && link.child === child)
  expect(childLink).toMatchObject({ parent: subagent, via: actionOf('claude', session, spawnChild.call) })
  assign(replaced, [
    participation('build-subagent', subagent, stages.build),
    participation('build-teammate', teammate, stages.build),
    participation('test-subagent', subagent, stages.test),
  ])
  const version = replaced.model.head(run)
  await engine.ingest(meta)
  const evidence = factsOf(replaced)
    .filter((fact) => fact.kind === 'json_snapshot' && fact.payload.file === 'agent_meta')
    .map(({ id }) => id)
  expect(evidence).toHaveLength(1)
  expect(replaced.observations.getRemoval({ kind: 'agent', id: subagent })?.replaced_by).toBe(teammate)
  expect(replaced.observations.getAgent(teammate)).toMatchObject({ role: 'teammate', parent: main })
  expect(replaced.observations.getAgent(child)).toMatchObject({ parent: teammate })
  expect(replaced.observations.getAction(actionOf('claude', session, work.call))?.agent).toBe(teammate)
  expectOwnedObjects(replaced, 'claude', session)
  expect(
    replaced.model
      .changes(run, version)
      .filter(({ op }) => op === 'link.retarget' || op === 'link.remove')
      .map(({ op, target, after, evidence: grounds }) => [op, target.id, after?.kind === 'link' ? after.value : null, grounds]),
  ).toEqual(
    expect.arrayContaining([
      ['link.remove', 'build-subagent', null, evidence],
      ['link.retarget', 'test-subagent', participation('test-subagent', teammate, stages.test), evidence],
      ['link.retarget', childLink?.id, { ...childLink, parent: teammate }, evidence],
    ]),
  )
  expect(
    replaced.model.changes(run, version).filter(({ op }) => op === 'link.retarget' || op === 'link.remove'),
  ).toHaveLength(3)
  expect(linksOf(replaced, run).find(({ id }) => id === 'test-subagent')).toEqual(
    participation('test-subagent', teammate, stages.test),
  )
  expect(stageLinks(replaced)).toEqual([
    [stages.build, teammate],
    [stages.test, teammate],
  ])
  const direct = (await createHome(onTestFinished)).open()
  await ingestEach(direct, [meta, lead, own])
  assign(direct, [participation('build', teammate, stages.build), participation('test', teammate, stages.test)])
  expect(direct.observations.getAgent(subagent)).toBeNull()
  expect(removalsOf(direct)).toEqual([])
  expect(stageLinks(direct)).toEqual(stageLinks(replaced))
  expect(spawnLinks(direct)).toEqual(spawnLinks(replaced))
  const objectsOf = (store: Store) => {
    const { session: observed, agents, actions, questions } = stateOf(store, 'claude', session)
    return { observed, agents, actions, questions }
  }
  expect(objectsOf(direct)).toEqual(objectsOf(replaced))
})

test('withdraws the spawn link derived from a replaced subagent and links its teammate in its place', async () => {
  const session = 'crew-spawn'
  const source = { session, cwd }
  const fileAgent = 'aworker-00112233445566ff'
  const spawn: ToolCall = { agent: null, call: 'spawn-background', at: '2026-10-01T11:50:00.000Z' }
  const run = runOf('claude', session)
  const main = mainOf('claude', session)
  const subagent = agentOf('claude', session, { kind: 'subagent', agent_id: fileAgent })
  const teammate = agentOf('claude', session, { kind: 'teammate', name: 'worker', team: 'crew' })
  const leadLines = [
    ...claudeTranscript(source).slice(0, 5),
    recordLine(session, toolUse(spawn, 'Agent', { description: 'Research', prompt: 'Research the parser' })),
    recordLine(
      session,
      toolResult({ ...spawn, at: '2026-10-01T11:50:01.000Z' }, 'Launched', {
        agentId: fileAgent,
        agentType: 'researcher',
        status: 'async_launched',
      }),
    ),
  ]
  const lead = jsonlFile({ runtime: 'claude', path: `${projects}/${session}.jsonl`, lines: leadLines, ino: 1n }).batch(
    1,
    leadLines.length,
  )
  const meta = snapshotBatch({
    path: `${projects}/${session}/subagents/agent-${fileAgent}.meta.json`,
    content: { agentType: 'researcher', name: 'worker', teamName: 'crew', taskKind: 'in_process_teammate' },
  })
  const results = []
  for (const order of [
    [lead, meta],
    [meta, lead],
  ]) {
    const store = (await createHome(onTestFinished)).open()
    const engine = startEngine(store, { all: true })
    await engine.ingest(order[0] ?? lead)
    const withdrawn = linksOf(store, run).find((link) => link.kind === 'spawn' && link.child === subagent)
    const version = store.model.head(run)
    await engine.ingest(order[1] ?? meta)
    if (order[0] === lead) {
      expect(withdrawn).toMatchObject({ parent: main, via: actionOf('claude', session, spawn.call) })
      expect(store.observations.getRemoval({ kind: 'agent', id: subagent })?.replaced_by).toBe(teammate)
      expect(
        store.model.changes(run, version).map(({ op, target, after }) => [op, target.id, after?.kind === 'link' ? after.value.kind : null]),
      ).toEqual(
        expect.arrayContaining([
          ['link.remove', withdrawn?.id, null],
          ['link.add', expect.any(String), 'spawn'],
        ]),
      )
    } else {
      expect(withdrawn).toBeUndefined()
      expect(removalsOf(store)).toEqual([])
    }
    expect(store.observations.getAgent(subagent)).toBeNull()
    expect(store.observations.getAgent(teammate)).toMatchObject({
      role: 'teammate',
      parent: main,
      spawned_by: actionOf('claude', session, spawn.call),
    })
    expect(linksOf(store, run)).toMatchObject([{ kind: 'spawn', parent: main, child: teammate }])
    results.push(stateOf(store, 'claude', session))
  }
  expect(results[1]).toEqual(results[0])
})
