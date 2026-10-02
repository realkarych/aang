import { AttentionItemId, type ModelEntityRef, ModelVersion } from '@aang/contract'
import { applyChangeSet, type ChangeSet, InvalidChangeSetError } from '@aang/engine'
import type { ModelReader, Store, Transaction } from '@aang/store'
import { expect, test, type TestContext } from 'vitest'
import { createHome, type Home } from './home.js'
import {
  at,
  byObserver,
  byRule,
  claimed,
  drafts,
  fact,
  firstCall,
  history,
  observed,
  observerCalls,
  put,
  remove,
  runA,
  runB,
  secondCall,
  sessionA,
  sessionB,
  sessionC,
  stages,
} from './model.js'

const version = (value: number): ModelVersion => ModelVersion.parse(value)

const start = version(0)

const runRef: ModelEntityRef = { kind: 'run', id: runA }
const permissionRef: ModelEntityRef = { kind: 'attention_item', id: drafts.permission.id }
const buildRef: ModelEntityRef = { kind: 'stage', id: stages.build }
const testRef: ModelEntityRef = { kind: 'stage', id: stages.test }
const verifyRef: ModelEntityRef = { kind: 'stage', id: stages.verify }
const sessionCRef: ModelEntityRef = { kind: 'session_membership', id: sessionC }

const applyStep = (transaction: Transaction, step: readonly ChangeSet[]): void => {
  for (const changeSet of step) {
    applyChangeSet(transaction, changeSet)
  }
}

const applyHistory = (store: Store, steps: readonly (readonly ChangeSet[])[]): void => {
  for (const step of steps) {
    store.transaction((transaction) => {
      applyStep(transaction, step)
    })
  }
}

const historyUntil = (steps: number): ChangeSet[][] => history().slice(0, steps)

const firstChangeSet = (): ChangeSet => {
  const [changeSet] = history()[0] ?? []
  if (changeSet === undefined) {
    throw new Error('the history starts with a change set')
  }
  return changeSet
}

const openHome = async (
  onTestFinished: TestContext['onTestFinished'],
): Promise<{ readonly home: Home; readonly store: Store }> => {
  const home = await createHome(onTestFinished)
  const store = home.open()
  home.recordObserverCalls(observerCalls)
  return { home, store }
}

const describeModel = (model: ModelReader): unknown =>
  [runA, runB].map((run) => {
    const head = model.head(run)
    return {
      run,
      head,
      versions: Array.from({ length: head }, (_, index) => model.version(run, version(index + 1))),
      entities: model.entities(run),
      changes: model.changes(run, start),
    }
  })

test('a change set becomes the next version of its run with a journal entry and a projection per change', async ({
  onTestFinished,
}) => {
  const { store } = await openHome(onTestFinished)

  const applied = store.transaction((transaction) => applyChangeSet(transaction, firstChangeSet()))

  const createdRun = { kind: 'run', value: { ...drafts.runA, version: 1 } }
  const openedPermission = { kind: 'attention_item', value: { ...drafts.permission, change_seq: 1 } }
  expect(applied.version).toEqual({
    run: runA,
    version: 1,
    base_version: 0,
    author: 'rule',
    observer_call: null,
    created_at: at(1),
    change_seq: 1,
  })
  expect(applied.changes[0]).toEqual({
    run: runA,
    version: 1,
    index: 0,
    op: 'run.create',
    target: runRef,
    before: null,
    after: createdRun,
    author: 'rule',
    basis: observed,
    evidence: [fact(1)],
    observer_call: null,
    change_seq: 1,
  })
  expect(
    applied.changes.map(({ index, op, target, before, after }) => [index, op, target.kind, before, after]),
  ).toEqual([
    [0, 'run.create', 'run', null, createdRun],
    [
      1,
      'run.create',
      'session_membership',
      null,
      { kind: 'session_membership', value: { session: sessionA, run: runA } },
    ],
    [
      2,
      'session.move',
      'session_membership',
      null,
      { kind: 'session_membership', value: { session: sessionC, run: runA } },
    ],
    [3, 'attention.open', 'attention_item', null, openedPermission],
  ])
  expect(store.model.head(runA)).toBe(1)
  expect(store.model.head(runB)).toBe(0)
  expect(store.model.version(runA, version(1))).toEqual(applied.version)
  expect(store.model.version(runA, version(2))).toBeNull()
  expect(store.model.changes(runA, start)).toEqual(applied.changes)
  expect(store.model.changes(runA, version(1))).toEqual([])
  expect(store.model.entity(runA, runRef)).toEqual(createdRun)
  expect(store.model.entity(runA, permissionRef)).toEqual(openedPermission)
  expect(store.model.entities(runA)).toHaveLength(4)
  expect(store.model.entities(runB)).toEqual([])
})

test('each change keeps the entity state before and after it, and the observer version keeps its call and base', async ({
  onTestFinished,
}) => {
  const { store } = await openHome(onTestFinished)

  applyHistory(store, historyUntil(3))

  const created = { kind: 'stage', value: { ...drafts.build, created_version: 2, updated_version: 2 } }
  const running = { kind: 'stage', value: { ...drafts.running, created_version: 2, updated_version: 3 } }
  expect(store.model.version(runA, version(2))).toEqual({
    run: runA,
    version: 2,
    base_version: 1,
    author: 'observer',
    observer_call: firstCall,
    created_at: at(10),
    change_seq: 2,
  })
  expect(store.model.version(runA, version(3))).toMatchObject({ base_version: 2, author: 'rule', observer_call: null })
  expect(store.model.entityChanges(runA, buildRef, start)).toEqual([
    expect.objectContaining({
      version: 2,
      op: 'stage.create',
      before: null,
      after: created,
      author: 'observer',
      basis: byObserver(firstCall),
      observer_call: firstCall,
    }),
    expect.objectContaining({
      version: 3,
      op: 'stage.execution',
      before: created,
      after: running,
      author: 'rule',
      basis: byRule('stage-execution'),
      evidence: [fact(6)],
      observer_call: null,
    }),
  ])
  expect(store.model.entity(runA, buildRef)).toEqual(running)
  expect(store.model.entity(runA, permissionRef)).toEqual({
    kind: 'attention_item',
    value: { ...drafts.answered, change_seq: 3 },
  })
  expect(store.model.entities(runA).map(({ kind }) => kind)).toEqual([
    'attention_item',
    'criterion',
    'link',
    'run',
    'session_membership',
    'session_membership',
    'stage',
    'stage',
  ])
})

test('an entity changed twice in one change set is journaled step by step', async ({ onTestFinished }) => {
  const { store } = await openHome(onTestFinished)

  applyHistory(store, history())

  const created = { kind: 'stage', value: { ...drafts.verify, created_version: 5, updated_version: 5 } }
  const summarized = { kind: 'stage', value: { ...drafts.summarized, created_version: 5, updated_version: 5 } }
  expect(
    store.model.entityChanges(runA, verifyRef, version(4)).map(({ version, index, op, before, after }) => ({
      version,
      index,
      op,
      before,
      after,
    })),
  ).toEqual([
    { version: 5, index: 1, op: 'stage.create', before: null, after: created },
    { version: 5, index: 2, op: 'stage.update', before: created, after: summarized },
  ])
  expect(store.model.entity(runA, verifyRef)).toEqual(summarized)
  expect(store.model.changes(runA, version(4)).map(({ op, basis }) => [op, basis])).toEqual([
    ['stage.replace', byObserver(secondCall)],
    ['stage.create', byObserver(secondCall)],
    ['stage.update', byObserver(secondCall)],
    ['card.add', claimed],
    ['attention.add', byObserver(secondCall)],
  ])
})

test('a session moved between runs leaves the source projection and is journaled in both runs', async ({
  onTestFinished,
}) => {
  const { store } = await openHome(onTestFinished)

  applyHistory(store, historyUntil(5))

  expect(store.model.entity(runA, sessionCRef)).toBeNull()
  expect(store.model.entity(runB, sessionCRef)).toEqual({
    kind: 'session_membership',
    value: { session: sessionC, run: runB },
  })
  expect(store.model.entity(runA, buildRef)).toEqual({
    kind: 'stage',
    value: { ...drafts.moved, created_version: 2, updated_version: 4 },
  })
  expect(store.model.version(runA, version(4))).toMatchObject({ base_version: 3, author: 'user', change_seq: 6 })
  expect(store.model.version(runB, version(2))).toMatchObject({ base_version: 1, author: 'user', change_seq: 5 })
  expect(store.model.entityChanges(runA, sessionCRef, start)).toEqual([
    expect.objectContaining({ version: 1, op: 'session.move', before: null }),
    expect.objectContaining({
      version: 4,
      op: 'session.move',
      before: { kind: 'session_membership', value: { session: sessionC, run: runA } },
      after: null,
      author: 'user',
    }),
  ])
  expect(store.model.entities(runB)).toEqual(
    expect.arrayContaining([
      { kind: 'binding', value: drafts.attachC },
      { kind: 'session_membership', value: { session: sessionB, run: runB } },
    ]),
  )
})

test('the history of an entity after an observer base version shows only what changed it since', async ({
  onTestFinished,
}) => {
  const { store } = await openHome(onTestFinished)

  applyHistory(store, history())

  const base = store.model.version(runA, version(5))?.base_version
  expect(base).toBe(3)
  expect(store.model.entityChanges(runA, buildRef, version(3))).toEqual([
    expect.objectContaining({
      version: 4,
      op: 'session.move',
      author: 'user',
      before: { kind: 'stage', value: { ...drafts.running, created_version: 2, updated_version: 3 } },
      after: { kind: 'stage', value: { ...drafts.moved, created_version: 2, updated_version: 4 } },
    }),
  ])
  expect(store.model.entityChanges(runA, testRef, version(3))).toEqual([
    expect.objectContaining({ version: 5, op: 'stage.replace', observer_call: secondCall }),
  ])
  expect(store.model.entityChanges(runA, buildRef, version(4))).toEqual([])
  expect(store.model.entityChanges(runB, buildRef, start)).toEqual([])
})

test('rebuilding the projection by replaying the journal restores the state it was built from', async ({
  onTestFinished,
}) => {
  const { home, store } = await openHome(onTestFinished)
  applyHistory(store, history())
  const original = describeModel(store.model)

  store.transaction((transaction) => {
    transaction.model.replay()
  })
  expect(describeModel(store.model)).toEqual(original)
  store.close()

  const database = home.database()
  database.exec(`
    DELETE FROM model_entities WHERE kind = 'stage' AND id = 'stage-build';
    UPDATE model_entities SET data = replace(data, 'Allow Bash', 'Deny Bash') WHERE id = 'attention-permission';
    INSERT INTO model_entities (run_id, kind, id, data, version, change_seq)
      SELECT run_id, kind, 'stage-stale', data, version, change_seq FROM model_entities WHERE id = 'stage-verify';
  `)
  database.close()
  const reopened = home.open()
  expect(describeModel(reopened.model)).not.toEqual(original)

  reopened.transaction((transaction) => {
    transaction.model.replay()
  })

  expect(describeModel(reopened.model)).toEqual(original)
})

test('the model version survives a restart after the writer is killed in the middle of a change set', async ({
  onTestFinished,
}) => {
  const { home, store } = await openHome(onTestFinished)
  store.close()
  const writer = await home.startWriter()

  await writer.kill()
  const restarted = home.open()

  const reference = (await openHome(onTestFinished)).store
  const committed = history()
  const interrupted = committed.pop() ?? []
  applyHistory(reference, committed)
  expect(restarted.model.head(runA)).toBe(4)
  expect(describeModel(restarted.model)).toEqual(describeModel(reference.model))

  applyHistory(restarted, [interrupted])
  applyHistory(reference, [interrupted])

  expect(restarted.model.version(runA, version(5))).toMatchObject({ change_seq: 7, observer_call: secondCall })
  expect(describeModel(restarted.model)).toEqual(describeModel(reference.model))
})

interface InvalidCase {
  readonly name: string
  readonly changeSet: ChangeSet
  readonly error: RegExp
}

const invalidCases: readonly InvalidCase[] = [
  {
    name: 'a change set without changes',
    changeSet: { run: runA, author: 'rule', at: at(2), changes: [] },
    error: /has no changes/,
  },
  {
    name: 'an entity of another run',
    changeSet: {
      run: runA,
      author: 'rule',
      at: at(2),
      changes: [put('run.create', { kind: 'run', value: drafts.runB }, observed, [fact(20)])],
    },
    error: /belongs to run/,
  },
  {
    name: 'the removal of an entity that does not exist',
    changeSet: {
      run: runA,
      author: 'rule',
      at: at(2),
      changes: [
        remove(
          'attention.close',
          { kind: 'attention_item', id: AttentionItemId.parse('attention-missing') },
          observed,
          [],
        ),
      ],
    },
    error: /does not exist/,
  },
]

test.for(invalidCases)(
  '$name is rejected together with its whole transaction',
  async ({ changeSet, error }, { onTestFinished }) => {
    const { store } = await openHome(onTestFinished)
    const attempt = (): void => {
      store.transaction((transaction) => {
        applyChangeSet(transaction, firstChangeSet())
        applyChangeSet(transaction, changeSet)
      })
    }

    expect(attempt).toThrow(InvalidChangeSetError)
    expect(attempt).toThrow(error)

    expect(describeModel(store.model)).toEqual([
      { run: runA, head: 0, versions: [], entities: [], changes: [] },
      { run: runB, head: 0, versions: [], entities: [], changes: [] },
    ])
    expect(store.transaction((transaction) => applyChangeSet(transaction, firstChangeSet())).version).toMatchObject({
      version: 1,
      change_seq: 1,
    })
  },
)
