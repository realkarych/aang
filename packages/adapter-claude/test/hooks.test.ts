import { claudeAdapter } from '@aang/adapter-claude'
import { FactDraft, type FactKind, type JsonValue, type SpoolEnv } from '@aang/contract'
import { describe, test } from 'vitest'
import {
  cliEnv,
  factsOf,
  hookRecord,
  hookEvent,
  hookSamples,
  type JsonObject,
  nestedArrays,
  observedAt,
  parseHookSample,
  readJsonSample,
  readSample,
  spoolEnv,
} from './samples.js'

const toolEvents: Readonly<Record<string, FactKind>> = {
  PreToolUse: 'action_start',
  PostToolUse: 'action_end',
  PostToolUseFailure: 'action_end',
  PostToolBatch: 'tool_batch_end',
  PermissionRequest: 'permission_request',
  PermissionDenied: 'permission_denied',
  Notification: 'notification',
}

const parseCliSample = async (name: string, env?: SpoolEnv) =>
  factsOf(
    claudeAdapter.parse(
      hookRecord({ payload: await readSample(`claude-code-hooks/${name}`), file: name, env: env ?? (await cliEnv()) }),
    ),
  )

const parsePayload = (payload: JsonValue, file = 'synthetic.hook') =>
  claudeAdapter.parse(hookRecord({ payload: JSON.stringify(payload), file }))

const withPayload = async (name: string, change: (payload: JsonObject) => JsonObject): Promise<JsonObject> =>
  change(await readJsonSample(`claude-code-hooks/${name}`))

describe.concurrent('Claude hooks: tools and permissions', () => {
  test('every tool and permission sample yields a fact of the expected kind, session, agent and call', async ({
    expect,
  }) => {
    const samples = (await hookSamples()).filter((sample) => {
      const event = hookEvent(sample)
      return typeof event === 'string' && event in toolEvents
    })

    expect(samples.length).toBeGreaterThanOrEqual(30)
    for (const sample of samples) {
      const payload = JSON.parse(sample.payload) as JsonObject
      const [fact, ...links] = factsOf(parseHookSample(sample))
      const call = payload.tool_use_id ?? null
      const event = payload.hook_event_name

      for (const link of links) {
        expect(link.kind, sample.name).toBe('agent_start')
        expect(link.payload, sample.name).toHaveProperty('spawned_by_call', call)
      }
      expect(fact?.kind, sample.name).toBe(typeof event === 'string' ? toolEvents[event] : undefined)
      expect(fact?.entity_key.session, sample.name).toBe(payload.session_id)
      expect(fact?.runtime_ids.session_id, sample.name).toBe(payload.session_id)
      expect(fact?.runtime_ids.agent_id, sample.name).toBe(payload.agent_id ?? null)
      expect(fact?.runtime_ids.call_id, sample.name).toBe(call)
      if (call !== null) {
        expect(fact?.entity_key, sample.name).toEqual({
          kind: 'action',
          runtime: 'claude',
          session: payload.session_id,
          call,
        })
      }
      expect(fact?.at, sample.name).toBe(observedAt)
      expect(fact?.redelivery_key, sample.name).toMatch(/^[0-9a-f]{64}$/)
      expect(FactDraft.parse(fact), sample.name).toEqual(fact)
    }
  })

  test('PreToolUse starts an action the solver asked for, with the engine version and entrypoint from the header', async ({
    expect,
  }) => {
    const [start] = await parseCliSample('PreToolUse.Bash.json')

    expect(start).toMatchObject({
      kind: 'action_start',
      speaker: 'solver',
      urgent: false,
      format_verified: true,
      payload: {
        tool: 'Bash',
        action_kind: 'command',
        input: { command: 'echo hi', description: 'Print hi' },
        description: 'Print hi',
        container_call: null,
      },
      runtime_ids: { prompt_id: '129d79dc-0dd6-45cf-9fa4-dfec38585d0c' },
      runtime_env: {
        cwd: '/tmp/aang-spike/cc-hooks/runs/A',
        version: '2.1.286',
        entrypoint: 'sdk-cli',
        originator: null,
        git_branch: null,
      },
    })
  })

  test('the Agent tool is an agent action', async ({ expect }) => {
    const [start] = await parseCliSample('PreToolUse.Agent.json')

    expect(start?.payload).toMatchObject({ tool: 'Agent', action_kind: 'agent', description: 'Run echo hi' })
  })

  test('PostToolUse ends the action with the tool output, duration and full response', async ({ expect }) => {
    const [end] = await parseCliSample('PostToolUse.Bash.json')

    expect(end).toMatchObject({
      kind: 'action_end',
      speaker: 'tool',
      urgent: false,
      payload: {
        outcome: 'ok',
        output: 'hi',
        persisted_output_path: null,
        exit_code: null,
        duration_ms: 163,
        result: { stdout: 'hi', stderr: '', interrupted: false },
      },
    })
  })

  test('an Agent call ends with the subagent report, and a background launch ends without output', async ({
    expect,
  }) => {
    const [completed] = await parseCliSample('PostToolUse.Agent.completed.json')
    const [launched] = await parseCliSample('PostToolUse.Agent.async_launched.json')

    expect(completed?.payload).toMatchObject({ outcome: 'ok', output: 'hi', result: { agentId: 'a0885622b68c3d0f1' } })
    expect(launched?.payload).toMatchObject({
      outcome: 'ok',
      output: null,
      result: { status: 'async_launched', agentId: 'a2623c7ee141c2838' },
    })
  })

  test('a failed tool call is an urgent error with its exit code', async ({ expect }) => {
    const [end] = await parseCliSample('PostToolUseFailure.Bash.json')

    expect(end).toMatchObject({
      kind: 'action_end',
      urgent: true,
      payload: {
        outcome: 'error',
        output: 'Exit code 1\nls: missing-aang-file: No such file or directory',
        exit_code: 1,
        duration_ms: 16,
        result: null,
      },
    })
  })

  test('a response that is neither text nor an object has no output but is kept as the result', async ({ expect }) => {
    for (const response of [true, 42, null]) {
      const payload = await withPayload('PostToolUse.Bash.json', (sample) => ({ ...sample, tool_response: response }))
      const [end] = factsOf(parsePayload(payload))

      expect(end?.payload, String(response)).toMatchObject({ output: null, result: response })
    }
  })

  test('an interrupted tool call is not an error', async ({ expect }) => {
    const payload = await withPayload('PostToolUseFailure.Bash.json', (sample) => ({
      ...sample,
      is_interrupt: true,
      error: 'Interrupted by user',
    }))
    const [end] = factsOf(parsePayload(payload))

    expect(end).toMatchObject({ urgent: false, payload: { outcome: 'interrupted', exit_code: null } })
  })

  test('PostToolBatch lists the responses of the batch, including a denial by the human', async ({ expect }) => {
    const [batch] = await parseCliSample('PostToolBatch.denied-by-human.json')

    expect(batch).toMatchObject({
      kind: 'tool_batch_end',
      entity_key: { kind: 'session', runtime: 'claude', session: 'f955f573-761d-470e-8136-cc414dfd30d6' },
      speaker: 'runtime',
      urgent: false,
      payload: {
        calls: [
          { call_id: 'toolu_01BQ2R7qRobfqen21b28z5KR', tool: 'Bash', response: 'Denied by the human (aang probe).' },
        ],
      },
    })
  })

  test('a batch inside a subagent belongs to that subagent', async ({ expect }) => {
    const sample = await readJsonSample('claude-agent-sdk/hook-command-PostToolBatch-subagent.json')
    const [batch] = factsOf(
      claudeAdapter.parse(hookRecord({ payload: JSON.stringify(sample.stdin), file: 'batch-subagent' })),
    )

    expect(batch?.entity_key).toEqual({
      kind: 'agent',
      runtime: 'claude',
      session: '6eaeafd8-aaba-4304-92e9-0f823860947e',
      agent: { kind: 'subagent', agent_id: 'a489ecb7791c0c23e' },
    })
  })

  test('a batch call without a response keeps the call with an empty response', async ({ expect }) => {
    const payload = await withPayload('PostToolBatch.json', (sample) => ({
      ...sample,
      tool_calls: [{ tool_name: 'Bash', tool_input: { command: 'echo hi' }, tool_use_id: 'toolu_without_response' }],
    }))
    const [batch] = factsOf(parsePayload(payload))

    expect(batch?.payload).toEqual({ calls: [{ call_id: 'toolu_without_response', tool: 'Bash', response: null }] })
  })

  test('PermissionRequest is an urgent question identified by its spool file', async ({ expect }) => {
    const [request] = await parseCliSample('PermissionRequest.Bash.stdio-host.json')

    expect(request).toMatchObject({
      kind: 'permission_request',
      entity_key: {
        kind: 'question',
        runtime: 'claude',
        session: 'f955f573-761d-470e-8136-cc414dfd30d6',
        question: 'PermissionRequest.Bash.stdio-host.json',
      },
      speaker: 'runtime',
      urgent: true,
      payload: { tool: 'Bash', input: { command: 'touch probe-allow.txt' } },
      runtime_ids: { call_id: null },
    })
  })

  test('a permission request outside the spool cannot be identified and is invalid', async ({ expect }) => {
    const payload = await readSample('claude-code-hooks/PermissionRequest.Bash.json')
    const result = claudeAdapter.parse(hookRecord({ payload, file: 'unused', position: 'otel' }))

    expect(result.parse_state).toBe('invalid')
  })

  test('PermissionDenied of auto mode ends nothing by itself and is marked unverified', async ({ expect }) => {
    const payload = await withPayload('PreToolUse.Bash.json', (sample) => ({
      ...sample,
      hook_event_name: 'PermissionDenied',
      reason: '[Safety Bypass Flag] rm -rf',
    }))
    const [denied] = factsOf(parsePayload(payload))

    expect(denied).toMatchObject({
      kind: 'permission_denied',
      entity_key: { kind: 'action', call: 'toolu_01MH1t1W3xdWEY6B3Kthd9Aw' },
      speaker: 'runtime',
      urgent: false,
      format_verified: false,
      payload: { tool: 'Bash', reason: '[Safety Bypass Flag] rm -rf' },
    })
  })

  test('Notification permission_prompt is a verified notification of the session', async ({ expect }) => {
    const [notification] = await parseCliSample('Notification.permission_prompt.json')

    expect(notification).toMatchObject({
      kind: 'notification',
      entity_key: { kind: 'session', runtime: 'claude', session: 'f955f573-761d-470e-8136-cc414dfd30d6' },
      urgent: false,
      format_verified: true,
      payload: { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' },
    })
  })

  test('idle_prompt is an unverified notification, not a question', async ({ expect }) => {
    const payload = await withPayload('Notification.permission_prompt.json', (sample) => ({
      ...sample,
      notification_type: 'idle_prompt',
      message: 'Claude is waiting for your input',
    }))
    const [notification] = factsOf(parsePayload(payload))

    expect(notification).toMatchObject({
      kind: 'notification',
      format_verified: false,
      payload: { notification_type: 'idle_prompt' },
    })
  })

  test('elicitation and agent input notifications are urgent questions identified by their spool file', async ({
    expect,
  }) => {
    for (const type of ['elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input']) {
      const payload = await withPayload('Notification.permission_prompt.json', (sample) => ({
        ...sample,
        notification_type: type,
        title: 'MCP server needs input',
        message: 'Pick a project',
      }))
      const [question] = factsOf(parsePayload(payload, `${type}.hook`))

      expect(question, type).toMatchObject({
        kind: 'question_asked',
        entity_key: { kind: 'question', question: `${type}.hook` },
        speaker: 'runtime',
        urgent: true,
        format_verified: false,
        payload: {
          source: 'notification',
          blocking: true,
          questions: [{ header: 'MCP server needs input', text: 'Pick a project', options: [] }],
        },
      })
    }
  })

  test('a question notification outside the spool cannot be identified and is invalid', async ({ expect }) => {
    const payload = await withPayload('Notification.permission_prompt.json', (sample) => ({
      ...sample,
      notification_type: 'agent_needs_input',
    }))
    const result = claudeAdapter.parse(hookRecord({ payload: JSON.stringify(payload), file: 'unused', position: 'otel' }))

    expect(result.parse_state).toBe('invalid')
  })

  test('the entrypoint comes from the header: Desktop, SDK and the CLI print mode', async ({ expect }) => {
    const entrypoints = new Map<string, Set<string | null>>()
    for (const sample of await hookSamples()) {
      const directory = sample.name.split('/')[0] ?? ''
      const seen = entrypoints.get(directory) ?? new Set()
      for (const fact of factsOf(parseHookSample(sample))) {
        seen.add(fact.runtime_env.entrypoint)
      }
      entrypoints.set(directory, seen)
    }

    expect(Object.fromEntries(entrypoints)).toEqual({
      'claude-code-hooks': new Set(['sdk-cli']),
      'claude-agent-sdk': new Set(['sdk-ts', 'sdk-cli', null]),
      desktop: new Set(['claude-desktop']),
    })
  })

  test('a hook without header environment has no entrypoint and no engine version', async ({ expect }) => {
    const [start] = factsOf(parsePayload(await readJsonSample('claude-code-hooks/PreToolUse.Bash.json')))

    expect(start?.runtime_env).toMatchObject({ entrypoint: null, version: null })
  })

  test('an observer session keeps its marker in the entrypoint', async ({ expect }) => {
    const [start] = await parseCliSample('PreToolUse.Bash.json', {
      CLAUDE_CODE_ENTRYPOINT: 'aang-observer',
      AI_AGENT: 'claude-code_2-1-290_harness',
    })

    expect(start?.runtime_env).toMatchObject({ entrypoint: 'aang-observer', version: '2.1.290' })
  })

  test('an unrecognised AI_AGENT value gives no engine version', async ({ expect }) => {
    const [start] = await parseCliSample('PreToolUse.Bash.json', { AI_AGENT: 'other-agent' })

    expect(start?.runtime_env.version).toBeNull()
  })
})

describe.concurrent('Claude hooks: double delivery', () => {
  test('the same event from an SDK callback and a command hook shares the content key, not the record key', async ({
    expect,
  }) => {
    const command = await readJsonSample('claude-agent-sdk/hook-command-PreToolUse.json')
    const callback = await readJsonSample('claude-agent-sdk/hook-callback-PreToolUse.json')
    const commandRecord = hookRecord({
      payload: JSON.stringify(command.stdin),
      file: 'spool-a',
      env: spoolEnv(command.env_seen_by_hook_process),
    })
    const callbackRecord = hookRecord({ payload: JSON.stringify(callback.input, null, 1), file: 'spool-b' })
    const [first] = factsOf(claudeAdapter.parse(commandRecord))
    const [second] = factsOf(claudeAdapter.parse(callbackRecord))

    expect(first?.redelivery_key).toBe(second?.redelivery_key)
    expect(first?.entity_key).toEqual(second?.entity_key)
    expect(claudeAdapter.rawKey(commandRecord)).not.toBe(claudeAdapter.rawKey(callbackRecord))
  })

  test('two deliveries of one permission request are two questions with a common content key', async ({ expect }) => {
    const payload = await readSample('claude-code-hooks/PermissionRequest.Bash.json')
    const [plugin, sdk] = ['plugin-delivery', 'sdk-delivery'].map(
      (file) =>
        factsOf(
          claudeAdapter.parse(hookRecord({ payload, file, env: { CLAUDE_PLUGIN_ROOT: `/plugins/${file}` } })),
        )[0],
    )

    expect(plugin?.entity_key).not.toEqual(sdk?.entity_key)
    expect(plugin?.redelivery_key).toBe(sdk?.redelivery_key)
  })

  test('different events have different content keys', async ({ expect }) => {
    const keys = await Promise.all(
      ['PreToolUse.Bash.json', 'PostToolUse.Bash.json', 'PermissionRequest.Bash.json'].map(
        async (name) => (await parseCliSample(name))[0]?.redelivery_key,
      ),
    )

    expect(new Set(keys).size).toBe(3)
  })

  test('the record key is the spool file name, so a file read twice is one record', async ({ expect }) => {
    const payload = await readSample('claude-code-hooks/PreToolUse.Bash.json')

    expect(claudeAdapter.rawKey(hookRecord({ payload, file: 'same-file' }))).toBe(
      claudeAdapter.rawKey(hookRecord({ payload: `${payload}\n`, file: 'same-file' })),
    )
  })
})

describe.concurrent('Claude hooks: malformed payloads', () => {
  test('a payload that is not a JSON object is invalid', ({ expect }) => {
    for (const payload of ['not json', '[1,2]', 'null']) {
      expect(claudeAdapter.parse(hookRecord({ payload, file: 'broken' })).parse_state, payload).toBe('invalid')
    }
  })

  test('a known event without its identifiers is invalid', async ({ expect }) => {
    const sample = await readJsonSample('claude-code-hooks/PreToolUse.Bash.json')
    const withoutSession = Object.fromEntries(Object.entries(sample).filter(([key]) => key !== 'session_id'))
    const withoutCall = Object.fromEntries(Object.entries(sample).filter(([key]) => key !== 'tool_use_id'))

    expect(parsePayload(withoutSession)).toMatchObject({ parse_state: 'invalid', reason: /session_id/ })
    expect(parsePayload(withoutCall)).toMatchObject({ parse_state: 'invalid', reason: /PreToolUse hook/ })
    expect(parsePayload({ session_id: 's' })).toMatchObject({ parse_state: 'invalid', reason: /hook_event_name/ })
  })

  test('an event without a parser stays unknown even with an unexpected shape', ({ expect }) => {
    expect(parsePayload({ hook_event_name: 'FutureEvent', detail: 1 })).toEqual({ parse_state: 'unknown', source_ts: null })
  })

  test('a hook nested too deeply to read stays unknown and the next hook is still parsed', async ({ expect }) => {
    const tooDeep = nestedArrays(5000)
    const bash = await readJsonSample('claude-code-hooks/PreToolUse.Bash.json')
    const stop = await readJsonSample('claude-code-hooks/Stop.json')

    for (const payload of [
      { ...bash, tool_input: tooDeep },
      { ...stop, extra: tooDeep },
      { ...stop, hook_event_name: 'FutureEvent', extra: tooDeep },
    ]) {
      expect(parsePayload(payload)).toEqual({ parse_state: 'unknown', source_ts: null })
    }
    expect(await parseCliSample('Stop.json')).toMatchObject([{ kind: 'turn_end' }])
    expect(factsOf(parsePayload({ ...bash, tool_input: nestedArrays(100) }))).toMatchObject([
      { kind: 'action_start', payload: { input: nestedArrays(100) } },
    ])
  })
})
