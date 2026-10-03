import {
  type Action,
  ActionId,
  type Agent,
  AgentId,
  ArtifactVersionId,
  AttentionItemId,
  ContentHash,
  CriterionId,
  type EpochNs,
  type Fact,
  type JsonValue,
  ObserverCallId,
  type ObserverInput,
  type ObserverMaterial,
  type ObserverNeed,
  type RawRecord,
  RawSeq,
  type RunAgentBrief,
  type RunId,
  type RunSessionBrief,
  type SessionId,
  type SnapshotAttentionItem,
  type SnapshotCriterion,
  type SnapshotStage,
  type StageId,
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
import { at, drafts, fact, observed, put, runA, runB, sessionA, sessionB, sessionC, stages } from './model.js'
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
const claudeCall = (call: string) => objectId({ kind: 'action', runtime: 'claude', session: 'session-a', call })
const editAction = claudeCall('toolu_edit')
const userDataAction = claudeCall('toolu_user_data')
const mcpAction = objectId({ kind: 'action', runtime: 'codex', session: codexThread, call: 'mcp_issue' })

const secrets = {
  thinking: 'PRIVATE-CLAUDE-THINKING',
  redacted: 'PRIVATE-CLAUDE-REDACTED',
  summary: 'PRIVATE-CODEX-SUMMARY',
  reasoning: 'PRIVATE-CODEX-REASONING',
  deep: 'PRIVATE-DEEP-REASONING',
  item: 'PRIVATE-REASONING-ITEM',
}

const thinkingBlock = { type: 'thinking', thinking: secrets.thinking, signature: 'signature' }

const thinkingBlocks = [thinkingBlock, { type: 'redacted_thinking', data: secrets.redacted }]

const reasoningItem = {
  type: 'reasoning',
  id: 'rs_private',
  summary: [{ type: 'summary_text', text: secrets.summary }],
  content: [{ type: 'reasoning_text', text: secrets.reasoning }],
  encrypted_content: 'gAAAAprivate',
}

const objectOf = (text: string): JsonObject => {
  const value = JSON.parse(text) as JsonValue
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

const userData = {
  task: { type: 'reasoning', description: 'USER-TASK-DATA' },
  steps: [{ type: 'thinking', thinking: 'USER-STEP-DATA' }, { type: 'redacted_thinking', data: 'USER-STEP-BLOB' }],
}

const withUserData = (line: string): string => {
  const record = objectOf(line)
  const message = membersOf(record['message'])
  return JSON.stringify({
    ...record,
    uuid: 'user-data-line',
    message: {
      ...message,
      id: 'msg_user_data',
      stop_reason: 'tool_use',
      content: [
        thinkingBlock,
        { type: 'tool_use', id: 'toolu_user_data', name: 'mcp__tracker__create_task', input: userData },
      ],
    },
  })
}

const rolloutTime = (ordinal: number): string => `2026-10-01T12:01:${String(ordinal).padStart(2, '0')}.000Z`

const nestedArrays = (depth: number): string => `${'['.repeat(depth)}${']'.repeat(depth)}`

const deepCompaction = (line: string, ordinal: number): string => {
  const record = objectOf(line)
  const payload = membersOf(record['payload'])
  const deepItem = { ...reasoningItem, id: 'rs_deep', summary: [{ type: 'summary_text', text: secrets.deep }] }
  return JSON.stringify({
    ...record,
    timestamp: rolloutTime(ordinal),
    ordinal,
    payload: {
      ...payload,
      replacement_history: [deepItem, ...listOf(payload['replacement_history'])],
      nested: 'nested',
    },
  }).replace('"nested":"nested"', `"nested":${nestedArrays(8_000)}`)
}

const rolloutLine = (ordinal: number, type: string, payload: JsonObject): string =>
  JSON.stringify({ timestamp: rolloutTime(ordinal), ordinal, type, payload })

const reasoningOnly = (ordinal: number): string =>
  rolloutLine(ordinal, 'response_item', {
    ...reasoningItem,
    id: 'rs_item',
    summary: [{ type: 'summary_text', text: secrets.item }],
  })

const mcpResult = {
  content: [{ type: 'text', text: 'Issue 7 is open' }],
  structuredContent: { id: 7, state: 'open', labels: ['bug'] },
  isError: false,
}

const mcpCall = (ordinal: number): string =>
  rolloutLine(ordinal, 'event_msg', {
    type: 'item_completed',
    thread_id: codexThread,
    turn_id: '01a0f755-c3a7-75a1-acf1-7d0839bc2d5c',
    item: {
      type: 'McpToolCall',
      id: 'mcp_issue',
      server: 'tracker',
      tool: 'get_issue',
      arguments: { id: 7 },
      status: 'completed',
      result: mcpResult,
      duration: { secs: 0, nanos: 5_000_000 },
    },
    started_at_ms: 1_790_856_033_000,
    completed_at_ms: 1_790_856_034_000,
  })

const editInput = {
  file_path: 'src/answer.ts',
  old_string: 'export const answer = 41',
  new_string: 'export const answer = 42',
  replace_all: false,
}

const editResponse = {
  filePath: 'src/answer.ts',
  oldString: editInput.old_string,
  newString: editInput.new_string,
  originalFile: `${'export const filler = 0\n'.repeat(400)}export const answer = 41\n`,
  structuredPatch: [
    {
      oldStart: 401,
      oldLines: 1,
      newStart: 401,
      newLines: 1,
      lines: ['-export const answer = 41', '+export const answer = 42'],
    },
  ],
  userModified: false,
  replaceAll: false,
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
  const claudeAll = [...claudeLines, withThinking(assistantText), withUserData(assistantText)]
  const claude = jsonlFile({ runtime: 'claude', path: `${home.path}/session-a.jsonl`, lines: claudeAll, ino: 10n })
  await engine.ingest(claude.batch(claudeLines.length + 1, claudeAll.length))
  const session = { session: 'session-a', cwd: home.path }
  const edit = { tool_name: 'Edit', tool_input: editInput, tool_use_id: 'toolu_edit' }
  await engine.ingest(
    hookBatch(
      { file: 'tool-batch.evt', payload: claudeHook('PostToolBatch.json', session) },
      { file: 'edit-start.evt', payload: claudeHook('PreToolUse.Bash.json', session, edit) },
      {
        file: 'edit-end.evt',
        payload: claudeHook('PostToolUse.Bash.json', session, { ...edit, tool_response: editResponse }),
      },
    ),
  )
  const rollout = codexRollout({ thread: codexThread, cwd: home.path })
  const compactionLine = rollout[24] ?? ''
  const deep = deepCompaction(compactionLine, rollout.length + 1)
  const codexLines = [
    ...rollout.map((line, index) => (index === 24 ? withReasoning(line) : line)),
    deep,
    reasoningOnly(rollout.length + 2),
    mcpCall(rollout.length + 3),
  ]
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
  const deepRecord = recordWith(store, 'rs_deep')
  const reasoningRecord = recordWith(store, 'rs_item')
  const userDataRecord = recordWith(store, 'user-data-line')
  const batchRecord = recordWith(store, 'PostToolBatch')
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
    deepRecord,
    reasoningRecord,
    userDataRecord,
    batchRecord,
    foreignRecord,
    factlessRecord,
    codexFacts,
    claudeAction: completedAction(store, sessionA),
    foreignAction: completedAction(store, sessionB),
    codexAction: completedAction(store, codexSession),
  }
}

const envelope = (output: string | null, result: JsonValue): string => JSON.stringify({ output, result })

const iso = (time: EpochNs | null): string | null =>
  time === null ? null : new Date(Number(time / 1_000_000n)).toISOString()

const respond = (store: Store, call: ObserverCallId, output: unknown, second: number) =>
  store.transaction((transaction) => applyObserverResponse(transaction, { call, output, at: at(second) }))

const followUp = (store: Store, previous = callId, id = followUpId, crossVendor = false): ObserverInput =>
  store.transaction((transaction) =>
    beginObserverFollowUp(transaction, { previous, id, at: at(21), crossVendor }),
  )

const queue = (store: Store) =>
  store.interpretations
    .ofRun(runA)
    .filter(({ attempts }) => attempts > 0)
    .map(({ status, attempts, observer_call }) => [status, attempts, observer_call])

const outcomes = (materials: readonly ObserverMaterial[]) =>
  materials.map((material) => (material.kind === 'unavailable' ? material.reason : material.kind))

const sessionBrief = (id: SessionId, runtime: 'claude' | 'codex'): RunSessionBrief => ({
  id,
  runtime,
  surface: null,
  cwd: null,
  git_branch: null,
  started_at: '2026-10-01T00:00:00.000Z',
})

const agentBrief = ({ id, session, role, service, agent_type, name, description, parent }: Agent): RunAgentBrief => ({
  id,
  session,
  role,
  service,
  agent_type,
  name,
  description,
  parent,
})

const agentOf = (store: Store, session: SessionId): Agent => {
  const [agent] = store.observations.agents(session)
  if (agent === undefined) {
    throw new Error(`session ${session} must have an agent`)
  }
  return agent
}

const snapshotStage = (store: Store, run: RunId, id: StageId): SnapshotStage => {
  const entity = store.model.entity(run, { kind: 'stage', id })
  if (entity?.kind !== 'stage') {
    throw new Error(`stage ${id} must exist in run ${run}`)
  }
  const { title, expected_result, summary, parent, origin, execution, decision } = entity.value
  return { id, title, expected_result, summary, parent, origin, execution: execution.value, decision: decision.value }
}

const snapshotCriterion = (): SnapshotCriterion => {
  const { id, stage, text, source, status } = drafts.testsPass
  return { id, stage, text, source, status: status.value }
}

const snapshotAttention = (): SnapshotAttentionItem => {
  const { id, kind, author, text, stage, runtime_wait, resolution } = drafts.permission
  return { id, kind, author, text, stage, runtime_wait, resolution, likely_resolved: false }
}

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
      output: end.kind === 'action_end' ? envelope(end.payload.output, end.payload.result) : null,
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
  expect(
    restarted.interpretations
      .ofRun(runA)
      .filter(({ fact }) => fact === solver.id)
      .map(({ status, attempts, observer_call }) => [status, attempts, observer_call]),
  ).toEqual([['pending', 0, callId]])
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
  const setup = await setupNeeds(onTestFinished)
  const { store, solver, begin, thinkingRecord, compactionRecord, deepRecord, reasoningRecord, batchRecord } = setup
  for (const secret of Object.values(secrets)) {
    expect(recordsOf(store).some(({ payload }) => payload.includes(secret))).toBe(true)
  }
  expect(store.facts.ofRecord(deepRecord.seq).map(({ kind }) => kind)).toEqual(['compaction'])
  expect(store.facts.ofRecord(reasoningRecord.seq)).toEqual([])
  const input = begin([solver])
  const needs: ObserverNeed[] = [thinkingRecord, compactionRecord, deepRecord, reasoningRecord, batchRecord].map(
    ({ seq }) => ({ kind: 'raw_record', seq }),
  )
  respond(store, callId, { base_version: input.model.version, ops: [], needs }, 20)
  const second = followUp(store, callId, followUpId, true)
  expect(
    second.materials.map((material) => {
      switch (material.kind) {
        case 'raw_record':
          return material.payload
        case 'unavailable':
          return material.reason
        default:
          return material.kind
      }
    }),
  ).toEqual([
    JSON.stringify(stripped(thinkingRecord.payload, 'message', 'content')),
    JSON.stringify(stripped(compactionRecord.payload, 'payload', 'replacement_history')),
    'out_of_scope',
    'out_of_scope',
    batchRecord.payload.slice(0, 4_000),
  ])
  const sent = JSON.stringify(store.observerCalls.get(followUpId)?.input)
  for (const secret of Object.values(secrets)) {
    expect(sent).not.toContain(secret)
  }
  expect(sent).toContain(JSON.stringify(objectOf(thinkingRecord.payload)['uuid']).slice(1, -1))
})

test('only runtime thinking blocks are removed, tool data with the same types stays intact', async ({
  onTestFinished,
}) => {
  const { store, userDataRecord, claudeAction, codexAction } = await setupNeeds(onTestFinished)
  const untouched = [
    factOf(store, claudeAction.input_fact).seq,
    factOf(store, claudeAction.output_fact).seq,
    factOf(store, codexAction.output_fact).seq,
  ]
  const [record, action, ...others] = resolve(store, { backend: 'claude', crossVendor: true }, [
    { kind: 'raw_record', seq: userDataRecord.seq },
    { kind: 'action', action: userDataAction },
    ...untouched.map((seq): ObserverNeed => ({ kind: 'raw_record', seq })),
  ])
  const payload = JSON.stringify(stripped(userDataRecord.payload, 'message', 'content'))
  expect(record).toMatchObject({ kind: 'raw_record', payload, truncated: null })
  expect(payload).toContain(JSON.stringify(userData))
  expect(payload).not.toContain(secrets.thinking)
  expect(action).toMatchObject({
    kind: 'action',
    tool: 'mcp__tracker__create_task',
    input: userData,
    output: null,
    truncated: [],
  })
  expect(others.map((material) => (material.kind === 'raw_record' ? material.payload : material.kind))).toEqual(
    untouched.map((seq) => store.rawRecords.get(seq)?.payload),
  )
})

test('an action carries its text output together with the structured result and the edit patch', async ({
  onTestFinished,
}) => {
  const { store, solver, begin } = await setupNeeds(onTestFinished)
  expect(store.observations.getAction(editAction)).toMatchObject({ tool: 'Edit', outcome: { value: 'ok' } })
  const input = begin([solver])
  const needs: ObserverNeed[] = [
    { kind: 'action', action: editAction },
    { kind: 'action', action: mcpAction },
  ]
  respond(store, callId, { base_version: input.model.version, ops: [], needs }, 20)
  const [edit, mcp] = followUp(store, callId, followUpId, true).materials
  expect(edit).toMatchObject({
    kind: 'action',
    tool: 'Edit',
    outcome: 'ok',
    input: editInput,
    output: envelope(null, { ...editResponse, originalFile: editResponse.originalFile.slice(0, 4_000) }),
    truncated: [{ path: 'result.originalFile', length: editResponse.originalFile.length }],
  })
  expect(edit?.kind === 'action' ? edit.output : null).toContain('+export const answer = 42')
  expect(mcp).toMatchObject({
    kind: 'action',
    tool: 'tracker/get_issue',
    action_kind: 'mcp',
    outcome: 'ok',
    input: { id: 7 },
    output: envelope('Issue 7 is open', mcpResult),
    truncated: [],
  })
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
  const originalResult = end.kind === 'action_end' ? membersOf(end.payload.result) : {}
  const originalInput = start.kind === 'action_start' ? membersOf(start.payload.input) : {}
  const longTexts = (members: JsonObject, prefix: string) =>
    Object.entries(members).flatMap(([key, value]) =>
      typeof value === 'string' && value.length > 1 ? [{ path: `${prefix}.${key}`, length: value.length }] : [],
    )
  const longInputs = longTexts(originalInput, 'input')
  const longResults = longTexts(originalResult, 'result')
  expect(longInputs.length).toBeGreaterThan(0)
  expect(longResults.length).toBeGreaterThan(0)
  expect(actionMaterial.output).toBe(
    envelope(
      originalOutput.slice(0, 1),
      Object.fromEntries(
        Object.entries(originalResult).map(([key, value]) => [
          key,
          typeof value === 'string' ? value.slice(0, 1) : value,
        ]),
      ),
    ),
  )
  expect(actionMaterial.truncated).toEqual([
    ...longInputs,
    { path: 'output', length: originalOutput.length },
    ...longResults,
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

test('every part of the observer input passes the same scope before the call is stored', async ({
  onTestFinished,
}) => {
  const setup = await setupNeeds(onTestFinished)
  const { store, solver, foreignRecord, foreignAction, codexAction, compactionRecord } = setup
  const grounded = (id: string, evidence: Fact['id'][]): SnapshotAttentionItem => {
    const item = { ...drafts.permission, id: AttentionItemId.parse(id), evidence }
    store.transaction((transaction) => {
      applyChangeSet(transaction, {
        run: runA,
        author: 'rule',
        at: at(4),
        changes: [put('attention.open', { kind: 'attention_item', value: item }, observed, evidence)],
      })
    })
    return { ...snapshotAttention(), id: item.id }
  }
  const codexGrounded = grounded('attention-codex', setup.codexFacts.slice(0, 1).map(({ id }) => id))
  const replaced = grounded('attention-replaced', [fact(999)])
  const ownAgent = agentOf(store, sessionA)
  const foreignAgent = agentOf(store, sessionB)
  const codexAgent = agentOf(store, codexSession)
  const base = inputFor(store, [solver])
  const stage = snapshotStage(store, runA, stages.build)
  const valid: ObserverInput = {
    ...base,
    run: { ...base.run, sessions: [sessionBrief(sessionA, 'claude')], agents: [agentBrief(ownAgent)] },
    model: {
      ...base.model,
      stages: [stage, snapshotStage(store, runA, stages.test)],
      criteria: [snapshotCriterion()],
      attention: [snapshotAttention(), replaced],
    },
    batch: {
      ...base.batch,
      facts: base.batch.facts.map((value) => ({ ...value, agent: ownAgent.id, action: setup.claudeAction.id })),
    },
  }
  const withRun = (run: Partial<ObserverInput['run']>): ObserverInput => ({ ...valid, run: { ...valid.run, ...run } })
  const withModel = (model: Partial<ObserverInput['model']>): ObserverInput => ({
    ...valid,
    model: { ...valid.model, ...model },
  })
  const withBatch = (batch: Partial<ObserverInput['batch']>): ObserverInput => ({
    ...valid,
    batch: { ...valid.batch, ...batch },
  })
  const withFact = (change: Partial<ObserverInput['batch']['facts'][number]>): ObserverInput =>
    withBatch({ facts: valid.batch.facts.map((value) => ({ ...value, ...change })) })
  const context = (seq: RawSeq): ObserverInput => ({
    ...valid,
    context: { seq, content_hash: ContentHash.parse('0'.repeat(64)), entries: [] },
  })
  const unknownAction = ActionId.parse('0'.repeat(32))
  const unknownAgent = AgentId.parse('0'.repeat(32))
  const unknownFact = fact(999)
  const artifact = ArtifactVersionId.parse('f'.repeat(32))
  const time = '2026-10-01T00:00:00.000Z'
  const outside = (object: string) => `${object} is not in run ${runA}`
  const foreignVendor = (object: string) => `${object} comes from a vendor other than backend claude`
  const cases: [ObserverInput, string][] = [
    [
      withRun({ sessions: [sessionBrief(sessionA, 'claude'), sessionBrief(sessionB, 'claude')] }),
      outside(`session ${sessionB}`),
    ],
    [withRun({ sessions: [sessionBrief(codexSession, 'codex')] }), foreignVendor(`session ${codexSession}`)],
    [withRun({ sessions: [sessionBrief(sessionC, 'claude')] }), outside(`session ${sessionC}`)],
    [withRun({ agents: [{ ...agentBrief(ownAgent), id: unknownAgent }] }), outside(`agent ${unknownAgent}`)],
    [withRun({ agents: [agentBrief(foreignAgent)] }), outside(`agent ${foreignAgent.id}`)],
    [withRun({ agents: [{ ...agentBrief(ownAgent), session: sessionB }] }), outside(`session ${sessionB}`)],
    [
      withRun({ agents: [{ ...agentBrief(ownAgent), parent: codexAgent.id }] }),
      foreignVendor(`agent ${codexAgent.id}`),
    ],
    [context(foreignRecord.seq), outside(`context record ${String(foreignRecord.seq)}`)],
    [context(compactionRecord.seq), foreignVendor(`context record ${String(compactionRecord.seq)}`)],
    [context(RawSeq.parse(999_999)), outside('context record 999999')],
    [withModel({ stages: [snapshotStage(store, runB, stages.verify)] }), outside(`stage ${stages.verify}`)],
    [withModel({ stages: [{ ...stage, parent: stages.verify }] }), outside(`stage ${stages.verify}`)],
    [
      withModel({ criteria: [{ ...snapshotCriterion(), id: CriterionId.parse('criterion-elsewhere') }] }),
      outside('criterion criterion-elsewhere'),
    ],
    [withModel({ criteria: [{ ...snapshotCriterion(), stage: stages.verify }] }), outside(`stage ${stages.verify}`)],
    [withModel({ attention: [{ ...snapshotAttention(), stage: stages.verify }] }), outside(`stage ${stages.verify}`)],
    [withModel({ attention: [codexGrounded] }), foreignVendor('attention_item attention-codex')],
    [withFact({ session: sessionB }), outside(`session ${sessionB}`)],
    [withFact({ id: unknownFact }), outside(`fact ${unknownFact}`)],
    [withFact({ agent: foreignAgent.id }), outside(`agent ${foreignAgent.id}`)],
    [withFact({ action: foreignAction.id }), outside(`action ${foreignAction.id}`)],
    [withFact({ action: codexAction.id }), foreignVendor(`action ${codexAction.id}`)],
    [withFact({ action: unknownAction }), outside(`action ${unknownAction}`)],
    [
      withBatch({
        collapsed: [
          { tool: 'Bash', action_kind: 'command', agent: foreignAgent.id, facts: [solver.id], from: time, to: time },
        ],
      }),
      outside(`agent ${foreignAgent.id}`),
    ],
    [
      withBatch({
        backlog: { from: time, to: time, facts: 1, agents: [{ agent: codexAgent.id, facts: 1, tools: [] }] },
      }),
      foreignVendor(`agent ${codexAgent.id}`),
    ],
    [
      withBatch({
        artifact_versions: [
          { id: artifact, ref: { kind: 'file', path: 'src/answer.ts' }, produced_by: foreignAction.id, retained: true },
        ],
      }),
      outside(`artifact version ${artifact}`),
    ],
  ]
  const start = (input: ObserverInput, crossVendor = false) => {
    store.transaction((transaction) => {
      beginObserverCall(transaction, { id: callId, backend: 'claude', crossVendor, input, at: at(10) })
    })
  }
  for (const [input, message] of cases) {
    expect(() => {
      start(input)
    }).toThrow(message)
  }
  expect(store.observerCalls.get(callId)).toBeNull()
  expect(store.interpretations.ofRun(runA).filter(({ status }) => status !== 'pending')).toEqual([])

  const crossVendor = {
    ...withRun({
      sessions: [...valid.run.sessions, sessionBrief(codexSession, 'codex')],
      agents: [...valid.run.agents, agentBrief(codexAgent)],
    }),
    model: { ...valid.model, attention: [...valid.model.attention, codexGrounded] },
    batch: withFact({ action: codexAction.id }).batch,
  }
  expect(() => {
    start(crossVendor)
  }).toThrow(foreignVendor(`session ${codexSession}`))
  start(crossVendor, true)
  expect(store.observerCalls.get(callId)?.input).toEqual(crossVendor)
})

test('a follow-up checks the stored input against the scope again', async ({ onTestFinished }) => {
  const { store, solver, codexFacts, claudeAction } = await setupNeeds(onTestFinished)
  const [codexFact] = codexFacts
  if (codexFact === undefined) {
    throw new Error('the rollout must produce codex facts')
  }
  const input = inputFor(store, [solver, codexFact])
  store.transaction((transaction) => {
    beginObserverCall(transaction, { id: callId, backend: 'claude', crossVendor: true, input, at: at(10) })
  })
  const needs: ObserverNeed[] = [{ kind: 'action', action: claudeAction.id }]
  respond(store, callId, { base_version: input.model.version, ops: [], needs }, 20)
  expect(() => followUp(store, callId, followUpId, false)).toThrow(
    `fact ${codexFact.id} comes from a vendor other than backend claude`,
  )
  expect(store.observerCalls.get(followUpId)).toBeNull()
  expect(queue(store)).toEqual(Array.from({ length: 2 }, () => ['in_call', 1, callId]))
  expect(outcomes(followUp(store, callId, followUpId, true).materials)).toEqual(['action'])
  expect(queue(store)).toEqual(Array.from({ length: 2 }, () => ['in_call', 1, followUpId]))
})
