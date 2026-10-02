import type { DatabaseSync } from 'node:sqlite'
import { type AgentRef, type CollectorBatch, type Link, ModelVersion, type RunId, type Runtime } from '@aang/contract'
import { objectId, runId } from '@aang/contract/ids'
import type { Store } from '@aang/store'
import { expect, onTestFinished, test } from 'vitest'
import { hookBatch, jsonlFile, snapshotBatch } from './batches.js'
import { factsOf, sessionKey, startEngine } from './harness.js'
import { createHome } from './home.js'
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

const stateOf = (store: Store, runtime: Runtime, session: string) => {
  const id = sessionOf(runtime, session)
  return {
    session: withoutCounters(store.observations.getSession(id) ?? {}),
    agents: store.observations.agents(id).map(withoutCounters),
    actions: store.observations.actions(id).map(withoutCounters),
    model: store.model.entities(runOf(runtime, session)).map(({ kind, value }) => [kind, withoutCounters(value)]),
  }
}

const startFacts = (store: Store, agent: string): string[] =>
  factsOf(store)
    .filter(({ kind, entity_key: key }) => kind === 'agent_start' && key.kind === 'agent' && objectId(key) === agent)
    .map(({ id }) => id)
    .sort()

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
      goal: null,
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
      await engine.ingest(hookBatch(subagentStop))
      expect(store.observations.agents(id).map(({ role }) => role)).toEqual(['main'])
      await engine.ingest(hookBatch(preCompact, compactStart, postCompact, subagentStart))
    }
    expect(store.observations.agents(id).map(({ id: agent, role, agent_type }) => [agent, role, agent_type])).toEqual(
      expect.arrayContaining([
        [mainOf('claude', session), 'main', null],
        [subagent, 'subagent', 'echoer'],
      ]),
    )
    expect(store.observations.agents(id)).toHaveLength(2)
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
  const line = (record: object) => JSON.stringify({ sessionId: session, cwd, ...record })
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
