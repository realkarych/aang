import { ObserverCallId, type ObserverOp } from '@aang/contract'
import { applyChangeSet, applyObserverResponse } from '@aang/engine'
import { expect, test } from 'vitest'
import { at, byRule, drafts, put, runA, stages } from './model.js'
import {
  callId,
  createStage,
  existing,
  response,
  setupObserver,
  temporary,
  version,
} from './observer-fixtures.js'

test('accepts an entire response with forward temporary references and journals the call and computed basis', async ({
  onTestFinished,
}) => {
  const { store, solver, begin } = await setupObserver(onTestFinished)
  begin()
  const parent = createStage([solver.id], 'parent')
  const child = { ...createStage([solver.id], 'child'), parent: temporary('parent') }
  const result = store.transaction((transaction) =>
    applyObserverResponse(transaction, {
      call: callId,
      output: response([child, parent], 2),
      at: at(20),
    }),
  )
  expect(result.status).toBe('accepted')
  expect(store.model.head(runA)).toBe(3)
  const changes = store.model.changes(runA, version(2))
  expect(changes).toHaveLength(2)
  expect(changes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        author: 'observer',
        observer_call: callId,
        basis: { kind: 'claimed' },
        evidence: [solver.id],
      }),
    ]),
  )
  const created = changes.flatMap(({ after }) => (after?.kind === 'stage' ? [after.value] : []))
  expect(created[0]?.parent).toBe(created[1]?.id)
  expect(store.interpretations.ofCall(callId).map(({ status }) => status)).toEqual([
    'interpreted',
    'interpreted',
    'interpreted',
  ])
  expect(store.observerCalls.get(callId)).toMatchObject({ base_version: 2, verdict: 'accepted', reasons: [] })
})

test.for([
  'missing',
  'foreign',
  'unsent',
  'wrong-kind',
  'duplicate-temp',
  'missing-temp',
  'cycle',
  'successor-cycle',
  'version',
  'schema',
])(
  'rejects %s and returns the whole batch to pending without accepting its shared fact',
  async (scenario, { onTestFinished }) => {
    const { store, solver, human, tool, facts, begin } = await setupObserver(onTestFinished)
    begin()
    const evidence = [solver.id]
    const nest = (stage: string, parent: string): ObserverOp => ({
      op: 'stage.nest',
      stage: existing(stage),
      parent: existing(parent),
      evidence,
      rationale: 'Nest',
    })
    const unsent = facts.find((fact) => ![solver.id, human.id, tool.id].includes(fact.id))
    if (unsent === undefined) {
      throw new Error('the transcript must contain facts outside the batch')
    }
    const invalid: Record<string, unknown> = {
      missing: {
        op: 'stage.state',
        stage: existing('invented'),
        execution: { state: 'done' },
        evidence,
        rationale: 'Done',
      },
      foreign: {
        op: 'stage.state',
        stage: existing(stages.verify),
        execution: { state: 'done' },
        evidence,
        rationale: 'Done',
      },
      unsent: createStage([unsent.id], 'unsent'),
      'wrong-kind': {
        op: 'criterion.assess',
        criterion: temporary('new-stage'),
        status: 'reported_done',
        evidence,
        rationale: 'Done',
      },
      'duplicate-temp': createStage(evidence),
      'missing-temp': {
        op: 'stage.nest',
        stage: temporary('unknown'),
        parent: null,
        evidence,
        rationale: 'Nest',
      },
      cycle: nest(stages.build, stages.test),
      'successor-cycle': {
        op: 'stage.replace',
        stage: existing(stages.test),
        by: [existing(stages.build)],
        evidence,
        rationale: 'Replace',
      },
      version: createStage(evidence, 'second'),
      schema: { ...createStage(evidence, 'second'), basis: { kind: 'observed' } },
    }
    const extra: ObserverOp[] =
      scenario === 'cycle'
        ? [nest(stages.test, stages.build)]
        : scenario === 'successor-cycle'
          ? [
              {
                op: 'stage.replace',
                stage: existing(stages.build),
                by: [existing(stages.test)],
                evidence,
                rationale: 'Replace',
              },
            ]
          : []
    const before = store.model.entities(runA)
    const result = store.transaction((transaction) =>
      applyObserverResponse(transaction, {
        call: callId,
        output: {
          base_version: scenario === 'version' ? 99 : 2,
          ops: [createStage(evidence), ...extra, invalid[scenario]],
          needs: [],
        },
        at: at(20),
      }),
    )
    expect(result.status).toBe('rejected')
    expect(store.model.head(runA)).toBe(2)
    expect(store.model.entities(runA)).toEqual(before)
    expect(store.interpretations.ofRun(runA).map(({ status }) => status)).toEqual([
      'pending',
      'pending',
      'pending',
    ])
    expect(store.observerCalls.get(callId)?.verdict).toBe('rejected')
    expect(store.observerCalls.get(callId)?.reasons).toHaveLength(1)
  },
)

test.for(['rule-other-field', 'user-other-field', 'user-same-field', 'replace', 'merge', 'split', 'move'])(
  'compares the current target history with the saved base for %s',
  async (scenario, { onTestFinished }) => {
    const { store, solver, begin, stage } = await setupObserver(onTestFinished)
    begin()
    const op =
      scenario === 'replace'
        ? 'stage.replace'
        : scenario === 'merge'
          ? 'stage.merge'
          : scenario === 'split'
            ? 'stage.split'
            : scenario === 'move'
              ? 'session.move'
              : 'stage.update'
    store.transaction((transaction) =>
      applyChangeSet(transaction, {
        run: runA,
        author: scenario.startsWith('user') ? 'user' : 'rule',
        at: at(11),
        changes: [
          put(
            op,
            {
              kind: 'stage',
              value: {
                ...drafts.build,
                ...(scenario === 'user-same-field' ? { title: 'User title' } : { summary: 'Another field' }),
              },
            },
            byRule('projection'),
            [],
          ),
        ],
      }),
    )
    const result = store.transaction((transaction) =>
      applyObserverResponse(transaction, {
        call: callId,
        output: response(
          [
            {
              op: 'stage.update',
              stage: existing(stages.build),
              title: 'New title',
              summary: null,
              expected_result: null,
              evidence: [solver.id],
              rationale: 'Update',
            },
          ],
          2,
        ),
        at: at(20),
      }),
    )
    expect(result.status).toBe(scenario.endsWith('other-field') ? 'accepted' : 'rejected')
    if (scenario.endsWith('other-field')) {
      expect(stage()).toMatchObject({ value: { title: 'New title', summary: 'Another field' } })
    } else {
      expect(result).toMatchObject({ rejections: [expect.objectContaining({ cause: 'conflict' })] })
    }
  },
)

test('keeps rule execution while recording the solver claim and never closes rule attention', async ({
  onTestFinished,
}) => {
  const { store, solver, begin, stage } = await setupObserver(onTestFinished)
  store.transaction((transaction) =>
    applyChangeSet(transaction, {
      run: runA,
      author: 'rule',
      at: at(3),
      changes: [
        put('stage.execution', { kind: 'stage', value: drafts.running }, byRule('stage-execution'), []),
      ],
    }),
  )
  begin()
  const done: ObserverOp = {
    op: 'stage.state',
    stage: existing(stages.build),
    execution: { state: 'done' },
    evidence: [solver.id],
    rationale: 'Solver finished',
  }
  const accepted = store.transaction((transaction) =>
    applyObserverResponse(transaction, { call: callId, output: response([done], 3), at: at(20) }),
  )
  expect(accepted.status).toBe('accepted')
  expect(stage()).toMatchObject({
    value: {
      execution: { value: { state: 'running' }, basis: byRule('stage-execution') },
      execution_claim: { value: { state: 'done' }, basis: { kind: 'claimed' }, evidence: [solver.id] },
    },
  })
  const next = ObserverCallId.parse('reject-rule-close')
  begin([solver], next)
  const result = store.transaction((transaction) =>
    applyObserverResponse(transaction, {
      call: next,
      output: response(
        [
          {
            op: 'attention.resolve',
            item: { kind: 'existing', id: drafts.permission.id },
            resolution: 'answered',
            evidence: [solver.id],
            rationale: 'Answered',
          },
        ],
        4,
      ),
      at: at(30),
    }),
  )
  expect(result).toMatchObject({
    status: 'rejected',
    rejections: [expect.objectContaining({ cause: 'invariant' })],
  })
  expect(store.model.entity(runA, { kind: 'attention_item', id: drafts.permission.id })).toMatchObject({
    value: { resolution: 'open' },
  })
})

test('does not accept origin plan without an actual plan fact', async ({ onTestFinished }) => {
  const { store, solver, begin } = await setupObserver(onTestFinished)
  begin()
  const result = store.transaction((transaction) =>
    applyObserverResponse(transaction, {
      call: callId,
      output: response([{ ...createStage([solver.id]), origin: 'plan' } as ObserverOp], 2),
      at: at(20),
    }),
  )
  expect(result).toMatchObject({
    status: 'rejected',
    rejections: [expect.objectContaining({ cause: 'invariant' })],
  })
})

test('marks completion based only on solver statements as claimed, not observed', async ({
  onTestFinished,
}) => {
  const { store, solver, begin, stage } = await setupObserver(onTestFinished)
  begin([solver])
  expect(
    store.transaction((transaction) =>
      applyObserverResponse(transaction, {
        call: callId,
        output: response(
          [
            {
              op: 'stage.state',
              stage: existing(stages.build),
              execution: { state: 'done' },
              evidence: [solver.id],
              rationale: 'The solver reports completion',
            },
          ],
          2,
        ),
        at: at(20),
      }),
    ).status,
  ).toBe('accepted')
  expect(stage()).toMatchObject({
    value: {
      execution: { value: { state: 'done' }, basis: { kind: 'claimed' }, evidence: [solver.id] },
      execution_claim: null,
    },
  })
})

test('computes interpreted basis from mixed speakers and enforces output limits atomically', async ({
  onTestFinished,
}) => {
  const { store, solver, human, begin } = await setupObserver(onTestFinished)
  begin()
  const accepted = store.transaction((transaction) =>
    applyObserverResponse(transaction, {
      call: callId,
      output: response([createStage([solver.id, human.id])], 2),
      at: at(20),
    }),
  )
  expect(accepted.status).toBe('accepted')
  expect(store.model.changes(runA, version(2))[0]?.basis).toEqual({
    kind: 'interpreted',
    interpreter: { kind: 'llm', call: callId },
  })
  const next = ObserverCallId.parse('limited-call')
  begin([solver], next)
  const result = store.transaction((transaction) =>
    applyObserverResponse(transaction, {
      call: next,
      output: response([createStage([solver.id])], 3),
      at: at(30),
      limits: { operations: 1, textLength: 4 },
    }),
  )
  expect(result.status).toBe('rejected')
  expect(store.observerCalls.get(next)?.reasons.map(({ cause }) => cause)).toContain('limit')
})
