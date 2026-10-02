import {
  type Action,
  ActionId,
  ArtifactVersionId,
  type EpochNs,
  type Fact,
  JsonValue,
  ObserverCallId,
  type ObserverInput,
  type ObserverMaterial,
  type ObserverNeed,
  type RawRecord,
  RawSeq,
} from '@aang/contract'
import { objectId } from '@aang/contract/ids'
import {
  applyChangeSet,
  applyObserverResponse,
  beginObserverCall,
  beginObserverFollowUp,
  inputScope,
  type InputScopeOptions,
  resolveObserverNeeds,
} from '@aang/engine'
import type { Store } from '@aang/store'
import { expect, test, type TestContext } from 'vitest'
import { hookBatch, jsonlFile } from './batches.js'
import { factsOf, recordsOf } from './harness.js'
import { at, observed, put, runA, sessionA, sessionB } from './model.js'
import { callId, createStage, inputFor, setupObserver } from './observer-fixtures.js'
import { claudeHook, claudeTranscript, codexRollout } from './samples.js'

type JsonObject = { readonly [key: string]: JsonValue }

const followUpId = ObserverCallId.parse('follow-up-call')
const thirdCall = ObserverCallId.parse('third-call')
const codexThread = '01a0f75c-0000-7000-8000-00000000c0de'
const codexSession = objectId({ kind: 'session', runtime: 'codex', session: codexThread })
const batchOnlyAction = objectId({
  kind: 'action',
  runtime: 'claude',
  session: 'session-a',
  call: 'toolu_01MH1t1W3xdWEY6B3Kthd9Aw',
})

const secrets = {
  thinking: 'PRIVATE-CLAUDE-THINKING',
  redacted: 'PRIVATE-CLAUDE-REDACTED',
  summary: 'PRIVATE-CODEX-SUMMARY',
  reasoning: 'PRIVATE-CODEX-REASONING',
}

const thinkingBlocks = [
  { type: 'thinking', thinking: secrets.thinking, signature: 'signature' },
  { type: 'redacted_thinking', data: secrets.redacted },
]

const reasoningItem = {
  type: 'reasoning',
  id: 'rs_private',
  summary: [{ type: 'summary_text', text: secrets.summary }],
  content: [{ type: 'reasoning_text', text: secrets.reasoning }],
  encrypted_content: 'gAAAAprivate',
}

const objectOf = (text: string): JsonObject => {
  const value = JsonValue.parse(JSON.parse(text))
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('expected a JSON object')
  }
  return value
}

const membersOf = (value: JsonValue | undefined): JsonObject => objectOf(JSON.stringify(value ?? null))

const listOf = (value: JsonValue | undefined): JsonValue[] => {
  if (!Array.isArray(value)) {
    throw new Error('expected a JSON array')
  }
  return value
}

const withThinking = (line: string): string => {
  const record = objectOf(line)
  const message = membersOf(record['message'])
  return JSON.stringify({
    ...record,
    uuid: 'thinking-line',
    parentUuid: record['uuid'] ?? null,
    message: { ...message, id: 'msg_thinking', content: [...thinkingBlocks, ...listOf(message['content'])] },
  })
}

const withReasoning = (line: string): string => {
  const record = objectOf(line)
  const payload = membersOf(record['payload'])
  return JSON.stringify({
    ...record,
    payload: { ...payload, replacement_history: [reasoningItem, ...listOf(payload['replacement_history'])] },
  })
}

const recordWith = (store: Store, marker: string): RawRecord => {
  const record = recordsOf(store).find(({ payload }) => payload.includes(marker))
  if (record === undefined) {
    throw new Error(`no raw record contains ${marker}`)
  }
  return record
}

const completedAction = (store: Store, session: typeof sessionA): Action => {
  const action = store.observations
    .actions(session)
    .find(({ input_fact, output_fact }) => input_fact !== null && output_fact !== null)
  if (action === undefined) {
    throw new Error('the session must contain a completed action')
  }
  return action
}

const factOf = (store: Store, id: Fact['id'] | null): Fact => {
  const fact = id === null ? null : store.facts.get(id)
  if (fact === null) {
    throw new Error('the fact must exist')
  }
  return fact
}

const setupNeeds = async (onTestFinished: TestContext['onTestFinished']) => {
  const observer = await setupObserver(onTestFinished)
  const { home, store, engine } = observer
  const claudeLines = claudeTranscript({ session: 'session-a', cwd: home.path })
  const assistantText = claudeLines[31] ?? ''
  const claudeAll = [...claudeLines, withThinking(assistantText)]
  const claude = jsonlFile({ runtime: 'claude', path: `${home.path}/session-a.jsonl`, lines: claudeAll, ino: 10n })
  await engine.ingest(claude.batch(claudeLines.length + 1, claudeAll.length))
  await engine.ingest(
    hookBatch({
      file: 'tool-batch.evt',
      payload: claudeHook('PostToolBatch.json', { session: 'session-a', cwd: home.path }),
    }),
  )
  const codexLines = codexRollout({ thread: codexThread, cwd: home.path }).map((line, index) =>
    index === 24 ? withReasoning(line) : line,
  )
  const codex = jsonlFile({ runtime: 'codex', path: `${home.path}/rollout.jsonl`, lines: codexLines, ino: 11n })
  await engine.ingest(codex.batch(1, codexLines.length))
  store.transaction((transaction) => {
    applyChangeSet(transaction, {
      run: runA,
      author: 'rule',
      at: at(3),
      changes: [
        put('session.move', { kind: 'session_membership', value: { run: runA, session: codexSession } }, observed, []),
      ],
    })
    const session = transaction.observations.getSession(codexSession)
    if (session === null) {
      throw new Error('the rollout must create a codex session')
    }
    transaction.observations.save({ ...session, run: runA })
  })
  const thinkingRecord = recordWith(store, 'thinking-line')
  const compactionRecord = recordWith(store, 'rs_private')
  const foreignRecord = recordsOf(store).find(
    ({ seq }) => store.facts.ofRecord(seq).some(({ entity_key }) => entity_key.session === 'session-b'),
  )
  const factlessRecord = recordsOf(store).find(
    ({ seq, payload }) => payload.includes('"session-a"') && store.facts.ofRecord(seq).length === 0,
  )
  const codexFacts = factsOf(store).filter(({ entity_key }) => entity_key.runtime === 'codex')
  if (foreignRecord === undefined || factlessRecord === undefined || codexFacts.length === 0) {
    throw new Error('the samples must contain foreign, factless and codex records')
  }
  return {
    ...observer,
    thinkingRecord,
    compactionRecord,
    foreignRecord,
    factlessRecord,
    codexFacts,
    claudeAction: completedAction(store, sessionA),
    foreignAction: completedAction(store, sessionB),
    codexAction: completedAction(store, codexSession),
  }
}

const iso = (time: EpochNs | null): string | null =>
  time === null ? null : new Date(Number(time / 1_000_000n)).toISOString()

const respond = (store: Store, call: ObserverCallId, output: unknown, second: number) =>
  store.transaction((transaction) => applyObserverResponse(transaction, { call, output, at: at(second) }))

const followUp = (store: Store, previous = callId, id = followUpId, crossVendor = false): ObserverInput =>
  store.transaction((transaction) =>
    beginObserverFollowUp(transaction, { previous, id, at: at(21), crossVendor }),
  )

const queue = (store: Store) =>
  store.interpretations.ofRun(runA).map(({ status, attempts, observer_call }) => [status, attempts, observer_call])

const outcomes = (materials: readonly ObserverMaterial[]) =>
  materials.map((material) => (material.kind === 'unavailable' ? material.reason : material.kind))

const resolve = (store: Store, options: Omit<InputScopeOptions, 'run'>, needs: ObserverNeed[]) =>
  resolveObserverNeeds(store, inputScope(store, { run: runA, ...options }), needs, { needs: 16, textLength: 100_000 })

const stripped = (payload: string, key: 'message' | 'payload', field: 'content' | 'replacement_history') => {
  const record = objectOf(payload)
  const container = membersOf(record[key])
  const items = listOf(container[field]).filter(
    (item) => !['thinking', 'redacted_thinking', 'reasoning'].includes(membersOf(item)['type'] as string),
  )
  return { ...record, [key]: { ...container, [field]: items } }
}

test('a response with needs changes nothing and gets exactly one follow-up on the same snapshot and batch', async ({
  onTestFinished,
}) => {
  const { store, solver, human, tool, begin, thinkingRecord, claudeAction } = await setupNeeds(onTestFinished)
  const input = begin([solver, human, tool])
  const base = input.model.version
  const needs: ObserverNeed[] = [
    { kind: 'raw_record', seq: thinkingRecord.seq },
    { kind: 'action', action: claudeAction.id },
  ]
  const changes = store.changes.head()
  expect(respond(store, callId, { base_version: base, ops: [createStage([solver.id])], needs }, 20)).toEqual({
    status: 'needs_requested',
  })
  expect(store.model.head(runA)).toBe(base)
  expect(store.model.changes(runA, base)).toEqual([])
  expect(store.observerCalls.get(callId)).toMatchObject({ verdict: 'needs_requested', reasons: [] })
  expect(store.changes.head()).toBeGreaterThan(changes)
  expect(queue(store)).toEqual(Array.from({ length: 3 }, () => ['in_call', 1, callId]))

  const second = followUp(store)
  expect(second).toEqual({ ...input, materials: second.materials })
  const start = factOf(store, claudeAction.input_fact)
  const end = factOf(store, claudeAction.output_fact)
  expect(second.materials).toEqual([
    {
      kind: 'raw_record',
      seq: thinkingRecord.seq,
      channel: 'transcript',
      observed_at: iso(thinkingRecord.observed_at),
      payload: JSON.stringify(stripped(thinkingRecord.payload, 'message', 'content')),
      truncated: null,
    },
    {
      kind: 'action',
      action: claudeAction.id,
      tool: claudeAction.tool,
      action_kind: claudeAction.action_kind,
      agent: claudeAction.agent,
      started_at: iso(claudeAction.started_at),
      ended_at: iso(claudeAction.ended_at),
      outcome: claudeAction.outcome?.value ?? null,
      input: start.kind === 'action_start' ? start.payload.input : null,
      output: end.kind === 'action_end' ? end.payload.output : null,
      truncated: [],
    },
  ])
  expect(store.observerCalls.get(followUpId)).toMatchObject({
    run: runA,
    backend: 'claude',
    base_version: base,
    input: second,
    verdict: null,
  })
  expect(queue(store)).toEqual(Array.from({ length: 3 }, () => ['in_call', 1, followUpId]))

  expect(respond(store, followUpId, { base_version: base, ops: [createStage([solver.id])], needs }, 30)).toEqual({
    status: 'accepted',
    version: base + 1,
  })
  expect(queue(store)).toEqual(Array.from({ length: 3 }, () => ['interpreted', 1, followUpId]))
  expect(() => followUp(store, followUpId, thirdCall)).toThrow('did not request materials')
  expect(() => followUp(store, callId, thirdCall)).toThrow('no longer owns its batch')
  expect(store.observerCalls.get(thirdCall)).toBeNull()
})

test('a rejected follow-up returns the batch to the queue without spending an extra attempt', async ({
  onTestFinished,
}) => {
  const { store, solver, human, begin, claudeAction } = await setupNeeds(onTestFinished)
  const input = begin([solver, human])
  const base = input.model.version
  respond(store, callId, { base_version: base, ops: [], needs: [{ kind: 'action', action: claudeAction.id }] }, 20)
  followUp(store)
  expect(respond(store, followUpId, { base_version: base - 1, ops: [], needs: [] }, 30)).toMatchObject({
    status: 'rejected',
    rejections: [{ cause: 'version' }],
  })
  expect(queue(store)).toEqual(Array.from({ length: 2 }, () => ['pending', 1, followUpId]))
  begin([solver, human], thirdCall)
  expect(queue(store)).toEqual(Array.from({ length: 2 }, () => ['in_call', 2, thirdCall]))
})

test('a restart between the request and the follow-up returns the batch to the queue', async ({
  onTestFinished,
}) => {
  const { home, store, solver, begin, claudeAction } = await setupNeeds(onTestFinished)
  const input = begin([solver])
  respond(
    store,
    callId,
    { base_version: input.model.version, ops: [], needs: [{ kind: 'action', action: claudeAction.id }] },
    20,
  )
  store.close()
  const restarted = home.open()
  expect(queue(restarted)).toEqual([['pending', 1, null]])
  expect(() => followUp(restarted)).toThrow('no longer owns its batch')
  expect(restarted.observerCalls.get(followUpId)).toBeNull()
})

test('needs outside the run, from another vendor or of unknown objects are not executed', async ({
  onTestFinished,
}) => {
  const setup = await setupNeeds(onTestFinished)
  const { store, solver, begin } = setup
  const needs: ObserverNeed[] = [
    { kind: 'raw_record', seq: setup.foreignRecord.seq },
    { kind: 'action', action: setup.foreignAction.id },
    { kind: 'raw_record', seq: setup.compactionRecord.seq },
    { kind: 'action', action: setup.codexAction.id },
    { kind: 'raw_record', seq: setup.factlessRecord.seq },
    { kind: 'raw_record', seq: RawSeq.parse(999_999) },
    { kind: 'action', action: ActionId.parse('0'.repeat(32)) },
    { kind: 'artifact_version', version: ArtifactVersionId.parse('f'.repeat(32)) },
    { kind: 'context', seq: setup.thinkingRecord.seq },
  ]
  const reasons = [
    'out_of_scope',
    'out_of_scope',
    'cross_vendor',
    'cross_vendor',
    'out_of_scope',
    'not_found',
    'not_found',
    'not_found',
    'not_found',
  ]
  const unavailable = needs.map((request, index) => ({ kind: 'unavailable', request, reason: reasons[index] }))
  expect(resolve(store, { backend: 'claude', crossVendor: false }, needs)).toEqual(unavailable)

  const input = begin([solver])
  respond(store, callId, { base_version: input.model.version, ops: [], needs }, 20)
  const second = followUp(store, callId, followUpId, false)
  expect(second.materials).toEqual(unavailable.slice(0, 8))
  const sent = JSON.stringify(store.observerCalls.get(followUpId)?.input)
  for (const record of [setup.foreignRecord, setup.compactionRecord, setup.factlessRecord]) {
    expect(sent).not.toContain(record.payload)
  }
  expect(sent).not.toContain(secrets.summary)
})

test('the backend vendor and crossVendor decide which sessions of the run are transferred', async ({
  onTestFinished,
}) => {
  const setup = await setupNeeds(onTestFinished)
  const { store, solver, codexFacts, thinkingRecord, claudeAction, compactionRecord, codexAction } = setup
  const claudeNeeds: ObserverNeed[] = [
    { kind: 'raw_record', seq: thinkingRecord.seq },
    { kind: 'action', action: claudeAction.id },
  ]
  const codexNeeds: ObserverNeed[] = [
    { kind: 'raw_record', seq: compactionRecord.seq },
    { kind: 'action', action: codexAction.id },
  ]
  const kinds = (options: Omit<InputScopeOptions, 'run'>) =>
    outcomes(resolve(store, options, [...claudeNeeds, ...codexNeeds]))
  expect(kinds({ backend: 'claude', crossVendor: false })).toEqual([
    'raw_record',
    'action',
    'cross_vendor',
    'cross_vendor',
  ])
  expect(kinds({ backend: 'codex', crossVendor: false })).toEqual([
    'cross_vendor',
    'cross_vendor',
    'raw_record',
    'action',
  ])
  expect(kinds({ backend: 'codex', crossVendor: true })).toEqual(['raw_record', 'action', 'raw_record', 'action'])

  const mixed = inputFor(store, [solver, ...codexFacts.slice(0, 1)])
  const start = (backend: 'claude' | 'codex', crossVendor: boolean, input = mixed) => {
    store.transaction((transaction) => {
      beginObserverCall(transaction, { id: callId, backend, crossVendor, input, at: at(10) })
    })
  }
  expect(() => {
    start('claude', false)
  }).toThrow('vendor other than backend claude')
  expect(() => {
    start('codex', false)
  }).toThrow('vendor other than backend codex')
  expect(() => {
    start('codex', false, inputFor(store, codexFacts.slice(0, 1)))
  }).not.toThrow()
  expect(store.observerCalls.get(callId)?.backend).toBe('codex')
  const base = store.observerCalls.get(callId)?.base_version
  respond(store, callId, { base_version: base, ops: [], needs: [...claudeNeeds, ...codexNeeds] }, 20)
  expect(outcomes(followUp(store).materials)).toEqual([
    'cross_vendor',
    'cross_vendor',
    'raw_record',
    'action',
  ])
  expect(store.observerCalls.get(followUpId)?.backend).toBe('codex')
})

test('thinking and reasoning blocks never reach the observer input', async ({ onTestFinished }) => {
  const { store, solver, begin, thinkingRecord, compactionRecord } = await setupNeeds(onTestFinished)
  for (const secret of Object.values(secrets)) {
    expect(recordsOf(store).some(({ payload }) => payload.includes(secret))).toBe(true)
  }
  const input = begin([solver])
  const needs: ObserverNeed[] = [
    { kind: 'raw_record', seq: thinkingRecord.seq },
    { kind: 'raw_record', seq: compactionRecord.seq },
  ]
  respond(store, callId, { base_version: input.model.version, ops: [], needs }, 20)
  const second = followUp(store, callId, followUpId, true)
  const payloads = second.materials.map((material) =>
    material.kind === 'raw_record' ? objectOf(material.payload) : null,
  )
  expect(payloads).toEqual([
    stripped(thinkingRecord.payload, 'message', 'content'),
    stripped(compactionRecord.payload, 'payload', 'replacement_history'),
  ])
  const sent = JSON.stringify(store.observerCalls.get(followUpId)?.input)
  for (const secret of Object.values(secrets)) {
    expect(sent).not.toContain(secret)
  }
  expect(sent).toContain(JSON.stringify(objectOf(thinkingRecord.payload)['uuid']).slice(1, -1))
})

test('needs are deduplicated, capped and truncated with the original length', async ({ onTestFinished }) => {
  const { store, thinkingRecord, claudeAction } = await setupNeeds(onTestFinished)
  const scope = inputScope(store, { run: runA, backend: 'claude', crossVendor: false })
  const action: ObserverNeed = { kind: 'action', action: claudeAction.id }
  const record: ObserverNeed = { kind: 'raw_record', seq: thinkingRecord.seq }
  const materials = resolveObserverNeeds(
    store,
    scope,
    [action, { ...action }, record, { kind: 'raw_record', seq: RawSeq.parse(999_999) }],
    { needs: 2, textLength: 1 },
  )
  expect(materials.map(({ kind }) => kind)).toEqual(['action', 'raw_record'])
  const [actionMaterial, recordMaterial] = materials
  const payload = JSON.stringify(stripped(thinkingRecord.payload, 'message', 'content'))
  expect(recordMaterial).toMatchObject({
    payload: payload.slice(0, 1),
    truncated: { path: 'payload', length: payload.length },
  })
  if (actionMaterial?.kind !== 'action') {
    throw new Error('the first material must describe the action')
  }
  const start = factOf(store, claudeAction.input_fact)
  const end = factOf(store, claudeAction.output_fact)
  const originalOutput = end.kind === 'action_end' ? (end.payload.output ?? '') : ''
  const originalInput = start.kind === 'action_start' ? membersOf(start.payload.input) : {}
  const longInputs = Object.entries(originalInput).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 1,
  )
  expect(longInputs.length).toBeGreaterThan(0)
  expect(actionMaterial.output).toBe(originalOutput.slice(0, 1))
  expect(actionMaterial.truncated).toEqual([
    ...longInputs.map(([key, value]) => ({ path: `input.${key}`, length: value.length })),
    { path: 'output', length: originalOutput.length },
  ])
  expect(() => resolveObserverNeeds(store, scope, [action], { needs: 0, textLength: 1 })).toThrow(
    'positive integers',
  )
})

test('an action keeps its structured input and an output known only from its tool batch', async ({
  onTestFinished,
}) => {
  const { store } = await setupNeeds(onTestFinished)
  const agent = store.observations.actions(sessionA).find(({ tool }) => tool === 'Agent')
  if (agent === undefined) {
    throw new Error('the transcript must contain an Agent action')
  }
  const start = factOf(store, agent.input_fact)
  expect(store.observations.getAction(batchOnlyAction)).toMatchObject({ input_fact: null })
  expect(
    resolve(store, { backend: 'claude', crossVendor: false }, [
      { kind: 'action', action: agent.id },
      { kind: 'action', action: batchOnlyAction },
    ]),
  ).toMatchObject([
    {
      kind: 'action',
      action: agent.id,
      tool: 'Agent',
      input: start.kind === 'action_start' ? start.payload.input : null,
      truncated: [],
    },
    { kind: 'action', action: batchOnlyAction, tool: 'Bash', input: null, output: 'hi', truncated: [] },
  ])
})

test('a first call cannot carry materials', async ({ onTestFinished }) => {
  const { store, solver, claudeAction } = await setupNeeds(onTestFinished)
  const input = inputFor(store, [solver])
  const scope = inputScope(store, { run: runA, backend: 'claude', crossVendor: false })
  const materials = resolveObserverNeeds(store, scope, [{ kind: 'action', action: claudeAction.id }])
  expect(() => {
    store.transaction((transaction) => {
      beginObserverCall(transaction, {
        id: callId,
        backend: 'claude',
        crossVendor: false,
        input: { ...input, materials },
        at: at(10),
      })
    })
  }).toThrow('materials are sent only in a follow-up call')
  expect(store.observerCalls.get(callId)).toBeNull()
})
