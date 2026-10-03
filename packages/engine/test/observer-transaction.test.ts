import { ObserverCallId, ObserverInput } from '@aang/contract'
import { applyObserverResponse, beginObserverCall } from '@aang/engine'
import { expect, test } from 'vitest'
import { at, runA } from './model.js'
import { callId, createStage, inputFor, response, setupObserver, version } from './observer-fixtures.js'

test.for(['started', 'applying', 'accepted'] as const)(
  'recovers atomically after SIGKILL of the observer writer in phase %s',
  async (phase, { onTestFinished }) => {
    const { home, store, solver, human } = await setupObserver(onTestFinished)
    const input = inputFor(store, [solver, human])
    store.transaction((transaction) => {
      transaction.settings.save('observer-test-input', input, at(10))
    })
    store.close()
    const writer = await home.startObserverWriter(phase)
    await writer.kill()
    const restarted = home.open()
    expect(restarted.model.head(runA)).toBe(phase === 'accepted' ? 3 : 2)
    expect(restarted.interpretations.ofRun(runA).map(({ status, attempts }) => [status, attempts])).toEqual(
      phase === 'accepted'
        ? [
            ['interpreted', 1],
            ['interpreted', 1],
          ]
        : [
            ['pending', 1],
            ['pending', 1],
          ],
    )
    const crashed = ObserverCallId.parse('crash-call')
    expect(restarted.observerCalls.get(crashed)?.verdict).toBe(phase === 'accepted' ? 'accepted' : null)
    expect(() =>
      restarted.transaction((transaction) =>
        applyObserverResponse(transaction, {
          call: crashed,
          output: response([], 2),
          at: at(30),
        }),
      ),
    ).toThrow()
    if (phase !== 'accepted') {
      const retry = ObserverCallId.parse('retry')
      restarted.transaction((transaction) => {
        beginObserverCall(transaction, {
          id: retry,
          backend: 'claude',
          crossVendor: false,
          input: ObserverInput.parse(restarted.settings.get('observer-test-input')),
          at: at(30),
        })
      })
      expect(
        restarted.transaction((transaction) =>
          applyObserverResponse(transaction, {
            call: retry,
            output: response([createStage([solver.id])], 2),
            at: at(40),
          }),
        ).status,
      ).toBe('accepted')
      expect(restarted.interpretations.ofRun(runA).map(({ status, attempts }) => [status, attempts])).toEqual(
        [
          ['interpreted', 2],
          ['interpreted', 2],
        ],
      )
    }
  },
)

test('rolls back the model and fact statuses when recording the verdict fails', async ({
  onTestFinished,
}) => {
  const { home, store, solver, begin } = await setupObserver(onTestFinished)
  begin()
  const before = store.changes.head()
  const database = home.database()
  database.exec(
    "CREATE TRIGGER reject_verdict BEFORE UPDATE ON observer_calls BEGIN SELECT RAISE(ABORT, 'disk write rejected'); END",
  )
  expect(() =>
    store.transaction((transaction) =>
      applyObserverResponse(transaction, {
        call: callId,
        output: response([createStage([solver.id])], 2),
        at: at(20),
      }),
    ),
  ).toThrow('disk write rejected')
  expect(store.model.head(runA)).toBe(2)
  expect(store.model.changes(runA, version(2))).toEqual([])
  expect(store.changes.head()).toBe(before)
  expect(store.interpretations.ofCall(callId).every(({ status }) => status === 'in_call')).toBe(true)
  expect(store.observerCalls.get(callId)?.verdict).toBeNull()
  database.exec('DROP TRIGGER reject_verdict')
  database.close()
  expect(
    store.transaction((transaction) =>
      applyObserverResponse(transaction, {
        call: callId,
        output: response([createStage([solver.id])], 2),
        at: at(20),
      }),
    ).status,
  ).toBe('accepted')
})

test('records an empty operation response as an accepted version and forbids a second application', async ({
  onTestFinished,
}) => {
  const { store, begin } = await setupObserver(onTestFinished)
  begin()
  expect(
    store.transaction((transaction) =>
      applyObserverResponse(transaction, { call: callId, output: response([], 2), at: at(20) }),
    ),
  ).toEqual({ status: 'accepted', version: 3 })
  expect(store.model.changes(runA, version(2))).toEqual([])
  expect(store.model.version(runA, version(3))).toMatchObject({ observer_call: callId, base_version: 2 })
  const head = store.changes.head()
  expect(() =>
    store.transaction((transaction) =>
      applyObserverResponse(transaction, { call: callId, output: response([], 2), at: at(30) }),
    ),
  ).toThrow('already finished')
  expect(store.changes.head()).toBe(head)
})

test('does not start a call with a stale snapshot, foreign facts or an already active batch', async ({
  onTestFinished,
}) => {
  const { store, solver, foreignFacts, begin } = await setupObserver(onTestFinished)
  const stale = inputFor(store, [solver])
  stale.model.version = version(0)
  expect(() => {
    store.transaction((transaction) => {
      beginObserverCall(transaction, { id: callId, backend: 'claude', crossVendor: false, input: stale, at: at(10) })
    })
  }).toThrow('current run version')
  const foreign = inputFor(store, foreignFacts)
  expect(() => {
    store.transaction((transaction) => {
      beginObserverCall(transaction, { id: callId, backend: 'claude', crossVendor: false, input: foreign, at: at(10) })
    })
  }).toThrow('not in run')
  expect(store.observerCalls.get(callId)).toBeNull()
  expect(store.interpretations.ofRun(runA)).toEqual([])
  begin()
  expect(() => begin([solver], ObserverCallId.parse('concurrent'))).toThrow('already has an observer call')
  expect(store.observerCalls.get(ObserverCallId.parse('concurrent'))).toBeNull()
})

test('refuses an empty batch that could not be recovered through interpretation records', async ({
  onTestFinished,
}) => {
  const { store } = await setupObserver(onTestFinished)
  expect(() => { store.transaction((transaction) => {
      beginObserverCall(transaction, { id: callId, backend: 'claude', crossVendor: false, input: inputFor(store, []), at: at(10) })
    }); },
  ).toThrow('nonempty batch')
  expect(store.observerCalls.get(callId)).toBeNull()
})

test('requires the exact recorded batch when accepting a response', async ({ onTestFinished }) => {
  const { store, solver, human } = await setupObserver(onTestFinished)
  const input = inputFor(store, [solver])
  store.transaction((transaction) => {
    transaction.observerCalls.start({ id: callId, backend: 'claude', input, at: at(10) })
    transaction.interpretations.begin(runA, callId, [human.id])
  })
  expect(() =>
    store.transaction((transaction) =>
      applyObserverResponse(transaction, { call: callId, output: response([], 2), at: at(20) }),
    ),
  ).toThrow('no longer owns its batch')
  expect(store.observerCalls.get(callId)?.verdict).toBeNull()
})

test('rejects nonpositive validation limits without consuming the batch', async ({ onTestFinished }) => {
  const { store, begin } = await setupObserver(onTestFinished)
  begin()
  expect(() =>
    store.transaction((transaction) =>
      applyObserverResponse(transaction, {
        call: callId,
        output: response([], 2),
        at: at(20),
        limits: { operations: 0, textLength: 5 },
      }),
    ),
  ).toThrow('positive integers')
  expect(store.interpretations.ofCall(callId).every(({ status }) => status === 'in_call')).toBe(true)
})

test.for([null, undefined, 'not json', { ops: [] }])(
  'reports schema rejection for malformed output %j',
  async (output, { onTestFinished }) => {
    const { store, begin } = await setupObserver(onTestFinished)
    begin()
    expect(
      store.transaction((transaction) =>
        applyObserverResponse(transaction, { call: callId, output, at: at(20) }),
      ).status,
    ).toBe('rejected')
    expect(store.interpretations.ofRun(runA).every(({ status }) => status === 'pending')).toBe(true)
    expect(store.observerCalls.get(callId)?.output).toEqual(output ?? null)
  },
)
