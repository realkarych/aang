import assert from 'node:assert/strict'
import { codexAdapter } from '@aang/adapter-codex'
import {
  type AgentKey,
  ChangeSeq,
  type CollectedRecord,
  EpochNs,
  type Fact,
  FactDraft,
  type FactId,
  ModelVersion,
  type RunId,
  type SessionKey,
} from '@aang/contract'
import { factIds, objectId, runId } from '@aang/contract/ids'
import { applyChangeSet, resolveEvidence } from '@aang/engine'
import type { Store } from '@aang/store'
import { expect, onTestFinished, test } from 'vitest'
import { anotherVersion, draftOf, reversedFactGroups, sameFacts, storeAnotherNormalizer } from './another-normalizer.js'
import { batchOf, hookBatch, joinBatches, jsonlFile } from './batches.js'
import { expectedOf, factsOf, recordsOf, sessionKey, startEngine, streamOf } from './harness.js'
import { createHome } from './home.js'
import { decisionRecord, otelRoot, otelThread } from './otel-records.js'
import { claudeHook, claudeTranscript, codexChildRollout, codexRollout } from './samples.js'

const cwd = '/work/reparse'
const session = 'reparse-session'
const hookOnly = 'reparse-hook-only'
const key = sessionKey('claude', session)
const run = runId(key)
const everything = 1_000_000

const startHook = (id: string) =>
  hookBatch({ file: `${id}-start.evt`, payload: claudeHook('SessionStart.startup.json', { session: id, cwd }) })

const transcriptFile = () =>
  jsonlFile({ runtime: 'claude', path: '/reparse.jsonl', lines: claudeTranscript({ session, cwd }), ino: 1n })

const permission = () =>
  hookBatch({
    file: 'permission.evt',
    payload: claudeHook('PermissionRequest.Bash.json', { session, cwd }),
    arrival: 1,
  })

const hooks = () => joinBatches(startHook(session), startHook(hookOnly), permission())

const sessionBatch = () => {
  const file = transcriptFile()
  return joinBatches(hooks(), file.batch(1, file.lines.length))
}

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

const byId = (left: Fact, right: Fact): number => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)

const withoutChangeSeq = <T extends { readonly change_seq: number }>(value: T) => ({ ...value, change_seq: 0 })

const withoutChangeSeqs = (observed: ReturnType<typeof observationsOf>) => ({
  session: observed.session === null ? null : withoutChangeSeq(observed.session),
  agents: observed.agents.map(withoutChangeSeq),
  actions: observed.actions.map(withoutChangeSeq),
  questions: observed.questions.map(withoutChangeSeq),
})

test('keeps fact ids and model references when another normalizer version stored the facts in another order', async () => {
  const home = await createHome(onTestFinished)
  let store = home.open()
  await startEngine(store, { all: true }).ingest(sessionBatch())
  const facts = factsOf(store)
  const records = recordsOf(store)
  const factless = records.filter(({ seq }) => store.facts.ofRecord(seq).length === 0)
  const ordered = new Map(
    records
      .map(({ seq }) => [seq, store.facts.ofRecord(seq).map(({ id }) => id)] as const)
      .filter(([, ids]) => ids.length > 1),
  )
  const observed = observationsOf(store, key)
  storeAnotherNormalizer(store, reversedFactGroups)
  expect(ordered.size).toBeGreaterThan(0)
  for (const [seq, ids] of ordered) {
    expect(store.facts.ofRecord(seq).map(({ id, normalizer_version }) => [id, normalizer_version])).toEqual(
      ids.toReversed().map((id) => [id, anotherVersion]),
    )
  }
  referenceFacts(store, run, facts.map(({ id }) => id))
  const journal = store.model.changes(run, ModelVersion.parse(0))
  store.close()

  store = home.open()
  const engine = startEngine(store, { all: true })
  const result = await engine.reparse()
  expect(result).toEqual({
    records: records.length,
    facts_added: 0,
    facts_kept: facts.length,
    facts_missing: 0,
    head: store.changes.head(),
  })
  for (const [seq, ids] of ordered) {
    expect(store.facts.ofRecord(seq).map(({ id }) => id)).toEqual(ids)
  }
  expect(store.model.changes(run, ModelVersion.parse(0))).toEqual(journal)
  expect(resolveEvidence(store.facts, modelEvidence(store))).toEqual(
    facts.map((fact) => ({ id: fact.id, state: 'available', fact })),
  )
  expect(observationsOf(store, key)).toEqual(observed)

  const again = await engine.reparse()
  expect(again).toEqual({
    records: factless.length,
    facts_added: 0,
    facts_kept: 0,
    facts_missing: 0,
    head: result.head,
  })
  expect((await engine.ingest(startHook(session))).duplicates).toBe(1)
  expect(store.changes.head()).toBe(result.head)
  store.close()

  store = home.open()
  expect(factsOf(store).toSorted(byId)).toEqual(facts.toSorted(byId))
  expect(observationsOf(store, key)).toEqual(observed)
})

test('shows a fact the current normalizer no longer produces as an unavailable basis and adds the facts it newly produces', async () => {
  const reference = await createHome(onTestFinished)
  const expected = reference.open()
  await startEngine(expected, { all: true }).ingest(sessionBatch())
  const facts = factsOf(expected)
  const agentStart = facts.find(({ kind }) => kind === 'agent_start')
  const message = facts.find(({ kind }) => kind === 'message')
  assert(agentStart?.entity_key.kind === 'agent' && agentStart.entity_key.agent.kind === 'subagent')
  assert(message !== undefined)
  const subagent = objectId(agentStart.entity_key)
  const previousAgent: AgentKey = {
    ...agentStart.entity_key,
    agent: { kind: 'subagent', agent_id: `${agentStart.entity_key.agent.agent_id}-previous` },
  }
  const observed = observationsOf(expected, key)

  const home = await createHome(onTestFinished)
  let store = home.open()
  const engine = startEngine(store, { all: true })
  const file = transcriptFile()
  await engine.ingest(joinBatches(hooks(), file.batch(1, file.lines.length - 1)))
  storeAnotherNormalizer(store, (drafts) =>
    drafts.map((draft) =>
      draft.kind === 'agent_start' ? FactDraft.parse({ ...draft, entity_key: previousAgent }) : draft,
    ),
  )
  store.transaction((transaction) => {
    for (const agent of observationsOf(store, key).agents) {
      transaction.observations.delete(agent)
    }
  })
  await engine.ingest(file.batch(file.lines.length, file.lines.length))
  const previousStart = factsOf(store).find(({ kind }) => kind === 'agent_start')
  assert(previousStart !== undefined)
  const current = factsOf(store).filter(({ normalizer_version }) => normalizer_version !== anotherVersion)
  const agents = observationsOf(store, key).agents.map(({ id }) => id)
  expect(agents).toContain(objectId(previousAgent))
  expect(agents).not.toContain(subagent)
  referenceFacts(store, run, [previousStart.id, message.id])
  const journal = store.model.changes(run, ModelVersion.parse(0))
  store.close()

  store = home.open()
  const result = await startEngine(store, { all: true }).reparse()
  expect(result).toMatchObject({
    facts_added: 1,
    facts_kept: facts.length - 1 - current.length,
    facts_missing: 1,
  })
  expect(factsOf(store).toSorted(byId)).toEqual(facts.toSorted(byId))
  expect(resolveEvidence(store.facts, modelEvidence(store))).toEqual([
    { id: previousStart.id, state: 'unavailable' },
    { id: message.id, state: 'available', fact: message },
  ])
  expect(store.model.changes(run, ModelVersion.parse(0))).toEqual(journal)
  expect(store.observations.getAgent(objectId(previousAgent))).toBeNull()
  expect(withoutChangeSeqs(observationsOf(store, key))).toEqual(withoutChangeSeqs(observed))
})

test('recounts the records the current normalizer recognises and closes their gap', async () => {
  const reference = await createHome(onTestFinished)
  const expected = reference.open()
  await startEngine(expected, { all: true }).ingest(sessionBatch())
  const observed = observationsOf(expected, key)
  const hookOnlyObserved = observationsOf(expected, sessionKey('claude', hookOnly))

  const home = await createHome(onTestFinished)
  let store = home.open()
  const engine = startEngine(store, { all: true })
  const file = transcriptFile()
  await engine.ingest(joinBatches(hooks(), file.batch(1, file.lines.length - 1)))
  const hookFacts = factsOf(store).filter(({ seq }) => store.rawRecords.get(seq)?.channel === 'hook')
  const rejected = hookFacts.filter(({ entity_key }) => entity_key.session === session).length
  storeAnotherNormalizer(store, (drafts, record) => (record.channel === 'hook' ? 'invalid' : drafts))
  store.transaction((transaction) => {
    for (const question of observationsOf(store, key).questions) {
      transaction.observations.delete(question)
    }
    const counted = transaction.observations.getSession(objectId(key))
    assert(counted !== null)
    transaction.observations.save({ ...counted, unknown_records: rejected })
  })
  await engine.ingest(file.batch(file.lines.length, file.lines.length))
  const gap = objectId({ kind: 'gap', gap: 'unknown_records', subject: objectId(key) })
  expect(rejected).toBeGreaterThan(0)
  expect(observationsOf(store, key).session?.unknown_records).toBe(rejected)
  expect(observationsOf(store, key).questions).toEqual([])
  expect(store.gaps.get(gap)).toMatchObject({ details: `${String(rejected)} unrecognised session records`, closed_at: null })
  store.close()

  store = home.open()
  const result = await startEngine(store, { all: true }).reparse()
  expect(result).toMatchObject({ facts_added: hookFacts.length, facts_missing: 0 })
  for (const { seq } of hookFacts) {
    expect(store.rawRecords.get(seq)).toMatchObject({ channel: 'hook', parse_state: 'parsed' })
  }
  expect(observationsOf(store, key).session?.unknown_records).toBe(0)
  expect(store.gaps.get(gap)?.closed_at).not.toBeNull()
  expect(withoutChangeSeqs(observationsOf(store, key))).toEqual(withoutChangeSeqs(observed))
  expect(withoutChangeSeqs(observationsOf(store, sessionKey('claude', hookOnly)))).toEqual(
    withoutChangeSeqs(hookOnlyObserved),
  )
})

test('keeps a session that only its unrecognised records support after its facts disappear', async () => {
  const future = sessionKey('claude', 'reparse-future')
  const home = await createHome(onTestFinished)
  let store = home.open()
  const lines = [JSON.stringify({ type: 'future_record', sessionId: future.session, cwd }), '{broken', '{broken again']
  await startEngine(store, { all: true }).ingest(
    jsonlFile({ runtime: 'claude', path: '/future.jsonl', lines, ino: 1n }).batch(1, lines.length),
  )
  const [record, ...broken] = recordsOf(store)
  const counted = store.observations.getSession(objectId(future))
  assert(record !== undefined && counted !== null)
  expect([record, ...broken].map(({ parse_state }) => parse_state)).toEqual(['unknown', 'invalid', 'invalid'])
  expect(counted.unknown_records).toBe(lines.length)
  const [start] = expectedOf(startHook(future.session).records).flatMap(({ facts }) => facts)
  assert(start !== undefined)
  store.transaction((transaction) => {
    transaction.facts.replace(record.seq, anotherVersion, [start])
    transaction.rawRecords.setParse(record.seq, 'parsed', record.observed_at)
    transaction.observations.save({ ...counted, unknown_records: broken.length })
  })
  store.close()

  store = home.open()
  const result = await startEngine(store, { all: true }).reparse()
  expect(result).toMatchObject({ records: lines.length, facts_added: 0, facts_kept: 0, facts_missing: 1 })
  expect(store.rawRecords.get(record.seq)).toMatchObject({ parse_state: 'unknown' })
  expect(store.facts.ofRecord(record.seq)).toEqual([])
  expect(store.observations.getSession(objectId(future))).toMatchObject({
    unknown_records: lines.length,
    support_mode: 'files_only',
  })
})

test('advances the change position when reparse only deletes facts and objects', async () => {
  const stale = sessionKey('claude', 'reparse-stale')
  const phantom = sessionKey('claude', 'reparse-phantom')
  const home = await createHome(onTestFinished)
  let store = home.open()
  await startEngine(store, { all: true }).ingest(sessionBatch())
  const facts = factsOf(store)
  const factless = recordsOf(store).filter(({ seq }) => store.facts.ofRecord(seq).length === 0)
  const record = factless.find(({ channel, parse_state }) => channel === 'transcript' && parse_state === 'parsed')
  const hookOnlyStart = facts.find(
    ({ kind, entity_key }) => kind === 'session_start' && entity_key.session === hookOnly,
  )
  const hookOnlySession = store.observations.getSession(objectId(sessionKey('claude', hookOnly)))
  assert(record !== undefined && hookOnlyStart !== undefined && hookOnlySession !== null)
  const sessions = store.observations.sessions()
  const unchanged = { records: factless.length, facts_added: 0, facts_kept: 0, facts_missing: 0 }
  store.transaction((transaction) => {
    transaction.observations.save({ ...hookOnlySession, id: objectId(stale), key: stale })
  })
  const staleHead = store.changes.head()
  store.close()

  store = home.open()
  const engine = startEngine(store, { all: true })
  const pruned = await engine.reparse()
  expect(pruned).toEqual({ ...unchanged, head: store.changes.head() })
  expect(pruned.head).toBeGreaterThan(staleHead)
  expect(store.changes.after(staleHead, everything)).toEqual([])
  expect(store.observations.sessions()).toEqual(sessions)

  store.transaction((transaction) => {
    transaction.facts.replace(record.seq, anotherVersion, [
      FactDraft.parse({
        ...draftOf(hookOnlyStart),
        entity_key: phantom,
        runtime_ids: { ...hookOnlyStart.runtime_ids, session_id: phantom.session },
      }),
    ])
    transaction.observations.save({ ...hookOnlySession, id: objectId(phantom), key: phantom })
  })
  expect(store.observations.getSession(objectId(phantom))).not.toBeNull()
  const head = store.changes.head()
  const result = await engine.reparse()
  expect(result).toEqual({ ...unchanged, facts_missing: 1, head: store.changes.head() })
  expect(result.head).toBeGreaterThan(head)
  expect(
    store.changes
      .after(head, everything)
      .map((change) => (change.layer === 'raw_record' ? [change.layer, change.record] : [change.layer])),
  ).toEqual([['raw_record', record]])
  expect(store.facts.ofRecord(record.seq)).toEqual([])
  expect(factsOf(store)).toEqual(facts)
  expect(store.observations.sessions()).toEqual(sessions)

  const again = await engine.reparse()
  expect(again).toEqual({ ...unchanged, head: result.head })
  expect(store.changes.after(ChangeSeq.parse(result.head), everything)).toEqual([])
})

test('resolves OTel decisions of known threads in one reparse and leaves one without a thread pending', async () => {
  const rejected = 'otel-rejected'
  const later = 'otel-later'
  const home = await createHome(onTestFinished)
  let store = home.open()
  const root = codexRollout({ thread: otelRoot, cwd }).slice(0, 1)
  const child = (thread: string) => codexChildRollout({ root: otelRoot, thread, cwd }).slice(0, 1)
  const rollout = (thread: string, ino: bigint) =>
    jsonlFile({ runtime: 'codex', path: `/${thread}.jsonl`, lines: child(thread), ino }).batch(1, 1)
  const resolved = decisionRecord()
  const unparsed = decisionRecord(rejected)
  const pending = decisionRecord(later)
  const malformed = { ...decisionRecord(), payload: 'not an OTel log record' }
  const engine = startEngine(store, { all: true })
  await engine.ingest(
    joinBatches(
      jsonlFile({ runtime: 'codex', path: '/root.jsonl', lines: root, ino: 1n }).batch(1, 1),
      rollout(otelThread, 2n),
      batchOf({ records: [resolved, unparsed, pending, malformed] }),
    ),
  )
  const seqOf = (record: CollectedRecord) => {
    const stored = recordsOf(store).find(({ dedupe_key }) => dedupe_key === codexAdapter.rawKey(record))
    assert(stored !== undefined)
    return stored.seq
  }
  storeAnotherNormalizer(store, (drafts, record) => (record.seq === seqOf(unparsed) ? 'invalid' : sameFacts(drafts, record)))
  await engine.ingest(rollout(rejected, 3n))
  const decisionId = (record: CollectedRecord, thread: string): FactId => {
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
      .sort()
  const otel = (record: CollectedRecord) => {
    const stored = store.rawRecords.get(seqOf(record))
    return stored === null ? null : { parse_state: stored.parse_state, stream: stored.stream }
  }
  expect(decisions()).toEqual([[decisionId(resolved, otelThread), anotherVersion]])
  expect(otel(unparsed)).toEqual({ parse_state: 'invalid', stream: null })
  const stored = factsOf(store).filter(({ normalizer_version }) => normalizer_version === anotherVersion)
  store.close()

  store = home.open()
  const reparsing = startEngine(store, { all: true })
  const result = await reparsing.reparse()
  expect(result).toMatchObject({ facts_added: 1, facts_kept: stored.length, facts_missing: 0 })
  expect(decisions()).toEqual(
    [
      [decisionId(resolved, otelThread), codexAdapter.normalizerVersion],
      [decisionId(unparsed, rejected), codexAdapter.normalizerVersion],
    ].sort(),
  )
  expect(otel(resolved)).toEqual({ parse_state: 'parsed', stream: streamOf('codex', child(otelThread)) })
  expect(otel(unparsed)).toEqual({ parse_state: 'parsed', stream: streamOf('codex', child(rejected)) })
  expect(otel(pending)).toEqual({ parse_state: 'unknown', stream: null })
  expect(otel(malformed)).toEqual({ parse_state: 'invalid', stream: null })
  const recovered = store.facts.get(decisionId(unparsed, rejected))
  assert(recovered?.kind === 'permission_decision' && recovered.entity_key.kind === 'action')
  expect(store.observations.getAction(objectId(recovered.entity_key))).toMatchObject({ tool: recovered.payload.tool })

  await reparsing.ingest(rollout(later, 4n))
  expect(decisions()).toEqual(
    [
      [decisionId(resolved, otelThread), codexAdapter.normalizerVersion],
      [decisionId(unparsed, rejected), codexAdapter.normalizerVersion],
      [decisionId(pending, later), codexAdapter.normalizerVersion],
    ].sort(),
  )
  expect(otel(pending)).toEqual({ parse_state: 'parsed', stream: streamOf('codex', child(later)) })
})

test('a SIGKILL during reparse leaves the stored state of the other normalizer version', async () => {
  const copies = 100
  const home = await createHome(onTestFinished)
  let store = home.open()
  await startEngine(store, { all: true }).ingest(
    joinBatches(
      ...Array.from({ length: copies }, (_, copy) => {
        const id = `${session}-${String(copy)}`
        const lines = claudeTranscript({ session: id, cwd })
        return jsonlFile({ runtime: 'claude', path: `/${id}.jsonl`, lines, ino: BigInt(copy + 1) }).batch(
          1,
          lines.length,
        )
      }),
    ),
  )
  const facts = factsOf(store)
  storeAnotherNormalizer(store, reversedFactGroups)
  const storedState = (stored: Store) => ({
    head: stored.changes.head(),
    records: recordsOf(stored),
    facts: factsOf(stored),
    sessions: stored.observations.sessions(),
  })
  const before = storedState(store)
  store.close()

  const reparsing = await home.startReparse()
  await reparsing.kill()

  store = home.open()
  expect(storedState(store)).toEqual(before)
  const result = await startEngine(store, { all: true }).reparse()
  expect(result).toMatchObject({ facts_added: 0, facts_kept: facts.length, facts_missing: 0 })
  expect(factsOf(store).toSorted(byId)).toEqual(facts.toSorted(byId))
  expect(store.observations.sessions().map(withoutChangeSeq)).toEqual(before.sessions.map(withoutChangeSeq))
})
