import assert from 'node:assert/strict'
import { EpochNs, type Runtime } from '@aang/contract'
import { objectId } from '@aang/contract/ids'
import { hookRedeliveries } from '@aang/engine'
import { expect, onTestFinished, test } from 'vitest'
import { hookBatch, jsonlFile } from './batches.js'
import { factsOf, sessionKey, startEngine } from './harness.js'
import { createHome } from './home.js'
import { claudeHook, claudeTranscript, codexChildRollout, codexHook, codexRollout } from './samples.js'

const session = 'merge-session'
const cwd = '/work/project'
const key = sessionKey('claude', session)
const sessionId = objectId(key)
const source = { session, cwd }
const start = { file: 'start.evt', payload: claudeHook('SessionStart.startup.json', source) }
const call = 'merged-call'

const transcript = () => {
  const lines = claudeTranscript(source).slice(0, 5)
  lines.push(
    JSON.stringify({
      type: 'assistant',
      sessionId: session,
      uuid: 'message-call',
      timestamp: '2026-10-01T11:00:00.000Z',
      cwd,
      message: {
        id: 'message-id',
        role: 'assistant',
        content: [{ type: 'tool_use', id: call, name: 'Bash', input: { command: 'file input' } }],
      },
    }),
  )
  lines.push(
    JSON.stringify({
      type: 'user',
      sessionId: session,
      uuid: 'message-result',
      timestamp: '2026-10-01T11:00:01.000Z',
      cwd,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: call, content: 'file output' }],
      },
    }),
  )
  return jsonlFile({ runtime: 'claude', path: '/transcript.jsonl', lines, ino: 1n })
}

test.each(['hooks-first', 'file-first'])(
  'merges a call with file content and earliest times: %s',
  async (order) => {
    const home = await createHome(onTestFinished)
    const store = home.open()
    const engine = startEngine(store, { all: true })
    const file = transcript()
    const hooks = hookBatch(
      start,
      {
        file: 'pre.evt',
        payload: claudeHook('PreToolUse.Bash.json', source, {
          tool_use_id: call,
          tool_input: { command: 'hook input' },
        }),
      },
      {
        file: 'post.evt',
        payload: claudeHook('PostToolUse.Bash.json', source, {
          tool_use_id: call,
          tool_response: 'hook output',
        }),
      },
    )
    for (const batch of order === 'hooks-first'
      ? [hooks, file.batch(1, file.lines.length)]
      : [file.batch(1, file.lines.length), hooks]) {
      await engine.ingest(batch)
    }
    const actions = store.observations.actions(sessionId)
    expect(actions).toHaveLength(1)
    const action = actions[0]
    assert(action !== undefined && action.input_fact !== null && action.output_fact !== null)
    expect(action).toMatchObject({
      id: objectId({ kind: 'action', runtime: 'claude', session, call }),
      agent: objectId({ kind: 'agent', runtime: 'claude', session, agent: { kind: 'main' } }),
      started_at: EpochNs.parse(1790852400000000000n),
      ended_at: EpochNs.parse(1790852401000000000n),
      execution: { state: 'done' },
      outcome: { value: 'ok', basis: { kind: 'observed' } },
    })
    expect(store.facts.get(action.input_fact)?.payload).toMatchObject({ input: { command: 'file input' } })
    expect(store.facts.get(action.output_fact)?.payload).toMatchObject({ output: 'file output' })
    expect(store.observations.sessions()).toHaveLength(1)
    expect(store.observations.agents(sessionId)).toHaveLength(1)
    const head = store.changes.head()
    await engine.ingest(hooks)
    expect(store.changes.head()).toBe(head)
    store.close()
    const reopened = home.open()
    expect(reopened.observations.actions(sessionId)).toEqual(actions)
  },
)

test('keeps resume launches, ignores compaction launches and never joins sessions by cwd', async () => {
  const store = (await createHome(onTestFinished)).open()
  await startEngine(store, { all: true }).ingest(
    hookBatch(
      start,
      {
        file: 'resume.evt',
        arrival: 100,
        payload: claudeHook('SessionStart.startup.json', source, { source: 'resume' }),
      },
      {
        file: 'compact.evt',
        arrival: 200,
        payload: claudeHook('SessionStart.startup.json', source, { source: 'compact' }),
      },
      { file: 'other.evt', payload: claudeHook('SessionStart.startup.json', { session: 'other', cwd }) },
    ),
  )
  expect(store.observations.sessions()).toHaveLength(2)
  expect(store.observations.getSession(sessionId)?.launches.map(({ launch }) => launch)).toEqual([
    'startup',
    'resume',
  ])
})

const permission = (runtime: Runtime) =>
  runtime === 'claude'
    ? claudeHook('PreToolUse.Bash.json', source, { hook_event_name: 'PermissionRequest' })
    : codexHook('PreToolUse.Bash.codemode-nested.json', source, { hook_event_name: 'PermissionRequest' })

test('keeps two identical permission episodes of one registration across a closing event', async () => {
  const store = (await createHome(onTestFinished)).open()
  await startEngine(store, { all: true }).ingest(
    hookBatch(
      start,
      { file: 'request-one.evt', payload: permission('claude') },
      { file: 'close.evt', arrival: 100, payload: claudeHook('PostToolUse.Bash.json', source) },
      { file: 'request-two.evt', arrival: 200, payload: permission('claude') },
    ),
  )
  expect(
    store.observations
      .questions(sessionId)
      .map(({ key: question, redelivery_group }) => [question.question, redelivery_group]),
  ).toEqual([
    ['request-one.evt', null],
    ['request-two.evt', null],
  ])
  expect(hookRedeliveries(store, key)).toEqual([])
  expect(store.observations.getSession(sessionId)?.double_registration).toBe(false)
})

test('groups mixed partial delivery without hiding requests and retains stable episode ids after restart and reordering', async () => {
  const deliveries = [
    { file: 'a1.evt', payload: permission('claude'), registration: 'plugin' as const, arrival: 0 },
    { file: 'b1.evt', payload: permission('claude'), registration: 'user' as const, arrival: 1_000_000_000 },
    {
      file: 'a2.evt',
      payload: permission('claude'),
      registration: 'plugin' as const,
      arrival: 1_500_000_000,
    },
  ]
  const home = await createHome(onTestFinished)
  let store = home.open()
  await startEngine(store, { all: true }).ingest(hookBatch(start, ...deliveries))
  const questions = store.observations.questions(sessionId)
  expect(questions).toHaveLength(3)
  expect(new Set(questions.map(({ id }) => id)).size).toBe(3)
  expect(new Set(questions.map(({ redelivery_group }) => redelivery_group)).size).toBe(1)
  expect(questions[0]?.redelivery_group).not.toBeNull()
  expect(hookRedeliveries(store, key)).toMatchObject([{ count: 3, ambiguous: true }])
  expect(store.observations.getSession(sessionId)?.double_registration).toBe(true)
  const head = store.changes.head()
  store.close()
  store = home.open()
  await startEngine(store, { all: true }).ingest(hookBatch(...deliveries.toReversed()))
  expect(store.observations.questions(sessionId)).toEqual(questions)
  expect(store.changes.head()).toBe(head)
  const other = (await createHome(onTestFinished)).open()
  await startEngine(other, { all: true }).ingest(hookBatch(start, ...deliveries.toReversed()))
  expect(
    other.observations.questions(sessionId).map(({ id, redelivery_group }) => [id, redelivery_group]),
  ).toEqual(questions.map(({ id, redelivery_group }) => [id, redelivery_group]))
})

test('uses registration tag and plugin root and the inclusive two-second window for Stop episodes', async () => {
  const store = (await createHome(onTestFinished)).open()
  const payload = claudeHook('SessionStart.startup.json', source, { hook_event_name: 'Stop' })
  await startEngine(store, { all: true }).ingest(
    hookBatch(
      start,
      { file: 'stop-a.evt', payload, env: { CLAUDE_PLUGIN_ROOT: '/one' } },
      { file: 'stop-b.evt', payload, env: { CLAUDE_PLUGIN_ROOT: '/two' }, arrival: 2_000_000_000 },
      { file: 'stop-far.evt', payload, registration: 'user', arrival: 4_000_000_001 },
    ),
  )
  expect(factsOf(store).filter(({ kind }) => kind === 'turn_end')).toHaveLength(3)
  expect(hookRedeliveries(store, key)).toMatchObject([{ count: 2, ambiguous: true }])
})

test('keeps code cells separate from commands and merges the command hook with rollout', async () => {
  const store = (await createHome(onTestFinished)).open()
  const lines = codexRollout({ thread: session, cwd })
  const file = jsonlFile({ runtime: 'codex', path: '/rollout.jsonl', lines, ino: 2n })
  const engine = startEngine(store, { all: true })
  await engine.ingest(file.batch(1, lines.length))
  await engine.ingest(
    hookBatch({
      runtime: 'codex',
      file: 'command.evt',
      payload: codexHook('PreToolUse.Bash.codemode-nested.json', source, {
        tool_use_id: 'exec-a8b47079-66cf-4c58-ba7c-268717fda6fb',
      }),
    }),
  )
  const actions = store.observations.actions(objectId(sessionKey('codex', session)))
  expect(actions).toHaveLength(2)
  expect(actions.find(({ is_container }) => is_container)).toMatchObject({ action_kind: 'code_cell' })
  expect(actions.find(({ is_container }) => !is_container)).toMatchObject({
    action_kind: 'command',
    outcome: { value: 'ok' },
  })
})

test('an earlier hook controls time while the later file supplies content', async () => {
  const store = (await createHome(onTestFinished)).open()
  const engine = startEngine(store, { all: true })
  const file = transcript()
  await engine.ingest(
    hookBatch(
      start,
      {
        file: 'early-pre.evt',
        arrival: -5_000_000_000_000,
        payload: claudeHook('PreToolUse.Bash.json', source, { tool_use_id: call }),
      },
      {
        file: 'early-post.evt',
        arrival: -4_500_000_000_000,
        payload: claudeHook('PostToolUse.Bash.json', source, { tool_use_id: call }),
      },
    ),
  )
  const early = store.observations.actions(sessionId)[0]
  assert(early !== undefined)
  await engine.ingest(file.batch(1, file.lines.length))
  const merged = store.observations.actions(sessionId)[0]
  assert(merged !== undefined)
  expect(merged.started_at).toBe(early.started_at)
  expect(merged.ended_at).toBe(early.ended_at)
  expect(merged.input_fact).not.toBe(early.input_fact)
  expect(merged.output_fact).not.toBe(early.output_fact)
})

test.each([
  ['error', false, 'failed'],
  ['interrupted', true, 'cancelled'],
] as const)('keeps a %s completion delivered before its start', async (outcome, interrupted, execution) => {
  const store = (await createHome(onTestFinished)).open()
  const engine = startEngine(store, { all: true })
  await engine.ingest(
    hookBatch(start, {
      file: 'end.evt',
      payload: claudeHook('PostToolUse.Bash.json', source, {
        hook_event_name: 'PostToolUseFailure',
        tool_use_id: call,
        error: 'stopped',
        is_interrupt: interrupted,
      }),
    }),
  )
  expect(store.observations.actions(sessionId)[0]).toMatchObject({
    started_at: null,
    outcome: { value: outcome },
  })
  await engine.ingest(
    hookBatch({
      file: 'pre.evt',
      arrival: -100,
      payload: claudeHook('PreToolUse.Bash.json', source, { tool_use_id: call }),
    }),
  )
  expect(store.observations.actions(sessionId)).toMatchObject([
    { execution: { state: execution }, outcome: { value: outcome }, tool: 'Bash' },
  ])
})

test('rolls back facts, objects and cursors together if storing an object fails', async () => {
  const home = await createHome(onTestFinished)
  const store = home.open()
  const database = home.database()
  database.exec(
    "CREATE TRIGGER reject_observation BEFORE INSERT ON objects BEGIN SELECT RAISE(ABORT, 'object write failed'); END",
  )
  const file = transcript()
  const engine = startEngine(store, { all: true })
  await expect(engine.ingest(file.batch(1, file.lines.length))).rejects.toThrow('object write failed')
  expect(factsOf(store)).toEqual([])
  expect(store.observations.sessions()).toEqual([])
  expect(store.cursors.list()).toEqual([])
  expect(store.changes.head()).toBe(0)
  database.exec('DROP TRIGGER reject_observation')
  await engine.ingest(file.batch(1, file.lines.length))
  expect(store.observations.actions(sessionId)).toHaveLength(1)
})

test.each(['hooks-first', 'file-first'])(
  'merges complementary subagent metadata in either order: %s',
  async (order) => {
    const store = (await createHome(onTestFinished)).open()
    const engine = startEngine(store, { all: true })
    const child = 'child-thread'
    const lines = codexChildRollout({ root: session, thread: child, cwd }).slice(0, 1)
    const file = jsonlFile({ runtime: 'codex', path: '/child.jsonl', lines, ino: 3n })
    const hooks = hookBatch(
      { runtime: 'codex', file: 'root.evt', payload: codexHook('SessionStart.startup.json', source) },
      {
        runtime: 'codex',
        file: 'child.evt',
        payload: codexHook('SubagentStart.json', source, { agent_id: child, agent_type: 'researcher' }),
      },
      {
        runtime: 'codex',
        file: 'end-child.evt',
        payload: codexHook('SubagentStop.json', source, { agent_id: child, agent_type: null }),
      },
    )
    for (const batch of order === 'hooks-first' ? [hooks, file.batch(1, 1)] : [file.batch(1, 1), hooks]) {
      await engine.ingest(batch)
    }
    const agents = store.observations.agents(objectId(sessionKey('codex', session)))
    expect(agents).toHaveLength(2)
    expect(agents.find(({ role }) => role === 'subagent')).toMatchObject({
      id: objectId({ kind: 'agent', runtime: 'codex', session, agent: { kind: 'thread', thread_id: child } }),
      agent_type: 'researcher',
      name: 'Confucius',
      description: '/root/probe_child',
      execution: { state: 'done' },
    })
  },
)

test('keeps Codex permission episodes and marks cross-registration delivery without merging them', async () => {
  const store = (await createHome(onTestFinished)).open()
  const engine = startEngine(store, { all: true })
  const payload = codexHook('PermissionRequest.json', source)
  await engine.ingest(
    hookBatch(
      { runtime: 'codex', file: 'start.evt', payload: codexHook('SessionStart.startup.json', source) },
      { runtime: 'codex', file: 'one.evt', payload, registration: 'user' },
      { runtime: 'codex', file: 'two.evt', payload, registration: 'plugin', arrival: 1 },
    ),
  )
  const codexKey = sessionKey('codex', session)
  const questions = store.observations.questions(objectId(codexKey))
  expect(questions).toHaveLength(2)
  expect(questions.map(({ kind }) => kind)).toEqual(['permission', 'permission'])
  expect(hookRedeliveries(store, codexKey)).toMatchObject([{ count: 2, ambiguous: true }])
  expect(store.observations.getSession(objectId(codexKey))?.double_registration).toBe(true)
})

test('merges hook calls with an occurrence id without treating them as ambiguous episodes', async () => {
  const store = (await createHome(onTestFinished)).open()
  const payload = claudeHook('PreToolUse.Bash.json', source, {
    tool_use_id: call,
    tool_name: 'AskUserQuestion',
    tool_input: {
      questions: [
        {
          question: 'Proceed?',
          header: 'Choice',
          options: [
            { label: 'Yes', description: 'Continue' },
            { label: 'No', description: 'Stop' },
          ],
          multiSelect: false,
        },
      ],
    },
  })
  await startEngine(store, { all: true }).ingest(
    hookBatch(
      start,
      { file: 'one.evt', payload },
      { file: 'two.evt', payload, registration: 'user', arrival: 1 },
    ),
  )
  expect(store.observations.actions(sessionId)).toHaveLength(1)
  expect(store.observations.questions(sessionId)).toHaveLength(1)
  expect(hookRedeliveries(store, key)).toEqual([])
  expect(store.observations.getSession(sessionId)?.double_registration).toBe(true)
})

test('keeps batch completion evidence without inventing a successful outcome', async () => {
  const store = (await createHome(onTestFinished)).open()
  const engine = startEngine(store, { all: true })
  await engine.ingest(
    hookBatch(
      start,
      { file: 'pre.evt', payload: claudeHook('PreToolUse.Bash.json', source, { tool_use_id: call }) },
      {
        file: 'batch.evt',
        arrival: 100,
        payload: claudeHook('PostToolBatch.denied-by-human.json', source, {
          tool_calls: [{ tool_name: 'Bash', tool_use_id: call, tool_response: 'Denied by the human' }],
        }),
      },
    ),
  )
  const action = store.observations.actions(sessionId)[0]
  assert(action !== undefined && action.output_fact !== null)
  expect(action).toMatchObject({ outcome: { value: 'unknown' }, execution: { state: 'unknown' } })
  expect(action.ended_at).not.toBeNull()
  expect(store.facts.get(action.output_fact)?.kind).toBe('tool_batch_end')
  const file = transcript()
  await engine.ingest(file.batch(1, file.lines.length))
  const complete = store.observations.actions(sessionId)[0]
  assert(complete !== undefined && complete.output_fact !== null)
  expect(complete.outcome?.value).toBe('ok')
  expect(store.facts.get(complete.output_fact)?.kind).toBe('action_end')
})

test.each(['hooks-first', 'file-first'])(
  'keeps question evidence deterministic across channels: %s',
  async (order) => {
    const store = (await createHome(onTestFinished)).open()
    const engine = startEngine(store, { all: true })
    const questions = [
      {
        question: 'Proceed?',
        header: 'Choice',
        options: [{ label: 'Yes', description: 'Continue' }],
        multiSelect: false,
      },
    ]
    const payload = claudeHook('PreToolUse.Bash.json', source, {
      tool_use_id: call,
      tool_name: 'AskUserQuestion',
      tool_input: { questions },
    })
    const hooks = hookBatch(start, { file: 'ask.evt', payload })
    const lines = [
      ...claudeTranscript(source).slice(0, 5),
      JSON.stringify({
        type: 'assistant',
        sessionId: session,
        uuid: 'question',
        timestamp: '2026-10-01T11:00:00.000Z',
        cwd,
        message: {
          id: 'question-id',
          role: 'assistant',
          content: [{ type: 'tool_use', id: call, name: 'AskUserQuestion', input: { questions } }],
        },
      }),
    ]
    const file = jsonlFile({ runtime: 'claude', path: '/questions.jsonl', lines, ino: 4n })
    for (const batch of order === 'hooks-first'
      ? [hooks, file.batch(1, lines.length)]
      : [file.batch(1, lines.length), hooks]) {
      await engine.ingest(batch)
    }
    const question = store.observations.questions(sessionId)[0]
    assert(question !== undefined)
    const basis = question.decision.evidence[0]
    assert(basis !== undefined)
    const fact = store.facts.get(basis)
    assert(fact !== null)
    expect(store.rawRecords.get(fact.seq)?.channel).toBe('transcript')
  },
)

test('does not group secondary facts of a hook with a known tool occurrence', async () => {
  const store = (await createHome(onTestFinished)).open()
  const payload = claudeHook('PostToolUse.Bash.json', source, {
    tool_use_id: 'spawn-call',
    tool_name: 'Agent',
    tool_response: { agentId: 'child', agentType: 'researcher' },
  })
  await startEngine(store, { all: true }).ingest(
    hookBatch(
      start,
      { file: 'one.evt', payload },
      { file: 'two.evt', payload, registration: 'user', arrival: 1 },
    ),
  )
  expect(store.observations.agents(sessionId).filter(({ role }) => role === 'subagent')).toHaveLength(1)
  expect(store.observations.actions(sessionId)).toHaveLength(1)
  expect(hookRedeliveries(store, key)).toEqual([])
})

test('saving unchanged observation fields in another order does not publish an object change', async () => {
  const store = (await createHome(onTestFinished)).open()
  await startEngine(store, { all: true }).ingest(hookBatch(start))
  const session = store.observations.getSession(sessionId)
  assert(session !== null)
  const { id, key: entity, change_seq, ...fields } = session
  store.transaction(({ observations }) => observations.save({ ...fields, key: entity, id }))
  expect(store.observations.getSession(sessionId)?.change_seq).toBe(change_seq)
})
