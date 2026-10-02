import {
  type Assessed,
  AttentionItemId,
  type Fact,
  type HumanDecision,
  ObserverCallId,
  type ObserverOp,
  type Question,
  TempId,
} from '@aang/contract'
import {
  applyChangeSet,
  applyObserverResponse,
  type AttentionItemDraft,
  refreshStageDecisions,
  refreshStageExecution,
} from '@aang/engine'
import type { Store } from '@aang/store'
import { expect, test } from 'vitest'
import { hookBatch } from './batches.js'
import {
  asyncQuestionLine,
  codexCall,
  codexRun,
  codexSession,
  setupCodexObserver,
  userMessageLine,
} from './codex-observer.js'
import { factsOf, startEngine } from './harness.js'
import { at, byObserver, byRule, drafts, observed, put, runA, sessionA, stages } from './model.js'
import { callId, existing, response, setupObserver, version } from './observer-fixtures.js'
import { claudeHook } from './samples.js'

const decisionRule = byRule('stage-decision')
const noObservations = { actions: [], agents: [] }

const ingestRequest = async (store: Store, cwd: string, file: string, command: string) => {
  const known = new Set(factsOf(store).map(({ id }) => id))
  await startEngine(store, { all: true }).ingest(
    hookBatch({
      file,
      payload: claudeHook('PermissionRequest.Bash.json', { session: 'session-a', cwd }, { tool_input: { command } }),
    }),
  )
  const fact = factsOf(store).find(({ id, kind }) => kind === 'permission_request' && !known.has(id))
  const question = store.observations
    .questions(sessionA)
    .find(({ decision }) => fact !== undefined && decision.evidence.includes(fact.id))
  if (fact === undefined || question === undefined) {
    throw new Error('the permission hook must produce a request and its question')
  }
  return { fact, question }
}

const ingestHookFact = async (store: Store, cwd: string, name: string, file: string): Promise<Fact> => {
  const known = new Set(factsOf(store).map(({ id }) => id))
  await startEngine(store, { all: true }).ingest(
    hookBatch({ file, payload: claudeHook(name, { session: 'session-a', cwd }) }),
  )
  const fact = factsOf(store).find(({ id }) => !known.has(id))
  if (fact === undefined) {
    throw new Error(`the ${name} hook must produce a fact`)
  }
  return fact
}

const ruleItem = (id: string, fact: Fact, question: Question): AttentionItemDraft => ({
  ...drafts.permission,
  id: AttentionItemId.parse(id),
  stage: stages.build,
  question: question.id,
  evidence: [fact.id],
  opened_at: fact.at,
})

const closed = (item: AttentionItemDraft, second: number): AttentionItemDraft => ({
  ...item,
  runtime_wait: 'ended',
  resolution: 'answered',
  closed_at: at(second),
})

const applyRule = (
  store: Store,
  op: 'attention.open' | 'attention.close',
  items: AttentionItemDraft[],
  second: number,
  refresh: 'execution' | 'decisions' = 'execution',
) => {
  store.transaction((transaction) => {
    applyChangeSet(transaction, {
      run: runA,
      author: 'rule',
      at: at(second),
      changes: items.map((item) => put(op, { kind: 'attention_item', value: item }, observed, item.evidence)),
    })
    if (refresh === 'execution') {
      refreshStageExecution(transaction, { run: runA, at: at(second), observations: noObservations })
    } else {
      refreshStageDecisions(transaction, { run: runA, at: at(second) })
    }
  })
}

const decide = (store: Store, question: Question, decision: Assessed<HumanDecision>): void => {
  store.transaction(({ observations }) => {
    observations.save({ ...question, decision })
  })
}

test('an active human request makes the stage wait with a requested decision until the observed approval', async ({
  onTestFinished,
}) => {
  const { store, home, solver, begin, stage } = await setupObserver(onTestFinished)
  const { fact, question } = await ingestRequest(store, home.path, 'approve.evt', 'pnpm test')
  const item = ruleItem('attention-approve', fact, question)
  applyRule(store, 'attention.open', [item], 5)
  expect(stage()).toMatchObject({
    value: {
      execution: { value: { state: 'waiting', reason: 'human' } },
      decision: { value: 'requested', basis: decisionRule, evidence: [fact.id] },
    },
  })
  const input = begin([solver])
  const done: ObserverOp = {
    op: 'stage.state',
    stage: existing(stages.build),
    execution: { state: 'done' },
    evidence: [solver.id],
    rationale: 'The solver reports completion',
  }
  expect(
    store.transaction((transaction) =>
      applyObserverResponse(transaction, {
        call: callId,
        output: response([done], input.model.version),
        at: at(20),
        observations: noObservations,
      }),
    ).status,
  ).toBe('accepted')
  expect(stage()).toMatchObject({
    value: {
      execution: { value: { state: 'waiting', reason: 'human' } },
      execution_claim: { value: { state: 'done' } },
      decision: { value: 'requested' },
    },
  })
  const approval = await ingestHookFact(store, home.path, 'PostToolUse.Bash.json', 'approved-call.evt')
  decide(store, question, { value: 'approved', basis: byRule('permission-decision'), evidence: [approval.id] })
  applyRule(store, 'attention.close', [closed(item, 30)], 30)
  expect(stage()).toMatchObject({
    value: {
      execution: { value: { state: 'done' } },
      execution_claim: null,
      decision: { value: 'approved', basis: decisionRule, evidence: [approval.id] },
    },
  })
  const entities = store.model.entities(runA)
  store.transaction((transaction) => {
    transaction.model.replay()
  })
  expect(store.model.entities(runA)).toEqual(entities)
  store.close()
  expect(home.open().model.entities(runA)).toEqual(entities)
})

test.for([
  ['approved', 'answered', 'PostToolUse.Bash.json', 'approved'],
  ['rejected', 'answered', 'PostToolBatch.denied-by-human.json', 'rejected'],
  ['requested', 'ended_without_answer', 'Stop.json', 'unknown'],
] as const)(
  'a stage whose request has the %s decision and %s resolution after %s reports %s',
  async ([observedDecision, resolution, hook, expected], { onTestFinished }) => {
    const { store, home, stage } = await setupObserver(onTestFinished)
    const { fact, question } = await ingestRequest(store, home.path, 'single.evt', 'pnpm lint')
    const item = ruleItem('attention-single', fact, question)
    applyRule(store, 'attention.open', [item], 5, 'decisions')
    expect(stage()).toMatchObject({
      value: { execution: drafts.build.execution, decision: { value: 'requested', evidence: [fact.id] } },
    })
    const outcome = await ingestHookFact(store, home.path, hook, 'single-outcome.evt')
    if (observedDecision !== 'requested') {
      decide(store, question, { value: observedDecision, basis: observed, evidence: [outcome.id] })
    }
    applyRule(store, 'attention.close', [{ ...closed(item, 30), resolution, evidence: [outcome.id] }], 30, 'decisions')
    expect(stage()).toMatchObject({
      value: { decision: { value: expected, basis: decisionRule, evidence: [outcome.id] } },
    })
    const head = store.model.head(runA)
    expect(store.transaction((transaction) => refreshStageDecisions(transaction, { run: runA, at: at(40) }))).toBeNull()
    expect(store.model.head(runA)).toBe(head)
  },
)

test('the latest closed request decides once nothing is open, and observer requests count without a runtime snapshot', async ({
  onTestFinished,
}) => {
  const { store, home, human, solver, begin, stage } = await setupObserver(onTestFinished)
  const first = await ingestRequest(store, home.path, 'first.evt', 'pnpm test')
  const second = await ingestRequest(store, home.path, 'second.evt', 'pnpm build')
  const items = [
    ruleItem('attention-first', first.fact, first.question),
    ruleItem('attention-second', second.fact, second.question),
  ] as const
  applyRule(store, 'attention.open', [...items], 5)
  expect(stage()).toMatchObject({ value: { decision: { value: 'requested' } } })
  const approval = await ingestHookFact(store, home.path, 'PostToolUse.Bash.json', 'first-approved.evt')
  const rejection = await ingestHookFact(store, home.path, 'PostToolBatch.denied-by-human.json', 'second-denied.evt')
  decide(store, first.question, { value: 'approved', basis: observed, evidence: [approval.id] })
  applyRule(store, 'attention.close', [closed(items[0], 30)], 30)
  expect(stage()).toMatchObject({
    value: { decision: { value: 'requested', basis: decisionRule, evidence: [second.fact.id] } },
  })
  decide(store, second.question, { value: 'rejected', basis: observed, evidence: [rejection.id] })
  applyRule(store, 'attention.close', [closed(items[1], 40)], 40)
  expect(stage()).toMatchObject({
    value: { decision: { value: 'rejected', basis: decisionRule, evidence: [rejection.id] } },
  })
  const current = stage()
  const execution = current?.kind === 'stage' ? current.value.execution : undefined
  const input = begin([human, solver])
  const grounds = { evidence: [solver.id], rationale: 'A follow-up review' }
  expect(
    store.transaction((transaction) =>
      applyObserverResponse(transaction, {
        call: callId,
        at: at(50),
        output: response(
          [
            {
              ...grounds,
              op: 'attention.add',
              temp_id: TempId.parse('review'),
              kind: 'review_request',
              text: 'Review the build change',
              stage: existing(stages.build),
            },
            {
              ...grounds,
              op: 'attention.add',
              temp_id: TempId.parse('blocker'),
              kind: 'blocker',
              text: 'The build cache is missing',
              stage: existing(stages.build),
            },
          ],
          input.model.version,
        ),
      }),
    ),
  ).toEqual({ status: 'accepted', version: version(input.model.version + 2) })
  const review = store.model
    .entities(runA)
    .find((entity) => entity.kind === 'attention_item' && entity.value.text === 'Review the build change')
  if (review?.kind !== 'attention_item') {
    throw new Error('the review request must be stored')
  }
  expect(stage()).toMatchObject({
    value: {
      execution,
      decision: { value: 'requested', basis: decisionRule, evidence: [solver.id] },
    },
  })
  const resolve = ObserverCallId.parse('review-answered')
  const next = begin([human], resolve)
  expect(
    store.transaction((transaction) =>
      applyObserverResponse(transaction, {
        call: resolve,
        at: at(60),
        output: response(
          [
            {
              op: 'attention.resolve',
              item: { kind: 'existing', id: review.value.id },
              resolution: 'answered',
              evidence: [human.id],
              rationale: 'The human accepted the change',
            },
          ],
          next.model.version,
        ),
      }),
    ).status,
  ).toBe('accepted')
  expect(stage()).toMatchObject({
    value: { decision: { value: 'answered', basis: decisionRule, evidence: [human.id] } },
  })
  expect(store.model.changes(runA, version(next.model.version))).toEqual([
    expect.objectContaining({ op: 'attention.resolve', author: 'observer' }),
    expect.objectContaining({ op: 'stage.execution', author: 'rule', evidence: [human.id] }),
  ])
})

test('refining a closed request cites the latest resolution, not the earlier closing or a later priority', async ({
  onTestFinished,
}) => {
  const { store, home, human, solver, tool, begin, stage } = await setupObserver(onTestFinished)
  const respond = (call: string, second: number, op: ObserverOp) => {
    const id = ObserverCallId.parse(call)
    const input = begin([solver, human, tool], id)
    return store.transaction(
      (transaction) =>
        applyObserverResponse(transaction, {
          call: id,
          at: at(second),
          output: response([op], input.model.version),
        }).status,
    )
  }
  expect(
    respond('review-add', 50, {
      op: 'attention.add',
      temp_id: TempId.parse('review'),
      kind: 'review_request',
      text: 'Review the build change',
      stage: existing(stages.build),
      evidence: [solver.id],
      rationale: 'The solver asked for a review',
    }),
  ).toBe('accepted')
  const review = store.model
    .entities(runA)
    .find((entity) => entity.kind === 'attention_item' && entity.value.text === 'Review the build change')
  if (review?.kind !== 'attention_item') {
    throw new Error('the review request must be stored')
  }
  const item = { kind: 'existing', id: review.value.id } as const
  expect(
    respond('review-resolved', 60, {
      op: 'attention.resolve',
      item,
      resolution: 'resolved',
      evidence: [tool.id],
      rationale: 'The tool output settled the review',
    }),
  ).toBe('accepted')
  expect(stage()).toMatchObject({
    value: { decision: { value: 'unknown', basis: decisionRule, evidence: [tool.id] } },
  })
  expect(
    respond('review-answered', 70, {
      op: 'attention.resolve',
      item,
      resolution: 'answered',
      evidence: [human.id],
      rationale: 'The human answered the review',
    }),
  ).toBe('accepted')
  expect(
    respond('review-priority', 80, {
      op: 'attention.priority',
      item,
      priority: 'low',
      evidence: [solver.id],
      rationale: 'The answered review no longer matters',
    }),
  ).toBe('accepted')
  const answered = { value: { decision: { value: 'answered', basis: decisionRule, evidence: [human.id] } } }
  expect(stage()).toMatchObject(answered)
  store.transaction((transaction) => {
    transaction.model.replay()
  })
  expect(stage()).toMatchObject(answered)
  store.close()
  const reopened = home.open()
  expect(reopened.model.entity(runA, { kind: 'stage', id: stages.build })).toMatchObject(answered)
  expect(
    reopened.transaction((transaction) => refreshStageDecisions(transaction, { run: runA, at: at(90) })),
  ).toBeNull()
})

test('resolving a rule question rejects the whole response and leaves every batch fact pending', async ({
  onTestFinished,
}) => {
  const { store, home, solver, human, begin, stage } = await setupObserver(onTestFinished)
  const { fact, question } = await ingestRequest(store, home.path, 'rule-question.evt', 'rm -rf build')
  const item = ruleItem('attention-rule-question', fact, question)
  applyRule(store, 'attention.open', [item], 5)
  const before = store.model.entities(runA)
  const head = store.model.head(runA)
  const input = begin([solver, human])
  const grounds = { evidence: [human.id], rationale: 'The human replied in the prompt' }
  const valid: ObserverOp[] = [
    { ...grounds, op: 'question.add', temp_id: TempId.parse('question'), text: 'Keep the cache?', stage: null },
    { ...grounds, op: 'attention.priority', item: { kind: 'existing', id: item.id }, priority: 'high' },
    { ...grounds, op: 'brief.update', text: 'Clean the build output' },
  ]
  const resolveRule: ObserverOp = {
    ...grounds,
    op: 'attention.resolve',
    item: { kind: 'existing', id: item.id },
    resolution: 'answered',
  }
  expect(
    store.transaction((transaction) =>
      applyObserverResponse(transaction, {
        call: callId,
        at: at(20),
        output: response([...valid, resolveRule], input.model.version),
      }),
    ),
  ).toMatchObject({
    status: 'rejected',
    rejections: [expect.objectContaining({ op_index: 3, cause: 'invariant' })],
  })
  expect(store.model.entities(runA)).toEqual(before)
  expect(store.model.head(runA)).toBe(head)
  expect(store.interpretations.ofCall(callId).map(({ status }) => status)).toEqual(['pending', 'pending'])
  const retry = ObserverCallId.parse('without-rule-resolution')
  const next = begin([solver, human], retry)
  expect(
    store.transaction((transaction) =>
      applyObserverResponse(transaction, { call: retry, at: at(30), output: response(valid, next.model.version) }),
    ).status,
  ).toBe('accepted')
  expect(store.model.entity(runA, { kind: 'attention_item', id: item.id })).toMatchObject({
    value: { resolution: 'open', closed_at: null, priority: { value: 'high', call: retry } },
  })
  expect(stage()).toMatchObject({
    value: {
      execution: { value: { state: 'waiting', reason: 'human' } },
      decision: { value: 'requested', evidence: [fact.id] },
    },
  })
})

test('a likely answer to an asynchronous Codex question marks the rule item and leaves it open', async ({
  onTestFinished,
}) => {
  const { store, facts, begin, stage } = await setupCodexObserver(onTestFinished, [
    asyncQuestionLine(41),
    userMessageLine(42, 'yes, proceed with the probe'),
  ])
  const asked = facts.find((fact) => fact.kind === 'question_asked')
  const reply = facts.find((fact) => fact.kind === 'prompt' && fact.payload.text === 'yes, proceed with the probe')
  if (asked === undefined || reply === undefined || asked.entity_key.kind !== 'question') {
    throw new Error('the rollout must contain the asynchronous question and the reply')
  }
  const observedQuestion = store.observations
    .questions(codexSession)
    .find(({ decision }) => decision.evidence.includes(asked.id))
  if (observedQuestion === undefined) {
    throw new Error('the asynchronous question must be observed')
  }
  expect(observedQuestion.blocking).toBe(false)
  const item: AttentionItemDraft = {
    ...drafts.permission,
    id: AttentionItemId.parse('attention-codex-question'),
    run: codexRun,
    kind: 'question',
    text: 'Proceed with probe?',
    stage: stages.build,
    question: observedQuestion.id,
    evidence: [asked.id],
    runtime_wait: 'none',
    opened_at: asked.at,
  }
  store.transaction((transaction) => {
    applyChangeSet(transaction, {
      run: codexRun,
      author: 'rule',
      at: at(5),
      changes: [put('attention.open', { kind: 'attention_item', value: item }, observed, [asked.id])],
    })
    refreshStageExecution(transaction, { run: codexRun, at: at(5), observations: noObservations })
  })
  expect(stage()).toMatchObject({
    value: { execution: { value: { state: 'planned' } }, decision: { value: 'requested', evidence: [asked.id] } },
  })
  const input = begin([asked, reply])
  expect(
    store.transaction((transaction) =>
      applyObserverResponse(transaction, {
        call: codexCall,
        at: at(20),
        observations: noObservations,
        output: response(
          [
            {
              op: 'attention.likely_resolved',
              item: item.id,
              evidence: [reply.id],
              rationale: 'The next human prompt answers the question',
            },
          ],
          input.model.version,
        ),
      }),
    ).status,
  ).toBe('accepted')
  expect(store.model.entity(codexRun, { kind: 'attention_item', id: item.id })).toMatchObject({
    value: {
      resolution: 'open',
      closed_at: null,
      runtime_wait: 'none',
      likely_resolved: { basis: byObserver(codexCall), evidence: [reply.id] },
    },
  })
  expect(stage()).toMatchObject({
    value: { execution: { value: { state: 'planned' } }, decision: { value: 'requested', evidence: [asked.id] } },
  })
})
