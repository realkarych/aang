import { ObserverCallId, type ObserverOp, type Stage } from '@aang/contract'
import { applyObserverResponse } from '@aang/engine'
import { expect, test } from 'vitest'
import { at, runA, stages } from './model.js'
import { createStage, existing, response, setupObserver, temporary, version } from './observer-fixtures.js'

test('keeps renamed, split, merged and replaced stages with navigable successors after replay and reopen', async ({
  onTestFinished,
}) => {
  const { store, home, solver, begin } = await setupObserver(onTestFinished)
  const grounds = { evidence: [solver.id], rationale: 'Replan the implementation' }
  const apply = (id: string, operations: ObserverOp[]) => {
    const call = ObserverCallId.parse(id)
    const input = begin([solver], call)
    expect(
      store.transaction((transaction) =>
        applyObserverResponse(transaction, {
          call,
          output: response(operations, input.model.version),
          at: at(20),
        }),
      ).status,
    ).toBe('accepted')
  }
  apply('split-work', [
    {
      ...grounds,
      op: 'stage.split',
      stage: existing(stages.build),
      into: [temporary('parser'), temporary('tests')],
    },
    { ...createStage([solver.id], 'parser'), title: 'Parser', parent: temporary('container') },
    { ...createStage([solver.id], 'tests'), title: 'Tests', parent: temporary('container') },
    { ...createStage([solver.id], 'container'), title: 'Delivery' },
    {
      ...grounds,
      op: 'stage.update',
      stage: existing(stages.build),
      title: 'Original plan',
      expected_result: 'A tested parser',
      summary: 'Split implementation and testing',
    },
    {
      ...grounds,
      op: 'stage.depends',
      stage: temporary('tests'),
      depends_on: temporary('parser'),
      via: null,
    },
  ])
  const byTitle = (title: string): Stage => {
    const entity = store.model.entities(runA).find((entry) => entry.kind === 'stage' && entry.value.title === title)
    if (entity?.kind !== 'stage') {
      throw new Error(`missing stage ${title}`)
    }
    return entity.value
  }
  const parser = byTitle('Parser')
  const tests = byTitle('Tests')
  const container = byTitle('Delivery')
  expect(parser.parent).toBe(container.id)
  expect(tests.parent).toBe(container.id)
  expect(byTitle('Original plan')).toMatchObject({
    id: stages.build,
    expected_result: 'A tested parser',
    summary: 'Split implementation and testing',
    lifecycle: { state: 'split', into: [parser.id, tests.id] },
    created_version: 2,
    updated_version: 3,
  })
  apply('merge-work', [
    { ...createStage([solver.id], 'merged'), title: 'Integrated parser' },
    { ...grounds, op: 'stage.merge', stages: [existing(parser.id), existing(tests.id)], into: temporary('merged') },
    { ...grounds, op: 'stage.nest', stage: temporary('merged'), parent: existing(container.id) },
  ])
  const merged = byTitle('Integrated parser')
  apply('replace-work', [
    { ...createStage([solver.id], 'replacement'), title: 'Release parser' },
    { ...grounds, op: 'stage.replace', stage: existing(merged.id), by: [temporary('replacement')] },
    { ...grounds, op: 'stage.nest', stage: existing(parser.id), parent: null },
  ])
  const replacement = byTitle('Release parser')
  expect(byTitle('Parser')).toMatchObject({ lifecycle: { state: 'merged', into: merged.id }, parent: null })
  expect(byTitle('Tests').lifecycle).toEqual({ state: 'merged', into: merged.id })
  expect(byTitle('Integrated parser').lifecycle).toEqual({ state: 'replaced', by: [replacement.id] })
  expect(byTitle('Release parser').lifecycle).toEqual({ state: 'active' })
  const history = store.model.entityChanges(runA, { kind: 'stage', id: stages.build }, version(2))
  expect(history.map(({ op }) => op)).toEqual(['stage.split', 'stage.update'])
  expect(history[0]?.before).toMatchObject({ value: { lifecycle: { state: 'active' } } })
  expect(history[0]?.after).toMatchObject({ value: { lifecycle: { state: 'split', into: [parser.id, tests.id] } } })
  expect(store.model.entities(runA)).toContainEqual({
    kind: 'link',
    value: expect.objectContaining({ kind: 'dependency', stage: tests.id, depends_on: parser.id, via: null }) as unknown,
  })
  const snapshot = store.model.entities(runA)
  const journal = store.model.changes(runA, version(0))
  store.transaction((transaction) => { transaction.model.replay() })
  expect(store.model.entities(runA)).toEqual(snapshot)
  store.close()
  const reopened = home.open()
  expect(reopened.model.entities(runA)).toEqual(snapshot)
  expect(reopened.model.changes(runA, version(0))).toEqual(journal)
})
