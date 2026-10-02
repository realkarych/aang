import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { codexAdapter } from '@aang/adapter-codex'
import { factIds, objectId } from '@aang/contract/ids'
import { expect, onTestFinished, test } from 'vitest'
import { batchOf, hookBatch, joinBatches, jsonlFile } from './batches.js'
import { factsOf, recordsOf, sessionKey, startEngine, streamOf } from './harness.js'
import { createHome } from './home.js'
import { decisionRecord, otelCall, otelRoot, otelThread } from './otel-records.js'
import { codexChildRollout, codexHook, codexRollout } from './samples.js'

const cwd = '/watched'
const childLines = () => codexChildRollout({ root: otelRoot, thread: otelThread, cwd })
const rootBatch = () => {
  const lines = codexRollout({ thread: otelRoot, cwd }).slice(0, 1)
  return jsonlFile({ runtime: 'codex', path: '/root.jsonl', lines, ino: 1n }).batch(1, 1)
}
const childBatch = () =>
  jsonlFile({ runtime: 'codex', path: '/child.jsonl', lines: childLines().slice(0, 1), ino: 2n }).batch(1, 1)
const actionBatch = () =>
  hookBatch({
    runtime: 'codex',
    file: 'child-action.evt',
    payload: codexHook(
      'PreToolUse.Bash.subagent.json',
      { session: otelRoot, cwd },
      { agent_id: otelThread, tool_use_id: otelCall },
    ),
  })

const expectedDecisionId = () => {
  const record = decisionRecord()
  const result = codexAdapter.parse({ ...record, stream: streamOf('codex', childLines()) })
  if (result.parse_state !== 'parsed') {
    throw new Error('sample did not parse')
  }
  return factIds(codexAdapter.rawKey(record), result.facts)[0]
}

test.each(['otel-first', 'stream-first', 'same-batch'])(
  'normalizes a subagent decision with its original raw key: %s',
  async (order) => {
    const home = await createHome(onTestFinished)
    let store = home.open()
    let engine = startEngine(store, { all: true })
    const decision = batchOf({ records: [decisionRecord()] })
    const streams = joinBatches(rootBatch(), childBatch(), actionBatch())
    if (order === 'otel-first') {
      await engine.ingest(decision)
      expect(recordsOf(store)).toMatchObject([
        { dedupe_key: codexAdapter.rawKey(decisionRecord()), parse_state: 'unknown' },
      ])
      expect(factsOf(store)).toEqual([])
      store.close()
      store = home.open()
      engine = startEngine(store, { all: true })
      await engine.ingest(streams)
    } else if (order === 'stream-first') {
      await engine.ingest(streams)
      store.close()
      store = home.open()
      engine = startEngine(store, { all: true })
      await engine.ingest(decision)
    } else {
      await engine.ingest(joinBatches(decision, streams))
    }
    const decisions = factsOf(store).filter(({ kind }) => kind === 'permission_decision')
    expect(decisions).toMatchObject([
      {
        id: expectedDecisionId(),
        entity_key: { kind: 'action', session: otelRoot, call: otelCall },
        runtime_ids: { thread_id: otelThread },
        speaker: 'human',
      },
    ])
    expect(recordsOf(store).filter(({ channel }) => channel === 'otel')).toMatchObject([
      {
        dedupe_key: codexAdapter.rawKey(decisionRecord()),
        parse_state: 'parsed',
        payload: decisionRecord().payload,
      },
    ])
    expect(store.observations.actions(objectId(sessionKey('codex', otelRoot)))).toHaveLength(1)
    expect(
      store.observations.agents(objectId(sessionKey('codex', otelRoot))).map(({ key }) => key.agent),
    ).toContainEqual({ kind: 'thread', thread_id: otelThread })
    const head = store.changes.head()
    await engine.ingest(decision)
    expect(store.changes.head()).toBe(head)
  },
)

test('retains an unresolved decision after SIGKILL and normalizes it on arrival of the stream', async () => {
  const home = await createHome(onTestFinished)
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('./otel-process.ts', import.meta.url)), home.path],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const kill = async () => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return
    }
    const exited = once(child, 'exit')
    child.kill('SIGKILL')
    await exited
  }
  onTestFinished(kill)
  await new Promise<void>((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk
      if (stdout.includes('committed\n')) {
        resolve()
      }
    })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('exit', () => {
      reject(new Error(`child exited: ${stderr}`))
    })
  })
  await kill()
  const store = home.open()
  expect(recordsOf(store)).toHaveLength(1)
  await startEngine(store, { all: true }).ingest(joinBatches(rootBatch(), childBatch()))
  expect(
    factsOf(store)
      .filter(({ kind }) => kind === 'permission_decision')
      .map(({ id }) => id),
  ).toEqual([expectedDecisionId()])
})

test('does not attribute an unresolved thread to an unrelated root and discards it once its root is external', async () => {
  const store = (await createHome(onTestFinished)).open()
  const engine = startEngine(store)
  await engine.ingest(batchOf({ records: [decisionRecord()] }))
  await engine.ingest(rootBatch())
  expect(factsOf(store)).toEqual([])
  expect(recordsOf(store)).toHaveLength(1)
  await engine.ingest(childBatch())
  expect(factsOf(store)).toEqual([])
  expect(recordsOf(store)).toEqual([])
  expect(store.observations.sessions()).toEqual([])
})

test.each(['decision-first', 'hook-first'])(
  'resolves the thread from hooks without waiting for rollout: %s',
  async (order) => {
    const home = await createHome(onTestFinished)
    let store = home.open()
    let engine = startEngine(store, { all: true })
    const hooks = hookBatch(
      {
        runtime: 'codex',
        file: 'start.evt',
        payload: codexHook('SessionStart.startup.json', { session: otelRoot, cwd }),
      },
      {
        runtime: 'codex',
        file: 'spawn.evt',
        payload: codexHook('SubagentStart.json', { session: otelRoot, cwd }, { agent_id: otelThread }),
      },
    )
    const decision = batchOf({ records: [decisionRecord()] })
    await engine.ingest(order === 'decision-first' ? decision : hooks)
    store.close()
    store = home.open()
    engine = startEngine(store, { all: true })
    await engine.ingest(order === 'decision-first' ? hooks : decision)
    expect(
      factsOf(store)
        .filter(({ kind }) => kind === 'permission_decision')
        .map(({ id }) => id),
    ).toEqual([expectedDecisionId()])
  },
)

test('keeps the original fallback dedupe key when an incoming OTel record already has a stream', async () => {
  const store = (await createHome(onTestFinished)).open()
  const engine = startEngine(store, { all: true })
  const record = decisionRecord()
  const incoming = {
    ...record,
    stream: streamOf('codex', childLines()),
    payload: record.payload.replace(otelCall, 'call:with-colon'),
  }
  const key = codexAdapter.rawKey(incoming)
  expect(key).not.toBe(codexAdapter.rawKey({ ...incoming, stream: null }))
  await engine.ingest(batchOf({ records: [incoming] }))
  expect(recordsOf(store).map(({ dedupe_key }) => dedupe_key)).toEqual([key])
  await engine.ingest(joinBatches(rootBatch(), childBatch()))
  expect(
    recordsOf(store)
      .filter(({ channel }) => channel === 'otel')
      .map(({ dedupe_key }) => dedupe_key),
  ).toEqual([key])
  const head = store.changes.head()
  await engine.ingest(batchOf({ records: [incoming] }))
  expect(store.changes.head()).toBe(head)
})

test.each(
  ['decision', 'call_id'].flatMap((missing) =>
    ['decision-first', 'hook-first'].flatMap((order) =>
      ['external', 'observer', 'watched', 'otel-observer'].map((scope) => ({ missing, order, scope })),
    ),
  ),
)('applies $scope scope to OTel without $missing: $order', async ({ missing, order, scope }) => {
  const home = await createHome(onTestFinished)
  let store = home.open()
  const watch = { all: scope !== 'external' }
  let engine = startEngine(store, watch)
  const record = decisionRecord(otelThread, {
    [missing]: undefined,
    ...(scope === 'otel-observer' ? { originator: 'aang_observer' } : {}),
  })
  const decision = batchOf({ records: [record] })
  const key = codexAdapter.rawKey(record)
  const env = scope === 'observer' ? { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'aang_observer' } : {}
  const root = hookBatch({
    runtime: 'codex',
    file: 'start.evt',
    payload: codexHook('SessionStart.startup.json', { session: otelRoot, cwd }),
    env,
  })
  const child = hookBatch({
    runtime: 'codex',
    file: 'spawn.evt',
    payload: codexHook('SubagentStart.json', { session: otelRoot, cwd }, { agent_id: otelThread }),
    env,
  })
  const pending = () => recordsOf(store).filter(({ channel }) => channel === 'otel')
  if (order === 'decision-first') {
    await engine.ingest(decision)
    expect(pending()).toMatchObject([{ dedupe_key: key, parse_state: 'unknown' }])
    await engine.ingest(root)
    expect(pending()).toHaveLength(1)
  } else {
    await engine.ingest(joinBatches(root, child))
  }
  store.close()
  store = home.open()
  engine = startEngine(store, watch)
  await engine.ingest(order === 'decision-first' ? child : decision)
  expect(factsOf(store).filter(({ kind }) => kind === 'permission_decision')).toEqual([])
  expect(store.scopes.get(streamOf('codex', childLines()))?.scope).toBe(
    scope === 'otel-observer' ? 'watched' : scope,
  )
  if (scope === 'watched') {
    expect(pending()).toMatchObject([{ dedupe_key: key, parse_state: 'unknown', payload: record.payload }])
    const head = store.changes.head()
    expect((await engine.ingest(decision)).duplicates).toBe(1)
    expect(store.changes.head()).toBe(head)
    expect(pending()).toHaveLength(1)
  } else {
    expect(pending()).toEqual([])
    await engine.ingest(decision)
    expect(pending()).toEqual([])
  }
})
