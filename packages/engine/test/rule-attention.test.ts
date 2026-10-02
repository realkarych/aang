import { type Basis, type JsonValue, ObserverCallId } from '@aang/contract'
import { objectId } from '@aang/contract/ids'
import { applyObserverResponse } from '@aang/engine'
import { expect, onTestFinished, test } from 'vitest'
import {
  actionId,
  attentionChanges,
  blockingQuestion,
  attentionOf,
  claudeHooks,
  codexHooks,
  codexRolloutFile,
  factOf,
  itemOf,
  millisecond,
  observeSession,
  otelDecision,
  questionId,
  questionOf,
} from './attention-fixtures.js'
import { hookBatch } from './batches.js'
import { factsOf, startEngine } from './harness.js'
import { runA } from './model.js'
import { response, setupObserver } from './observer-fixtures.js'

const observed: Basis = { kind: 'observed' }
const rule = (name: string): Basis => ({ kind: 'interpreted', interpreter: { kind: 'rule', rule: name } })
const ms = (value: number): number => value * millisecond
const sorted = (...ids: readonly string[]): string[] => [...ids].sort()

const question = 'Which database should the parser use?'
const askInput: JsonValue = {
  questions: [{ question, header: 'Database', options: [{ label: 'SQLite' }, { label: 'Postgres' }] }],
}
const askAnswer: JsonValue = { questions: [{ question }], answers: { [question]: 'SQLite' } }

test('opens the permission item in the transaction that stores the request fact', async () => {
  const { home, store, key, engine } = await observeSession(onTestFinished, 'claude', 'atomic')
  const hooks = claudeHooks('atomic')
  const batch = hookBatch(hooks.start(), hooks.pre('pre.evt', 'call', ms(1)), hooks.request('request.evt', ms(2)))
  const database = home.database()
  database.exec(
    "CREATE TRIGGER reject_attention BEFORE INSERT ON model_changes WHEN NEW.entity_kind = 'attention_item' BEGIN SELECT RAISE(ABORT, 'attention write failed'); END",
  )
  await expect(engine.ingest(batch)).rejects.toThrow('attention write failed')
  expect(factsOf(store)).toEqual([])
  expect(store.observations.questions(objectId(key))).toEqual([])
  expect(attentionOf(store, key)).toEqual([])
  database.exec('DROP TRIGGER reject_attention')
  await engine.ingest(batch)
  const request = factOf(store, 'request.evt')
  expect(attentionChanges(store, key)).toMatchObject([
    { op: 'attention.open', author: 'rule', basis: observed, evidence: [request.id] },
  ])
  expect(itemOf(store, key, 'request.evt')).toMatchObject({
    kind: 'permission',
    author: 'rule',
    text: 'Bash: touch probe-perm.txt',
    stage: null,
    question: questionId(key, 'request.evt'),
    action: actionId(key, 'call'),
    basis: observed,
    evidence: [request.id],
    runtime_wait: 'active',
    resolution: 'open',
    likely_resolved: null,
    priority: null,
    opened_at: request.at,
    closed_at: null,
  })
  expect(questionOf(store, key, 'request.evt')).toMatchObject({
    action: { action: actionId(key, 'call'), ambiguous: false, basis: rule('permission-link') },
    decision: { value: 'requested', basis: observed, evidence: [request.id] },
    answered_at: null,
  })
})

test('links a request only to an unfinished call of the same agent with the same tool and input', async () => {
  const { store, key, engine } = await observeSession(onTestFinished, 'claude', 'link')
  const hooks = claudeHooks('link')
  await engine.ingest(
    hookBatch(
      hooks.start(),
      hooks.pre('finished-pre.evt', 'finished', ms(1)),
      hooks.post('finished-post.evt', 'finished', ms(2)),
      hooks.pre('batched-pre.evt', 'batched', ms(2) + 100),
      hooks.denied('batched-end.evt', 'batched', ms(2) + 200),
      hooks.pre('other-input.evt', 'other-input', ms(3), { command: 'ls' }),
      hooks.pre('other-agent.evt', 'other-agent', ms(4), undefined, 'Bash', { agent_id: 'helper' }),
      hooks.pre('target-pre.evt', 'target', ms(5)),
      hooks.request('single.evt', ms(6)),
    ),
  )
  expect(questionOf(store, key, 'single.evt').action).toEqual({
    action: actionId(key, 'target'),
    ambiguous: false,
    basis: rule('permission-link'),
  })
  expect(itemOf(store, key, 'single.evt').action).toBe(actionId(key, 'target'))
  await engine.ingest(
    hookBatch(
      hooks.pre('twin-a.evt', 'twin-a', ms(10)),
      hooks.pre('twin-b.evt', 'twin-b', ms(11)),
      hooks.request('twin.evt', ms(12)),
      hooks.request('unmatched.evt', ms(13), { command: 'rm -rf build' }),
      hooks.request('tool.evt', ms(14), 'AANG-6', { tool_name: 'mcp__tracker__close' }),
    ),
  )
  expect(itemOf(store, key, 'tool.evt')).toMatchObject({ action: null, text: 'mcp__tracker__close' })
  expect(questionOf(store, key, 'twin.evt').action).toEqual({
    action: actionId(key, 'twin-b'),
    ambiguous: true,
    basis: rule('permission-link'),
  })
  expect(itemOf(store, key, 'twin.evt').action).toBeNull()
  expect(questionOf(store, key, 'unmatched.evt').action).toBeNull()
  expect(itemOf(store, key, 'unmatched.evt')).toMatchObject({ action: null, text: 'Bash: rm -rf build' })
})

test.each([
  ['approval', 'approved'],
  ['denial', 'rejected'],
] as const)('a Claude %s after the request closes the item as answered by a rule', async (kind, decision) => {
  const { store, key, engine } = await observeSession(onTestFinished, 'claude', `decision-${kind}`)
  const hooks = claudeHooks(`decision-${kind}`)
  await engine.ingest(hookBatch(hooks.start(), hooks.pre('pre.evt', 'call', ms(1)), hooks.request('request.evt', ms(2))))
  await engine.ingest(
    hookBatch(
      kind === 'approval' ? hooks.post('closing.evt', 'call', ms(3)) : hooks.denied('closing.evt', 'call', ms(3)),
    ),
  )
  const request = factOf(store, 'request.evt')
  const closing = factOf(store, 'closing.evt')
  expect(questionOf(store, key, 'request.evt')).toMatchObject({
    decision: { value: decision, basis: rule('permission-decision'), evidence: sorted(request.id, closing.id) },
    answered_at: closing.at,
  })
  expect(itemOf(store, key, 'request.evt')).toMatchObject({
    runtime_wait: 'ended',
    resolution: 'answered',
    closed_at: closing.at,
  })
  expect(attentionChanges(store, key).map(({ op, basis, evidence }) => [op, basis, evidence])).toEqual([
    ['attention.open', observed, [request.id]],
    ['attention.close', rule('permission-decision'), sorted(request.id, closing.id)],
  ])
  const head = store.changes.head()
  await engine.ingest(hookBatch(hooks.stop('stop.evt', ms(4))))
  expect(attentionChanges(store, key)).toHaveLength(2)
  expect(itemOf(store, key, 'request.evt').closed_at).toBe(closing.at)
  expect(store.changes.head()).toBeGreaterThan(head)
})

test('an automatic denial without a host opens and closes the item at once', async () => {
  const { store, key, engine } = await observeSession(onTestFinished, 'claude', 'auto-deny')
  const hooks = claudeHooks('auto-deny')
  await engine.ingest(
    hookBatch(
      hooks.start(),
      hooks.pre('pre.evt', 'call', ms(1)),
      hooks.request('request.evt', ms(2)),
      hooks.denied('batch.evt', 'call', ms(2) + 300_000),
      hooks.stop('stop.evt', ms(3)),
    ),
  )
  const changes = attentionChanges(store, key)
  expect(changes.map(({ op, version }) => [op, version])).toEqual([
    ['attention.open', changes[0]?.version],
    ['attention.close', changes[0]?.version],
  ])
  expect(changes[0]?.after).toMatchObject({ value: { resolution: 'open', runtime_wait: 'active' } })
  expect(attentionOf(store, key).filter(({ resolution }) => resolution === 'open')).toEqual([])
  expect(itemOf(store, key, 'request.evt')).toMatchObject({ resolution: 'answered', runtime_wait: 'ended' })
  expect(questionOf(store, key, 'request.evt').decision.value).toBe('rejected')
})

test.each([
  ['User', 'approved', 'approved'],
  ['User', 'denied', 'rejected'],
  ['Config', 'approved', 'none'],
  ['AutomatedReviewer', 'denied', 'none'],
] as const)('an OTel decision with source %s and %s gives the human decision %s', async (source, decision, human) => {
  const session = `otel-${source}-${decision}`
  const { store, key, engine } = await observeSession(onTestFinished, 'codex', session)
  const hooks = codexHooks(session)
  await engine.ingest(hookBatch(hooks.start(), hooks.pre('pre.evt', 'call', ms(1)), hooks.request('request.evt', ms(2))))
  await engine.ingest(otelDecision(session, 'call', source, decision, ms(3)))
  await engine.ingest(hookBatch(hooks.post('post.evt', 'call', ms(4))))
  const otel = factsOf(store).find(({ kind }) => kind === 'permission_decision')
  expect(otel).toBeDefined()
  expect(questionOf(store, key, 'request.evt')).toMatchObject({
    action: { action: actionId(key, 'call'), ambiguous: false },
    decision: { value: human, basis: observed, evidence: [otel?.id] },
    answered_at: otel?.at,
  })
  expect(itemOf(store, key, 'request.evt')).toMatchObject({
    runtime_wait: 'ended',
    resolution: 'answered',
    closed_at: otel?.at,
  })
})

test('without OTel a Codex call that ran after the request is an approval inferred by a rule', async () => {
  const { store, key, engine } = await observeSession(onTestFinished, 'codex', 'codex-ran')
  const hooks = codexHooks('codex-ran')
  await engine.ingest(
    hookBatch(
      hooks.start(),
      hooks.pre('pre.evt', 'call', ms(1)),
      hooks.request('request.evt', ms(2)),
      hooks.post('post.evt', 'call', ms(3)),
    ),
  )
  expect(questionOf(store, key, 'request.evt').decision).toEqual({
    value: 'approved',
    basis: rule('permission-decision'),
    evidence: sorted(factOf(store, 'request.evt').id, factOf(store, 'post.evt').id),
  })
})

const claudeEnders = {
  'session end': (hooks: ReturnType<typeof claudeHooks>) => hooks.end('ender.evt', ms(3)),
  'turn end': (hooks: ReturnType<typeof claudeHooks>) => hooks.stop('ender.evt', ms(3)),
}

test.each(Object.entries(claudeEnders))(
  'the Claude %s ends the permission wait without an answer',
  async (name, ender) => {
    const session = `claude-${name.replace(' ', '-')}`
    const { store, key, engine } = await observeSession(onTestFinished, 'claude', session)
    const hooks = claudeHooks(session)
    await engine.ingest(hookBatch(hooks.start(), hooks.pre('pre.evt', 'call', ms(1)), hooks.request('request.evt', ms(2))))
    await engine.ingest(hookBatch(ender(hooks)))
    const request = factOf(store, 'request.evt')
    const end = factOf(store, 'ender.evt')
    expect(itemOf(store, key, 'request.evt')).toMatchObject({
      runtime_wait: 'ended',
      resolution: 'ended_without_answer',
      closed_at: end.at,
    })
    expect(questionOf(store, key, 'request.evt')).toMatchObject({
      decision: { value: 'unknown', basis: rule('permission-decision'), evidence: sorted(request.id, end.id) },
      answered_at: null,
    })
    expect(attentionChanges(store, key).at(-1)).toMatchObject({
      op: 'attention.close',
      basis: observed,
      evidence: [end.id],
    })
  },
)

test.each(['rollout turn_aborted', 'Interrupt hook'])(
  'a Codex %s ends the permission wait without an answer and is inferred as a rejection',
  async (source) => {
    const session = source === 'Interrupt hook' ? 'codex-interrupt' : 'codex-aborted'
    const { store, key, engine } = await observeSession(onTestFinished, 'codex', session)
    const hooks = codexHooks(session)
    await engine.ingest(hookBatch(hooks.start(), hooks.pre('pre.evt', 'call', ms(1)), hooks.request('request.evt', ms(2))))
    if (source === 'Interrupt hook') {
      await engine.ingest(hookBatch(hooks.interrupt('interrupt.evt', ms(3))))
    } else {
      const file = codexRolloutFile(session, ['event_msg.turn_aborted.mock-tui.json'], 40n)
      await engine.ingest(file.batch(1, file.lines.length))
    }
    const aborted = factsOf(store).find(({ kind }) => kind === 'turn_end')
    expect(aborted?.payload).toMatchObject({ outcome: 'interrupted' })
    expect(itemOf(store, key, 'request.evt')).toMatchObject({
      runtime_wait: 'ended',
      resolution: 'ended_without_answer',
      closed_at: aborted?.at,
    })
    expect(questionOf(store, key, 'request.evt')).toMatchObject({
      decision: {
        value: 'rejected',
        basis: rule('permission-decision'),
        evidence: sorted(factOf(store, 'request.evt').id, aborted?.id ?? ''),
      },
      answered_at: null,
    })
  },
)

test('an unanswered question survives the next prompt and the end of the session', async () => {
  const { store, key, engine } = await observeSession(onTestFinished, 'claude', 'unanswered')
  const hooks = claudeHooks('unanswered')
  await engine.ingest(hookBatch(hooks.start(), hooks.pre('ask.evt', 'ask', ms(1), askInput, 'AskUserQuestion')))
  const asked = factsOf(store).find(({ kind }) => kind === 'question_asked')
  expect(itemOf(store, key, 'ask')).toMatchObject({
    kind: 'question',
    text: question,
    question: questionId(key, 'ask'),
    action: actionId(key, 'ask'),
    evidence: [asked?.id],
    runtime_wait: 'active',
    resolution: 'open',
  })
  expect(questionOf(store, key, 'ask').action).toEqual({ action: actionId(key, 'ask'), ambiguous: false, basis: observed })
  await engine.ingest(hookBatch(hooks.prompt('prompt.evt', ms(2))))
  const prompt = factOf(store, 'prompt.evt')
  expect(itemOf(store, key, 'ask')).toMatchObject({ runtime_wait: 'ended', resolution: 'open', closed_at: null })
  await engine.ingest(hookBatch(hooks.end('end.evt', ms(3))))
  expect(itemOf(store, key, 'ask')).toMatchObject({ runtime_wait: 'ended', resolution: 'open', closed_at: null })
  expect(questionOf(store, key, 'ask')).toMatchObject({ decision: { value: 'requested' }, answered_at: null })
  expect(attentionChanges(store, key).map(({ op, evidence }) => [op, evidence])).toEqual([
    ['attention.open', [asked?.id]],
    ['attention.wait', [prompt.id]],
  ])
})

test('a correlated answer closes a question even after the session ended', async () => {
  const { store, key, engine } = await observeSession(onTestFinished, 'claude', 'answered')
  const hooks = claudeHooks('answered')
  await engine.ingest(
    hookBatch(
      hooks.start(),
      hooks.pre('ask.evt', 'ask', ms(1), askInput, 'AskUserQuestion'),
      hooks.end('end.evt', ms(2)),
    ),
  )
  await engine.ingest(hookBatch(hooks.post('answer.evt', 'ask', ms(3), 'AskUserQuestion', askAnswer)))
  const answer = factsOf(store).find(({ kind }) => kind === 'question_answered')
  expect(questionOf(store, key, 'ask')).toMatchObject({
    decision: { value: 'answered', basis: observed, evidence: [answer?.id] },
    answered_at: answer?.at,
  })
  expect(itemOf(store, key, 'ask')).toMatchObject({
    runtime_wait: 'ended',
    resolution: 'answered',
    closed_at: answer?.at,
  })
  expect(attentionChanges(store, key).at(-1)).toMatchObject({ op: 'attention.close', evidence: [answer?.id] })
})

test('an asynchronous Codex question never waits and stays open after a prompt and the session end', async () => {
  const session = 'codex-async'
  const { store, key, engine } = await observeSession(onTestFinished, 'codex', session)
  const file = codexRolloutFile(session, ['event_msg.item_completed.AgentMessage.question-async.mock.json'], 41n)
  await engine.ingest(file.batch(1, file.lines.length))
  const hooks = codexHooks(session)
  await engine.ingest(hookBatch(hooks.prompt('prompt.evt', ms(1)), hooks.end('end.evt', ms(2))))
  expect(itemOf(store, key, 'call_mock_25')).toMatchObject({
    kind: 'question',
    text: 'Proceed with probe?',
    action: null,
    runtime_wait: 'none',
    resolution: 'open',
    closed_at: null,
  })
  expect(attentionChanges(store, key).map(({ op }) => op)).toEqual(['attention.open'])
})

test('a human prompt ends the wait of a blocking Codex question without answering it', async () => {
  const session = 'codex-blocking'
  const { store, key, engine } = await observeSession(onTestFinished, 'codex', session)
  const file = codexRolloutFile(session, [blockingQuestion()], 42n)
  await engine.ingest(file.batch(1, file.lines.length))
  expect(itemOf(store, key, 'call_mock_25')).toMatchObject({ runtime_wait: 'active', resolution: 'open' })
  await engine.ingest(hookBatch(codexHooks(session).prompt('prompt.evt', ms(1))))
  const prompt = factOf(store, 'prompt.evt')
  expect(prompt).toMatchObject({ kind: 'prompt', speaker: 'human' })
  expect(itemOf(store, key, 'call_mock_25')).toMatchObject({ runtime_wait: 'ended', resolution: 'open' })
  expect(attentionChanges(store, key).at(-1)).toMatchObject({ op: 'attention.wait', evidence: [prompt.id] })
})

test.each([
  ['accept', 'answered'],
  ['decline', 'rejected'],
  ['cancel', 'rejected'],
] as const)('an ElicitationResult %s answers only the elicitation with its id', async (action, decision) => {
  const session = `elicitation-${action}`
  const { store, key, engine } = await observeSession(onTestFinished, 'claude', session)
  const hooks = claudeHooks(session)
  await engine.ingest(
    hookBatch(
      hooks.start(),
      hooks.elicitation('first.evt', ms(1), 'first'),
      hooks.elicitation('second.evt', ms(2), 'second'),
      hooks.elicitationResult('result.evt', ms(3), 'first', action),
    ),
  )
  const result = factOf(store, 'result.evt')
  expect(questionOf(store, key, 'first.evt')).toMatchObject({
    decision: { value: decision, basis: observed, evidence: [result.id] },
    answered_at: result.at,
  })
  expect(itemOf(store, key, 'first.evt')).toMatchObject({
    kind: 'question',
    text: 'Which ticket should be closed?',
    runtime_wait: 'ended',
    resolution: 'answered',
  })
  expect(itemOf(store, key, 'second.evt')).toMatchObject({ runtime_wait: 'active', resolution: 'open' })
})

test('a plan approval answers ExitPlanMode as a rule interpretation', async () => {
  const { store, key, engine } = await observeSession(onTestFinished, 'claude', 'plan')
  const hooks = claudeHooks('plan')
  await engine.ingest(
    hookBatch(hooks.start(), hooks.pre('plan.evt', 'plan', ms(1), { plan: 'Parse, then test' }, 'ExitPlanMode')),
  )
  expect(itemOf(store, key, 'plan')).toMatchObject({ runtime_wait: 'active', resolution: 'open' })
  await engine.ingest(hookBatch(hooks.post('approved.evt', 'plan', ms(2), 'ExitPlanMode', { plan: 'Parse, then test' })))
  const approved = factsOf(store).find(({ kind }) => kind === 'action_end')
  expect(questionOf(store, key, 'plan').decision).toMatchObject({ value: 'approved', basis: rule('plan-approval') })
  expect(itemOf(store, key, 'plan')).toMatchObject({
    text: 'Parse, then test',
    runtime_wait: 'ended',
    resolution: 'answered',
    closed_at: approved?.at,
  })
})

test('idle and permission notifications open no item while a request for input does', async () => {
  const { store, key, engine } = await observeSession(onTestFinished, 'claude', 'notifications')
  const hooks = claudeHooks('notifications')
  await engine.ingest(
    hookBatch(
      hooks.start(),
      hooks.notification('idle.evt', ms(1), 'idle_prompt'),
      hooks.notification('prompt.evt', ms(2), 'permission_prompt'),
      hooks.notification('input.evt', ms(3), 'agent_needs_input'),
    ),
  )
  expect(attentionOf(store, key).map((item) => item.question)).toEqual([questionId(key, 'input.evt')])
  expect(itemOf(store, key, 'input.evt')).toMatchObject({
    kind: 'question',
    text: 'Claude needs your permission to use Bash',
    runtime_wait: 'active',
    resolution: 'open',
  })
})

test('runtime wait and resolution change independently and keep the marks of the observer', async () => {
  const { store, home, solver, begin } = await setupObserver(onTestFinished)
  const hooks = claudeHooks('session-a')
  const engine = startEngine(store, { all: true })
  await engine.ingest(hookBatch(hooks.pre('ask.evt', 'ask', ms(1), askInput, 'AskUserQuestion')))
  const key = { kind: 'session', runtime: 'claude', session: 'session-a' } as const
  const item = itemOf(store, key, 'ask')
  const input = begin([solver], ObserverCallId.parse('likely-call'))
  expect(
    store.transaction((transaction) =>
      applyObserverResponse(transaction, {
        call: ObserverCallId.parse('likely-call'),
        at: item.opened_at,
        output: response(
          [{ op: 'attention.likely_resolved', item: item.id, evidence: [solver.id], rationale: 'Answered in chat' }],
          input.model.version,
        ),
      }),
    ).status,
  ).toBe('accepted')
  const likely = { basis: { kind: 'interpreted', interpreter: { kind: 'llm', call: 'likely-call' } }, evidence: [solver.id] }
  await engine.ingest(hookBatch(hooks.end('end.evt', ms(2))))
  expect(itemOf(store, key, 'ask')).toMatchObject({
    runtime_wait: 'ended',
    resolution: 'open',
    closed_at: null,
    likely_resolved: likely,
  })
  await engine.ingest(hookBatch(hooks.post('answer.evt', 'ask', ms(3), 'AskUserQuestion', askAnswer)))
  expect(itemOf(store, key, 'ask')).toMatchObject({
    runtime_wait: 'ended',
    resolution: 'answered',
    likely_resolved: likely,
  })
  const entities = store.model.entities(runA)
  store.close()
  const reopened = home.open()
  expect(reopened.model.entities(runA)).toEqual(entities)
  reopened.transaction((transaction) => {
    transaction.model.replay()
  })
  expect(reopened.model.entities(runA)).toEqual(entities)
})

test.each(['request-first', 'call-first'])(
  'the item and decision do not depend on the order of reading or a restart: %s',
  async (order) => {
    const session = `order-${order}`
    const { home, store, key, engine } = await observeSession(onTestFinished, 'claude', session)
    const hooks = claudeHooks(session)
    const requests = hookBatch(hooks.start(), hooks.request('request.evt', ms(2)))
    const calls = hookBatch(hooks.pre('pre.evt', 'call', ms(1)), hooks.post('post.evt', 'call', ms(3)))
    for (const batch of order === 'request-first' ? [requests, calls] : [calls, requests]) {
      await engine.ingest(batch)
    }
    const request = factOf(store, 'request.evt')
    const post = factOf(store, 'post.evt')
    expect(questionOf(store, key, 'request.evt')).toMatchObject({
      action: { action: actionId(key, 'call'), ambiguous: false },
      decision: { value: 'approved', evidence: sorted(request.id, post.id) },
    })
    expect(itemOf(store, key, 'request.evt')).toMatchObject({
      action: actionId(key, 'call'),
      runtime_wait: 'ended',
      resolution: 'answered',
      opened_at: request.at,
      closed_at: post.at,
    })
    const items = attentionOf(store, key)
    const head = store.changes.head()
    store.close()
    const reopened = home.open()
    const restarted = startEngine(reopened, { all: true })
    await restarted.ingest(requests)
    await restarted.ingest(calls)
    expect(reopened.changes.head()).toBe(head)
    expect(attentionOf(reopened, key)).toEqual(items)
  },
)

test('a call read after its request refines the open item', async () => {
  const { store, key, engine } = await observeSession(onTestFinished, 'claude', 'refined')
  const hooks = claudeHooks('refined')
  await engine.ingest(hookBatch(hooks.start(), hooks.request('request.evt', ms(2))))
  expect(itemOf(store, key, 'request.evt')).toMatchObject({ action: null, runtime_wait: 'active' })
  await engine.ingest(hookBatch(hooks.pre('pre.evt', 'call', ms(1))))
  const request = factOf(store, 'request.evt')
  expect(itemOf(store, key, 'request.evt')).toMatchObject({
    action: actionId(key, 'call'),
    runtime_wait: 'active',
    resolution: 'open',
  })
  expect(attentionChanges(store, key).map(({ op, evidence }) => [op, evidence])).toEqual([
    ['attention.open', [request.id]],
    ['attention.open', [request.id]],
  ])
})

test('an answer read before its question opens nothing until the question arrives', async () => {
  const { store, key, engine } = await observeSession(onTestFinished, 'claude', 'answer-first')
  const hooks = claudeHooks('answer-first')
  await engine.ingest(hookBatch(hooks.start(), hooks.post('answer.evt', 'ask', ms(2), 'AskUserQuestion', askAnswer)))
  expect(store.observations.questions(objectId(key))).toEqual([])
  expect(attentionOf(store, key)).toEqual([])
  await engine.ingest(hookBatch(hooks.pre('ask.evt', 'ask', ms(1), askInput, 'AskUserQuestion')))
  expect(itemOf(store, key, 'ask')).toMatchObject({ runtime_wait: 'ended', resolution: 'answered' })
  expect(attentionChanges(store, key).map(({ op, version }) => [op, version])).toEqual([
    ['attention.open', attentionChanges(store, key)[0]?.version],
    ['attention.close', attentionChanges(store, key)[0]?.version],
  ])
})

test('redelivered requests from two registrations keep separate items linked to one call', async () => {
  const { store, key, engine } = await observeSession(onTestFinished, 'claude', 'redelivery')
  const hooks = claudeHooks('redelivery')
  await engine.ingest(
    hookBatch(
      hooks.start(),
      hooks.pre('pre.evt', 'call', ms(1)),
      hooks.request('plugin.evt', ms(2)),
      { ...hooks.request('user.evt', ms(3)), registration: 'user' },
      hooks.post('post.evt', 'call', ms(4)),
    ),
  )
  const questions = ['plugin.evt', 'user.evt'].map((file) => questionOf(store, key, file))
  expect(questions.map(({ redelivery_group }) => redelivery_group)).toEqual([
    questions[0]?.redelivery_group,
    questions[0]?.redelivery_group,
  ])
  expect(questions[0]?.redelivery_group).not.toBeNull()
  expect(['plugin.evt', 'user.evt'].map((file) => itemOf(store, key, file))).toMatchObject([
    { action: actionId(key, 'call'), resolution: 'answered' },
    { action: actionId(key, 'call'), resolution: 'answered' },
  ])
})
