import {
  type Fact,
  ObserverCallId,
  type ObserverOp,
  type RunId,
  TempId,
} from '@aang/contract'
import { applyChangeSet, applyObserverResponse } from '@aang/engine'
import type { Store } from '@aang/store'
import { expect, test } from 'vitest'
import { hookBatch, jsonlFile } from './batches.js'
import { codexCall, codexRun, setupCodexObserver } from './codex-observer.js'
import { factsOf, startEngine } from './harness.js'
import { at, byObserver, drafts, observed, put, runA, stages } from './model.js'
import { callId, existing, response, setupObserver, temporary, version } from './observer-fixtures.js'
import { claudeHook, claudeTranscript } from './samples.js'

const originalText = (fact: Fact): string | null =>
  fact.kind === 'message'
    ? fact.payload.text
    : fact.kind === 'turn_end' || fact.kind === 'agent_end'
      ? fact.payload.final_message
      : null

const ingestHook = async (store: Store, cwd: string, name: string, changes: Record<string, string | null>) => {
  const known = new Set(factsOf(store).map(({ id }) => id))
  await startEngine(store, { all: true }).ingest(
    hookBatch({ file: `${name}.evt`, payload: claudeHook(name, { session: 'session-a', cwd }, changes) }),
  )
  return factsOf(store).filter(({ id }) => !known.has(id))
}

const ingestIntermediateMessage = async (store: Store, cwd: string): Promise<Fact | undefined> => {
  const known = new Set(factsOf(store).map(({ id }) => id))
  const final = claudeTranscript({ session: 'session-a', cwd })
    .map((line) => JSON.parse(line) as { type: string; message?: { stop_reason?: string } })
    .find((record) => record.type === 'assistant' && record.message?.stop_reason === 'end_turn')
  if (final?.message === undefined) {
    throw new Error('the transcript must contain a final assistant message')
  }
  const line = JSON.stringify({
    ...final,
    uuid: 'intermediate-text',
    message: {
      ...final.message,
      id: 'intermediate-message',
      stop_reason: 'tool_use',
      content: [{ type: 'text', text: 'Running the parser tests now.' }],
    },
  })
  const file = jsonlFile({ runtime: 'claude', path: `${cwd}/intermediate.jsonl`, lines: [line], ino: 11n })
  await startEngine(store, { all: true }).ingest(file.batch(1, 1))
  return factsOf(store).find(({ id, kind }) => kind === 'message' && !known.has(id))
}

const cardOp = (source: Fact, text: string, fragment: string): ObserverOp => {
  const start = text.indexOf(fragment)
  return {
    op: 'card.add',
    stages: [existing(stages.build)],
    text: fragment,
    source: { fact: source.id, start, end: start + fragment.length },
    evidence: [source.id],
    rationale: 'A result stated in the final text',
  }
}

const expectCardLeadsToOriginal = (store: Store, run: RunId, fragment: string): void => {
  const card = store.model.entities(run).find((entity) => entity.kind === 'card')
  if (card?.kind !== 'card') {
    throw new Error('the card must be stored')
  }
  expect(card.value).toMatchObject({ run, stages: [stages.build], text: fragment })
  const fact = store.facts.get(card.value.source.fact)
  if (fact === null) {
    throw new Error('the card must cite a stored fact')
  }
  expect(originalText(fact)?.slice(card.value.source.start, card.value.source.end)).toBe(fragment)
  expect(store.rawRecords.get(fact.seq)?.payload).toContain(fragment)
}

test.for(['transcript', 'stop', 'subagent'] as const)(
  'a card from the %s final text leads to its fragment of the original after reopening',
  async (source, { onTestFinished }) => {
    const { store, home, facts, begin } = await setupObserver(onTestFinished)
    const text = 'All 14 parser tests passed. The deploy still needs approval.'
    const fragment = 'All 14 parser tests passed.'
    const final =
      source === 'transcript'
        ? facts.find((fact) => fact.kind === 'message' && fact.speaker === 'solver' && fact.payload.final)
        : (
            await ingestHook(store, home.path, source === 'stop' ? 'Stop.json' : 'SubagentStop.json', {
              last_assistant_message: text,
            })
          ).find((fact) => fact.kind === (source === 'stop' ? 'turn_end' : 'agent_end'))
    if (final === undefined) {
      throw new Error(`the ${source} sample must carry final text`)
    }
    const original = originalText(final) ?? ''
    const expected = source === 'transcript' ? original : fragment
    const input = begin([final])
    expect(
      store.transaction((transaction) =>
        applyObserverResponse(transaction, {
          call: callId,
          output: response([cardOp(final, original, expected)], input.model.version),
          at: at(20),
        }),
      ).status,
    ).toBe('accepted')
    expectCardLeadsToOriginal(store, runA, expected)
    const cards = store.model.entities(runA).filter(({ kind }) => kind === 'card')
    store.close()
    const reopened = home.open()
    expect(reopened.model.entities(runA).filter(({ kind }) => kind === 'card')).toEqual(cards)
    expectCardLeadsToOriginal(reopened, runA, expected)
  },
)

test('a card from the final Codex answer leads to its fragment of the rollout line', async ({ onTestFinished }) => {
  const { store, facts, begin } = await setupCodexObserver(onTestFinished)
  const final = facts.find((fact) => fact.kind === 'message' && fact.speaker === 'solver' && fact.payload.final)
  if (final?.kind !== 'message') {
    throw new Error('the rollout must contain a final answer')
  }
  const fragment = final.payload.text.slice(0, Math.min(2, final.payload.text.length))
  const input = begin([final])
  expect(
    store.transaction((transaction) =>
      applyObserverResponse(transaction, {
        call: codexCall,
        output: response([cardOp(final, final.payload.text, fragment)], input.model.version),
        at: at(20),
      }),
    ).status,
  ).toBe('accepted')
  expectCardLeadsToOriginal(store, codexRun, fragment)
})

test.for(['intermediate', 'empty-stop'] as const)(
  'rejects a card citing %s text that is not the final text of an agent',
  async (scenario, { onTestFinished }) => {
    const { store, home, begin } = await setupObserver(onTestFinished)
    const source =
      scenario === 'intermediate'
        ? await ingestIntermediateMessage(store, home.path)
        : (await ingestHook(store, home.path, 'Stop.json', { last_assistant_message: null })).find(
            (fact) => fact.kind === 'turn_end',
          )
    if (source === undefined) {
      throw new Error(`the ${scenario} source must exist`)
    }
    const text = originalText(source) ?? 'missing'
    const input = begin([source])
    const before = store.model.entities(runA)
    expect(
      store.transaction((transaction) =>
        applyObserverResponse(transaction, {
          call: callId,
          output: response([cardOp(source, text, text.slice(0, 1) || 'm')], input.model.version),
          at: at(20),
        }),
      ),
    ).toMatchObject({ status: 'rejected', rejections: [expect.objectContaining({ op_index: 0, cause: 'invariant' })] })
    expect(store.model.entities(runA)).toEqual(before)
  },
)

test('criterion assessments stay interpretations across calls and never become a confirmation', async ({
  onTestFinished,
}) => {
  const { store, home, facts, human, tool, solver, begin } = await setupObserver(onTestFinished)
  const final = facts.find((fact) => fact.kind === 'message' && fact.speaker === 'solver' && fact.payload.final)
  if (final === undefined) {
    throw new Error('the transcript must contain a final solver message')
  }
  const first = begin([human, final])
  expect(
    store.transaction((transaction) =>
      applyObserverResponse(transaction, {
        call: callId,
        at: at(20),
        output: response(
          [
            {
              op: 'stage.create',
              temp_id: TempId.parse('parser'),
              title: 'Build the parser',
              expected_result: 'A parser with passing tests',
              summary: null,
              parent: null,
              origin: 'inferred',
              evidence: [human.id],
              rationale: 'The task asks for a parser',
            },
            {
              op: 'criterion.add',
              temp_id: TempId.parse('tests'),
              stage: temporary('parser'),
              text: 'All parser tests pass',
              source: 'task',
              evidence: [human.id],
              rationale: 'Stated in the task',
            },
            {
              op: 'criterion.assess',
              criterion: { kind: 'new', temp_id: TempId.parse('tests') },
              status: 'reported_done',
              evidence: [final.id],
              rationale: 'The solver reports completion',
            },
          ],
          first.model.version,
        ),
      }),
    ).status,
  ).toBe('accepted')
  const criterion = () => {
    const entity = store.model.entities(runA).find((candidate) => candidate.kind === 'criterion' && candidate.value.text === 'All parser tests pass')
    if (entity?.kind !== 'criterion') {
      throw new Error('the criterion must be stored')
    }
    return entity.value
  }
  const parser = store.model
    .entities(runA)
    .flatMap((entity) => (entity.kind === 'stage' && entity.value.title === 'Build the parser' ? [entity.value.id] : []))
  expect(criterion()).toMatchObject({
    stage: parser[0],
    source: 'task',
    contract: null,
    checked_commit: null,
    status: { value: 'reported_done', basis: { kind: 'claimed' }, evidence: [final.id] },
  })
  const reference = { kind: 'existing', id: criterion().id } as const
  const confirm = ObserverCallId.parse('assess-confirmed')
  const second = begin([tool, solver], confirm)
  const head = store.model.head(runA)
  expect(
    store.transaction((transaction) =>
      applyObserverResponse(transaction, {
        call: confirm,
        at: at(30),
        output: {
          base_version: second.model.version,
          needs: [],
          ops: [
            { op: 'criterion.assess', criterion: reference, status: 'partial', evidence: [tool.id], rationale: 'Some tests ran' },
            { op: 'criterion.assess', criterion: reference, status: 'confirmed', evidence: [tool.id], rationale: 'Tests passed' },
          ],
        },
      }),
    ),
  ).toMatchObject({ status: 'rejected', rejections: [expect.objectContaining({ op_index: 1, cause: 'schema' })] })
  expect(store.model.head(runA)).toBe(head)
  expect(criterion().status.value).toBe('reported_done')
  const partial = ObserverCallId.parse('assess-partial')
  const third = begin([tool, solver], partial)
  expect(
    store.transaction((transaction) =>
      applyObserverResponse(transaction, {
        call: partial,
        at: at(40),
        output: response(
          [{ op: 'criterion.assess', criterion: reference, status: 'partial', evidence: [solver.id, tool.id], rationale: 'Only unit tests ran' }],
          third.model.version,
        ),
      }),
    ).status,
  ).toBe('accepted')
  expect(criterion().status).toEqual({ value: 'partial', basis: byObserver(partial), evidence: [solver.id, tool.id] })
  const statuses = store.model
    .changes(runA, version(0))
    .flatMap(({ after }) => (after?.kind === 'criterion' ? [after.value.status.value] : []))
  expect(statuses).toEqual(['not_checked', 'not_checked', 'reported_done', 'partial'])
  const entities = store.model.entities(runA)
  store.close()
  const reopened = home.open()
  reopened.transaction((transaction) => {
    transaction.model.replay()
  })
  expect(reopened.model.entities(runA)).toEqual(entities)
})

test('the run brief retells the observed goal as an interpretation and rejects an empty retelling', async ({
  onTestFinished,
}) => {
  const { store, human, solver, begin } = await setupObserver(onTestFinished)
  const run = () => store.model.entity(runA, { kind: 'run', id: runA })
  const input = begin([human, solver])
  const brief = (text: string): ObserverOp => ({
    op: 'brief.update',
    text,
    evidence: [human.id],
    rationale: 'Retell the first prompt',
  })
  expect(
    store.transaction((transaction) =>
      applyObserverResponse(transaction, {
        call: callId,
        at: at(20),
        output: response([brief('Ship a parser'), brief('   ')], input.model.version),
      }),
    ),
  ).toMatchObject({ status: 'rejected', rejections: [expect.objectContaining({ op_index: 1, cause: 'invariant' })] })
  expect(run()).toMatchObject({ value: { brief: null } })
  const retry = ObserverCallId.parse('brief-retry')
  const next = begin([human, solver], retry)
  expect(
    store.transaction((transaction) =>
      applyObserverResponse(transaction, {
        call: retry,
        at: at(30),
        output: response([brief('Ship a parser with passing tests')], next.model.version),
      }),
    ).status,
  ).toBe('accepted')
  expect(run()).toMatchObject({
    value: {
      goal: drafts.runA.goal,
      brief: { text: 'Ship a parser with passing tests', basis: byObserver(retry), evidence: [human.id] },
    },
  })
})

test.for(['rule-goal', 'user-brief'] as const)(
  'a %s change after the base version decides whether the observer brief conflicts',
  async (scenario, { onTestFinished }) => {
    const { store, human, begin } = await setupObserver(onTestFinished)
    const input = begin([human])
    const run = drafts.runA
    store.transaction((transaction) =>
      applyChangeSet(transaction, {
        run: runA,
        author: scenario === 'user-brief' ? 'user' : 'rule',
        at: at(15),
        changes: [
          scenario === 'user-brief'
            ? put('brief.update', { kind: 'run', value: { ...run, brief: { text: 'Edited by the user', basis: observed, evidence: [] } } }, observed, [])
            : put('run.goal', { kind: 'run', value: { ...run, goal: { text: 'Ship the parser today', fact: human.id } } }, observed, [human.id]),
        ],
      }),
    )
    const result = store.transaction((transaction) =>
      applyObserverResponse(transaction, {
        call: callId,
        at: at(20),
        output: response(
          [{ op: 'brief.update', text: 'Ship a parser', evidence: [human.id], rationale: 'Retell the goal' }],
          input.model.version,
        ),
      }),
    )
    const stored = store.model.entity(runA, { kind: 'run', id: runA })
    if (scenario === 'user-brief') {
      expect(result).toMatchObject({ status: 'rejected', rejections: [expect.objectContaining({ cause: 'conflict' })] })
      expect(stored).toMatchObject({ value: { brief: { text: 'Edited by the user' } } })
    } else {
      expect(result.status).toBe('accepted')
      expect(stored).toMatchObject({
        value: { goal: { text: 'Ship the parser today' }, brief: { text: 'Ship a parser', basis: byObserver(callId) } },
      })
    }
  },
)
