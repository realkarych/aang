import { readFileSync } from 'node:fs'
import { expect, onTestFinished, test } from 'vitest'
import { objectId } from '@aang/contract/ids'
import { joinBatches, jsonlFile } from './batches.js'
import { createHome } from './home.js'
import { at, clockedEngine, doubleHook, hook, registry, sessionId, source } from './session-fixtures.js'
import { codexRollout } from './samples.js'

test.each(['claude', 'codex'] as const)('projects the turn lifecycle and keeps child turns separate: %s', async (runtime) => {
  const store = (await createHome(onTestFinished)).open()
  const { engine } = clockedEngine(store)
  const read = () => store.observations.getSession(sessionId(runtime))
  await engine.ingest(hook('SessionStart', 0, {}, runtime))
  expect(read()).toMatchObject({ state: 'unknown', execution: { state: 'unknown' } })
  await engine.ingest(hook('UserPromptSubmit', 1, { prompt: 'Start' }, runtime))
  expect(read()).toMatchObject({ state: 'turn_running', execution: { state: 'running' } })
  await engine.ingest(hook('Stop', 2, { agent_id: 'child' }, runtime))
  expect(read()).toMatchObject({ state: 'turn_running', execution: { state: 'running' } })
  await engine.ingest(hook('Stop', 3, {}, runtime))
  expect(read()).toMatchObject({ state: 'turn_done', execution: { state: 'waiting', reason: 'idle' } })
  await engine.ingest(hook('SessionEnd', 4, { reason: 'other' }, runtime))
  expect(read()).toMatchObject({ state: 'ended', execution: { state: 'done' } })
  await engine.ingest(hook('SessionStart', 5, { source: 'resume' }, runtime))
  expect(read()).toMatchObject({ state: 'unknown', execution: { state: 'unknown' } })
  await engine.ingest(hook('UserPromptSubmit', 6, { prompt: 'Continue' }, runtime))
  expect(read()).toMatchObject({ state: 'turn_running', execution: { state: 'running' } })
})

test('registry status and idle notifications determine waits without inventing questions', async () => {
  const store = (await createHome(onTestFinished)).open()
  const { engine } = clockedEngine(store)
  const read = () => store.observations.getSession(sessionId())
  await engine.ingest(joinBatches(hook('SessionStart', 0), registry('busy', 10)))
  expect(read()).toMatchObject({ state: 'turn_running', execution: { state: 'running' } })
  await engine.ingest(registry('waiting', 20))
  expect(read()).toMatchObject({ execution: { state: 'waiting', reason: 'human' } })
  await engine.ingest(registry('busy', 30))
  expect(read()?.execution).toEqual({ state: 'running' })
  await engine.ingest(registry('idle', 40))
  expect(read()).toMatchObject({ state: 'turn_done', execution: { state: 'waiting', reason: 'idle' } })
  await engine.ingest(hook('UserPromptSubmit', 50))
  await engine.ingest(registry('waiting', 60, 20))
  expect(read()?.execution).toEqual({ state: 'running' })
  await engine.ingest(hook('Notification', 70, { notification_type: 'idle_prompt' }))
  expect(read()).toMatchObject({ state: 'turn_done', execution: { state: 'waiting', reason: 'idle' } })
  expect(store.observations.questions(sessionId())).toEqual([])
  expect(read()?.support_mode).toBe('hooks_only')
})

test('new tool activity supersedes an older registry wait', async () => {
  const store = (await createHome(onTestFinished)).open()
  const { engine } = clockedEngine(store)
  await engine.ingest(joinBatches(hook('SessionStart', 0), registry('waiting', 10)))
  expect(store.observations.getSession(sessionId())?.execution).toEqual({ state: 'waiting', reason: 'human' })
  await engine.ingest(hook('PreToolUse', 20, { tool_use_id: 'next', tool_name: 'Bash', tool_input: { command: 'pwd' } }))
  expect(store.observations.getSession(sessionId())?.execution).toEqual({ state: 'running' })
})

test('a late Stop preserves an ended session until an explicit continuation', async () => {
  const store = (await createHome(onTestFinished)).open()
  const { engine } = clockedEngine(store)
  await engine.ingest(joinBatches(hook('SessionStart', 0), hook('SessionEnd', 10, { reason: 'other' })))
  await engine.ingest(hook('Stop', 20))
  expect(store.observations.getSession(sessionId())).toMatchObject({ state: 'ended', execution: { state: 'done' } })
  await engine.ingest(hook('SessionStart', 30, { source: 'resume' }))
  await engine.ingest(hook('UserPromptSubmit', 40))
  expect(store.observations.getSession(sessionId())).toMatchObject({ state: 'turn_running', execution: { state: 'running' } })
})

test('a human transcript prompt starts a turn and a final message ends it without hooks', async () => {
  const store = (await createHome(onTestFinished)).open()
  const { engine } = clockedEngine(store)
  const lines = [
    JSON.stringify({ type: 'user', sessionId: source.session, cwd: source.cwd, uuid: 'prompt',
      timestamp: '2026-10-01T11:00:00.000Z', message: { content: 'Start' } }),
    JSON.stringify({ type: 'assistant', sessionId: source.session, cwd: source.cwd, uuid: 'final',
      timestamp: '2026-10-01T11:00:01.000Z', message: { id: 'reply', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done' }] } }),
  ]
  const file = jsonlFile({ runtime: 'claude', path: '/plain.jsonl', lines, ino: 1n })
  await engine.ingest(file.batch(1, 1))
  expect(store.observations.getSession(sessionId())).toMatchObject({ state: 'turn_running', execution: { state: 'running' } })
  await engine.ingest(file.batch(2, 2))
  expect(store.observations.getSession(sessionId())).toMatchObject({ state: 'turn_done', execution: { state: 'waiting', reason: 'idle' } })
})

test('an unrelated action does not end a blocking question but its own answer does', async () => {
  const store = (await createHome(onTestFinished)).open()
  const { engine } = clockedEngine(store)
  await engine.ingest(joinBatches(hook('SessionStart', 0), hook('UserPromptSubmit', 1),
    hook('PreToolUse', 2, { tool_use_id: 'ask', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Continue?' }] } }),
  ))
  expect(store.observations.getSession(sessionId())?.execution).toEqual({ state: 'waiting', reason: 'human' })
  await engine.ingest(hook('PostToolUse', 3, { tool_use_id: 'other', tool_name: 'Bash', tool_input: {}, tool_response: 'done' }))
  expect(store.observations.getSession(sessionId())?.execution).toEqual({ state: 'waiting', reason: 'human' })
  await engine.ingest(hook('PostToolUse', 4, { tool_use_id: 'ask', tool_name: 'AskUserQuestion', tool_input: {},
    tool_response: { questions: [], answers: { 'Continue?': 'Yes' } },
  }))
  expect(store.observations.getSession(sessionId())?.execution).toEqual({ state: 'running' })
})

test('a permission wait ends when its matching call completes and does not change the question decision', async () => {
  const store = (await createHome(onTestFinished)).open()
  const { engine } = clockedEngine(store)
  const call = { tool_use_id: 'approved', tool_name: 'Bash', tool_input: { command: 'pwd' } }
  await engine.ingest(joinBatches(hook('SessionStart', 0), hook('UserPromptSubmit', 1),
    hook('PreToolUse', 2, call), hook('PermissionRequest', 3, { tool_name: 'Bash', tool_input: { command: 'pwd' } }),
  ))
  expect(store.observations.getSession(sessionId())?.execution).toEqual({ state: 'waiting', reason: 'human' })
  await engine.ingest(hook('PostToolUse', 4, { ...call, tool_use_id: 'unrelated', tool_response: 'done' }))
  expect(store.observations.getSession(sessionId())?.execution).toEqual({ state: 'waiting', reason: 'human' })
  await engine.ingest(hook('PostToolUse', 5, { ...call, tool_response: '/workspace' }))
  expect(store.observations.getSession(sessionId())?.execution).toEqual({ state: 'running' })
  expect(store.observations.questions(sessionId())).toMatchObject([{ decision: { value: 'requested' } }])
})

test.each([
  ['claude', 'StopFailure', { error: 'rate_limit' }, 'failed'],
  ['codex', 'Interrupt', {}, 'cancelled'],
] as const)('preserves an explicit %s %s outcome through silence', async (runtime, event, fields, state) => {
  const store = (await createHome(onTestFinished)).open()
  const { engine, advance } = clockedEngine(store)
  await engine.ingest(joinBatches(hook('SessionStart', 0, {}, runtime), hook(event, 1, fields, runtime)))
  expect(store.observations.getSession(sessionId(runtime))).toMatchObject({ state: 'turn_done', execution: { state } })
  advance(600_000)
  await engine.refreshFreshness()
  expect(store.observations.getSession(sessionId(runtime))).toMatchObject({ freshness: 'ok', execution: { state } })
})

test('a turn waits for known background work until its agent finishes', async () => {
  const home = await createHome(onTestFinished)
  let store = home.open()
  const { engine } = clockedEngine(store)
  await engine.ingest(joinBatches(
    hook('SessionStart', 0),
    hook('UserPromptSubmit', 1),
    hook('SubagentStart', 2, { agent_id: 'background-agent', agent_type: 'researcher' }),
    hook('Stop', 3, { background_tasks: [{ id: 'background-agent', type: 'subagent', status: 'running' }] }),
  ))
  expect(store.observations.getSession(sessionId())).toMatchObject({
    state: 'turn_done', execution: { state: 'waiting', reason: 'background' },
  })
  store.close()
  store = home.open()
  await clockedEngine(store).engine.ingest(hook('SubagentStop', 4, { agent_id: 'background-agent' }))
  expect(store.observations.getSession(sessionId())).toMatchObject({
    state: 'turn_done', execution: { state: 'waiting', reason: 'idle' }, last_event_at: at(4),
  })
})

test.each(['normal', 'reversed'] as const)('blocking waits end at turn boundaries in event order: %s', async (order) => {
  const store = (await createHome(onTestFinished)).open()
  const { engine } = clockedEngine(store)
  await engine.ingest(hook('SessionStart', 0))
  const events = [
    hook('UserPromptSubmit', 1),
    hook('PermissionRequest', 2, { tool_name: 'Bash', tool_input: { command: 'pwd' } }),
  ]
  for (const event of order === 'normal' ? events : events.toReversed()) { await engine.ingest(event) }
  expect(store.observations.getSession(sessionId())?.execution).toEqual({ state: 'waiting', reason: 'human' })
  await engine.ingest(hook('Stop', 3))
  expect(store.observations.getSession(sessionId())?.execution).toEqual({ state: 'waiting', reason: 'idle' })
  expect(store.observations.questions(sessionId())).toHaveLength(1)
})

test('a child agent exposes its own human wait and idle state independently of the root', async () => {
  const store = (await createHome(onTestFinished)).open()
  const { engine } = clockedEngine(store)
  const child = objectId({ kind: 'agent', runtime: 'claude', session: source.session, agent: { kind: 'subagent', agent_id: 'child' } })
  await engine.ingest(joinBatches(hook('SessionStart', 0), hook('UserPromptSubmit', 1),
    hook('SubagentStart', 2, { agent_id: 'child' }),
    hook('PermissionRequest', 3, { agent_id: 'child', tool_name: 'Bash', tool_input: { command: 'pwd' } }),
  ))
  expect(store.observations.getSession(sessionId())?.execution).toEqual({ state: 'running' })
  expect(store.observations.getAgent(child)?.execution).toEqual({ state: 'waiting', reason: 'human' })
  await engine.ingest(hook('Stop', 4, { agent_id: 'child' }))
  expect(store.observations.getAgent(child)?.execution).toEqual({ state: 'waiting', reason: 'idle' })
})

test('a nonblocking Codex question after the turn does not restart execution', async () => {
  const store = (await createHome(onTestFinished)).open()
  const { engine } = clockedEngine(store)
  const sample = readFileSync(new URL('../../../docs/research/samples/codex-cli/rollout/event_msg.item_completed.AgentMessage.question-async.mock.json', import.meta.url), 'utf8')
  const message = JSON.parse(sample) as {
    ordinal: number
    timestamp: string
    payload: { started_at_ms: number; completed_at_ms: number; item: { phase: string } }
  }
  const time = Number(at(200) / 1_000_000n)
  const lines = [
    ...codexRollout({ thread: source.session, cwd: source.cwd }).slice(0, 2),
    JSON.stringify({ ...message, ordinal: 1000, timestamp: new Date(time).toISOString(),
      payload: { ...message.payload, started_at_ms: time, completed_at_ms: time,
        item: { ...message.payload.item, phase: 'commentary' } },
    }),
  ]
  const file = jsonlFile({ runtime: 'codex', path: '/async.jsonl', lines, ino: 1n })
  await engine.ingest(file.batch(1, 2))
  await engine.ingest(hook('Stop', 100, {}, 'codex'))
  await engine.ingest(file.batch(3, 3))
  expect(store.observations.questions(sessionId('codex'))).toMatchObject([{ blocking: false }])
  expect(store.observations.getSession(sessionId('codex'))).toMatchObject({ state: 'turn_done', execution: { state: 'waiting', reason: 'idle' } })
})

const elicitation = (milliseconds: number, id: string, fields: Record<string, string> = {}) =>
  hook('Elicitation', milliseconds, { mcp_server_name: 'docs', message: `Allow ${id}?`, elicitation_id: id, ...fields })

const elicitationResult = (milliseconds: number, id: string, action: string, fields: Record<string, string> = {}) =>
  hook('ElicitationResult', milliseconds, {
    mcp_server_name: 'docs', elicitation_id: id, action, ...(action === 'accept' ? { content: { approved: 'yes' } } : {}), ...fields,
  })

test.each(['accept', 'decline', 'cancel'])('an Elicitation result ends only the wait it answers: %s', async (action) => {
  const store = (await createHome(onTestFinished)).open()
  const { engine } = clockedEngine(store)
  const read = () => store.observations.getSession(sessionId())?.execution
  await engine.ingest(joinBatches(hook('SessionStart', 0), hook('UserPromptSubmit', 1),
    elicitation(2, 'request-1'), elicitation(3, 'request-2'),
  ))
  expect(read()).toEqual({ state: 'waiting', reason: 'human' })
  await engine.ingest(elicitationResult(4, 'request-3', action))
  expect(read()).toEqual({ state: 'waiting', reason: 'human' })
  await engine.ingest(elicitationResult(5, 'request-1', action))
  expect(read()).toEqual({ state: 'waiting', reason: 'human' })
  await engine.ingest(joinBatches(elicitationResult(6, 'request-2', action),
    hook('PreToolUse', 7, { tool_use_id: 'next', tool_name: 'Bash', tool_input: { command: 'pwd' } }),
  ))
  expect(read()).toEqual({ state: 'running' })
  expect(store.observations.questions(sessionId())).toHaveLength(2)
})

test.each(['accept', 'decline', 'cancel'])('a doubly delivered Elicitation result ends every delivered wait it answers: %s', async (action) => {
  const store = (await createHome(onTestFinished)).open()
  const { engine } = clockedEngine(store)
  const read = () => store.observations.getSession(sessionId())
  const answer = { mcp_server_name: 'docs', elicitation_id: 'request-1', action, ...(action === 'accept' ? { content: { approved: 'yes' } } : {}) }
  await engine.ingest(joinBatches(hook('SessionStart', 0), hook('UserPromptSubmit', 1),
    doubleHook('Elicitation', 2, { mcp_server_name: 'docs', message: 'Allow request-1?', elicitation_id: 'request-1' }),
    elicitation(3, 'request-2'),
  ))
  expect(read()).toMatchObject({ double_registration: true, execution: { state: 'waiting', reason: 'human' } })
  await engine.ingest(doubleHook('ElicitationResult', 4, answer))
  expect(read()?.execution).toEqual({ state: 'waiting', reason: 'human' })
  await engine.ingest(elicitationResult(5, 'request-2', action))
  expect(read()?.execution).toEqual({ state: 'running' })
  await engine.ingest(hook('ElicitationResult', 6, answer))
  expect(read()?.execution).toEqual({ state: 'running' })
  const questions = store.observations.questions(sessionId())
  expect(questions).toHaveLength(3)
  expect(new Set(questions.map(({ redelivery_group: group }) => group)).size).toBe(2)
})

test('an Elicitation result answers only the agent that asked', async () => {
  const store = (await createHome(onTestFinished)).open()
  const { engine } = clockedEngine(store)
  const child = objectId({ kind: 'agent', runtime: 'claude', session: source.session, agent: { kind: 'subagent', agent_id: 'child' } })
  await engine.ingest(joinBatches(hook('SessionStart', 0), hook('UserPromptSubmit', 1),
    hook('SubagentStart', 2, { agent_id: 'child' }), elicitation(3, 'request-1', { agent_id: 'child' }),
  ))
  expect(store.observations.getAgent(child)?.execution).toEqual({ state: 'waiting', reason: 'human' })
  await engine.ingest(elicitationResult(4, 'request-1', 'accept'))
  expect(store.observations.getAgent(child)?.execution).toEqual({ state: 'waiting', reason: 'human' })
  expect(store.observations.getSession(sessionId())?.execution).toEqual({ state: 'running' })
  await engine.ingest(elicitationResult(5, 'request-1', 'accept', { agent_id: 'child' }))
  expect(store.observations.getAgent(child)?.execution).toEqual({ state: 'running' })
  expect(store.observations.getSession(sessionId())?.execution).toEqual({ state: 'running' })
})

test('a hooks-only Codex child starts every new turn from its prompt without changing the root', async () => {
  const store = (await createHome(onTestFinished)).open()
  const { engine } = clockedEngine(store)
  const child = objectId({ kind: 'agent', runtime: 'codex', session: source.session, agent: { kind: 'thread', thread_id: 'child-1' } })
  const inChild = { agent_id: 'child-1' }
  const read = () => store.observations.getAgent(child)?.execution
  await engine.ingest(joinBatches(hook('SessionStart', 0, {}, 'codex'), hook('UserPromptSubmit', 1, { prompt: 'Delegate' }, 'codex'),
    hook('SubagentStart', 2, { ...inChild, agent_type: 'default' }, 'codex'),
    hook('UserPromptSubmit', 3, { ...inChild, prompt: 'First task' }, 'codex'),
  ))
  expect(read()).toEqual({ state: 'running' })
  await engine.ingest(hook('Stop', 4, inChild, 'codex'))
  expect(read()).toEqual({ state: 'waiting', reason: 'idle' })
  const root = store.observations.getSession(sessionId('codex'))
  await engine.ingest(hook('UserPromptSubmit', 5, { ...inChild, prompt: 'Second task' }, 'codex'))
  expect(read()).toEqual({ state: 'running' })
  expect(store.observations.getSession(sessionId('codex'))).toMatchObject({
    state: root?.state, execution: root?.execution, support_mode: 'hooks_only',
  })
  expect(root).toMatchObject({ state: 'turn_running', execution: { state: 'running' } })
})
