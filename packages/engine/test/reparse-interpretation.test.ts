import assert from 'node:assert/strict'
import {
  type Adapter,
  type AdapterRegistry,
  type Fact,
  ObserverCallId,
  type ObserverInput,
  type RunId,
  type Runtime,
} from '@aang/contract'
import { objectId, runId } from '@aang/contract/ids'
import { applyChangeSet, applyObserverResponse, createEngine, failObserverCall, startObserverBatch } from '@aang/engine'
import type { Store } from '@aang/store'
import { expect, onTestFinished, test } from 'vitest'
import { anotherVersion } from './another-normalizer.js'
import { hookBatch, jsonlFile } from './batches.js'
import { adapters, recordsOf, sessionKey, startEngine } from './harness.js'
import { createHome } from './home.js'
import { at } from './model.js'
import { claudeHook, claudeTranscript, codexRollout } from './samples.js'

const cwd = '/work/reparse-interpretation'
const limits = { facts: 1_000, bytes: 10_000_000, textLength: 4_000, inputTokens: 10_000_000 }

const adapterOf = (runtime: Runtime): Adapter => {
  const adapter = adapters.get(runtime)
  assert(adapter !== undefined)
  return adapter
}

const previousNormalizer = (runtime: Runtime, parse: Adapter['parse']): Adapter => {
  const adapter = adapterOf(runtime)
  return {
    runtime,
    normalizerVersion: anotherVersion,
    streamKey: (lines) => adapter.streamKey(lines),
    rawKey: (record) => adapter.rawKey(record),
    owner: (record) => adapter.owner(record),
    parse,
  }
}

const previousEngine = (store: Store, ...previous: readonly Adapter[]) => {
  const registry: AdapterRegistry = new Map([...adapters, ...previous.map((adapter) => [adapter.runtime, adapter] as const)])
  return createEngine({ store, adapters: registry, watch: { all: true, roots: [] } })
}

const withExtraHumanFact = (runtime: Runtime) => {
  const adapter = adapterOf(runtime)
  let extended: string | null = null
  const normalizer = previousNormalizer(runtime, (record) => {
    const result = adapter.parse(record)
    const human = result.parse_state === 'parsed' ? result.facts.find(({ speaker }) => speaker === 'human') : undefined
    if (result.parse_state !== 'parsed' || human === undefined || (extended !== null && extended !== record.payload)) {
      return result
    }
    extended = record.payload
    return { ...result, facts: [...result.facts, human] }
  })
  const extra = (store: Store): Fact => {
    const record = recordsOf(store).find(({ payload }) => payload === extended)
    const fact = record === undefined ? undefined : store.facts.ofRecord(record.seq).at(-1)
    assert(fact !== undefined)
    return fact
  }
  return { normalizer, extra }
}

const withoutPermissionRequests = previousNormalizer('claude', (record) =>
  record.payload.includes('"PermissionRequest"')
    ? { parse_state: 'unknown', source_ts: null }
    : adapterOf('claude').parse(record),
)

const start = (store: Store, run: RunId, id: string, second: number, backend: Runtime, crossVendor: boolean) =>
  store.transaction((transaction) =>
    startObserverBatch(transaction, { run, backend, crossVendor, id: ObserverCallId.parse(id), at: at(second), limits }),
  )

const respond = (store: Store, input: ObserverInput | null, id: string, second: number, ops: readonly object[] = []) => {
  assert(input !== null)
  return store.transaction((transaction) =>
    applyObserverResponse(transaction, {
      call: ObserverCallId.parse(id),
      output: { base_version: input.model.version, ops, needs: [] },
      at: at(second),
    }),
  )
}

const statuses = (store: Store, run: RunId) =>
  store.interpretations.ofRun(run).map(({ fact, status, attempts, observer_call: call }) => [fact, status, attempts, call])

const stage = (temp: string, title: string, summary: string, evidence: readonly Fact['id'][]) => ({
  op: 'stage.create',
  temp_id: temp,
  title,
  expected_result: null,
  summary,
  parent: null,
  origin: 'inferred',
  evidence,
  rationale: 'Observed facts',
})

test('reparse queues the facts it adds in the run of their session and keeps the statuses of the facts it keeps', async () => {
  const session = 'reparse-permission'
  const run = runId(sessionKey('claude', session))
  const home = await createHome(onTestFinished)
  const store = home.open()
  const lines = claudeTranscript({ session, cwd })
  const previous = previousEngine(store, withoutPermissionRequests)
  await previous.ingest(jsonlFile({ runtime: 'claude', path: `/${session}.jsonl`, lines, ino: 1n }).batch(1, lines.length))
  await previous.ingest(
    hookBatch({ file: 'permission.evt', payload: claudeHook('PermissionRequest.Bash.json', { session, cwd }), arrival: 1 }),
  )
  const permissionRecord = recordsOf(store).find(({ payload }) => payload.includes('"PermissionRequest"'))
  assert(permissionRecord !== undefined)
  expect(permissionRecord.parse_state).toBe('unknown')
  expect(respond(store, start(store, run, 'first-call', 10, 'claude', false), 'first-call', 11)).toMatchObject({
    status: 'accepted',
  })
  const interpreted = statuses(store, run)
  expect(interpreted.length).toBeGreaterThan(0)
  expect(interpreted.every(([, status, attempts]) => status === 'interpreted' && attempts === 1)).toBe(true)

  const engine = startEngine(store, { all: true })
  expect(await engine.reparse()).toMatchObject({ facts_added: 1, facts_missing: 0 })
  const [permission] = store.facts.ofRecord(permissionRecord.seq)
  assert(permission !== undefined)
  expect(permission).toMatchObject({ kind: 'permission_request', urgent: true })
  expect(statuses(store, run)).toEqual(
    [...interpreted, [permission.id, 'pending', 0, null]].toSorted(([left], [right]) => String(left).localeCompare(String(right))),
  )
  const next = start(store, run, 'second-call', 20, 'claude', false)
  expect(next?.batch.facts.map(({ id, kind, urgent }) => [id, kind, urgent])).toEqual([
    [permission.id, 'permission_request', true],
  ])
  expect(respond(store, next, 'second-call', 21)).toMatchObject({ status: 'accepted' })
  const settled = statuses(store, run)
  expect(settled).toContainEqual([permission.id, 'interpreted', 1, 'second-call'])

  expect(await engine.reparse()).toMatchObject({ facts_added: 0, facts_kept: 0, facts_missing: 0 })
  expect(statuses(store, run)).toEqual(settled)
  expect(start(store, run, 'third-call', 30, 'claude', false)).toBeNull()
})

test('a model text grounded on a fact that reparse deleted reaches another vendor only with crossVendor', async () => {
  const thread = '01a0f75c-0000-7000-8000-00000000beef'
  const attached = 'reparse-attached'
  const run = runId(sessionKey('codex', thread))
  const home = await createHome(onTestFinished)
  const store = home.open()
  const codex = withExtraHumanFact('codex')
  const claude = withExtraHumanFact('claude')
  const previous = previousEngine(store, codex.normalizer, claude.normalizer)
  const rollout = codexRollout({ thread, cwd })
  await previous.ingest(jsonlFile({ runtime: 'codex', path: '/rollout.jsonl', lines: rollout, ino: 1n }).batch(1, rollout.length))
  const attachedSession = objectId({ kind: 'session', runtime: 'claude', session: attached })
  store.transaction((transaction) => {
    applyChangeSet(transaction, {
      run,
      author: 'rule',
      at: at(1),
      changes: [
        {
          op: 'session.move',
          put: { kind: 'session_membership', value: { run, session: attachedSession } },
          basis: { kind: 'observed' },
          evidence: [],
        },
      ],
    })
  })
  const transcript = claudeTranscript({ session: attached, cwd })
  await previous.ingest(
    jsonlFile({ runtime: 'claude', path: `/${attached}.jsonl`, lines: transcript, ino: 2n }).batch(1, transcript.length),
  )
  expect(store.observations.getSession(attachedSession)?.run).toBe(run)
  const codexGround = codex.extra(store)
  const claudeGround = claude.extra(store)
  expect([codexGround.entity_key.runtime, claudeGround.entity_key.runtime]).toEqual(['codex', 'claude'])

  const first = start(store, run, 'crossing-call', 10, 'claude', true)
  expect(first?.batch.facts.map(({ id }) => id)).toEqual(expect.arrayContaining([codexGround.id, claudeGround.id]))
  expect(
    respond(store, first, 'crossing-call', 11, [
      { op: 'brief.update', text: 'CODEX-PRIVATE-BRIEF', evidence: [codexGround.id], rationale: 'Codex prompt' },
      stage('codex', 'CODEX-PRIVATE-STAGE', 'CODEX-PRIVATE-RESULT', [codexGround.id]),
      stage('claude', 'Claude attached stage', 'Claude attached result', [claudeGround.id]),
    ]),
  ).toMatchObject({ status: 'accepted' })

  const engine = startEngine(store, { all: true })
  expect(await engine.reparse()).toMatchObject({ facts_added: 0, facts_missing: 2 })
  expect([store.facts.get(codexGround.id), store.facts.get(claudeGround.id)]).toEqual([null, null])
  await engine.ingest(
    hookBatch({
      file: 'attached-permission.evt',
      payload: claudeHook('PermissionRequest.Bash.json', { session: attached, cwd }),
      arrival: 2,
    }),
  )

  const separated = start(store, run, 'separated-call', 20, 'claude', false)
  expect(separated?.batch.facts.map(({ kind }) => kind)).toEqual(['permission_request'])
  expect(separated?.run.brief).toBeNull()
  expect(separated?.model.stages.map(({ title, summary }) => [title, summary])).toEqual([
    ['Claude attached stage', 'Claude attached result'],
  ])
  expect(JSON.stringify(separated)).not.toContain('CODEX-PRIVATE')
  store.transaction((transaction) => {
    failObserverCall(transaction, { call: ObserverCallId.parse('separated-call'), outcome: 'failed', at: at(21) })
  })

  const crossing = start(store, run, 'crossing-again', 30, 'claude', true)
  expect(crossing?.run.brief).toBe('CODEX-PRIVATE-BRIEF')
  expect(crossing?.model.stages.map(({ title, summary }) => [title, summary])).toEqual(
    expect.arrayContaining([
      ['CODEX-PRIVATE-STAGE', 'CODEX-PRIVATE-RESULT'],
      ['Claude attached stage', 'Claude attached result'],
    ]),
  )
})
