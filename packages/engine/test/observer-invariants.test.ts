import {
  ActionId,
  AgentId,
  ArtifactVersionId,
  ObserverCallId,
  type ObserverOp,
  ObserverOutput,
} from '@aang/contract'
import { applyObserverResponse, beginObserverCall } from '@aang/engine'
import { expect, test } from 'vitest'
import { hookBatch } from './batches.js'
import { factsOf, startEngine } from './harness.js'
import { at, drafts, runA, runB, stages } from './model.js'
import {
  callId,
  createStage,
  existing,
  inputFor,
  response,
  setupObserver,
  temporary,
  version,
} from './observer-fixtures.js'

test('uses stored speakers and kinds, accepts real plan facts and keeps rule attention open after a likely resolution', async ({
  onTestFinished,
}) => {
  const { store, solver, human, begin, home } = await setupObserver(onTestFinished)
  await startEngine(store, { all: true }).ingest(
    hookBatch({
      file: 'plan.evt',
      payload: JSON.stringify({
        session_id: 'session-a',
        cwd: home.path,
        hook_event_name: 'TaskCreated',
        task_id: 'task-1',
        task_subject: 'Validate the observer',
        task_description: 'Validate operations',
      }),
    }),
  )
  const plan = factsOf(store).find(({ kind }) => kind === 'plan_update')
  if (plan === undefined) {
    throw new Error('the task hook must produce a plan fact')
  }
  const input = inputFor(store, [solver, human, plan])
  input.batch.facts = input.batch.facts.map((fact) => ({ ...fact, speaker: 'solver' }))
  store.transaction((transaction) => {
    beginObserverCall(transaction, { id: callId, input, at: at(10) })
  })
  const output = ObserverOutput.parse({
    base_version: 2,
    needs: [],
    ops: [
      { ...createStage([plan.id]), origin: 'plan' },
      {
        op: 'criterion.add',
        temp_id: 'criterion',
        stage: temporary('new-stage'),
        text: 'Tests pass',
        source: 'plan',
        evidence: [plan.id],
        rationale: 'Plan',
      },
      {
        op: 'criterion.assess',
        criterion: temporary('criterion'),
        status: 'reported_done',
        evidence: [human.id],
        rationale: 'Assessment',
      },
      {
        op: 'attention.likely_resolved',
        item: drafts.permission.id,
        evidence: [solver.id],
        rationale: 'Probably answered',
      },
      { op: 'brief.update', text: 'Work on the parser', evidence: [human.id], rationale: 'Task' },
    ],
  })
  expect(
    store.transaction((transaction) =>
      applyObserverResponse(transaction, { call: callId, output, at: at(20) }),
    ),
  ).toMatchObject({ status: 'accepted' })
  expect(store.model.entities(runA)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: 'stage',
        value: expect.objectContaining({ origin: 'plan', basis: { kind: 'claimed' } }) as unknown,
      }),
      expect.objectContaining({
        kind: 'criterion',
        value: expect.objectContaining({
          status: {
            value: 'reported_done',
            basis: { kind: 'interpreted', interpreter: { kind: 'llm', call: callId } },
            evidence: [human.id],
          },
        }) as unknown,
      }),
    ]),
  )
  expect(store.model.entity(runA, { kind: 'attention_item', id: drafts.permission.id })).toMatchObject({
    value: {
      resolution: 'open',
      closed_at: null,
      likely_resolved: {
        basis: { kind: 'interpreted', interpreter: { kind: 'llm', call: callId } },
        evidence: [solver.id],
      },
    },
  })
  expect(store.model.entity(runA, { kind: 'run', id: runA })).toMatchObject({
    value: { brief: { basis: { kind: 'interpreted', interpreter: { kind: 'llm', call: callId } } } },
  })
  const next = ObserverCallId.parse('empty-evidence')
  begin([solver], next)
  expect(
    store.transaction((transaction) =>
      applyObserverResponse(transaction, { call: next, output: response([createStage([])], 3), at: at(30) }),
    ).status,
  ).toBe('accepted')
  expect(store.model.changes(runA, version(3))[0]?.basis).toEqual({
    kind: 'interpreted',
    interpreter: { kind: 'llm', call: next },
  })
})

test.for([
  ['solver', 'human', 'title'],
  ['solver', 'tool', 'summary'],
  ['human', 'tool', 'expected_result'],
  ['human', 'solver', 'title'],
] as const)(
  'updates stage text grounds from %s to %s when changing %s and retains them after reopening',
  async ([from, to, field], { onTestFinished }) => {
    const { store, home, begin, solver, human, tool } = await setupObserver(onTestFinished)
    const facts = { solver, human, tool }
    const first = facts[from]
    const second = facts[to]
    begin([first])
    expect(
      store.transaction((transaction) =>
        applyObserverResponse(transaction, {
          call: callId,
          output: response([createStage([first.id])], 2),
          at: at(20),
        }),
      ),
    ).toEqual({ status: 'accepted', version: 3 })
    const created = store.model.changes(runA, version(2))[0]?.after
    if (created?.kind !== 'stage') {
      throw new Error('the first response must create a stage')
    }
    const next = ObserverCallId.parse('updated-stage-text')
    begin([second], next)
    expect(
      store.transaction((transaction) =>
        applyObserverResponse(transaction, {
          call: next,
          output: response(
            [
              {
                op: 'stage.update',
                stage: existing(created.value.id),
                title: null,
                expected_result: null,
                summary: null,
                [field]: 'Revised from new evidence',
                evidence: [second.id],
                rationale: 'New evidence changes the text',
              },
            ],
            3,
          ),
          at: at(30),
        }),
      ),
    ).toEqual({ status: 'accepted', version: 4 })
    const basis =
      to === 'solver'
        ? { kind: 'claimed' }
        : { kind: 'interpreted', interpreter: { kind: 'llm', call: next } }
    const expected = {
      kind: 'stage',
      value: {
        ...created.value,
        [field]: 'Revised from new evidence',
        basis,
        evidence: [second.id],
        updated_version: 4,
      },
    }
    const ref = { kind: 'stage', id: created.value.id } as const
    expect(store.model.entity(runA, ref)).toEqual(expected)
    const changes = store.model.changes(runA, version(3))
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({
      op: 'stage.update',
      basis,
      evidence: [second.id],
      before: created,
      after: expected,
    })
    store.close()
    const reopened = home.open()
    expect(reopened.model.entity(runA, ref)).toEqual(expected)
    expect(reopened.model.changes(runA, version(3))).toEqual(changes)
    reopened.transaction((transaction) => {
      transaction.model.replay()
    })
    expect(reopened.model.entity(runA, ref)).toEqual(expected)
  },
)

test.for(['confirmed', 'contract', 'delete', 'observed'])(
  'the closed protocol prevents %s from being assigned by the observer',
  async (scenario, { onTestFinished }) => {
    const { store, solver, begin } = await setupObserver(onTestFinished)
    begin()
    const invalid: Record<string, unknown> = {
      confirmed: {
        op: 'criterion.assess',
        criterion: { kind: 'existing', id: drafts.testsPass.id },
        status: 'confirmed',
        evidence: [solver.id],
        rationale: 'Done',
      },
      contract: {
        op: 'criterion.add',
        temp_id: 'contract',
        stage: null,
        text: 'Tests',
        source: 'contract',
        evidence: [solver.id],
        rationale: 'Contract',
      },
      delete: {
        op: 'stage.delete',
        stage: existing(stages.build),
        evidence: [solver.id],
        rationale: 'Delete',
      },
      observed: { ...createStage([solver.id]), basis: { kind: 'observed' } },
    }
    const result = store.transaction((transaction) =>
      applyObserverResponse(transaction, {
        call: callId,
        output: { base_version: 2, ops: [invalid[scenario]], needs: [] },
        at: at(20),
      }),
    )
    expect(result.status).toBe('rejected')
    expect(store.model.head(runA)).toBe(2)
    expect(store.observerCalls.get(callId)?.reasons.map(({ cause }) => cause)).toContain('schema')
  },
)

test.for(['action', 'agent', 'artifact_version'] as const)(
  'validates current ownership of every %s reference before linking it',
  async (kind, { onTestFinished }) => {
    const { store, home, solver, begin } = await setupObserver(onTestFinished)
    const id = 'a'.repeat(32)
    const database = home.database()
    database
      .prepare(
        'INSERT INTO objects (id, kind, entity_key, run_id, data, change_seq) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(id, kind, '{}', runA, '{}', 1)
    const operation: ObserverOp =
      kind === 'action'
        ? {
            op: 'actions.assign',
            actions: [ActionId.parse(id)],
            stage: existing(stages.build),
            evidence: [solver.id],
            rationale: 'Assign',
          }
        : kind === 'agent'
          ? {
              op: 'agents.participate',
              agents: [AgentId.parse(id)],
              stage: existing(stages.build),
              evidence: [solver.id],
              rationale: 'Participate',
            }
          : {
              op: 'artifact.link',
              version: ArtifactVersionId.parse(id),
              direction: 'output',
              stage: existing(stages.build),
              evidence: [solver.id],
              rationale: 'Output',
            }
    begin()
    expect(
      store.transaction((transaction) =>
        applyObserverResponse(transaction, { call: callId, output: response([operation], 2), at: at(20) }),
      ).status,
    ).toBe('accepted')
    expect(store.model.changes(runA, version(2))).toHaveLength(1)
    for (const state of ['foreign', 'missing']) {
      if (state === 'foreign') {
        database.prepare('UPDATE objects SET run_id = ? WHERE id = ?').run(runB, id)
      } else {
        database.prepare('DELETE FROM objects WHERE id = ?').run(id)
      }
      const call = ObserverCallId.parse(state)
      begin([solver], call)
      expect(
        store.transaction((transaction) =>
          applyObserverResponse(transaction, { call, output: response([operation], 3), at: at(30) }),
        ),
      ).toMatchObject({
        status: 'rejected',
        rejections: [expect.objectContaining({ cause: state === 'foreign' ? 'scope' : 'reference' })],
      })
    }
    database.close()
  },
)

test('accepts referenced questions, attention and final-message cards without fabricating observed grounds', async ({
  onTestFinished,
}) => {
  const { store, facts, begin } = await setupObserver(onTestFinished)
  const final = facts.find(
    (fact) => fact.kind === 'message' && fact.speaker === 'solver' && fact.payload.final,
  )
  if (final?.kind !== 'message') {
    throw new Error('the sample must have a final solver message')
  }
  begin([final])
  const evidence = [final.id]
  const output = ObserverOutput.parse({
    base_version: 2,
    needs: [],
    ops: [
      {
        op: 'question.add',
        temp_id: 'question',
        text: 'Review this?',
        stage: existing(stages.build),
        evidence,
        rationale: 'Question',
      },
      {
        op: 'attention.add',
        temp_id: 'blocker',
        kind: 'blocker',
        text: 'Missing input',
        stage: null,
        evidence,
        rationale: 'Blocker',
      },
      {
        op: 'attention.priority',
        item: temporary('blocker'),
        priority: 'high',
        evidence,
        rationale: 'Priority',
      },
      {
        op: 'attention.resolve',
        item: temporary('question'),
        resolution: 'answered',
        evidence,
        rationale: 'Answered',
      },
      {
        op: 'card.add',
        stages: [existing(stages.build)],
        text: 'K',
        source: { fact: final.id, start: 1, end: 2 },
        evidence,
        rationale: 'Result',
      },
    ],
  })
  expect(
    store.transaction((transaction) =>
      applyObserverResponse(transaction, { call: callId, output, at: at(20) }),
    ).status,
  ).toBe('accepted')
  expect(store.model.entities(runA)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: 'attention_item',
        value: expect.objectContaining({
          text: 'Review this?',
          resolution: 'answered',
          closed_at: at(20),
        }) as unknown,
      }),
      expect.objectContaining({
        kind: 'attention_item',
        value: expect.objectContaining({
          text: 'Missing input',
          priority: { value: 'high', call: callId },
          resolution: 'open',
        }) as unknown,
      }),
      expect.objectContaining({
        kind: 'card',
        value: expect.objectContaining({
          text: 'K',
          source: { fact: final.id, start: 1, end: 2 },
          basis: { kind: 'claimed' },
        }) as unknown,
      }),
    ]),
  )
})

test.for(['All security tests passed and production deploy succeeded', 'O'])(
  'rejects a card whose text %s differs from its valid source range without accepting other operations',
  async (text, { onTestFinished }) => {
    const { store, facts, human, begin } = await setupObserver(onTestFinished)
    const final = facts.find(
      (fact) => fact.kind === 'message' && fact.speaker === 'solver' && fact.payload.final,
    )
    if (final?.kind !== 'message') {
      throw new Error('the sample must have a final solver message')
    }
    expect(final.payload.text).toBe('OK')
    const before = store.model.entities(runA)
    begin([final, human])
    expect(
      store.transaction((transaction) =>
        applyObserverResponse(transaction, {
          call: callId,
          output: response(
            [
              createStage([final.id]),
              {
                op: 'card.add',
                stages: [temporary('new-stage')],
                text,
                source: { fact: final.id, start: 1, end: 2 },
                evidence: [final.id],
                rationale: 'Result',
              },
            ],
            2,
          ),
          at: at(20),
        }),
      ),
    ).toMatchObject({
      status: 'rejected',
      rejections: [expect.objectContaining({ op_index: 1, cause: 'invariant' })],
    })
    expect(store.model.head(runA)).toBe(2)
    expect(store.model.entities(runA)).toEqual(before)
    expect(store.model.changes(runA, version(2))).toEqual([])
    expect(store.interpretations.ofCall(callId).map(({ status }) => status)).toEqual([
      'pending',
      'pending',
    ])
    expect(store.observerCalls.get(callId)?.verdict).toBe('rejected')
  },
)

test.for([
  'nest-new',
  'replace-self',
  'split-cycle',
  'merge-cycle',
  'empty-replacement',
  'duplicate-split',
  'single-merge',
])('rejects invalid structural change %s', async (scenario, { onTestFinished }) => {
  const { store, solver, begin } = await setupObserver(onTestFinished)
  begin()
  const grounds = { evidence: [solver.id], rationale: 'Restructure' }
  const variants: Record<string, unknown[]> = {
    'nest-new': [
      { ...createStage([solver.id], 'a'), parent: temporary('b') },
      { ...createStage([solver.id], 'b'), parent: temporary('a') },
    ],
    'replace-self': [
      { ...grounds, op: 'stage.replace', stage: existing(stages.build), by: [existing(stages.build)] },
    ],
    'split-cycle': [
      {
        ...grounds,
        op: 'stage.split',
        stage: existing(stages.build),
        into: [existing(stages.build), existing(stages.test)],
      },
    ],
    'merge-cycle': [
      {
        ...grounds,
        op: 'stage.merge',
        stages: [existing(stages.build), existing(stages.test)],
        into: existing(stages.build),
      },
    ],
    'empty-replacement': [{ ...grounds, op: 'stage.replace', stage: existing(stages.build), by: [] }],
    'duplicate-split': [
      {
        ...grounds,
        op: 'stage.split',
        stage: existing(stages.build),
        into: [existing(stages.test), existing(stages.test)],
      },
    ],
    'single-merge': [
      { ...grounds, op: 'stage.merge', stages: [existing(stages.build)], into: existing(stages.test) },
    ],
  }
  const result = store.transaction((transaction) =>
    applyObserverResponse(transaction, {
      call: callId,
      output: { base_version: 2, needs: [], ops: variants[scenario] },
      at: at(20),
    }),
  )
  expect(result.status).toBe('rejected')
  expect(store.model.head(runA)).toBe(2)
  expect(store.observerCalls.get(callId)?.reasons.map(({ cause }) => cause)).toContain('invariant')
})

test('limits texts rather than ids and rejects an oversized operation batch', async ({ onTestFinished }) => {
  const { store, solver, begin } = await setupObserver(onTestFinished)
  begin()
  const short = ObserverOutput.parse({
    base_version: 2,
    needs: [],
    ops: [
      {
        ...createStage([solver.id], 'long-temporary-identifier'),
        title: 'Short',
        rationale: 'Why',
      },
    ],
  })
  expect(
    store.transaction((transaction) =>
      applyObserverResponse(transaction, {
        call: callId,
        output: short,
        at: at(20),
        limits: { operations: 1, textLength: 5 },
      }),
    ).status,
  ).toBe('accepted')
  const next = ObserverCallId.parse('too-many')
  begin([solver], next)
  const result = store.transaction((transaction) =>
    applyObserverResponse(transaction, {
      call: next,
      output: response([createStage([solver.id], 'a'), createStage([solver.id], 'b')], 3),
      at: at(30),
      limits: { operations: 1, textLength: 100 },
    }),
  )
  expect(result).toMatchObject({
    status: 'rejected',
    rejections: [expect.objectContaining({ op_index: null, cause: 'limit' })],
  })
})

test.for([
  'missing-fact',
  'foreign-fact',
  'empty-title',
  'empty-resolve',
  'observer-likely',
  'bad-card',
  'self-dependency',
])('rejects the whole response for %s', async (scenario, { onTestFinished }) => {
  const { store, solver, human, foreignFacts, begin } = await setupObserver(onTestFinished)
  begin()
  const grounds = { evidence: [solver.id], rationale: 'Change' }
  const variants: Record<string, unknown> = {
    'missing-fact': { ...createStage([]), evidence: ['0'.repeat(32)] },
    'foreign-fact': { ...createStage([]), evidence: [foreignFacts[0]?.id] },
    'empty-title': { ...createStage([solver.id]), title: '  ' },
    'empty-resolve': {
      ...grounds,
      op: 'attention.resolve',
      item: { kind: 'existing', id: drafts.review.id },
      resolution: 'resolved',
      evidence: [],
    },
    'observer-likely': { ...grounds, op: 'attention.likely_resolved', item: drafts.review.id },
    'bad-card': {
      ...grounds,
      op: 'card.add',
      stages: [],
      text: 'Card',
      source: { fact: human.id, start: 0, end: 10 },
    },
    'self-dependency': {
      ...grounds,
      op: 'stage.depends',
      stage: existing(stages.build),
      depends_on: existing(stages.build),
      via: null,
    },
  }
  expect(
    store.transaction((transaction) =>
      applyObserverResponse(transaction, {
        call: callId,
        output: { base_version: 2, needs: [], ops: [variants[scenario]] },
        at: at(20),
      }),
    ).status,
  ).toBe('rejected')
  expect(store.interpretations.ofRun(runA).every(({ status }) => status === 'pending')).toBe(true)
  expect(store.model.head(runA)).toBe(2)
})

test.for(['replace', 'split', 'merge', 'nest', 'depends'])(
  'preserves all stages and records an acyclic %s change',
  async (scenario, { onTestFinished }) => {
    const { store, solver, begin } = await setupObserver(onTestFinished)
    begin()
    const grounds = { evidence: [solver.id], rationale: 'Change structure' }
    const variants: Record<string, unknown> = {
      replace: { ...grounds, op: 'stage.replace', stage: existing(stages.build), by: [temporary('next')] },
      split: {
        ...grounds,
        op: 'stage.split',
        stage: existing(stages.build),
        into: [temporary('next'), temporary('other')],
      },
      merge: {
        ...grounds,
        op: 'stage.merge',
        stages: [existing(stages.build), existing(stages.test)],
        into: temporary('next'),
      },
      nest: { ...grounds, op: 'stage.nest', stage: existing(stages.build), parent: temporary('next') },
      depends: {
        ...grounds,
        op: 'stage.depends',
        stage: existing(stages.build),
        depends_on: temporary('next'),
        via: null,
      },
    }
    const output = {
      base_version: 2,
      needs: [],
      ops: [createStage([solver.id], 'next'), createStage([solver.id], 'other'), variants[scenario]],
    }
    expect(
      store.transaction((transaction) =>
        applyObserverResponse(transaction, { call: callId, output, at: at(20) }),
      ).status,
    ).toBe('accepted')
    expect(store.model.entities(runA).filter(({ kind }) => kind === 'stage')).toHaveLength(4)
    const changes = store.model.changes(runA, version(2))
    expect(changes.filter(({ op }) => op === `stage.${scenario}`)).toHaveLength(scenario === 'merge' ? 2 : 1)
    const before = store.model.entities(runA)
    store.transaction((transaction) => {
      transaction.model.replay()
    })
    expect(store.model.entities(runA)).toEqual(before)
  },
)

test('checks successor cycles against earlier history as well as the current projection', async ({
  onTestFinished,
}) => {
  const { store, solver, begin } = await setupObserver(onTestFinished)
  const grounds = { evidence: [solver.id], rationale: 'Replace' }
  begin()
  expect(
    store.transaction((transaction) =>
      applyObserverResponse(transaction, {
        call: callId,
        output: response(
          [{ ...grounds, op: 'stage.replace', stage: existing(stages.build), by: [existing(stages.test)] }],
          2,
        ),
        at: at(20),
      }),
    ).status,
  ).toBe('accepted')
  const second = ObserverCallId.parse('replacement-two')
  begin([solver], second)
  expect(
    store.transaction((transaction) =>
      applyObserverResponse(transaction, {
        call: second,
        output: response(
          [
            createStage([solver.id], 'next'),
            { ...grounds, op: 'stage.replace', stage: existing(stages.build), by: [temporary('next')] },
          ],
          3,
        ),
        at: at(30),
      }),
    ).status,
  ).toBe('accepted')
  const third = ObserverCallId.parse('replacement-cycle')
  begin([solver], third)
  expect(
    store.transaction((transaction) =>
      applyObserverResponse(transaction, {
        call: third,
        output: response(
          [{ ...grounds, op: 'stage.replace', stage: existing(stages.test), by: [existing(stages.build)] }],
          4,
        ),
        at: at(40),
      }),
    ),
  ).toMatchObject({ status: 'rejected', rejections: [expect.objectContaining({ cause: 'invariant' })] })
  expect(store.model.head(runA)).toBe(4)
})
