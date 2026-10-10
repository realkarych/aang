import { codexAdapter } from '@aang/adapter-codex'
import type { CollectedRecord, FactDraft, TokenUsage } from '@aang/contract'
import { expect, test } from 'vitest'
import {
  archivedPath,
  expectUnknown,
  factsOf,
  parseFacts,
  realRollout,
  realThread,
  record,
  rolloutLines,
  sampleLine,
  sessionsPath,
  streamFrom,
  threadStream,
  withPayload,
} from './rollout-records.js'

const firstTurn = '01a0f752-4102-7740-9432-0533263c2dc1'
const resumedTurn = '01a0f755-c3a7-75a1-acf1-7d0839bc2d5c'
const codeCell = 'call_MxHF39QIUjLqImvlqfhdfE2y'
const nestedCommand = 'exec-a8b47079-66cf-4c58-ba7c-268717fda6fb'
const spawnRoot = '01a0f75c-465e-7a01-876f-c7df6fc989a0'
const spawnChild = '01a0f75c-46d2-7430-92a2-c3b0cd5d85b6'
const guardianThread = '01a0f75b-8064-73c2-8b8a-ba66c5467425'
const responses = [
  'resp_00a7ba1502c50863016abe4a6679b887d29972f57cdb348c7b',
  'resp_00a7ba1502c50863016abe4a699a4c87d2a35bc9e5febceb48',
  'resp_00a7ba1502c50863016abe4b4bc1f087d2acc7b2af71c3c2a4',
  'resp_00a7ba1502c50863016abe4b5c169887d2ac1d510229c04358',
] as const

const multiAgentV1Meta = (spawn: Record<string, unknown>, meta: Record<string, unknown> = {}): string =>
  withPayload('session_meta.subagent.thread_spawn.mock.json', {
    session_id: spawnChild,
    parent_thread_id: undefined,
    agent_path: undefined,
    agent_role: 'explorer',
    multi_agent_version: undefined,
    source: {
      subagent: {
        thread_spawn: {
          parent_thread_id: spawnRoot,
          depth: 1,
          agent_path: null,
          agent_nickname: 'Confucius',
          agent_role: 'explorer',
          ...spawn,
        },
      },
    },
    ...meta,
  })

const readRollout = (path: string) => {
  const lines = rolloutLines(realRollout)
  const stream = codexAdapter.streamKey(null, lines.slice(0, 3))
  let offset = 0
  return lines.map((payload, index) => {
    const collected = record(payload, stream, { position: { kind: 'line', path, offset, line: index + 1 } })
    offset += Buffer.byteLength(payload) + 1
    return collected
  })
}

const parsedFacts = (records: readonly CollectedRecord[]): FactDraft[] =>
  records.flatMap((collected) => {
    const result = codexAdapter.parse(collected)
    return result.parse_state === 'parsed' ? factsOf(result) : []
  })

const addTokens = (left: TokenUsage, right: TokenUsage): TokenUsage => ({
  uncached_input_tokens: left.uncached_input_tokens + right.uncached_input_tokens,
  cache_read_input_tokens: left.cache_read_input_tokens + right.cache_read_input_tokens,
  cache_write_input_tokens: left.cache_write_input_tokens + right.cache_write_input_tokens,
  output_tokens: left.output_tokens + right.output_tokens,
  reasoning_output_tokens: (left.reasoning_output_tokens ?? 0) + (right.reasoning_output_tokens ?? 0),
})

const describeFact = (fact: FactDraft): string => {
  switch (fact.kind) {
    case 'session_start':
      return `${fact.payload.launch} in ${String(fact.payload.cwd)}`
    case 'turn_end':
      return `${fact.payload.outcome}: ${String(fact.payload.final_message)}`
    case 'turn_settings':
      return `${String(fact.payload.model)} ${String(fact.payload.approval_policy)} ${String(fact.payload.sandbox)}`
    case 'prompt':
    case 'message':
      return fact.payload.text
    case 'action_start':
      return `${fact.payload.action_kind} ${fact.entity_key.kind === 'action' ? fact.entity_key.call : ''}`
    case 'action_end':
      return `${fact.payload.outcome} ${fact.entity_key.kind === 'action' ? fact.entity_key.call : ''}`
    case 'compaction':
      return fact.payload.phase
    case 'usage':
      return fact.entity_key.kind === 'usage' ? fact.entity_key.usage : ''
    case 'usage_total':
      return fact.payload.source
    default:
      return ''
  }
}

test('the real exec rollout with resume and compaction is keyed by thread and ordinal and parses every line', () => {
  const records = readRollout(sessionsPath)

  expect(records[0]?.stream).toBe(`codex:${realThread}:${realThread}`)
  expect(records.map((collected) => codexAdapter.rawKey(collected))).toEqual(
    records.map((_, ordinal) => `codex:${realThread}:${String(ordinal)}`),
  )
  const states = records.map((collected) => codexAdapter.parse(collected).parse_state)
  expect(states).toEqual(records.map(() => 'parsed'))
})

test('the real rollout yields the session, both turns, the code-mode cell and its nested command', () => {
  const facts = parsedFacts(readRollout(sessionsPath))

  expect(
    facts.map((fact) => [fact.runtime_ids.ordinal, fact.kind, fact.runtime_ids.turn_id, describeFact(fact)]),
  ).toEqual([
    [0, 'session_start', null, 'startup in /tmp/aang-spike/codex-cli/run1'],
    [1, 'turn_start', firstTurn, ''],
    [7, 'turn_settings', firstTurn, 'gpt-6.1-sol never read-only'],
    [9, 'prompt', firstTurn, 'Run the shell command `echo hi` exactly once, then reply with just: OK'],
    [10, 'action_start', firstTurn, `code_cell ${codeCell}`],
    [11, 'usage', firstTurn, `${realThread}:${responses[0]}`],
    [11, 'usage_total', firstTurn, 'thread_token_usage'],
    [12, 'action_start', firstTurn, `command ${nestedCommand}`],
    [12, 'action_end', firstTurn, `ok ${nestedCommand}`],
    [13, 'action_end', firstTurn, `unknown ${codeCell}`],
    [14, 'usage_total', null, 'token_count'],
    [15, 'message', firstTurn, 'OK'],
    [17, 'usage', firstTurn, `${realThread}:${responses[1]}`],
    [17, 'usage_total', firstTurn, 'thread_token_usage'],
    [18, 'usage_total', null, 'token_count'],
    [19, 'turn_end', firstTurn, 'completed: OK'],
    [22, 'turn_start', resumedTurn, ''],
    [23, 'usage', resumedTurn, `${realThread}:${responses[2]}`],
    [23, 'usage_total', resumedTurn, 'thread_token_usage'],
    [24, 'compaction', null, 'boundary'],
    [26, 'usage_total', null, 'token_count'],
    [27, 'compaction', resumedTurn, 'started'],
    [27, 'compaction', resumedTurn, 'completed'],
    [33, 'turn_settings', resumedTurn, 'gpt-6.1-sol never read-only'],
    [35, 'prompt', resumedTurn, 'Reply with just: OK2'],
    [36, 'message', resumedTurn, 'OK2'],
    [38, 'usage', resumedTurn, `${realThread}:${responses[3]}`],
    [38, 'usage_total', resumedTurn, 'thread_token_usage'],
    [39, 'usage_total', null, 'token_count'],
    [40, 'turn_end', resumedTurn, 'completed: OK2'],
  ])
  expect(new Set(facts.map((fact) => fact.entity_key.session))).toEqual(new Set([realThread]))
  expect(facts.filter((fact) => fact.urgent).map((fact) => [fact.runtime_ids.ordinal, fact.kind])).toEqual([
    [15, 'message'],
    [19, 'turn_end'],
    [24, 'compaction'],
    [27, 'compaction'],
    [27, 'compaction'],
    [36, 'message'],
    [40, 'turn_end'],
  ])
  expect(facts.every((fact) => fact.format_verified)).toBe(true)
})

test('an archived rollout re-read from another path yields the same keys and facts', () => {
  const live = readRollout(sessionsPath)
  const archived = readRollout(archivedPath)

  expect(archived.map((collected) => codexAdapter.rawKey(collected))).toEqual(
    live.map((collected) => codexAdapter.rawKey(collected)),
  )
  expect(archived.map((collected) => codexAdapter.parse(collected))).toEqual(
    live.map((collected) => codexAdapter.parse(collected)),
  )
})

test('the stream of a sub-agent rollout names its root session and its own thread', () => {
  expect(streamFrom(sampleLine('session_meta.subagent.thread_spawn.mock.json'))).toBe(
    'codex:01a0f75c-465e-7a01-876f-c7df6fc989a0:01a0f75c-46d2-7430-92a2-c3b0cd5d85b6',
  )
  expect(streamFrom(sampleLine('session_meta.guardian.mock.json'))).toBe(
    'codex:01a0f75b-8043-70d2-95ed-39bd0831b81a:01a0f75b-8064-73c2-8b8a-ba66c5467425',
  )
})

test('a multi-agent v1 sub-agent that names itself as the session joins its parent session and does not speak for the human', () => {
  const lines = [
    multiAgentV1Meta({}),
    sampleLine('event_msg.task_started.subagent.mock.json'),
    sampleLine('event_msg.item_completed.UserMessage.real.json'),
    sampleLine('event_msg.item_completed.AgentMessage.final.real.json'),
  ]
  const stream = codexAdapter.streamKey(null, lines.slice(0, 3))
  const childAgent = { kind: 'agent', session: spawnRoot, agent: { kind: 'thread', thread_id: spawnChild } }

  expect(stream).toBe(`codex:${spawnRoot}:${spawnChild}`)
  expect(lines.flatMap((payload) => factsOf(codexAdapter.parse(record(payload, stream))))).toMatchObject([
    {
      kind: 'agent_start',
      entity_key: childAgent,
      runtime_ids: { session_id: spawnRoot, thread_id: spawnChild },
      payload: {
        role: 'subagent',
        agent_role: 'explorer',
        description: null,
        nickname: 'Confucius',
        parent: { kind: 'main' },
        depth: 1,
      },
    },
    { kind: 'turn_start', entity_key: childAgent },
    {
      kind: 'prompt',
      entity_key: { kind: 'message', session: spawnRoot, message: `${spawnChild}:9` },
      speaker: 'runtime',
      payload: { origin: 'unknown' },
    },
    { kind: 'message', entity_key: { session: spawnRoot }, payload: { final: true, audience: 'agent' } },
  ])
  expect(streamFrom(multiAgentV1Meta({}, { session_id: undefined }))).toBe(`codex:${spawnRoot}:${spawnChild}`)
})

test('a sub-agent rollout whose root session cannot be established has no stream and stays unknown', () => {
  const unresolved = [
    multiAgentV1Meta({ depth: 2, parent_thread_id: 'nested-parent-thread' }),
    multiAgentV1Meta({ parent_thread_id: undefined }),
    multiAgentV1Meta({ parent_thread_id: 'parent:thread' }),
    withPayload('session_meta.guardian.mock.json', { session_id: guardianThread }),
  ]

  for (const line of unresolved) {
    expect(codexAdapter.streamKey(null, [line])).toBeNull()
    expectUnknown(line, null)
  }
})

test('a file that does not open with session_meta has no stream', () => {
  const lines = rolloutLines(realRollout)

  expect(codexAdapter.streamKey(null, [])).toBeNull()
  expect(codexAdapter.streamKey(null, lines.slice(1))).toBeNull()
  expect(codexAdapter.streamKey(null, ['{"timestamp": "2026-10-01T11:55:58.087Z", "ordinal": 0'])).toBeNull()
  expect(codexAdapter.streamKey(null, [lines[0]?.replace('"id": "01a0f752', '"id": "01:a0f752') ?? ''])).toBeNull()
})

test('the usage records of the real rollout add up to its last thread total, while token counts stay separate totals', () => {
  const facts = parsedFacts(readRollout(sessionsPath))
  const usage = facts.flatMap((fact) => (fact.kind === 'usage' ? [fact] : []))
  const totals = (source: string) =>
    facts.flatMap((fact) =>
      fact.kind === 'usage_total' && fact.payload.source === source ? [fact.payload.tokens] : [],
    )
  const sum = usage.map((fact) => fact.payload.tokens).reduce(addTokens)

  expect(new Set(usage.map((fact) => JSON.stringify(fact.entity_key))).size).toBe(4)
  expect(sum).toEqual(totals('thread_token_usage').at(-1))
  expect(sum).toEqual({
    uncached_input_tokens: 4545,
    cache_read_input_tokens: 52864,
    cache_write_input_tokens: 0,
    output_tokens: 130,
    reasoning_output_tokens: 0,
  })
  expect(totals('token_count')).toHaveLength(4)
  expect(totals('token_count').at(-1)).toMatchObject({ output_tokens: 38 })
})

test('a sub-agent is tied to its spawning call, its own rollout and the root session from both threads', () => {
  const parent = threadStream(spawnRoot)
  const childMeta = sampleLine('session_meta.subagent.thread_spawn.mock.json')
  const child = streamFrom(childMeta)
  const [spawn] = parseFacts(sampleLine('response_item.function_call.spawn_agent.mock.json'), parent)
  const [started] = parseFacts(sampleLine('event_msg.item_completed.SubAgentActivity.started.mock.json'), parent)
  const [completed] = parseFacts(sampleLine('event_msg.item_completed.SubAgentActivity.completed.mock.json'), parent)
  const [ownStart] = parseFacts(childMeta, child)
  const [childUsage, childTotal] = parseFacts(sampleLine('token_usage_record.subagent.mock.json'), child)

  expect(started?.kind === 'agent_start' ? started.payload.spawned_by_call : null).toBe(
    spawn?.entity_key.kind === 'action' ? spawn.entity_key.call : undefined,
  )
  expect(started?.entity_key).toEqual(ownStart?.entity_key)
  expect(completed?.entity_key).toEqual(ownStart?.entity_key)
  expect(childTotal?.entity_key).toEqual(ownStart?.entity_key)
  expect(childUsage?.entity_key).toEqual({
    kind: 'usage',
    runtime: 'codex',
    session: spawnRoot,
    usage: `${spawnChild}:resp_mock_38`,
  })
})

test('a forked rollout is its own root session that names its origin and continues the parent ordinals', () => {
  const forkThread = '01a0f75f-4fc5-7bf0-9860-9766a76bffd7'
  const meta = sampleLine('session_meta.fork.mock.json')
  const fork = streamFrom(meta)
  const usage = withPayload('token_usage_record.real.json', { thread_id: forkThread, session_id: forkThread })

  expect(fork).toBe(`codex:${forkThread}:${forkThread}`)
  expect(codexAdapter.rawKey(record(meta, fork))).toBe(`codex:${forkThread}:38`)
  expect(parseFacts(meta, fork)).toMatchObject([
    {
      kind: 'session_start',
      entity_key: { kind: 'session', session: forkThread },
      payload: { launch: 'fork', forked_from: { session: '01a0f75a-a4b7-7361-aa8c-65ee90d82f99', ordinal: 38 } },
    },
  ])
  expect(parseFacts(usage, fork)[0]?.entity_key).toEqual({
    kind: 'usage',
    runtime: 'codex',
    session: forkThread,
    usage: `${forkThread}:${responses[0]}`,
  })
})
