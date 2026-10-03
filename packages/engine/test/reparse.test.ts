import assert from 'node:assert/strict'
import { cp, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { codexAdapter } from '@aang/adapter-codex'
import {
  type AgentKey,
  type AttentionItem,
  ChangeSeq,
  CheckContract,
  type CollectedRecord,
  type Fact,
  FactDraft,
  type FactId,
  type Link,
  ModelVersion,
  type RunId,
  type SessionKey,
} from '@aang/contract'
import { factIds, objectId, runId } from '@aang/contract/ids'
import { applyChangeSet, createEngine, resolveEvidence } from '@aang/engine'
import type { Store } from '@aang/store'
import { expect, onTestFinished, test } from 'vitest'
import { anotherVersion, draftOf, reversedFactGroups, sameFacts, storeAnotherNormalizer } from './another-normalizer.js'
import { batchOf, hookBatch, joinBatches, jsonlFile } from './batches.js'
import { adapters, expectedOf, factsOf, recordsOf, removalsOf, sessionKey, startEngine, streamOf } from './harness.js'
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
  const current = store.model.entity(owner, { kind: 'run', id: owner })
  assert(goal !== undefined && current?.kind === 'run')
  const { runtime, root_session: root, brief, start_pruned: pruned, created_at: at } = current.value
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
              runtime,
              root_session: root,
              goal: { text: 'Reparse the transcript', fact: goal },
              brief,
              start_pruned: pruned,
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

const linksOf = (store: Store): Link[] =>
  store.model.entities(run).flatMap((entity) => (entity.kind === 'link' ? [entity.value] : []))

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
  const factById = new Map(facts.map((fact) => [fact.id, fact]))
  expect(modelEvidence(store)).toEqual(expect.arrayContaining(facts.map(({ id }) => id)))
  expect(resolveEvidence(store.facts, modelEvidence(store))).toEqual(
    modelEvidence(store).map((id) => ({ id, state: 'available', fact: factById.get(id) })),
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

test('shows a fact the current normalizer no longer produces as unavailable and replaces the agent it keyed', async () => {
  const reference = await createHome(onTestFinished)
  const expected = reference.open()
  await startEngine(expected, { all: true }).ingest(sessionBatch())
  const facts = factsOf(expected)
  const agentStart = facts.find(({ kind }) => kind === 'agent_start')
  const message = facts.find(({ kind }) => kind === 'message')
  const started = agentStart?.entity_key
  assert(agentStart !== undefined && started?.kind === 'agent' && started.agent.kind === 'subagent')
  assert(message !== undefined)
  const subagent = objectId(started)
  const { agent_id: agentId } = started.agent
  const renamed = (suffix: string): AgentKey => ({ ...started, agent: { kind: 'subagent', agent_id: `${agentId}-${suffix}` } })
  const previousAgent = renamed('previous')
  const replaced = renamed('replaced')
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
  const spawned = linksOf(store)
  expect(spawned.map(({ kind }) => kind)).toEqual(['spawn'])
  store.transaction((transaction) => {
    for (const agent of observationsOf(store, key).agents) {
      transaction.observations.delete(agent)
    }
    applyChangeSet(transaction, {
      run,
      author: 'rule',
      at: agentStart.at,
      changes: spawned.map(({ id }) => ({
        op: 'link.remove',
        remove: { kind: 'link', id },
        basis: { kind: 'observed' },
        evidence: [],
      })),
    })
  })
  await engine.ingest(file.batch(file.lines.length, file.lines.length))
  const previousStart = factsOf(store).find(({ kind }) => kind === 'agent_start')
  const previous = store.observations.getAgent(objectId(previousAgent))
  assert(previousStart !== undefined && previous !== null)
  store.transaction((transaction) => {
    transaction.observations.save({ ...previous, id: objectId(replaced), key: replaced })
    transaction.observations.remove({ kind: 'agent', id: objectId(replaced), replaced_by: previous.id })
  })
  const current = factsOf(store).filter(({ normalizer_version }) => normalizer_version !== anotherVersion)
  const agents = observationsOf(store, key).agents.map(({ id }) => id)
  expect(agents).toContain(previous.id)
  expect(agents).not.toContain(subagent)
  expect(linksOf(store)).toMatchObject([{ kind: 'spawn', child: previous.id }])
  referenceFacts(store, run, [previousStart.id, message.id])
  const journal = store.model.changes(run, ModelVersion.parse(0))
  const head = store.changes.head()
  store.close()

  store = home.open()
  const result = await startEngine(store, { all: true }).reparse()
  expect(result).toMatchObject({
    facts_added: 1,
    facts_kept: facts.length - 1 - current.length,
    facts_missing: 1,
  })
  expect(factsOf(store).toSorted(byId)).toEqual(facts.toSorted(byId))
  expect(resolveEvidence(store.facts, modelEvidence(store))).toEqual(
    modelEvidence(store).map((id) =>
      id === previousStart.id ? { id, state: 'unavailable' } : { id, state: 'available', fact: store.facts.get(id) },
    ),
  )
  expect(modelEvidence(store)).toEqual(expect.arrayContaining([previousStart.id, message.id]))
  expect(store.model.changes(run, ModelVersion.parse(0)).slice(0, journal.length)).toEqual(journal)
  const [spawn, ...links] = linksOf(store)
  assert(spawn?.kind === 'spawn' && spawn.child === subagent)
  expect(links).toEqual([])
  expect(spawn.evidence).toContain(agentStart.id)
  expect(
    store.model
      .changes(run, ModelVersion.parse(journal.at(-1)?.version ?? 0))
      .map(({ op, author, before, after, evidence }) => ({
        op,
        author,
        before: before?.kind,
        after: after?.kind,
        evidence,
      })),
  ).toEqual([
    { op: 'link.remove', author: 'rule', before: 'link', after: undefined, evidence: [agentStart.id] },
    { op: 'link.add', author: 'rule', before: undefined, after: 'link', evidence: spawn.evidence },
  ])
  expect(withoutChangeSeqs(observationsOf(store, key))).toEqual(withoutChangeSeqs(observed))
  const expectReplaced = (stored: Store) => {
    expect(stored.observations.getAgent(previous.id)).toBeNull()
    expect(stored.observations.getAgent(objectId(replaced))).toBeNull()
    expect(stored.observations.getRemoval({ kind: 'agent', id: previous.id })).toMatchObject({ replaced_by: subagent })
    expect(stored.observations.getRemoval({ kind: 'agent', id: objectId(replaced) })).toMatchObject({
      replaced_by: subagent,
    })
    for (const removal of removalsOf(stored)) {
      expect(stored.observations.getAgent(removal.replaced_by)).not.toBeNull()
      expect(removal.change_seq).toBeGreaterThan(head)
    }
    for (const link of linksOf(stored)) {
      const ends = link.kind === 'spawn' ? [link.parent, link.child] : link.kind === 'participation' ? [link.agent] : []
      for (const end of ends) {
        expect(stored.observations.getAgent(end)).not.toBeNull()
      }
    }
  }
  expectReplaced(store)
  store.close()

  store = home.open()
  expectReplaced(store)
  expect(withoutChangeSeqs(observationsOf(store, key))).toEqual(withoutChangeSeqs(observed))
})

test('deletes an agent whose facts the current normalizer splits between agents and names no replacement', async () => {
  const home = await createHome(onTestFinished)
  let store = home.open()
  const engine = startEngine(store, { all: true })
  const file = transcriptFile()
  await engine.ingest(joinBatches(hooks(), file.batch(1, file.lines.length - 1)))
  const agents = observationsOf(store, key).agents
  const facts = factsOf(store)
  const started = facts.find(({ kind }) => kind === 'agent_start')?.entity_key
  const call = facts.find(({ kind }) => kind === 'action_start')
  assert(started?.kind === 'agent' && call !== undefined)
  const merged: AgentKey = { ...started, agent: { kind: 'subagent', agent_id: 'reparse-merged' } }
  storeAnotherNormalizer(store, (drafts, record) =>
    drafts.map((draft) =>
      draft.kind === 'agent_start'
        ? FactDraft.parse({ ...draft, entity_key: merged })
        : record.seq === call.seq
          ? FactDraft.parse({ ...draft, runtime_ids: { ...draft.runtime_ids, agent_id: 'reparse-merged' } })
          : draft,
    ),
  )
  await engine.ingest(file.batch(file.lines.length, file.lines.length))
  expect(store.observations.getAgent(objectId(merged))).toMatchObject({ role: 'subagent' })
  store.close()

  store = home.open()
  await startEngine(store, { all: true }).reparse()
  expect(store.observations.getAgent(objectId(merged))).toBeNull()
  expect(removalsOf(store)).toEqual([])
  expect(observationsOf(store, key).agents.map(withoutChangeSeq)).toEqual(agents.map(withoutChangeSeq))
})

test('refuses a reparse that would delete the replacement of removed agents when no agent of its session replaces it', async () => {
  const home = await createHome(onTestFinished)
  let store = home.open()
  await startEngine(store, { all: true }).ingest(sessionBatch())
  const subagent = store.observations.agents(objectId(key)).find(({ role }) => role === 'subagent')
  const hookSession = store.observations.getSession(objectId(sessionKey('claude', hookOnly)))
  assert(subagent?.key.agent.kind === 'subagent' && hookSession !== null)
  const strayKey = (suffix: string): AgentKey => ({
    ...subagent.key,
    session: hookOnly,
    agent: { kind: 'subagent', agent_id: `reparse-${suffix}` },
  })
  const stray = strayKey('stray')
  const replaced = strayKey('replaced')
  storeAnotherNormalizer(store, (drafts) =>
    drafts.map((draft) => (draft.kind === 'agent_start' ? FactDraft.parse({ ...draft, entity_key: stray }) : draft)),
  )
  store.transaction((transaction) => {
    const moved = { ...subagent, session: hookSession.id, run: hookSession.run, parent: null, spawned_by: null }
    transaction.observations.save({ ...moved, id: objectId(stray), key: stray })
    transaction.observations.save({ ...moved, id: objectId(replaced), key: replaced })
    transaction.observations.remove({ kind: 'agent', id: objectId(replaced), replaced_by: objectId(stray) })
  })
  const stateOf = (state: Store) => ({
    head: state.changes.head(),
    facts: factsOf(state),
    observed: [observationsOf(state, key), observationsOf(state, sessionKey('claude', hookOnly))],
    removals: removalsOf(state),
  })
  const before = stateOf(store)
  expect(before.removals).toMatchObject([{ id: objectId(replaced), replaced_by: objectId(stray) }])
  store.close()

  store = home.open()
  await expect(startEngine(store, { all: true }).reparse()).rejects.toThrow(
    `agent ${objectId(stray)} replaces removed observations`,
  )
  expect(stateOf(store)).toEqual(before)
  store.close()

  store = home.open()
  expect(stateOf(store)).toEqual(before)
})

interface CheckSource {
  readonly session: string
  readonly cwd: string
}

const checkProject = async (home: { readonly path: string }): Promise<string> => {
  const project = join(home.path, '..', 'project')
  await mkdir(project, { recursive: true })
  return project
}

const checkEngine = (store: Store, project: string) =>
  createEngine({
    store,
    adapters,
    watch: {
      all: true,
      roots: [{ path: project, contracts: [CheckContract.parse({ name: 'test', command: '^pnpm test' })] }],
    },
  })

const checkRun = (source: CheckSource): RunId => runId(sessionKey('claude', source.session))

const checkAction = (source: CheckSource, call: string) =>
  objectId({ kind: 'action', runtime: 'claude', session: source.session, call })

const checkStart = (source: CheckSource) => ({
  file: `${source.session}-start.evt`,
  payload: claudeHook('SessionStart.startup.json', source),
})

const check = (source: CheckSource, call: string, passed: boolean, arrival: number) => {
  const tool = { tool_use_id: call, tool_input: { command: 'pnpm test', description: 'Run the check' } }
  return [
    { file: `${source.session}-${call}-pre.evt`, payload: claudeHook('PreToolUse.Bash.json', source, tool), arrival },
    {
      file: `${source.session}-${call}-post.evt`,
      arrival: arrival + 1,
      payload: passed
        ? claudeHook('PostToolUse.Bash.json', source, tool)
        : claudeHook('PostToolUseFailure.Bash.json', source, {
            ...tool,
            error: 'Exit code 1\nchecks failed',
            is_interrupt: false,
          }),
    },
  ]
}

const failedChecks = (state: Store, owner: RunId) =>
  state.model
    .entities(owner)
    .flatMap(({ kind, value }) => (kind === 'attention_item' && value.kind === 'failed_check' ? [value] : []))

const endOf = (ends: readonly Fact[], source: CheckSource, call: string) =>
  ends.find(
    ({ entity_key: entity }) => entity.kind === 'action' && entity.session === source.session && entity.call === call,
  )

test('applies the failed check rule to a failure and its successful repeat that one reparse recovers', async () => {
  const home = await createHome(onTestFinished)
  const project = await checkProject(home)
  const failing = { session: 'reparse-failing', cwd: project }
  const repaired = { session: 'reparse-repaired', cwd: project }
  let store = home.open()
  await startEngine(store, { all: true }).ingest(
    hookBatch(
      checkStart(failing),
      ...check(failing, 'call-fail', false, 10),
      checkStart(repaired),
      ...check(repaired, 'call-fail', false, 20),
      ...check(repaired, 'call-pass', true, 30),
    ),
  )
  const ends = factsOf(store).filter(({ kind }) => kind === 'action_end')
  expect(ends).toHaveLength(3)
  storeAnotherNormalizer(store, (drafts) => (drafts.some(({ kind }) => kind === 'action_end') ? 'invalid' : drafts))
  expect(failedChecks(store, checkRun(failing))).toEqual([])
  expect(failedChecks(store, checkRun(repaired))).toEqual([])
  store.close()

  store = home.open()
  const engine = checkEngine(store, project)
  const result = await engine.reparse()
  expect(result).toMatchObject({ facts_added: ends.length, facts_missing: 0 })
  expect(store.observations.getAction(checkAction(failing, 'call-fail'))?.execution.state).toBe('failed')
  expect(failedChecks(store, checkRun(failing))).toMatchObject([
    {
      action: checkAction(failing, 'call-fail'),
      text: 'Check "test" failed with exit code 1',
      resolution: 'open',
      opened_at: endOf(ends, failing, 'call-fail')?.at,
      closed_at: null,
    },
  ])
  const [closed] = failedChecks(store, checkRun(repaired))
  expect(closed).toMatchObject({
    action: checkAction(repaired, 'call-fail'),
    resolution: 'answered',
    opened_at: endOf(ends, repaired, 'call-fail')?.at,
    closed_at: endOf(ends, repaired, 'call-pass')?.at,
  })
  assert(closed !== undefined)
  expect(
    store.model
      .entityChanges(checkRun(repaired), { kind: 'attention_item', id: closed.id }, ModelVersion.parse(0))
      .map(({ op, author }) => [op, author]),
  ).toEqual([
    ['attention.open', 'rule'],
    ['attention.close', 'rule'],
  ])
  expect((await engine.reparse()).head).toBe(result.head)
})

test('closes the open failed checks of actions that one reparse finds successful under the same fact ids', async () => {
  const home = await createHome(onTestFinished)
  const project = await checkProject(home)
  const misread = { session: 'reparse-misread', cwd: project }
  const shifted = { session: 'reparse-shifted', cwd: project }
  let store = home.open()
  await startEngine(store, { all: true }).ingest(
    hookBatch(
      checkStart(misread),
      ...check(misread, 'call-pass', true, 10),
      checkStart(shifted),
      ...check(shifted, 'call-pass', true, 20),
      ...check(shifted, 'call-fail', false, 30),
    ),
  )
  const ends = factsOf(store).filter(({ kind }) => kind === 'action_end')
  const passOf = (source: CheckSource) => {
    const end = endOf(ends, source, 'call-pass')
    assert(end !== undefined)
    return end
  }
  const evidenceOf = (state: Store, source: CheckSource) =>
    factsOf(state)
      .filter(
        ({ kind, entity_key: entity }) =>
          (kind === 'action_start' || kind === 'action_end') &&
          entity.kind === 'action' &&
          entity.session === source.session &&
          entity.call === 'call-pass',
      )
      .map(({ id }) => id)
      .sort()
  storeAnotherNormalizer(store, (drafts) =>
    drafts.map((draft) =>
      draft.kind === 'action_end' && draft.entity_key.kind === 'action' && draft.entity_key.call === 'call-pass'
        ? FactDraft.parse({ ...draft, payload: { ...draft.payload, outcome: 'error', exit_code: 1 } })
        : draft,
    ),
  )
  await checkEngine(store, project).ingest(
    hookBatch(
      { file: 'misread-stop.evt', payload: claudeHook('Stop.json', misread), arrival: 40 },
      { file: 'shifted-stop.evt', payload: claudeHook('Stop.json', shifted), arrival: 41 },
    ),
  )
  expect(store.observations.getAction(checkAction(misread, 'call-pass'))?.execution.state).toBe('failed')
  const [falseFailure] = failedChecks(store, checkRun(misread))
  expect(falseFailure).toMatchObject({
    action: checkAction(misread, 'call-pass'),
    text: 'Check "test" failed with exit code 1',
    resolution: 'open',
    opened_at: passOf(misread).at,
  })
  const [shiftedFailure] = failedChecks(store, checkRun(shifted))
  expect(failedChecks(store, checkRun(shifted))).toMatchObject([
    { action: checkAction(shifted, 'call-fail'), resolution: 'open', opened_at: passOf(shifted).at },
  ])
  assert(falseFailure !== undefined && shiftedFailure !== undefined)
  store.close()

  store = home.open()
  const engine = checkEngine(store, project)
  const result = await engine.reparse()
  expect(result).toMatchObject({ facts_added: 0, facts_missing: 0 })
  expect(store.observations.getAction(checkAction(misread, 'call-pass'))?.execution.state).toBe('done')
  const corrected = (state: Store) => ({
    misread: failedChecks(state, checkRun(misread)),
    shifted: failedChecks(state, checkRun(shifted)).toSorted((left, right) =>
      left.opened_at < right.opened_at ? -1 : 1,
    ),
  })
  const closedBy = (item: AttentionItem, source: CheckSource) => ({
    ...item,
    resolution: 'answered',
    closed_at: passOf(source).at,
    change_seq: expect.any(Number) as unknown,
  })
  expect(corrected(store)).toEqual({
    misread: [closedBy(falseFailure, misread)],
    shifted: [
      closedBy(shiftedFailure, shifted),
      expect.objectContaining({
        action: checkAction(shifted, 'call-fail'),
        resolution: 'open',
        opened_at: endOf(ends, shifted, 'call-fail')?.at,
        closed_at: null,
      }),
    ],
  })
  for (const [source, item] of [
    [misread, falseFailure],
    [shifted, shiftedFailure],
  ] as const) {
    expect(
      store.model
        .entityChanges(checkRun(source), { kind: 'attention_item', id: item.id }, ModelVersion.parse(0))
        .map(({ op, author, evidence }) => [op, author, evidence]),
    ).toEqual([
      ['attention.open', 'rule', item.evidence],
      ['attention.close', 'rule', evidenceOf(store, source)],
    ])
  }
  const after = corrected(store)
  expect((await engine.reparse()).head).toBe(result.head)
  store.close()

  store = home.open()
  expect(corrected(store)).toEqual(after)
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
  const agents = store.observations.agents(objectId(key))
  const [known] = agents
  assert(known !== undefined)
  const staleAgent: AgentKey = { ...known.key, agent: { kind: 'subagent', agent_id: 'reparse-stale' } }
  const unchanged = { records: factless.length, facts_added: 0, facts_kept: 0, facts_missing: 0 }
  store.transaction((transaction) => {
    transaction.observations.save({ ...hookOnlySession, id: objectId(stale), key: stale })
    transaction.observations.save({ ...known, id: objectId(staleAgent), key: staleAgent })
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
  expect(store.observations.agents(objectId(key))).toEqual(agents)

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

test('a SIGKILL during reparse leaves either the stored state of the other normalizer version or the reparsed one', async () => {
  const copies = 20
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
  const stateOf = (stored: Store) => ({ head: stored.changes.head(), facts: factsOf(stored) })
  const before = stateOf(store)
  store.close()
  const reference = await createHome(onTestFinished)
  await cp(home.path, reference.path, { recursive: true })
  const expected = reference.open()
  await startEngine(expected, { all: true }).reparse()
  const reparsed = stateOf(expected)
  expect(new Set(reparsed.facts.map(({ normalizer_version }) => normalizer_version))).toEqual(
    new Set([codexAdapter.normalizerVersion]),
  )

  const reparsing = await home.startReparse()
  await reparsing.kill()

  store = home.open()
  expect([before, reparsed]).toContainEqual(stateOf(store))
  await startEngine(store, { all: true }).reparse()
  expect(stateOf(store)).toEqual(reparsed)
  expect(factsOf(store).toSorted(byId)).toEqual(facts.toSorted(byId))
}, 120_000)
