import { claudeAdapter } from '@aang/adapter-claude'
import { FactDraft, type FactKind, type SpoolEnv } from '@aang/contract'
import { describe, test } from 'vitest'
import {
  cliEnv,
  factsOf,
  hookEvent,
  hookRecord,
  hookSamples,
  type JsonObject,
  observedAt,
  parseHookSample,
  readJsonSample,
  readSample,
} from './samples.js'

const sessionEvents: Readonly<Record<string, FactKind>> = {
  SessionEnd: 'session_end',
  UserPromptSubmit: 'turn_start',
  Stop: 'turn_end',
  SubagentStart: 'agent_start',
  SubagentStop: 'agent_end',
  PreCompact: 'compaction',
  PostCompact: 'compaction',
  InstructionsLoaded: 'instructions_loaded',
  MessageDisplay: 'runtime_event',
}

const expectedKind = (payload: JsonObject): FactKind | undefined => {
  const event = payload.hook_event_name
  if (event === 'SessionStart') {
    return payload.source === 'compact' ? 'runtime_event' : 'session_start'
  }
  return typeof event === 'string' ? sessionEvents[event] : undefined
}

const parseCli = async (name: string, env?: SpoolEnv) =>
  factsOf(
    claudeAdapter.parse(
      hookRecord({ payload: await readSample(`claude-code-hooks/${name}`), file: name, env: env ?? (await cliEnv()) }),
    ),
  )

const sessionStart = (env: SpoolEnv) => parseCli('SessionStart.startup.json', env)

const synthetic = (payload: JsonObject, file = 'synthetic.hook') =>
  claudeAdapter.parse(hookRecord({ payload: JSON.stringify(payload), file }))

const session = '80e34e98-8248-4fe4-b913-0bed557bed27'

const common = { session_id: session, transcript_path: '/home/user/.claude/projects/p/s.jsonl', cwd: '/work' }

describe.concurrent('Claude hooks: acceptance on samples', () => {
  test('every hook sample of every surface is parsed, none is unknown or invalid', async ({ expect }) => {
    const samples = await hookSamples()

    expect(samples.length).toBeGreaterThanOrEqual(70)
    for (const sample of samples) {
      const result = parseHookSample(sample)
      expect(result.parse_state, sample.name).toBe('parsed')
      for (const fact of factsOf(result)) {
        expect(FactDraft.parse(fact), sample.name).toEqual(fact)
      }
    }
  })

  test('every session, turn, agent and compaction sample yields a fact of the expected kind, session and agent', async ({
    expect,
  }) => {
    const samples = (await hookSamples()).filter((sample) => {
      const event = hookEvent(sample)
      return event === 'SessionStart' || (typeof event === 'string' && event in sessionEvents)
    })

    expect(samples.length).toBeGreaterThanOrEqual(40)
    for (const sample of samples) {
      const payload = JSON.parse(sample.payload) as JsonObject
      const facts = factsOf(parseHookSample(sample))
      const [fact] = facts
      const agent = payload.agent_id ?? null

      expect(facts, sample.name).toHaveLength(1)
      expect(fact?.kind, sample.name).toBe(expectedKind(payload))
      expect(fact?.entity_key.session, sample.name).toBe(payload.session_id)
      expect(fact?.runtime_ids.session_id, sample.name).toBe(payload.session_id)
      expect(fact?.runtime_ids.agent_id, sample.name).toBe(agent)
      expect(fact?.runtime_ids.prompt_id, sample.name).toBe(payload.prompt_id ?? null)
      expect(fact?.entity_key, sample.name).toMatchObject(
        typeof agent === 'string'
          ? { kind: 'agent', runtime: 'claude', agent: { kind: 'subagent', agent_id: agent } }
          : { kind: 'session', runtime: 'claude' },
      )
      expect(fact?.at, sample.name).toBe(observedAt)
      expect(fact?.format_verified, sample.name).toBe(true)
      expect(fact?.redelivery_key, sample.name).toMatch(/^[0-9a-f]{64}$/)
    }
  })
})

describe.concurrent('Claude hooks: session', () => {
  test('SessionStart startup, resume and fork are launches of the session with its cwd', async ({ expect }) => {
    const launches = await Promise.all(
      ['startup', 'resume', 'fork'].map(async (source) => (await parseCli(`SessionStart.${source}.json`))[0]),
    )

    expect(launches.map((fact) => [fact?.kind, fact?.speaker, fact?.urgent, fact?.payload])).toEqual([
      [
        'session_start',
        'runtime',
        false,
        {
          launch: 'startup',
          surface: { surface: 'claude_cli', basis: 'observed' },
          cwd: '/tmp/aang-spike/cc-hooks/runs/A',
          forked_from: null,
          observer_marker: false,
        },
      ],
      [
        'session_start',
        'runtime',
        false,
        expect.objectContaining({ launch: 'resume', cwd: '/tmp/aang-spike/cc-hooks/runs/A-resume' }),
      ],
      ['session_start', 'runtime', false, expect.objectContaining({ launch: 'fork', forked_from: null })],
    ])
    expect(launches[2]?.entity_key).toEqual({
      kind: 'session',
      runtime: 'claude',
      session: '4c80e3c2-e653-4dc7-81cb-20f6484aa3f3',
    })
  })

  test('SessionStart after compaction is not a launch but a generic event of the session', async ({ expect }) => {
    const [event] = await parseCli('SessionStart.compact.json')

    expect(event).toMatchObject({
      kind: 'runtime_event',
      entity_key: { kind: 'session', session },
      speaker: 'runtime',
      urgent: false,
      format_verified: true,
      payload: { event: 'SessionStart', data: { source: 'compact', model: 'claude-opus-5-5' } },
    })
  })

  test('a clear, an unfamiliar or a missing source gives the matching launch kind', async ({ expect }) => {
    const sample = await readJsonSample('claude-code-hooks/SessionStart.startup.json')
    const launchOf = (source: string | null) => {
      const [fact] = factsOf(synthetic({ ...sample, source }))
      return fact?.kind === 'session_start' ? fact.payload.launch : fact?.kind
    }

    expect(launchOf('clear')).toBe('clear')
    expect(launchOf('teleport')).toBe('unknown')
    expect(launchOf(null)).toBe('unknown')
  })

  test('the surface comes from the hook header, the SDK marker wins over the inherited CLI entrypoint', async ({
    expect,
  }) => {
    const surfaceOf = async (env: SpoolEnv) => {
      const [fact] = await sessionStart(env)
      return fact?.kind === 'session_start' ? fact.payload.surface : undefined
    }
    const sdkVersion = '0.3.286'

    expect(await surfaceOf({ CLAUDE_CODE_ENTRYPOINT: 'cli' })).toEqual({ surface: 'claude_cli', basis: 'observed' })
    expect(await surfaceOf({ CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' })).toEqual({ surface: 'claude_cli', basis: 'observed' })
    expect(await surfaceOf({ CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' })).toEqual({ surface: 'claude_sdk', basis: 'observed' })
    expect(await surfaceOf({ CLAUDE_CODE_ENTRYPOINT: 'sdk-py' })).toEqual({ surface: 'claude_sdk', basis: 'observed' })
    expect(
      await surfaceOf({ CLAUDE_CODE_ENTRYPOINT: 'sdk-cli', CLAUDE_AGENT_SDK_VERSION: sdkVersion }),
    ).toEqual({ surface: 'claude_sdk', basis: 'observed' })
    expect(await surfaceOf({ CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' })).toEqual({
      surface: 'claude_desktop',
      basis: 'observed',
    })
    expect(
      await surfaceOf({ CLAUDE_CODE_ENTRYPOINT: 'claude-desktop', CLAUDE_AGENT_SDK_VERSION: sdkVersion }),
    ).toEqual({ surface: 'claude_desktop', basis: 'observed' })
    expect(await surfaceOf({ CLAUDE_CODE_ENTRYPOINT: 'local-agent' })).toBeNull()
    expect(await surfaceOf({})).toBeNull()
  })

  test('the surfaces of the recorded CLI, SDK and Desktop sessions are recognised, a sample without a header has none', async ({
    expect,
  }) => {
    const surfaces = (await hookSamples())
      .filter((sample) => hookEvent(sample) === 'SessionStart')
      .flatMap((sample) => factsOf(parseHookSample(sample)))
      .flatMap((fact) => (fact.kind === 'session_start' ? [fact.payload.surface?.surface ?? null] : []))

    expect(new Set(surfaces)).toEqual(new Set(['claude_cli', 'claude_sdk', 'claude_desktop', null]))
  })

  test('an observer session keeps its marker and has no user surface', async ({ expect }) => {
    const [start] = await sessionStart({ CLAUDE_CODE_ENTRYPOINT: 'aang-observer' })

    expect(start?.payload).toMatchObject({ observer_marker: true, surface: null })
  })

  test('SessionEnd ends the session with its reason', async ({ expect }) => {
    const [end] = await parseCli('SessionEnd.json')
    const sample = await readJsonSample('claude-code-hooks/SessionEnd.json')
    const [withoutReason] = factsOf(synthetic({ ...sample, reason: null }))

    expect(end).toMatchObject({
      kind: 'session_end',
      entity_key: { kind: 'session', session },
      speaker: 'runtime',
      urgent: false,
      payload: { reason: 'other' },
    })
    expect(withoutReason?.payload).toEqual({ reason: null })
  })
})

describe.concurrent('Claude hooks: turns', () => {
  test('a submitted prompt starts a turn and leaves the prompt text to the transcript', async ({ expect }) => {
    const [start] = await parseCli('UserPromptSubmit.json')
    const [notification] = await parseCli('UserPromptSubmit.task-notification.json')

    expect(start).toMatchObject({
      kind: 'turn_start',
      entity_key: { kind: 'session', session },
      speaker: 'runtime',
      urgent: false,
      payload: {},
      runtime_ids: { prompt_id: '129d79dc-0dd6-45cf-9fa4-dfec38585d0c' },
    })
    expect(notification).toMatchObject({
      kind: 'turn_start',
      payload: {},
      runtime_ids: { prompt_id: 'e7c71ea9-8c0a-478c-915c-c7ce52338ffe' },
    })
  })

  test('Stop ends the turn with the final message and no background work', async ({ expect }) => {
    const [end] = await parseCli('Stop.json')

    expect(end).toMatchObject({
      kind: 'turn_end',
      entity_key: { kind: 'session', session },
      speaker: 'runtime',
      urgent: true,
      payload: { outcome: 'completed', reason: null, final_message: 'DONE', background_tasks: [] },
    })
  })

  test('Stop with a running background subagent lists it as a background task', async ({ expect }) => {
    const [end] = await parseCli('Stop.with-background-subagent.json')

    expect(end?.payload).toHaveProperty('final_message', expect.stringContaining('The echoer agent is still running'))
    expect(end?.payload).toMatchObject({
      outcome: 'completed',
      background_tasks: [
        {
          id: 'a2623c7ee141c2838',
          task_type: 'subagent',
          status: 'running',
          description: 'Run echo hi',
          agent_type: 'echoer',
        },
      ],
    })
  })

  test('Stop without background tasks or a final message keeps empty values', async ({ expect }) => {
    const sample = await readJsonSample('claude-code-hooks/Stop.json')
    const rest = Object.fromEntries(
      Object.entries(sample).filter(([key]) => key !== 'background_tasks' && key !== 'last_assistant_message'),
    )
    const [end] = factsOf(synthetic({ ...rest, background_tasks: [{ id: 'b1', type: 'shell', status: 'running' }] }))
    const [bare] = factsOf(synthetic(rest))

    expect(end?.payload).toMatchObject({
      final_message: null,
      background_tasks: [{ id: 'b1', task_type: 'shell', status: 'running', description: null, agent_type: null }],
    })
    expect(bare?.payload).toMatchObject({ final_message: null, background_tasks: [] })
  })

  test('a background task without its identity makes Stop invalid', async ({ expect }) => {
    const sample = await readJsonSample('claude-code-hooks/Stop.json')

    expect(synthetic({ ...sample, background_tasks: [{ type: 'subagent' }] })).toMatchObject({
      parse_state: 'invalid',
      reason: /Stop hook/,
    })
  })

  test('StopFailure ends the turn as failed with the error, unverified', ({ expect }) => {
    const [failure] = factsOf(
      synthetic({
        ...common,
        hook_event_name: 'StopFailure',
        prompt_id: 'p1',
        error: 'rate_limit',
        error_details: '429',
        last_assistant_message: 'partial',
      }),
    )
    const [bare] = factsOf(synthetic({ ...common, hook_event_name: 'StopFailure', error: 'unknown' }))

    expect(failure).toMatchObject({
      kind: 'turn_end',
      entity_key: { kind: 'session', session },
      urgent: true,
      format_verified: false,
      payload: { outcome: 'failed', reason: 'rate_limit', final_message: 'partial', background_tasks: [] },
    })
    expect(bare?.payload).toMatchObject({ outcome: 'failed', reason: 'unknown', final_message: null })
  })
})

describe.concurrent('Claude hooks: subagents', () => {
  const subagentSession = '2efd7dbe-c696-49b2-8c6e-3827c5256a01'
  const subagent = 'a0885622b68c3d0f1'
  const subagentProject = '/Users/USER/.claude/projects/-tmp-aang-spike-cc-hooks-runs-D-subagent'

  test('SubagentStart starts the subagent without knowing its parent or call', async ({ expect }) => {
    const [start] = await parseCli('SubagentStart.json')

    expect(start).toMatchObject({
      kind: 'agent_start',
      entity_key: {
        kind: 'agent',
        runtime: 'claude',
        session: subagentSession,
        agent: { kind: 'subagent', agent_id: subagent },
      },
      speaker: 'runtime',
      urgent: false,
      payload: {
        role: 'subagent',
        service: null,
        agent_type: 'echoer',
        agent_role: null,
        description: null,
        nickname: null,
        parent: null,
        spawned_by_call: null,
        background: null,
        depth: null,
      },
    })
  })

  test('SubagentStop ends the subagent with its final message and transcript', async ({ expect }) => {
    const [end] = await parseCli('SubagentStop.json')

    expect(end).toMatchObject({
      kind: 'agent_end',
      entity_key: { kind: 'agent', session: subagentSession, agent: { kind: 'subagent', agent_id: subagent } },
      speaker: 'runtime',
      urgent: true,
      payload: {
        outcome: 'completed',
        final_message: 'hi',
        agent_type: 'echoer',
        transcript_path: `${subagentProject}/${subagentSession}/subagents/agent-${subagent}.jsonl`,
      },
    })
  })

  test('the stop of the compaction agent keeps its empty type for the engine to recognise', async ({ expect }) => {
    const [end] = await parseCli('SubagentStop.internal-compaction.json')

    expect(end).toMatchObject({
      kind: 'agent_end',
      entity_key: { agent: { kind: 'subagent', agent_id: 'aba57616e9a18e7bc' } },
      payload: { agent_type: '' },
    })
    expect(end?.payload).toHaveProperty('transcript_path', expect.stringMatching(/subagents\/agent-aba57616e9a18e7bc\.jsonl$/))
    expect(end?.payload).toHaveProperty('final_message', expect.stringMatching(/^<analysis>/))
  })

  test('a subagent event without its agent id is invalid', async ({ expect }) => {
    const sample = await readJsonSample('claude-code-hooks/SubagentStart.json')
    const sampleStop = await readJsonSample('claude-code-hooks/SubagentStop.json')

    expect(synthetic({ ...sample, agent_id: null })).toMatchObject({ parse_state: 'invalid', reason: /SubagentStart hook/ })
    expect(synthetic({ ...sampleStop, agent_id: '' })).toMatchObject({ parse_state: 'invalid' })
  })
})

describe.concurrent('Claude hooks: compaction and instructions', () => {
  test('PreCompact starts a compaction and PostCompact completes it with the summary', async ({ expect }) => {
    const [started] = await parseCli('PreCompact.manual.json')
    const [completed] = await parseCli('PostCompact.manual.json')

    expect(started).toMatchObject({
      kind: 'compaction',
      entity_key: { kind: 'session', session },
      speaker: 'runtime',
      urgent: false,
      payload: { phase: 'started', trigger: 'manual', summary: null, tokens_before: null },
    })
    expect(completed).toMatchObject({
      kind: 'compaction',
      urgent: true,
      payload: { phase: 'completed', trigger: 'manual', tokens_before: null },
    })
    expect(completed?.payload).toHaveProperty('summary', expect.stringMatching(/^<analysis>/))
  })

  test('an automatic, unfamiliar or missing trigger is kept or reported as unknown', async ({ expect }) => {
    const sample = await readJsonSample('claude-code-hooks/PostCompact.manual.json')
    const triggerOf = (trigger: string | null) => factsOf(synthetic({ ...sample, trigger }))[0]?.payload

    expect(triggerOf('auto')).toMatchObject({ trigger: 'auto' })
    expect(triggerOf('budget')).toMatchObject({ trigger: 'unknown' })
    expect(triggerOf(null)).toMatchObject({ trigger: 'unknown' })
  })

  test('InstructionsLoaded names the loaded file, its memory type and the load reason', async ({ expect }) => {
    const [loaded] = await parseCli('InstructionsLoaded.session_start.json')
    const sample = await readJsonSample('claude-code-hooks/InstructionsLoaded.session_start.json')
    const [bare] = factsOf(synthetic({ ...sample, memory_type: null, load_reason: null }))

    expect(loaded).toMatchObject({
      kind: 'instructions_loaded',
      entity_key: { kind: 'session', session: '4c80e3c2-e653-4dc7-81cb-20f6484aa3f3' },
      speaker: 'runtime',
      urgent: false,
      payload: { path: '/tmp/aang-spike/cc-hooks/runs/A/CLAUDE.md', memory_type: 'Project', load_reason: 'session_start' },
    })
    expect(bare?.payload).toMatchObject({ memory_type: null, load_reason: null })
  })
})

describe.concurrent('Claude hooks: plan tasks', () => {
  const task = { ...common, prompt_id: 'p1', task_id: '3', task_subject: 'Write the parser' }

  test('a created and a completed task are unverified plan updates of the solver', ({ expect }) => {
    const [created] = factsOf(
      synthetic({ ...task, hook_event_name: 'TaskCreated', task_description: 'Parse the hook payloads' }),
    )
    const [completed] = factsOf(synthetic({ ...task, hook_event_name: 'TaskCompleted' }))

    expect(created).toMatchObject({
      kind: 'plan_update',
      entity_key: { kind: 'session', session },
      speaker: 'solver',
      urgent: true,
      format_verified: false,
      payload: {
        source: 'task_hook',
        text: 'Parse the hook payloads',
        items: [{ id: '3', text: 'Write the parser', status: 'pending' }],
      },
    })
    expect(completed?.payload).toEqual({
      source: 'task_hook',
      text: null,
      items: [{ id: '3', text: 'Write the parser', status: 'completed' }],
    })
  })

  test('a task of a teammate belongs to the teammate, a task inside a subagent to the subagent', ({ expect }) => {
    const [teammate] = factsOf(
      synthetic({ ...task, hook_event_name: 'TaskCreated', teammate_name: 'reviewer', team_name: 'core' }),
    )
    const [subagent] = factsOf(synthetic({ ...task, hook_event_name: 'TaskCompleted', agent_id: 'a1', team_name: 'core' }))

    expect(teammate?.entity_key).toEqual({
      kind: 'agent',
      runtime: 'claude',
      session,
      agent: { kind: 'teammate', name: 'reviewer', team: 'core' },
    })
    expect(subagent?.entity_key).toEqual({
      kind: 'agent',
      runtime: 'claude',
      session,
      agent: { kind: 'subagent', agent_id: 'a1' },
    })
  })

  test('a task without its id is invalid', ({ expect }) => {
    expect(synthetic({ ...task, hook_event_name: 'TaskCreated', task_id: null })).toMatchObject({
      parse_state: 'invalid',
      reason: /TaskCreated hook/,
    })
  })
})

describe.concurrent('Claude hooks: elicitation', () => {
  const elicitation = { ...common, prompt_id: 'p1', mcp_server_name: 'tracker', elicitation_id: 'el-1' }

  test('Elicitation is an urgent unverified question of the MCP server identified by its spool file', ({
    expect,
  }) => {
    const [question] = factsOf(
      synthetic(
        { ...elicitation, hook_event_name: 'Elicitation', message: 'Pick a project', mode: 'form', requested_schema: {} },
        'elicitation.hook',
      ),
    )

    expect(question).toMatchObject({
      kind: 'question_asked',
      entity_key: { kind: 'question', runtime: 'claude', session, question: 'elicitation.hook' },
      speaker: 'tool',
      urgent: true,
      format_verified: false,
      runtime_ids: { call_id: 'el-1' },
      payload: {
        source: 'elicitation',
        blocking: true,
        questions: [{ header: 'tracker', text: 'Pick a project', options: [] }],
      },
    })
  })

  test('an elicitation outside the spool cannot be identified and is invalid', ({ expect }) => {
    const result = claudeAdapter.parse(
      hookRecord({
        payload: JSON.stringify({ ...elicitation, hook_event_name: 'Elicitation', message: 'Pick' }),
        file: 'unused',
        position: 'otel',
      }),
    )

    expect(result.parse_state).toBe('invalid')
  })

  test('ElicitationResult is the human answer, paired with the request by the engine', ({ expect }) => {
    const result = (fields: JsonObject) =>
      factsOf(synthetic({ ...elicitation, hook_event_name: 'ElicitationResult', ...fields }))[0]

    expect(result({ action: 'accept', content: { project: 'aang', count: 2 } })).toMatchObject({
      kind: 'question_answered',
      entity_key: { kind: 'session', session },
      speaker: 'human',
      urgent: false,
      format_verified: false,
      runtime_ids: { call_id: 'el-1' },
      payload: {
        outcome: 'answered',
        answers: [
          { question: 'project', answer: 'aang' },
          { question: 'count', answer: '2' },
        ],
      },
    })
    expect(result({ action: 'accept', content: 'done' })?.payload).toEqual({
      outcome: 'answered',
      answers: [{ question: null, answer: 'done' }],
    })
    expect(result({ action: 'accept', mode: 'url', elicitation_id: null })).toMatchObject({
      runtime_ids: { call_id: null },
      payload: { outcome: 'answered', answers: [] },
    })
    expect(result({ action: 'decline', content: { project: 'aang' } })?.payload).toEqual({
      outcome: 'declined',
      answers: [],
    })
    expect(result({ action: 'cancel' })?.payload).toEqual({ outcome: 'cancelled', answers: [] })
  })

  test('an unfamiliar elicitation action is unknown', ({ expect }) => {
    expect(synthetic({ ...elicitation, hook_event_name: 'ElicitationResult', action: 'defer' })).toEqual({
      parse_state: 'unknown',
      source_ts: null,
    })
  })
})

describe.concurrent('Claude hooks: other events', () => {
  test('a displayed message delta is a verified generic event of the session', async ({ expect }) => {
    const [event] = await parseCli('MessageDisplay.json')

    expect(event).toMatchObject({
      kind: 'runtime_event',
      entity_key: { kind: 'session', session },
      speaker: 'runtime',
      urgent: false,
      format_verified: true,
      payload: { event: 'MessageDisplay', data: { delta: 'DONE', final: true, index: 0 } },
    })
  })

  test('an event outside the documented list stays unknown, so new runtime events are counted', ({ expect }) => {
    expect(synthetic({ ...common, hook_event_name: 'FutureEvent', detail: 1 })).toEqual({
      parse_state: 'unknown',
      source_ts: null,
    })
  })

  test('documented events without a dedicated fact are unverified generic events of their owner', ({ expect }) => {
    const events = [
      'Setup',
      'UserPromptExpansion',
      'TeammateIdle',
      'ConfigChange',
      'CwdChanged',
      'DirectoryAdded',
      'FileChanged',
      'WorktreeCreate',
      'WorktreeRemove',
      'PreModelSwitch',
      'PostModelSwitch',
    ]
    for (const event of events) {
      const [fact] = factsOf(synthetic({ ...common, hook_event_name: event, agent_id: 'a7', detail: 1 }))

      expect(fact, event).toMatchObject({
        kind: 'runtime_event',
        entity_key: { kind: 'agent', agent: { kind: 'subagent', agent_id: 'a7' } },
        format_verified: false,
        payload: { event, data: { hook_event_name: event, detail: 1 } },
      })
    }
  })
})
