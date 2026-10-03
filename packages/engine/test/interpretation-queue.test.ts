import { ObserverCallId } from '@aang/contract'
import { runId } from '@aang/contract/ids'
import { boundObserverQueue, exhaustObserverCall, failObserverCall, startObserverBatch } from '@aang/engine'
import { expect, onTestFinished, test } from 'vitest'
import { batchOf, hookBatch, joinBatches, jsonlFile } from './batches.js'
import { factsOf, sessionKey, startEngine, streamOf } from './harness.js'
import { createHome } from './home.js'
import { at, runA } from './model.js'
import { callId, setupObserver } from './observer-fixtures.js'
import { decisionRecord, otelCall, otelRoot, otelThread } from './otel-records.js'
import { claudeTranscript, codexChildRollout, codexHook, codexRollout } from './samples.js'

const cwd = '/watched'

test('the ingest transaction queues every new fact in the run of its session once', async () => {
  const home = await createHome(onTestFinished)
  const store = home.open()
  const engine = startEngine(store, { all: true })
  const files = ['session-a', 'session-b'].map((session, index) => {
    const lines = claudeTranscript({ session, cwd })
    return { session, lines, file: jsonlFile({ runtime: 'claude', path: `/${session}.jsonl`, lines, ino: BigInt(index + 1) }) }
  })
  for (const { file, lines } of files) {
    await engine.ingest(file.batch(1, 40))
    await engine.ingest(file.batch(41, lines.length, streamOf('claude', lines)))
  }
  const queued = () =>
    files.map(({ session }) =>
      store.interpretations
        .ofRun(runId(sessionKey('claude', session)))
        .map(({ fact, status, attempts, observer_call: call }) => [fact, status, attempts, call]),
    )
  const expected = files.map(({ session }) =>
    factsOf(store)
      .filter(({ entity_key: key }) => key.session === session)
      .map(({ id }) => id)
      .toSorted()
      .map((id) => [id, 'pending', 0, null]),
  )
  expect(expected.every((facts) => facts.length > 0)).toBe(true)
  expect(queued()).toEqual(expected)

  const [first] = files
  if (first === undefined) {
    throw new Error('missing transcript')
  }
  const redelivery = await engine.ingest(first.file.batch(1, first.lines.length, streamOf('claude', first.lines)))
  expect(redelivery).toMatchObject({ inserted: 0, duplicates: first.lines.length })
  expect(queued()).toEqual(expected)
})

test('facts of a deferred OTel record join the queue when its stream becomes known', async () => {
  const home = await createHome(onTestFinished)
  const store = home.open()
  const engine = startEngine(store, { all: true })
  await engine.ingest(batchOf({ records: [decisionRecord()] }))
  expect(store.interpretations.pendingRuns()).toEqual([])

  const root = codexRollout({ thread: otelRoot, cwd }).slice(0, 1)
  const child = codexChildRollout({ root: otelRoot, thread: otelThread, cwd }).slice(0, 1)
  await engine.ingest(
    joinBatches(
      jsonlFile({ runtime: 'codex', path: '/root.jsonl', lines: root, ino: 1n }).batch(1, 1),
      jsonlFile({ runtime: 'codex', path: '/child.jsonl', lines: child, ino: 2n }).batch(1, 1),
      hookBatch({
        runtime: 'codex',
        file: 'child-action.evt',
        payload: codexHook('PreToolUse.Bash.subagent.json', { session: otelRoot, cwd }, { agent_id: otelThread, tool_use_id: otelCall }),
      }),
    ),
  )
  const [decision] = factsOf(store).filter(({ kind }) => kind === 'permission_decision')
  const run = runId(sessionKey('codex', otelRoot))
  expect(store.interpretations.pendingRuns()).toContain(run)
  expect(store.interpretations.pending(run).map(({ fact }) => fact)).toContain(decision?.id)
})

test('queue operations refuse invalid bounds, unknown runs and finished calls', async () => {
  const { store, begin } = await setupObserver(onTestFinished)
  const limits = { facts: 30, bytes: 96_000, textLength: 4_000 }
  const start = (run = runA, batch = limits) =>
    store.transaction((transaction) =>
      startObserverBatch(transaction, {
        run,
        backend: 'claude',
        crossVendor: false,
        id: ObserverCallId.parse('guarded-call'),
        at: at(10),
        limits: batch,
      }),
    )
  expect(start(runId(sessionKey('claude', 'session-without-facts')))).toBeNull()
  expect(() => start(runA, { ...limits, facts: 0 })).toThrow(RangeError)
  expect(() =>
    store.transaction((transaction) =>
      startObserverBatch(transaction, {
        run: runA,
        backend: 'claude',
        crossVendor: false,
        id: ObserverCallId.parse('guarded-call'),
        at: at(10),
        limits,
        catchUpMs: 0,
      }),
    ),
  ).toThrow(RangeError)
  expect(() =>
    store.transaction((transaction) => boundObserverQueue(transaction, { run: runA, at: at(10), bounds: { facts: 1, ageMs: 0 } })),
  ).toThrow(RangeError)
  expect(() =>
    store.transaction((transaction) => exhaustObserverCall(transaction, { call: callId, attempts: 0, at: at(10) })),
  ).toThrow(RangeError)
  expect(() =>
    store.transaction((transaction) => exhaustObserverCall(transaction, { call: callId, attempts: 3, at: at(10) })),
  ).toThrow('missing')
  begin()
  const [held] = store.interpretations.ofCall(callId)
  if (held === undefined) {
    throw new Error('the call holds no facts')
  }
  expect(() => {
    store.transaction((transaction) => {
      transaction.interpretations.summarize(runA, callId, [held.fact])
    })
  }).toThrow('is not deferred for a summary')
  store.transaction((transaction) => {
    failObserverCall(transaction, { call: callId, outcome: 'failed', at: at(20) })
  })
  expect(() => {
    store.transaction((transaction) => {
      failObserverCall(transaction, { call: callId, outcome: 'failed', at: at(30) })
    })
  }).toThrow('already finished')
  expect(store.observerCalls.get(callId)?.verdict).toBe('failed')
})
