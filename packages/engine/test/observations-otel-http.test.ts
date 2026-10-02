import { createCollector } from '@aang/collector'
import { Config } from '@aang/contract'
import { expect, onTestFinished, test } from 'vitest'
import { hookBatch, joinBatches } from './batches.js'
import { factsOf, recordsOf, startEngine } from './harness.js'
import { createHome } from './home.js'
import { createLiveRoots, type LiveRoots } from './live.js'
import { decisionRecord, otelCall, otelRoot, otelThread } from './otel-records.js'
import { codexHook } from './samples.js'

const token = 'otel-engine-integration-0123456789abcdef'
const eventTime = '1790861489275000000'

const startReceiver = async (roots: LiveRoots) => {
  const collector = createCollector({
    spool: roots.spool,
    runtimeRoots: { claude: roots.claude, codex: roots.codex },
    config: Config.parse({}),
  })
  const batches = collector.start([])[Symbol.asyncIterator]()
  const close = async () => {
    await collector.close()
    await batches.return?.()
  }
  onTestFinished(close)
  const listener = await collector.listenOtel({ port: 0, token })
  const receive = async (body: string) => {
    const response = await fetch(`http://${listener.host}:${String(listener.port)}/otel/${token}/v1/logs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({})
    const next = await batches.next()
    if (next.done === true) {
      throw new Error('collector stopped before delivering OTel')
    }
    expect(next.value.records).toHaveLength(1)
    return next.value
  }
  return { receive, close, ack: collector.ack }
}

const envelope = (log: Readonly<Record<string, unknown>>, service = 'codex_exec') =>
  JSON.stringify({
    resourceLogs: [{
      resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] },
      scopeLogs: [{ scope: { name: 'codex_otel.log_only' }, logRecords: [log] }],
    }],
  })

test.each(
  ['complete', 'decision', 'call_id'].flatMap((missing) =>
    ['decision-first', 'stream-first'].flatMap((order) =>
      ['watched', 'external', 'observer', 'otel-observer'].map((scope) => ({ missing, order, scope })),
    ),
  ),
)('ingests HTTP OTel for $scope with $missing fields: $order', async ({ missing, order, scope }) => {
  const home = await createHome(onTestFinished)
  const roots = await createLiveRoots(onTestFinished)
  let store = home.open()
  const watch = { all: scope !== 'external' }
  let engine = startEngine(store, watch)
  let receiver = await startReceiver(roots)
  const record = decisionRecord(otelThread, {
    ...(missing === 'complete' ? {} : { [missing]: undefined }),
    ...(scope === 'otel-observer' ? { originator: 'aang_observer' } : {}),
  })
  const log = { ...JSON.parse(record.payload) as Record<string, unknown>, timeUnixNano: eventTime }
  const body = envelope(log)
  const env = scope === 'observer' ? { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'aang_observer' } : {}
  const root = hookBatch({
    runtime: 'codex',
    file: 'start.evt',
    payload: codexHook('SessionStart.startup.json', { session: otelRoot, cwd: roots.codex }),
    env,
  })
  const child = hookBatch({
    runtime: 'codex',
    file: 'spawn.evt',
    payload: codexHook('SubagentStart.json', { session: otelRoot, cwd: roots.codex }, { agent_id: otelThread }),
    env,
  })
  const deliver = async (payload = body) => {
    const batch = await receiver.receive(payload)
    expect(batch.records[0]?.payload).toBe(payload)
    const result = await engine.ingest(batch)
    for (const settled of result.settled) {
      await receiver.ack(settled)
    }
    return result
  }
  const otelRecords = () => recordsOf(store).filter(({ channel }) => channel === 'otel')
  const decisions = () => factsOf(store).filter(({ kind }) => kind === 'permission_decision')

  if (order === 'decision-first') {
    await deliver()
    expect(otelRecords()).toMatchObject([{ parse_state: 'unknown', payload: body }])
    expect(decisions()).toEqual([])
    await engine.ingest(root)
    expect(otelRecords()).toHaveLength(1)
    expect(decisions()).toEqual([])
  } else {
    await engine.ingest(joinBatches(root, child))
  }

  await receiver.close()
  store.close()
  store = home.open()
  engine = startEngine(store, watch)
  receiver = await startReceiver(roots)
  if (order === 'decision-first') {
    await engine.ingest(child)
  } else {
    await deliver()
  }

  if (scope === 'watched') {
    if (missing === 'complete') {
      expect(decisions()).toMatchObject([{
        entity_key: { kind: 'action', session: otelRoot, call: otelCall },
        runtime_ids: { thread_id: otelThread },
        at: BigInt(eventTime),
        speaker: 'human',
        payload: { decision: 'approved', source: 'user' },
      }])
      expect(otelRecords()).toMatchObject([{
        dedupe_key: `codex:otel:${otelThread}:${otelCall}:approved:${eventTime}`,
        parse_state: 'parsed',
        source_ts: BigInt(eventTime),
        payload: body,
      }])
    } else {
      expect(decisions()).toEqual([])
      expect(otelRecords()).toMatchObject([{ parse_state: 'unknown', payload: body }])
    }
    const head = store.changes.head()
    const before = { records: otelRecords(), facts: decisions() }
    expect((await deliver()).duplicates).toBe(1)
    if (missing === 'complete') {
      const redelivery = envelope({ ...log, observedTimeUnixNano: '1790861490000000000' }, 'resent')
      expect((await deliver(redelivery)).duplicates).toBe(1)
    }
    expect(store.changes.head()).toBe(head)
    expect({ records: otelRecords(), facts: decisions() }).toEqual(before)
  } else {
    expect(decisions()).toEqual([])
    expect(otelRecords()).toEqual([])
    await deliver()
    expect(decisions()).toEqual([])
    expect(otelRecords()).toEqual([])
    if (scope !== 'otel-observer') {
      expect(recordsOf(store)).toEqual([])
      expect(factsOf(store)).toEqual([])
      expect(store.observations.sessions()).toEqual([])
    }
  }
})
