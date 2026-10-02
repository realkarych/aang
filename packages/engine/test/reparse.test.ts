import assert from 'node:assert/strict'
import { codexAdapter } from '@aang/adapter-codex'
import {
  EpochNs,
  type Fact,
  type FactId,
  ModelVersion,
  NormalizerVersion,
  type RunId,
  type SessionKey,
} from '@aang/contract'
import { factIds, objectId, runId } from '@aang/contract/ids'
import { applyChangeSet, resolveEvidence } from '@aang/engine'
import type { Store } from '@aang/store'
import { expect, onTestFinished, test } from 'vitest'
import { batchOf, hookBatch, joinBatches, jsonlFile } from './batches.js'
import { factsOf, recordsOf, sessionKey, startEngine, streamOf } from './harness.js'
import { createHome } from './home.js'
import { failingAt, invalidChannel, nextNormalizers, reversedFactGroups, withoutFacts } from './normalizers.js'
import { decisionRecord, otelRoot, otelThread } from './otel-records.js'
import { claudeHook, claudeTranscript, codexChildRollout, codexRollout } from './samples.js'

const cwd = '/work/reparse'
const session = 'reparse-session'
const hookOnly = 'reparse-hook-only'
const key = sessionKey('claude', session)
const run = runId(key)

const startHook = (id: string) =>
  hookBatch({ file: `${id}-start.evt`, payload: claudeHook('SessionStart.startup.json', { session: id, cwd }) })

const transcript = () => {
  const lines = claudeTranscript({ session, cwd })
  return jsonlFile({ runtime: 'claude', path: '/reparse.jsonl', lines, ino: 1n }).batch(1, lines.length)
}

const permission = () =>
  hookBatch({
    file: 'permission.evt',
    payload: claudeHook('PermissionRequest.Bash.json', { session, cwd }),
    arrival: 1,
  })

const sessionBatch = () => joinBatches(startHook(session), startHook(hookOnly), permission(), transcript())

const observationsOf = (store: Store, observed: SessionKey) => {
  const id = objectId(observed)
  return {
    session: store.observations.getSession(id),
    agents: store.observations.agents(id),
    actions: store.observations.actions(id),
    questions: store.observations.questions(id),
  }
}

const referenceFacts = (store: Store, owner: RunId, evidence: readonly FactId[]): void => {
  const [goal] = evidence
  assert(goal !== undefined)
  const at = EpochNs.parse(1_790_856_600_000_000_000n)
  store.transaction((transaction) =>
    applyChangeSet(transaction, {
      run: owner,
      at,
      author: 'rule',
      changes: [
        {
          op: 'run.create',
          put: {
            kind: 'run',
            value: {
              id: owner,
              runtime: 'claude',
              root_session: objectId(key),
              goal: { text: 'Reparse the transcript', fact: goal },
              brief: null,
              start_pruned: false,
              created_at: at,
            },
          },
          basis: { kind: 'observed' },
          evidence: [...evidence],
        },
      ],
    }),
  )
}

const modelEvidence = (store: Store): FactId[] =>
  store.model.changes(run, ModelVersion.parse(0)).flatMap(({ evidence }) => evidence)

const withVersion = (fact: Fact, version: number): Fact => ({
  ...fact,
  normalizer_version: NormalizerVersion.parse(version),
})

const withoutChangeSeq = <T extends { readonly change_seq: number }>(value: T) => ({ ...value, change_seq: 0 })

test('keeps fact ids and model references when the next normalizer reorders the facts of each record', async () => {
  const home = await createHome(onTestFinished)
  let store = home.open()
  await startEngine(store, { all: true }).ingest(sessionBatch())
  const facts = factsOf(store)
  const records = recordsOf(store)
  const reordered = new Map(
    records
      .map(({ seq }) => [seq, store.facts.ofRecord(seq).map(({ id }) => id)] as const)
      .filter(([, ids]) => ids.length > 1),
  )
  expect(reordered.size).toBeGreaterThan(0)
  expect(observationsOf(store, key).questions).toHaveLength(1)
  referenceFacts(store, run, facts.map(({ id }) => id))
  const journal = store.model.changes(run, ModelVersion.parse(0))
  const observed = observationsOf(store, key)
  store.close()

  store = home.open()
  const engine = startEngine(store, { all: true, adapters: nextNormalizers(2, reversedFactGroups) })
  const result = await engine.reparse()
  expect(result).toEqual({
    records: records.length,
    facts_added: 0,
    facts_kept: facts.length,
    facts_missing: 0,
    head: store.changes.head(),
  })
  for (const [seq, ids] of reordered) {
    expect(store.facts.ofRecord(seq).map(({ id }) => id)).toEqual(ids.toReversed())
  }
  expect(store.model.changes(run, ModelVersion.parse(0))).toEqual(journal)
  expect(resolveEvidence(store.facts, modelEvidence(store))).toEqual(
    facts.map((fact) => ({ id: fact.id, state: 'available', fact: withVersion(fact, 2) })),
  )
  expect(observationsOf(store, key)).toEqual(observed)

  const again = await engine.reparse()
  expect(again).toMatchObject({ facts_added: 0, facts_missing: 0, head: result.head })
  expect((await engine.ingest(startHook(session))).duplicates).toBe(1)
  expect(store.changes.head()).toBe(result.head)
  store.close()

  store = home.open()
  expect(factsOf(store).map(({ id, normalizer_version }) => [id, normalizer_version])).toEqual(
    expect.arrayContaining(facts.map(({ id }) => [id, 2])),
  )
  expect(observationsOf(store, key)).toEqual(observed)
})

test('shows an omitted fact as an unavailable basis and restores it with the same id', async () => {
  const home = await createHome(onTestFinished)
  let store = home.open()
  await startEngine(store, { all: true }).ingest(sessionBatch())
  const facts = factsOf(store)
  const hookSeqs = new Set(recordsOf(store).filter(({ channel }) => channel === 'hook').map(({ seq }) => seq))
  const agentStart = facts.find(({ kind }) => kind === 'agent_start')
  const message = facts.find(({ kind }) => kind === 'message')
  const hookFact = facts.find(({ seq }) => hookSeqs.has(seq))
  assert(agentStart?.entity_key.kind === 'agent' && message !== undefined && hookFact !== undefined)
  const subagent = objectId(agentStart.entity_key)
  const omitted = facts.filter(({ id, seq }) => id === agentStart.id || hookSeqs.has(seq))
  const observed = observationsOf(store, key)
  const hookOnlyObserved = observationsOf(store, sessionKey('claude', hookOnly))
  expect(observed.session?.support_mode).toBe('full')
  expect(observed.agents.map(({ id }) => id)).toContain(subagent)
  expect(observed.questions).toHaveLength(1)
  expect(hookOnlyObserved.session).not.toBeNull()
  const evidence = [agentStart.id, message.id, hookFact.id]
  referenceFacts(store, run, evidence)
  const journal = store.model.changes(run, ModelVersion.parse(0))
  store.close()

  store = home.open()
  const omitting = await startEngine(store, {
    all: true,
    adapters: nextNormalizers(2, withoutFacts('agent_start'), invalidChannel('hook')),
  }).reparse()
  expect(omitting).toMatchObject({
    facts_added: 0,
    facts_kept: facts.length - omitted.length,
    facts_missing: omitted.length,
  })
  expect(resolveEvidence(store.facts, modelEvidence(store))).toEqual([
    { id: agentStart.id, state: 'unavailable' },
    { id: message.id, state: 'available', fact: withVersion(message, 2) },
    { id: hookFact.id, state: 'unavailable' },
  ])
  expect(store.model.changes(run, ModelVersion.parse(0))).toEqual(journal)
  for (const seq of hookSeqs) {
    expect(store.rawRecords.get(seq)).toMatchObject({ parse_state: 'invalid', source_ts: null })
  }
  const reduced = observationsOf(store, key)
  expect(reduced.session).toMatchObject({ support_mode: 'full', unknown_records: 2 })
  expect(reduced.agents.map(({ id }) => id)).not.toContain(subagent)
  expect(store.observations.getAgent(subagent)).toBeNull()
  expect(reduced.questions).toEqual([])
  expect(reduced.actions.map(({ id, input_fact }) => ({ id, input_fact }))).toEqual(
    observed.actions.map(({ id, input_fact }) => ({ id, input_fact })),
  )
  expect(observationsOf(store, sessionKey('claude', hookOnly))).toMatchObject({
    session: { support_mode: 'hooks_only', unknown_records: 1 },
    agents: [],
    actions: [],
    questions: [],
  })
  store.close()

  store = home.open()
  const restoring = await startEngine(store, { all: true, adapters: nextNormalizers(3) }).reparse()
  expect(restoring).toMatchObject({
    facts_added: omitted.length,
    facts_kept: facts.length - omitted.length,
    facts_missing: 0,
  })
  expect(resolveEvidence(store.facts, modelEvidence(store))).toEqual(
    [agentStart, message, hookFact].map((fact) => ({ id: fact.id, state: 'available', fact: withVersion(fact, 3) })),
  )
  for (const seq of hookSeqs) {
    expect(store.rawRecords.get(seq)).toMatchObject({ parse_state: 'parsed' })
  }
  const restored = observationsOf(store, key)
  expect(restored.session?.support_mode).toBe('full')
  expect(restored.agents.map(withoutChangeSeq)).toEqual(observed.agents.map(withoutChangeSeq))
  expect(restored.actions.map(withoutChangeSeq)).toEqual(observed.actions.map(withoutChangeSeq))
  expect(restored.questions.map(withoutChangeSeq)).toEqual(observed.questions.map(withoutChangeSeq))
  expect(observationsOf(store, sessionKey('claude', hookOnly)).session).toMatchObject({
    id: hookOnlyObserved.session?.id,
    support_mode: 'hooks_only',
  })
})

test('keeps a resolved OTel decision and leaves an unresolved one pending until its thread appears', async () => {
  const later = 'otel-later'
  const home = await createHome(onTestFinished)
  let store = home.open()
  const root = codexRollout({ thread: otelRoot, cwd }).slice(0, 1)
  const child = (thread: string) => codexChildRollout({ root: otelRoot, thread, cwd }).slice(0, 1)
  const resolved = decisionRecord()
  const pending = decisionRecord(later)
  await startEngine(store, { all: true }).ingest(
    joinBatches(
      jsonlFile({ runtime: 'codex', path: '/root.jsonl', lines: root, ino: 1n }).batch(1, 1),
      jsonlFile({ runtime: 'codex', path: '/child.jsonl', lines: child(otelThread), ino: 2n }).batch(1, 1),
      batchOf({ records: [resolved, pending] }),
    ),
  )
  const decisionId = (record: typeof resolved, thread: string): FactId => {
    const parsed = codexAdapter.parse({ ...record, stream: streamOf('codex', child(thread)) })
    assert(parsed.parse_state === 'parsed')
    const [id] = factIds(codexAdapter.rawKey(record), parsed.facts)
    assert(id !== undefined)
    return id
  }
  const decisions = () =>
    factsOf(store)
      .filter(({ kind }) => kind === 'permission_decision')
      .map(({ id, normalizer_version }) => [id, normalizer_version])
  const otel = () =>
    recordsOf(store)
      .filter(({ channel }) => channel === 'otel')
      .map(({ dedupe_key, parse_state, stream }) => ({ dedupe_key, parse_state, stream }))
      .sort((left, right) => left.dedupe_key.localeCompare(right.dedupe_key))
  expect(decisions()).toEqual([[decisionId(resolved, otelThread), 1]])
  store.close()

  store = home.open()
  const engine = startEngine(store, { all: true, adapters: nextNormalizers(2, reversedFactGroups) })
  await engine.reparse()
  expect(decisions()).toEqual([[decisionId(resolved, otelThread), 2]])
  expect(otel()).toEqual([
    { dedupe_key: codexAdapter.rawKey(resolved), parse_state: 'parsed', stream: streamOf('codex', child(otelThread)) },
    { dedupe_key: codexAdapter.rawKey(pending), parse_state: 'unknown', stream: null },
  ])

  await engine.ingest(
    jsonlFile({ runtime: 'codex', path: '/later.jsonl', lines: child(later), ino: 3n }).batch(1, 1),
  )
  expect(decisions()).toEqual([
    [decisionId(resolved, otelThread), 2],
    [decisionId(pending, later), 2],
  ])
  expect(otel().map(({ dedupe_key, parse_state }) => [dedupe_key, parse_state])).toEqual([
    [codexAdapter.rawKey(resolved), 'parsed'],
    [codexAdapter.rawKey(pending), 'parsed'],
  ])
})

test('leaves the store unchanged when the next normalizer fails midway and keeps ingesting', async () => {
  const home = await createHome(onTestFinished)
  let store = home.open()
  await startEngine(store, { all: true }).ingest(sessionBatch())
  const head = store.changes.head()
  const facts = factsOf(store)
  const records = recordsOf(store)
  const observed = observationsOf(store, key)
  store.close()

  store = home.open()
  const engine = startEngine(store, { all: true, adapters: nextNormalizers(2, reversedFactGroups, failingAt(50)) })
  await expect(engine.reparse()).rejects.toThrow('the next normalizer fails at line 50')
  expect(store.changes.head()).toBe(head)
  expect(factsOf(store)).toEqual(facts)
  expect(recordsOf(store)).toEqual(records)
  expect(observationsOf(store, key)).toEqual(observed)
  expect((await engine.ingest(startHook(session))).duplicates).toBe(1)
  expect(store.changes.head()).toBe(head)
})
