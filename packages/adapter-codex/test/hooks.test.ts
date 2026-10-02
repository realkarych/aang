import { readdirSync, readFileSync } from 'node:fs'
import { codexAdapter } from '@aang/adapter-codex'
import { CollectedRecord, EpochNs, type FactDraft, type JsonValue, type SpoolEnv } from '@aang/contract'
import { canonicalJson, contentHash } from '@aang/contract/ids'
import { describe, expect, test } from 'vitest'
import { factsOf, parseFacts, sampleLine, streamFrom, threadStream } from './rollout-records.js'

const samplesRoot = new URL('../../../docs/research/samples/', import.meta.url)
const cliHooks = new URL('codex-cli/hooks/', samplesRoot)
const desktopHooks = new URL('desktop/exp-codex-desktop-appserver-hooks.jsonl', samplesRoot)
const hookConfig = 'hooks.json.logger-config.json'
const observedAt = EpochNs.parse(1_790_856_592_228_739_000n)
const cliEnv: SpoolEnv = { CODEX_HOME: '/tmp/aang-spike/codex-cli/home' }

const codexHookEvents = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PreCompact',
  'PostCompact',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'Interrupt',
  'SessionEnd',
]

type JsonObject = { readonly [key: string]: JsonValue }

const objectOf = (value: JsonValue | undefined): JsonObject => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('expected a JSON object')
  }
  return value
}

const unwrapCliSample = (name: string): JsonObject =>
  objectOf(objectOf(JSON.parse(readFileSync(new URL(name, cliHooks), 'utf8')) as JsonValue)['stdin'])

const cliSampleNames = (): string[] =>
  readdirSync(cliHooks)
    .filter((name) => name.endsWith('.json') && name !== hookConfig)
    .sort()

interface Delivery {
  readonly payload: string
  readonly file: string
  readonly env?: SpoolEnv
}

const hookRecord = ({ payload, file, env = cliEnv }: Delivery): CollectedRecord =>
  CollectedRecord.parse({
    channel: 'hook',
    runtime: 'codex',
    stream: null,
    position: { kind: 'spool', file },
    hook: { registration: 'user', env },
    observed_at: observedAt,
    payload,
  })

const spoolFileOf = (name: string): string => `codex-${name.replace(/\.json$/, '')}.spool`

const deliver = (payload: JsonObject, file = 'synthetic.spool', env?: SpoolEnv) =>
  codexAdapter.parse(hookRecord({ payload: JSON.stringify(payload), file, ...(env === undefined ? {} : { env }) }))

const hookFacts = (payload: JsonObject, file?: string, env?: SpoolEnv): FactDraft[] =>
  factsOf(deliver(payload, file, env))

const cliFacts = (name: string): FactDraft[] => hookFacts(unwrapCliSample(name), spoolFileOf(name))

const withSample = (name: string, changes: Record<string, JsonValue | undefined>): JsonObject =>
  Object.fromEntries(
    Object.entries({ ...unwrapCliSample(name), ...changes }).flatMap(([key, value]) =>
      value === undefined ? [] : [[key, value]],
    ),
  )

const askSession = '01a0f75b-f4bd-76c2-a690-3a3d92a00517'
const askTurn = '01a0f75b-f4e1-7003-8c73-7e2c422a9861'
const spawnRoot = '01a0f75c-465e-7a01-876f-c7df6fc989a0'
const spawnChild = '01a0f75c-46d2-7430-92a2-c3b0cd5d85b6'
const compactSession = '01a0f75c-caa3-7032-aff1-44dbbf58a79b'
const codeModeSession = '01a0f765-13c3-7170-8bc6-732d6a94bd8a'
const nestedCommand = 'exec-ec1259ae-952d-41b8-aafe-a810132cc20b'
const childRollout =
  '/tmp/aang-spike/codex-cli/home/sessions/2026/10/01/rollout-2026-10-01T15-06-54-01a0f75c-46d2-7430-92a2-c3b0cd5d85b6.jsonl'

const session = (id: string) => ({ kind: 'session', runtime: 'codex', session: id })
const action = (id: string, call: string) => ({ kind: 'action', runtime: 'codex', session: id, call })
const childAgent = {
  kind: 'agent',
  runtime: 'codex',
  session: spawnRoot,
  agent: { kind: 'thread', thread_id: spawnChild },
}
const childIds = { session_id: spawnRoot, agent_id: spawnChild, thread_id: spawnChild }

const expectations: Readonly<Record<string, readonly Record<string, unknown>[]>> = {
  'Interrupt.json': [
    {
      kind: 'turn_end',
      entity_key: session('01a0f765-4429-7c23-8d10-aea36a8d601b'),
      speaker: 'runtime',
      urgent: true,
      runtime_ids: { turn_id: '01a0f765-4454-74d1-8523-2749f1374bef' },
      payload: { outcome: 'interrupted', reason: null, final_message: null, background_tasks: [] },
    },
  ],
  'PermissionRequest.json': [
    {
      kind: 'permission_request',
      entity_key: {
        kind: 'question',
        runtime: 'codex',
        session: '01a0f75b-8043-70d2-95ed-39bd0831b81a',
        question: spoolFileOf('PermissionRequest.json'),
      },
      speaker: 'runtime',
      urgent: true,
      runtime_ids: { turn_id: '01a0f75b-8065-7f92-8294-0a64a7930991', call_id: null },
      payload: {
        tool: 'Bash',
        input: { command: 'touch /tmp/aang-spike-escalate-probe', description: 'aang spike approval probe' },
      },
    },
  ],
  'PreCompact.auto.json': [
    {
      kind: 'compaction',
      entity_key: session(compactSession),
      urgent: true,
      payload: { phase: 'started', trigger: 'auto', summary: null, tokens_before: null },
    },
  ],
  'PostCompact.auto.json': [
    {
      kind: 'compaction',
      entity_key: session(compactSession),
      urgent: true,
      payload: { phase: 'completed', trigger: 'auto' },
    },
  ],
  'PreToolUse.apply_patch.json': [
    {
      kind: 'action_start',
      entity_key: action('01a0f75b-7d68-7522-8475-d393ffeeda82', 'call_mock_5'),
      speaker: 'solver',
      urgent: false,
      runtime_ids: { call_id: 'call_mock_5', agent_id: null },
      payload: {
        tool: 'apply_patch',
        action_kind: 'file_write',
        input: { command: '*** Begin Patch\n*** Add File: patched.txt\n+hello\n*** End Patch\n' },
        description: null,
        container_call: null,
      },
    },
  ],
  'PostToolUse.apply_patch.json': [
    {
      kind: 'action_end',
      entity_key: action('01a0f75b-f1ae-7202-88d4-4759d4563cf9', 'call_mock_21'),
      speaker: 'tool',
      urgent: false,
      payload: {
        outcome: 'unknown',
        output: 'Exit code: 0\nWall time: 0 seconds\nOutput:\nSuccess. Updated the following files:\nA patched.txt\n',
        result: null,
      },
    },
  ],
  'PreToolUse.Bash.json': [
    {
      kind: 'action_start',
      entity_key: action(compactSession, 'call_mock_1'),
      payload: { tool: 'Bash', action_kind: 'command', input: { command: 'echo before-compact' } },
    },
  ],
  'PostToolUse.Bash.json': [
    {
      kind: 'action_end',
      entity_key: action(compactSession, 'call_mock_1'),
      payload: { outcome: 'unknown', output: 'before-compact\n' },
    },
  ],
  'PreToolUse.Bash.codemode-nested.json': [
    {
      kind: 'action_start',
      entity_key: action(codeModeSession, nestedCommand),
      runtime_ids: { call_id: nestedCommand },
      payload: { action_kind: 'command', input: { command: 'echo hi-from-js' }, container_call: null },
    },
  ],
  'PostToolUse.Bash.codemode-nested.json': [
    { kind: 'action_end', entity_key: action(codeModeSession, nestedCommand), payload: { output: 'hi-from-js\n' } },
  ],
  'PreToolUse.Bash.subagent.json': [
    {
      kind: 'action_start',
      entity_key: action(spawnRoot, 'call_mock_37'),
      runtime_ids: { ...childIds, call_id: 'call_mock_37' },
      payload: { action_kind: 'command', input: { command: 'echo from-child' } },
    },
  ],
  'PostToolUse.Bash.subagent.json': [
    {
      kind: 'action_end',
      entity_key: action(spawnRoot, 'call_mock_37'),
      runtime_ids: childIds,
      payload: { output: 'from-child\n' },
    },
  ],
  'PreToolUse.collaborationspawn_agent.json': [
    {
      kind: 'action_start',
      entity_key: action(spawnRoot, 'call_mock_33'),
      runtime_ids: { session_id: spawnRoot, agent_id: null, thread_id: spawnRoot },
      payload: { tool: 'collaborationspawn_agent', action_kind: 'agent' },
    },
  ],
  'PostToolUse.collaborationspawn_agent.json': [
    {
      kind: 'action_end',
      entity_key: action(spawnRoot, 'call_mock_33'),
      payload: { output: '{"task_name":"/root/probe_child"}', result: null },
    },
  ],
  'PreToolUse.collaborationwait_agent.json': [
    {
      kind: 'action_start',
      entity_key: action(spawnRoot, 'call_mock_35'),
      payload: { action_kind: 'agent', input: { timeout_ms: 20000 } },
    },
  ],
  'PostToolUse.collaborationwait_agent.json': [{ kind: 'action_end', entity_key: action(spawnRoot, 'call_mock_35') }],
  'PreToolUse.request_user_input_async.json': [
    {
      kind: 'action_start',
      entity_key: action(askSession, 'call_mock_25'),
      payload: {
        tool: 'request_user_input_async',
        action_kind: 'question',
        input: { questions: [{ title: 'Proceed with probe?', options: ['yes', 'no'] }] },
      },
    },
  ],
  'PostToolUse.request_user_input_async.json': [
    { kind: 'action_end', entity_key: action(askSession, 'call_mock_25'), payload: { output: '{"accepted":true}' } },
  ],
  'PreToolUse.request_user_input.json': [
    {
      kind: 'action_start',
      entity_key: action('01a0f75b-f7ca-77b0-abd8-183a27d6e25f', 'call_mock_29'),
      payload: { tool: 'request_user_input', action_kind: 'question' },
    },
  ],
  'SessionStart.startup.json': [
    {
      kind: 'session_start',
      entity_key: session(askSession),
      speaker: 'runtime',
      urgent: false,
      runtime_ids: { session_id: askSession, thread_id: askSession, turn_id: null },
      runtime_env: { cwd: '/tmp/aang-spike/codex-cli/m_ask', version: null, originator: null },
      payload: {
        launch: 'startup',
        surface: null,
        cwd: '/tmp/aang-spike/codex-cli/m_ask',
        forked_from: null,
        observer_marker: false,
      },
    },
  ],
  'SessionStart.resume.json': [
    {
      kind: 'session_start',
      entity_key: session('01a0f75a-a4b7-7361-aa8c-65ee90d82f99'),
      payload: { launch: 'resume' },
    },
  ],
  'SessionStart.fork.json': [
    {
      kind: 'session_start',
      entity_key: session('01a0f75f-4fc5-7bf0-9860-9766a76bffd7'),
      payload: { launch: 'fork', forked_from: null },
    },
  ],
  'SessionStart.compact.json': [
    {
      kind: 'compaction',
      entity_key: session(compactSession),
      urgent: true,
      payload: { phase: 'boundary', trigger: 'unknown' },
    },
  ],
  'UserPromptSubmit.json': [
    {
      kind: 'prompt',
      entity_key: {
        kind: 'message',
        runtime: 'codex',
        session: askSession,
        message: spoolFileOf('UserPromptSubmit.json'),
      },
      speaker: 'human',
      urgent: false,
      runtime_ids: { turn_id: askTurn },
      payload: { text: 'SCN_ASK', origin: 'human', origin_raw: null },
    },
  ],
  'Stop.json': [
    {
      kind: 'turn_end',
      entity_key: session(askSession),
      urgent: true,
      runtime_ids: { turn_id: askTurn },
      payload: { outcome: 'completed', reason: null, final_message: 'ASK DONE', background_tasks: [] },
    },
  ],
  'SessionEnd.json': [
    { kind: 'session_end', entity_key: session(askSession), urgent: false, payload: { reason: 'other' } },
  ],
  'SubagentStart.json': [
    {
      kind: 'agent_start',
      entity_key: childAgent,
      speaker: 'runtime',
      urgent: false,
      runtime_ids: { ...childIds, turn_id: '01a0f75c-46f1-7091-8408-199407132c7c' },
      payload: {
        role: 'subagent',
        service: null,
        agent_type: 'default',
        parent: null,
        spawned_by_call: null,
        depth: null,
      },
    },
  ],
  'SubagentStop.json': [
    {
      kind: 'agent_end',
      entity_key: childAgent,
      urgent: true,
      runtime_ids: childIds,
      payload: {
        outcome: 'completed',
        final_message: 'CHILD DONE',
        agent_type: 'default',
        transcript_path: childRollout,
      },
    },
  ],
}

describe('Codex CLI hook samples', () => {
  test('every hook sample has an expectation and together they cover all twelve events', () => {
    expect(Object.keys(expectations).sort()).toEqual(cliSampleNames())
    expect(new Set(cliSampleNames().map((name) => unwrapCliSample(name)['hook_event_name']))).toEqual(
      new Set(codexHookEvents),
    )
  })

  test.each(Object.entries(expectations))('%s', (name, expected) => {
    const stdin = unwrapCliSample(name)
    const result = codexAdapter.parse(hookRecord({ payload: JSON.stringify(stdin), file: spoolFileOf(name) }))

    expect(result).toMatchObject({ parse_state: 'parsed', source_ts: null })
    const facts = factsOf(result)
    expect(facts).toMatchObject(expected)
    for (const fact of facts) {
      expect(fact).toMatchObject({
        at: observedAt,
        format_verified: true,
        redelivery_key: contentHash(canonicalJson(stdin)),
        runtime_ids: { session_id: stdin['session_id'], ordinal: null },
        runtime_env: { cwd: stdin['cwd'] },
      })
    }
  })
})

test('the Codex Desktop app-server hook log yields three sessions with the originator its environment carries', () => {
  const entries = readFileSync(desktopHooks, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => objectOf(JSON.parse(line) as JsonValue))
  const facts = entries.map((entry, index) => {
    const env = objectOf(entry['env'])
    const originator = env['CODEX_INTERNAL_ORIGINATOR_OVERRIDE']
    return hookFacts(objectOf(entry['payload']), `desktop-${String(index)}.spool`, {
      ...(typeof env['CODEX_HOME'] === 'string' ? { CODEX_HOME: env['CODEX_HOME'] } : {}),
      ...(typeof originator === 'string' ? { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: originator } : {}),
    })
  })
  const runOf = ['session_start', 'prompt', 'action_start', 'action_end', 'turn_end', 'session_end']

  expect(facts.map((list) => list.map((fact) => fact.kind)).flat()).toEqual([...runOf, ...runOf, ...runOf])
  expect(facts.flat().map((fact) => fact.runtime_env.originator)).toEqual([
    ...Array<string>(12).fill('Codex'),
    ...Array<null>(6).fill(null),
  ])
  expect(new Set(facts.flat().map((fact) => fact.entity_key.session))).toEqual(
    new Set([
      '01a0f75d-a46d-7333-a7dc-5519c21c6018',
      '01a0f75e-44a5-7302-b927-12de93ab29f5',
      '01a0f75e-49bf-79a3-b3ea-33487e3255d8',
    ]),
  )
  expect(facts[2]?.[0]?.entity_key).toEqual(facts[3]?.[0]?.entity_key)
  expect(facts[2]?.[0]?.entity_key).toEqual(action('01a0f75d-a46d-7333-a7dc-5519c21c6018', 'call_mock_1'))
})

test('hook tool_use_id and agent_id address the same actions and agents as the rollout', () => {
  const patchRun = threadStream('01a0f75b-f1ae-7202-88d4-4759d4563cf9')
  const askRun = threadStream(askSession)
  const spawnRun = threadStream(spawnRoot)
  const interruptRun = threadStream('01a0f765-4429-7c23-8d10-aea36a8d601b')
  const childMeta = sampleLine('session_meta.subagent.thread_spawn.mock.json')
  const entity = (facts: readonly FactDraft[], index = 0) => facts[index]?.entity_key
  const rollout = (name: string, stream = spawnRun) => parseFacts(sampleLine(name), stream)

  expect(entity(cliFacts('PostToolUse.apply_patch.json'))).toEqual(
    entity(rollout('event_msg.item_completed.FileChange.mock.json', patchRun), 1),
  )
  expect(entity(cliFacts('PreToolUse.request_user_input_async.json'))).toEqual(
    entity(rollout('response_item.function_call.request_user_input_async.mock.json', askRun)),
  )
  expect(entity(cliFacts('PreToolUse.collaborationspawn_agent.json'))).toEqual(
    entity(rollout('response_item.function_call.spawn_agent.mock.json')),
  )
  expect(rollout('event_msg.item_completed.SubAgentActivity.started.mock.json')[0]).toMatchObject({
    payload: { spawned_by_call: 'call_mock_33' },
  })
  expect(entity(cliFacts('PostToolUse.collaborationwait_agent.json'))).toEqual(
    entity(rollout('event_msg.item_completed.CollabAgentToolCall.wait.mock.json'), 1),
  )
  expect(entity(cliFacts('SubagentStart.json'))).toEqual(entity(parseFacts(childMeta, streamFrom(childMeta))))
  expect(entity(cliFacts('SubagentStop.json'))).toEqual(
    entity(rollout('event_msg.item_completed.SubAgentActivity.completed.mock.json')),
  )
  expect(entity(cliFacts('Interrupt.json'))).toEqual(
    entity(rollout('event_msg.turn_aborted.mock-tui.json', interruptRun)),
  )
  expect(entity(cliFacts('PreCompact.auto.json'))).toEqual(
    entity(rollout('compacted.inline-local.mock.json', threadStream(compactSession))),
  )
})

test('hook payloads that are not objects are invalid and unrecognized or incomplete events stay unknown', () => {
  const unknown = { parse_state: 'unknown', source_ts: null }
  for (const payload of ['{"hook_event_name": "Stop"', '[1, 2]', '"Stop"']) {
    expect(codexAdapter.parse(hookRecord({ payload, file: 'broken.spool' }))).toEqual({
      parse_state: 'invalid',
      reason: 'hook payload is not a JSON object',
    })
  }
  const variants = [
    withSample('Stop.json', { hook_event_name: 'WorktreeCreate' }),
    withSample('Stop.json', { session_id: undefined }),
    withSample('Stop.json', { turn_id: 7 }),
    withSample('PreToolUse.Bash.json', { tool_use_id: undefined }),
    withSample('PreToolUse.Bash.json', { tool_input: undefined }),
    withSample('PostToolUse.Bash.json', { tool_response: undefined }),
    withSample('PermissionRequest.json', { tool_name: '' }),
    withSample('UserPromptSubmit.json', { prompt: undefined }),
    withSample('SessionStart.startup.json', { agent_id: spawnChild }),
    withSample('SessionEnd.json', { agent_id: spawnChild }),
    withSample('SubagentStart.json', { agent_id: undefined }),
    withSample('SubagentStop.json', { agent_id: spawnRoot }),
    withSample('Stop.json', { last_assistant_message: 7 }),
    withSample('PreCompact.auto.json', { trigger: 7 }),
  ]
  for (const variant of variants) {
    expect(deliver(variant)).toEqual(unknown)
  }
  const line = { kind: 'line', path: '/home/u/.codex/hooks.log', offset: 0, line: 1 } as const
  const notSpooled = CollectedRecord.parse({
    ...hookRecord({ payload: JSON.stringify(unwrapCliSample('Stop.json')), file: 'stop.spool' }),
    position: line,
  })
  expect(codexAdapter.parse(notSpooled)).toEqual(unknown)
})

test('a hook nested too deeply to read stays unknown and the next hook is still parsed', () => {
  const nested = (depth: number): JsonValue => JSON.parse(`${'['.repeat(depth)}0${']'.repeat(depth)}`) as JsonValue
  const tooDeep = nested(5000)
  const variants = [
    withSample('Stop.json', { extra: tooDeep }),
    withSample('Stop.json', { hook_event_name: 'FutureEvent', extra: tooDeep }),
    withSample('PreToolUse.Bash.json', { tool_input: tooDeep }),
  ]
  for (const variant of variants) {
    expect(deliver(variant)).toEqual({ parse_state: 'unknown', source_ts: null })
  }
  expect(cliFacts('Stop.json')).toMatchObject([{ kind: 'turn_end', payload: { outcome: 'completed' } }])
  expect(hookFacts(withSample('PreToolUse.Bash.json', { tool_input: nested(100) }))).toMatchObject([
    { kind: 'action_start', payload: { input: nested(100) } },
  ])
})

test('hook variants keep unobserved values open instead of guessing', () => {
  expect(hookFacts(withSample('SessionStart.startup.json', { source: 'clear' }))[0]).toMatchObject({
    payload: { launch: 'clear' },
  })
  expect(hookFacts(withSample('SessionStart.startup.json', { source: 'reload', cwd: undefined }))[0]).toMatchObject({
    runtime_env: { cwd: null },
    payload: { launch: 'unknown', cwd: null },
  })
  expect(hookFacts(withSample('SessionStart.startup.json', { source: undefined }))[0]).toMatchObject({
    payload: { launch: 'unknown' },
  })
  expect(hookFacts(withSample('PostCompact.auto.json', { trigger: 'manual' }))[0]).toMatchObject({
    payload: { trigger: 'manual' },
  })
  expect(hookFacts(withSample('PreCompact.auto.json', { trigger: undefined }))[0]).toMatchObject({
    payload: { trigger: 'unknown' },
  })
  expect(
    hookFacts(withSample('PostToolUse.Bash.json', { tool_response: { exit_code: 0, stdout: 'ok' } }))[0],
  ).toMatchObject({ payload: { output: null, result: { exit_code: 0, stdout: 'ok' } } })
  expect(hookFacts(withSample('SessionEnd.json', { reason: undefined }))[0]).toMatchObject({
    payload: { reason: null },
  })
  expect(hookFacts(withSample('SubagentStart.json', { agent_type: null }))[0]).toMatchObject({
    payload: { agent_type: null },
  })
  expect(hookFacts(withSample('SubagentStop.json', { agent_transcript_path: undefined }))[0]).toMatchObject({
    payload: { transcript_path: null },
  })
  expect(
    hookFacts(withSample('SubagentStop.json', { agent_type: undefined, last_assistant_message: undefined }))[0],
  ).toMatchObject({ payload: { agent_type: null, final_message: null, transcript_path: childRollout } })
  expect(hookFacts(withSample('Stop.json', { last_assistant_message: null }))[0]).toMatchObject({
    payload: { final_message: null },
  })

  const toolKind = (tool: string, input: JsonValue = {}) =>
    hookFacts(withSample('PreToolUse.Bash.json', { tool_name: tool, tool_input: input }))[0]
  expect(toolKind('multi_agent_v1spawn_agent')).toMatchObject({ payload: { action_kind: 'agent' } })
  expect(toolKind('mcp__cua_repl__js')).toMatchObject({ payload: { action_kind: 'mcp' } })
  expect(toolKind('web_search', { query: 'aang', description: 'look it up' })).toMatchObject({
    payload: { action_kind: 'other', description: 'look it up' },
  })
})

test('events inside a sub-agent belong to its thread and its prompts do not speak for the human', () => {
  const inChild = { agent_id: spawnChild, session_id: spawnRoot }

  expect(hookFacts(withSample('UserPromptSubmit.json', inChild), 'child-prompt.spool')).toMatchObject([
    {
      kind: 'prompt',
      entity_key: { kind: 'message', session: spawnRoot, message: 'child-prompt.spool' },
      speaker: 'runtime',
      runtime_ids: childIds,
      payload: { origin: 'unknown' },
    },
  ])
  expect(hookFacts(withSample('Stop.json', inChild))).toMatchObject([{ kind: 'turn_end', entity_key: childAgent }])
  expect(hookFacts(withSample('PostCompact.auto.json', inChild))).toMatchObject([
    { kind: 'compaction', entity_key: childAgent },
  ])
  expect(hookFacts(withSample('Interrupt.json', inChild))).toMatchObject([{ kind: 'turn_end', entity_key: childAgent }])
})

test('a hook delivered twice keeps two episodes that share one redelivery key', () => {
  const stdin = unwrapCliSample('PermissionRequest.json')
  const first = hookRecord({ payload: JSON.stringify(stdin), file: '1790856592-1.spool' })
  const second = hookRecord({ payload: JSON.stringify(stdin), file: '1790856592-2.spool' })
  const [firstFact] = factsOf(codexAdapter.parse(first))
  const [secondFact] = factsOf(codexAdapter.parse(second))

  expect(codexAdapter.rawKey(first)).toBe('hook:1790856592-1.spool')
  expect(codexAdapter.rawKey(second)).toBe('hook:1790856592-2.spool')
  expect(firstFact?.entity_key).not.toEqual(secondFact?.entity_key)
  expect(firstFact?.redelivery_key).toBe(secondFact?.redelivery_key)
  expect(
    hookFacts(withSample('PermissionRequest.json', { tool_input: { command: 'ls' } }))[0]?.redelivery_key,
  ).not.toBe(firstFact?.redelivery_key)
})

test('a session started by the aang observer is marked from the originator in its hook environment', () => {
  expect(
    hookFacts(unwrapCliSample('SessionStart.startup.json'), 'observer.spool', {
      CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'aang_observer',
    }),
  ).toMatchObject([{ runtime_env: { originator: 'aang_observer' }, payload: { observer_marker: true } }])
})

test('the originator override in the hook environment names Desktop and the TUI only as assumed surfaces', () => {
  const surfaceWith = (originator?: string) =>
    hookFacts(
      unwrapCliSample('SessionStart.startup.json'),
      'surface.spool',
      originator === undefined ? cliEnv : { ...cliEnv, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: originator },
    )[0]?.payload

  expect(surfaceWith('Codex Desktop')).toMatchObject({
    surface: { surface: 'codex_desktop', basis: 'assumed' },
    observer_marker: false,
  })
  expect(surfaceWith('codex-tui')).toMatchObject({ surface: { surface: 'codex_tui', basis: 'assumed' } })
  expect(surfaceWith('codex_exec')).toMatchObject({ surface: null })
  expect(surfaceWith('aang_observer')).toMatchObject({ surface: null, observer_marker: true })
  expect(surfaceWith()).toMatchObject({ surface: null, observer_marker: false })
})
