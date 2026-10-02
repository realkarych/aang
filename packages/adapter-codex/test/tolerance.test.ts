import { codexAdapter } from '@aang/adapter-codex'
import { EpochNs, SpoolFileName, StreamKey } from '@aang/contract'
import { expect, test } from 'vitest'
import {
  expectUnknown,
  millis,
  parseFacts,
  realThread,
  record,
  sampleLine,
  sampleObject,
  sessionsPath,
  streamFrom,
  threadStream,
  withItem,
  withPayload,
} from './rollout-records.js'

const real = threadStream(realThread)
const root = '01a0f75c-465e-7a01-876f-c7df6fc989a0'
const child = threadStream(root, '01a0f75c-46d2-7430-92a2-c3b0cd5d85b6')
const parentThread = 'parent-sub-agent-thread'

const mcpItem = {
  type: 'McpToolCall',
  id: 'call_mcp_1',
  server: 'cua_repl',
  tool: 'js',
  arguments: { code: 'await page.title()', title: 'read title' },
  status: 'completed',
  result: { content: [{ type: 'text', text: 'Example' }], isError: false },
  duration: { secs: 1, nanos: 500_000_000 },
}

test('a rollout line that is not a JSON object is invalid', () => {
  for (const payload of ['{"timestamp": "2026-10-01T11:55:58.087Z", "ordinal": 0', '[1, 2]', '"text"']) {
    expect(codexAdapter.parse(record(payload, real))).toEqual({
      parse_state: 'invalid',
      reason: 'rollout line is not a JSON object',
    })
  }
})

test('unrecognized rollout lines are kept as unknown with their source time when it is readable', () => {
  expect(codexAdapter.parse(record('{"type": "event_msg"}', real))).toEqual({ parse_state: 'unknown', source_ts: null })
  const hookStarted = withPayload('event_msg.task_started.real.json', { type: 'hook_started' })
  expect(codexAdapter.parse(record(hookStarted, real))).toEqual({
    parse_state: 'unknown',
    source_ts: EpochNs.parse(1_790_855_758_088_000_000n),
  })
  const timestamped = (timestamp: string) =>
    JSON.stringify({ ...sampleObject('event_msg.task_started.real.json'), timestamp })
  expect(codexAdapter.parse(record(timestamped('2026-10-01T11:55:58.123456789Z'), real))).toMatchObject({
    source_ts: EpochNs.parse(1_790_855_758_123_456_789n),
  })
  expect(codexAdapter.parse(record(timestamped('2026-10-01T11:55:58Z'), real))).toMatchObject({
    source_ts: EpochNs.parse(1_790_855_758_000_000_000n),
  })
  for (const timestamp of ['2026-10-01 11:55:58', '2026-13-45T99:99:99Z', '1960-01-01T00:00:00Z']) {
    expect(codexAdapter.parse(record(timestamped(timestamp), real))).toEqual({
      parse_state: 'unknown',
      source_ts: null,
    })
  }
})

test('known record types with an unexpected shape are unknown rather than misread', () => {
  const variants = [
    withPayload('session_meta.exec.real.json', { id: 7 }),
    withPayload('turn_context.real.json', { model: 7 }),
    withPayload('event_msg.task_started.real.json', { turn_id: 7 }),
    withPayload('event_msg.task_complete.real.json', { last_agent_message: 7 }),
    withPayload('event_msg.turn_aborted.mock-tui.json', { reason: 7 }),
    withPayload('event_msg.item_completed.UserMessage.real.json', { item: 'UserMessage' }),
    withItem('event_msg.item_completed.UserMessage.real.json', { content: 'text' }),
    withItem('event_msg.item_completed.AgentMessage.final.real.json', { content: 'OK' }),
    withItem('event_msg.item_completed.CommandExecution.real.json', { command: 'echo hi' }),
    withItem('event_msg.item_completed.FileChange.mock.json', { changes: [] }),
    withItem('event_msg.item_completed.ContextCompaction.real.json', { type: 'ImageView' }),
    withItem('event_msg.item_completed.UserMessage.real.json', { ...mcpItem, server: '' }),
    withPayload('response_item.function_call.exec_command.mock.json', { arguments: { cmd: 'ls' } }),
    withPayload('response_item.custom_tool_call.exec-codemode.real.json', { input: null }),
    withPayload('response_item.function_call_output.mock.json', { call_id: '' }),
    withPayload('response_item.message.assistant.real.json', { type: 'tool_search_call' }),
    JSON.stringify({ ...sampleObject('event_msg.task_started.real.json'), payload: 'task_started' }),
  ]
  for (const variant of variants) {
    expectUnknown(variant, real)
  }
})

test('rollout values nested too deeply to read leave the line unknown and the next line is still parsed', () => {
  const nested = (depth: number): unknown => JSON.parse(`${'['.repeat(depth)}0${']'.repeat(depth)}`)
  const tooDeep = nested(5000)
  const changes = (content: unknown) => ({ changes: { '/tmp/deep.txt': { type: 'add', content } } })
  const fileChangeTime = EpochNs.parse(1_790_856_393_277_000_000n)

  for (const item of [changes(tooDeep), { ...mcpItem, arguments: tooDeep }, { ...mcpItem, result: tooDeep }]) {
    expect(codexAdapter.parse(record(withItem('event_msg.item_completed.FileChange.mock.json', item), real))).toEqual({
      parse_state: 'unknown',
      source_ts: fileChangeTime,
    })
  }
  expectUnknown(
    withItem('event_msg.item_completed.CollabAgentToolCall.wait.mock.json', { agents_states: tooDeep }),
    threadStream(root),
  )
  expect(
    parseFacts(withPayload('event_msg.item_completed.FileChange.mock.json', { extra: tooDeep }), real),
  ).toMatchObject([{ kind: 'action_start' }, { kind: 'action_end', payload: { outcome: 'ok' } }])
  expect(parseFacts(withItem('event_msg.item_completed.FileChange.mock.json', changes(nested(100))), real)).toMatchObject(
    [{ kind: 'action_start', payload: { input: changes(nested(100)) } }, { kind: 'action_end' }],
  )

  const deepArguments = JSON.stringify({ cmd: tooDeep })
  expect(
    parseFacts(withPayload('response_item.function_call.exec_command.mock.json', { arguments: deepArguments }), real),
  ).toMatchObject([{ kind: 'action_start', payload: { input: deepArguments } }])
})

test('records that are not rollout lines of a known thread are unknown for this adapter', () => {
  const line = sampleLine('event_msg.task_started.real.json')
  const position = { kind: 'line', path: sessionsPath, offset: 0, line: 1 } as const

  expect(codexAdapter.parse(record(line, null))).toMatchObject({ parse_state: 'unknown' })
  for (const stream of ['claude:s1:main', `codex:${realThread}`, `codex:a:b:c`, 'codex:a b:c']) {
    expect(codexAdapter.parse(record(line, StreamKey.parse(stream)))).toMatchObject({ parse_state: 'unknown' })
  }
  expect(codexAdapter.parse(record(line, real, { channel: 'hook', position }))).toEqual({
    parse_state: 'unknown',
    source_ts: null,
  })
  expect(codexAdapter.parse(record('', real, { position: { kind: 'stream_lost', path: sessionsPath } }))).toEqual({
    parse_state: 'unknown',
    source_ts: null,
  })
})

test('records without a rollout ordinal fall back to keys derived from their position and content', () => {
  const unordered = '{"timestamp": "2026-10-01T11:55:58.087Z", "type": "session_meta"}'
  const at = (line: number) => ({ kind: 'line', path: sessionsPath, offset: 0, line }) as const
  const key = (payload: string, line: number, stream: StreamKey | null = real) =>
    codexAdapter.rawKey(record(payload, stream, { position: at(line) }))

  expect(key(unordered, 3)).toMatch(new RegExp(`^codex:${realThread}:line:3:[0-9a-f]{64}$`))
  expect(key(unordered, 3)).toBe(key(unordered, 3))
  expect(key(unordered, 4)).not.toBe(key(unordered, 3))
  expect(key(sampleLine('event_msg.task_started.real.json'), 3, null)).toMatch(
    new RegExp(`^codex:${sessionsPath}:line:3:[0-9a-f]{64}$`),
  )
  expect(key(sampleLine('event_msg.task_started.real.json'), 3)).toBe(`codex:${realThread}:1`)

  const spoolFile = SpoolFileName.parse('1790855758-42.spool')
  const spool = record('{}', null, { channel: 'hook', position: { kind: 'spool', file: spoolFile } })
  expect(codexAdapter.rawKey(spool)).toBe('hook:1790855758-42.spool')

  const otel = (payload: string) =>
    codexAdapter.rawKey(record(payload, null, { channel: 'otel', position: { kind: 'otel' } }))
  expect(otel('{"call_id":"call_1"}')).toMatch(/^codex:otel:[0-9a-f]{64}$/)
  expect(otel('{"call_id":"call_1"}')).toBe(otel('{"call_id":"call_1"}'))
  expect(otel('{"call_id":"call_2"}')).not.toBe(otel('{"call_id":"call_1"}'))
})

test('an MCP tool call item is parsed from its observed structure and marked unverified', () => {
  const mcp = (changes: Record<string, unknown>) =>
    parseFacts(withItem('event_msg.item_completed.UserMessage.real.json', { ...mcpItem, ...changes }), real)

  expect(mcp({})).toMatchObject([
    {
      kind: 'action_start',
      entity_key: { kind: 'action', call: 'call_mcp_1' },
      format_verified: false,
      payload: { tool: 'cua_repl/js', action_kind: 'mcp', input: mcpItem.arguments },
    },
    {
      kind: 'action_end',
      urgent: false,
      format_verified: false,
      payload: { outcome: 'ok', output: 'Example', duration_ms: 1500, result: mcpItem.result },
    },
  ])
  expect(mcp({ result: { content: [], isError: true } })[1]).toMatchObject({
    urgent: true,
    payload: { outcome: 'error', output: null },
  })
  expect(mcp({ status: 'failed', result: null, arguments: undefined })).toMatchObject([
    { urgent: false, payload: { input: null } },
    { urgent: true, payload: { outcome: 'error', output: null, result: null } },
  ])
})

test('turn settings read the observed variants of approval policy, effort and sandbox', () => {
  const settings = (changes: Record<string, unknown>) =>
    parseFacts(withPayload('turn_context.real.json', changes), real)[0]?.payload

  expect(
    settings({
      approval_policy: { granular: { sandbox_approval: false, request_permissions: true } },
      effort: 'xhigh',
      sandbox_policy: { type: 'workspace-write' },
    }),
  ).toEqual({ model: 'gpt-6.1-sol', effort: 'xhigh', approval_policy: 'granular', sandbox: 'workspace-write' })
  expect(settings({ collaboration_mode: { settings: { reasoning_effort: 'high' } } })).toMatchObject({ effort: 'high' })
  expect(settings({ approval_policy: { a: 1, b: 2 }, sandbox_policy: null, model: null })).toMatchObject({
    approval_policy: null,
    sandbox: null,
    model: null,
  })
  expect(settings({ approval_policy: ['never'] })).toMatchObject({ approval_policy: null })
})

test('turn ends keep unrecognized abort reasons and missing final messages', () => {
  expect(parseFacts(withPayload('event_msg.turn_aborted.mock-tui.json', { reason: 'replaced' }), real)).toMatchObject([
    { kind: 'turn_end', payload: { outcome: 'unknown', reason: 'replaced' } },
  ])
  expect(parseFacts(withPayload('event_msg.turn_aborted.mock-tui.json', { reason: null }), real)).toMatchObject([
    { payload: { outcome: 'unknown', reason: null } },
  ])
  expect(
    parseFacts(
      withPayload('event_msg.task_complete.real.json', { last_agent_message: null, turn_id: undefined }),
      real,
    ),
  ).toMatchObject([{ runtime_ids: { turn_id: null }, payload: { outcome: 'completed', final_message: null } }])
})

test('session_meta variants classify roots, observers and service threads', () => {
  const meta = (changes: Record<string, unknown>) => {
    const line = withPayload('session_meta.exec.real.json', changes)
    return parseFacts(line, streamFrom(line))
  }

  expect(meta({ originator: 'aang_observer', git: { branch: 'main' }, timestamp: 'later' })).toMatchObject([
    {
      kind: 'session_start',
      at: EpochNs.parse(1_790_855_758_087_000_000n),
      runtime_env: { git_branch: 'main' },
      payload: { observer_marker: true },
    },
  ])
  expect(meta({ session_id: undefined, cwd: undefined, timestamp: undefined })).toMatchObject([
    { kind: 'session_start', entity_key: { session: realThread }, payload: { cwd: null } },
  ])
  expect(meta({ session_id: root, source: { subagent: { other: 'memory_writer' } } })).toMatchObject([
    {
      kind: 'agent_start',
      payload: { role: 'service', service: null, agent_type: 'memory_writer', parent: null, depth: null },
    },
  ])
  expect(
    meta({ session_id: root, parent_thread_id: parentThread, agent_path: '/root/a/b', agent_role: 'explorer' }),
  ).toMatchObject([
    {
      kind: 'agent_start',
      payload: {
        role: 'subagent',
        agent_role: 'explorer',
        description: '/root/a/b',
        parent: { kind: 'thread', thread_id: parentThread },
      },
    },
  ])
})

test('messages inside a sub-agent thread are addressed to agents and prompts there are not human', () => {
  expect(
    parseFacts(withItem('event_msg.item_completed.AgentMessage.final.real.json', { phase: 'commentary' }), child),
  ).toMatchObject([{ kind: 'message', urgent: false, payload: { final: false, audience: 'agent' } }])
  expect(parseFacts(sampleLine('event_msg.item_completed.UserMessage.real.json'), child)).toMatchObject([
    { kind: 'prompt', speaker: 'runtime', payload: { origin: 'unknown' } },
  ])
  expect(
    parseFacts(
      withItem('event_msg.item_completed.AgentMessage.question-async.mock.json', {
        delivery: undefined,
        questions: [{ title: 'Continue?' }],
      }),
      real,
    )[1],
  ).toMatchObject({
    kind: 'question_asked',
    payload: { blocking: true, questions: [{ text: 'Continue?', options: [] }] },
  })
})

test('reasoning is recognized and never becomes content', () => {
  const reasoning = withItem('event_msg.item_completed.ContextCompaction.real.json', {
    type: 'Reasoning',
    summary: [],
    encrypted_content: 'gAAAA',
  })
  expect(parseFacts(reasoning, real)).toEqual([])
  expect(parseFacts(withPayload('response_item.message.assistant.real.json', { type: 'reasoning' }), real)).toEqual([])
})

test('item times fall back to the line time when the item omits or garbles them', () => {
  const lineTime = EpochNs.parse(1_790_856_018_085_000_000n)

  expect(
    parseFacts(withPayload('event_msg.item_completed.ContextCompaction.real.json', { started_at_ms: undefined }), real),
  ).toMatchObject([{ kind: 'compaction', at: millis(1790856018085), payload: { phase: 'completed' } }])
  expect(
    parseFacts(
      withPayload('event_msg.item_completed.ContextCompaction.real.json', {
        started_at_ms: 1790856003175.5,
        completed_at_ms: undefined,
      }),
      real,
    ),
  ).toMatchObject([{ at: lineTime, payload: { phase: 'completed' } }])
  expect(
    parseFacts(
      withPayload('event_msg.item_completed.FileChange.mock.json', {
        started_at_ms: 1790856393300,
        completed_at_ms: -1,
      }),
      real,
    ),
  ).toMatchObject([
    { kind: 'action_start', at: millis(1790856393300) },
    { kind: 'action_end', at: EpochNs.parse(1_790_856_393_277_000_000n), payload: { duration_ms: null } },
  ])
})

test('command and call variants keep their observed outcome, kind and raw input', () => {
  const commandEnd = (changes: Record<string, unknown>) =>
    parseFacts(withItem('event_msg.item_completed.CommandExecution.real.json', changes), real)[1]
  const command = (changes: Record<string, unknown>) => commandEnd(changes)?.payload
  expect(commandEnd({ status: 'declined' })).toMatchObject({ urgent: false, payload: { outcome: 'denied' } })
  expect(command({ status: 'in_progress', duration: null, exit_code: null })).toMatchObject({
    outcome: 'unknown',
    exit_code: null,
    duration_ms: 0,
  })
  expect(command({ status: null, aggregated_output: null })).toMatchObject({ outcome: 'unknown', output: null })

  const call = (changes: Record<string, unknown>) =>
    parseFacts(withPayload('response_item.function_call.exec_command.mock.json', changes), real)[0]?.payload
  expect(call({ arguments: 'cmd=ls' })).toMatchObject({ input: 'cmd=ls' })
  expect(call({ arguments: '{"cmd": "ls"' })).toMatchObject({ input: '{"cmd": "ls"' })
  expect(call({ namespace: 'mcp__cua_repl', name: 'js' })).toMatchObject({
    tool: 'mcp__cua_repl/js',
    action_kind: 'mcp',
  })
  expect(call({ namespace: 'multi_agent_v1', name: 'wait_agent' })).toMatchObject({ action_kind: 'agent' })
  expect(call({ namespace: '', name: 'clock_sleep' })).toMatchObject({ tool: 'clock_sleep', action_kind: 'other' })
  expect(
    parseFacts(withPayload('response_item.custom_tool_call.exec-codemode.real.json', { name: 'js_repl' }), real)[0]
      ?.payload,
  ).toMatchObject({ tool: 'js_repl', action_kind: 'other' })
  expect(
    parseFacts(
      withPayload('response_item.function_call_output.mock.json', { internal_chat_message_metadata_passthrough: null }),
      real,
    )[0]?.runtime_ids,
  ).toMatchObject({ turn_id: null })
  expect(
    parseFacts(withItem('event_msg.item_completed.FileChange.mock.json', { stdout: '', stderr: null }), real)[1]
      ?.payload,
  ).toMatchObject({ output: null })
  expect(
    parseFacts(withItem('event_msg.item_completed.FileChange.mock.json', { status: 'failed' }), real),
  ).toMatchObject([
    { kind: 'action_start', urgent: false },
    { kind: 'action_end', urgent: true, payload: { outcome: 'error' } },
  ])
})

test('usage records count each response once under the thread of the file and reject inconsistent token counts', () => {
  const usage = (changes: Record<string, unknown>) => withPayload('token_usage_record.real.json', changes)
  const tokens = (input: number, cached: number, write?: number) => ({
    input_tokens: input,
    cached_input_tokens: cached,
    cache_write_input_tokens: write,
    output_tokens: 3,
    reasoning_output_tokens: null,
    total_tokens: input + 3,
  })

  expect(parseFacts(usage({ thread_id: 'another-thread', session_id: 'another-root' }), real)[0]?.entity_key).toEqual({
    kind: 'usage',
    runtime: 'codex',
    session: realThread,
    usage: `${realThread}:resp_00a7ba1502c50863016abe4a6679b887d29972f57cdb348c7b`,
  })
  expect(
    parseFacts(usage({ usage: tokens(100, 60, 10), thread_token_usage: undefined, turn_id: undefined }), real),
  ).toMatchObject([
    {
      kind: 'usage',
      runtime_ids: { turn_id: null },
      payload: {
        tokens: {
          uncached_input_tokens: 30,
          cache_read_input_tokens: 60,
          cache_write_input_tokens: 10,
          output_tokens: 3,
          reasoning_output_tokens: null,
        },
      },
    },
  ])
  expect(
    parseFacts(usage({ usage: { input_tokens: 5, output_tokens: 1 }, thread_token_usage: undefined }), real)[0],
  ).toMatchObject({ payload: { tokens: { uncached_input_tokens: 5, cache_read_input_tokens: 0 } } })
  expectUnknown(usage({ usage: tokens(10, 20) }), real)
  expectUnknown(usage({ thread_token_usage: tokens(10, 20) }), real)
  expectUnknown(usage({ response_id: undefined }), real)
  expectUnknown(withPayload('event_msg.token_count.real.json', { info: { total_token_usage: tokens(10, 20) } }), real)
  expectUnknown(withPayload('event_msg.token_count.real.json', { info: 'unavailable' }), real)
  expect(parseFacts(withPayload('event_msg.token_count.real.json', { info: null }), real)).toEqual([])
  expect(parseFacts(withPayload('event_msg.token_count.real.json', { info: undefined }), real)).toEqual([])
})

test('sub-agent activity and collaboration calls keep unobserved variants unknown or unresolved', () => {
  const parent = threadStream(root)
  const activity = (changes: Record<string, unknown>) =>
    withItem('event_msg.item_completed.SubAgentActivity.started.mock.json', changes)

  expectUnknown(activity({ kind: 'interrupted' }), parent)
  expectUnknown(activity({ agent_thread_id: root }), parent)
  expectUnknown(activity({ agent_thread_id: undefined }), parent)
  expect(parseFacts(activity({ agent_path: undefined }), parent)[0]).toMatchObject({
    kind: 'agent_start',
    payload: { description: null },
  })
  expectUnknown(activity({}), child)
  expect(parseFacts(activity({ agent_thread_id: 'grandchild-thread' }), child)[0]).toMatchObject({
    entity_key: { session: root, agent: { kind: 'thread', thread_id: 'grandchild-thread' } },
    payload: { parent: { kind: 'thread', thread_id: '01a0f75c-46d2-7430-92a2-c3b0cd5d85b6' } },
  })

  const collab = (changes: Record<string, unknown>) =>
    parseFacts(withItem('event_msg.item_completed.CollabAgentToolCall.wait.mock.json', changes), parent)
  expect(
    collab({
      status: 'failed',
      sender_thread_id: undefined,
      receiver_thread_ids: undefined,
      agents_states: undefined,
      started_at_ms: undefined,
    }),
  ).toMatchObject([
    { kind: 'action_start', payload: { input: { sender_thread_id: null, receiver_thread_ids: [], prompt: null } } },
    { kind: 'action_end', urgent: true, payload: { outcome: 'error', result: null } },
  ])
  expectUnknown(withItem('event_msg.item_completed.CollabAgentToolCall.wait.mock.json', { tool: '' }), parent)
})

test('inter-agent messages keep only readable text and compaction records keep only a readable summary', () => {
  const parent = threadStream(root)
  const message = (changes: Record<string, unknown>) =>
    withPayload('response_item.agent_message.child-final-to-parent.mock.json', changes)

  expect(
    parseFacts(
      message({
        content: [
          { type: 'input_text', text: 'Payload:\n' },
          { type: 'encrypted_content', encrypted_content: 'gAAAA-task' },
        ],
        internal_chat_message_metadata_passthrough: null,
      }),
      parent,
    ),
  ).toMatchObject([{ kind: 'message', runtime_ids: { turn_id: null }, payload: { text: 'Payload:\n' } }])
  expectUnknown(message({ content: 'CHILD DONE' }), parent)
  expect(parseFacts(sampleLine('inter_agent_communication_metadata.mock.json'), parent)).toEqual([])

  expect(parseFacts(withPayload('compacted.inline-local.mock.json', { message: 'summary' }), real)).toMatchObject([
    { kind: 'compaction', urgent: true, payload: { phase: 'boundary', summary: 'summary' } },
  ])
  expectUnknown(withPayload('compacted.remote.real.json', { message: null }), real)
})
