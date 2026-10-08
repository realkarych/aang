import { claudeAdapter } from '@aang/adapter-claude'
import { CollectedRecord, FactDraft, type ParseResult } from '@aang/contract'
import { describe, test } from 'vitest'
import {
  cliEnv,
  factsOf,
  hookRecord,
  type JsonObject,
  lineRecord,
  nestedArrays,
  observedAt,
  readJsonSample,
  readSample,
  snapshotRecord,
  transcriptRecords,
} from './samples.js'

const projects = '/home/user/.claude/projects'
const mainSession = '86f93ed5-1acd-4c6e-8c60-f1c98335c2ef'
const subagent = 'aad616394e806288d'
const agentCall = 'toolu_01D254DDPoZEYPvJBjampKox'
const session = '0b5c2a51-7f4e-4d8e-9a43-2f1c8f6b9e10'
const teammateAgent = 'arev-0123456789abcdef'
const workflowAgent = 'a5c0820ae74966418'

const parsedFacts = (records: readonly CollectedRecord[]): FactDraft[] =>
  records.flatMap((record) => {
    const result = claudeAdapter.parse(record)
    return result.parse_state === 'parsed' ? result.facts : []
  })

const parseSnapshot = (path: string, content?: JsonObject | string): ParseResult =>
  claudeAdapter.parse(
    snapshotRecord({ path, content: typeof content === 'object' ? JSON.stringify(content) : content }),
  )

const parseHookPayload = (payload: JsonObject) =>
  claudeAdapter.parse(hookRecord({ payload: JSON.stringify(payload), file: 'synthetic.hook' }))

const parseCliHook = async (name: string) =>
  factsOf(
    claudeAdapter.parse(
      hookRecord({ payload: await readSample(`claude-code-hooks/${name}`), file: name, env: await cliEnv() }),
    ),
  )

const subagentKey = (owner: string, agent: string) => ({
  kind: 'agent',
  runtime: 'claude',
  session: owner,
  agent: { kind: 'subagent', agent_id: agent },
})

const teammateKey = { kind: 'agent', runtime: 'claude', session, agent: { kind: 'teammate', name: 'rev', team: 'core' } }

const teammateMeta = {
  agentType: 'reviewer',
  description: 'Review the parser',
  name: 'rev',
  spawnDepth: 1,
  requestShape: 'background',
  requestNonInteractive: true,
  model: 'opus',
  taskKind: 'in_process_teammate',
  teamName: 'core',
  color: 'blue',
  planModeRequired: false,
  permissionMode: 'auto',
}

const teammateSpawned = {
  status: 'teammate_spawned',
  prompt: 'Review the parser',
  teammate_id: 'rev@core',
  agent_id: 'rev@core',
  agent_type: 'reviewer',
  model: 'opus',
  name: 'rev',
  color: 'blue',
  team_name: 'core',
  is_splitpane: false,
  plan_mode_required: false,
}

const workflowSnapshot = {
  runId: 'wf_26936a42-d9c',
  timestamp: '2026-10-01T10:00:00.000Z',
  taskId: 'task-0001',
  script: 'export const meta = {}',
  scriptPath: '/home/user/.claude/workflows/review.js',
  args: { scratch: '/tmp/scratch' },
  result: { tracks: [{ verdict: 'ok' }] },
  agentCount: 2,
  logs: ['started'],
  durationMs: 120_000,
  summary: 'Two tracks reviewed',
  workflowName: 'review-changes',
  status: 'completed',
  startTime: 1_790_805_267_999,
  phases: [{ title: 'Review', detail: 'Review each track' }],
  defaultModel: 'opus',
  workflowProgress: [{ type: 'phase_started', index: 1, title: 'Review' }],
  totalTokens: 3_338_388,
  totalToolCalls: 1548,
}

describe.concurrent('Claude subagents: link to the Agent call', () => {
  test('the subagent is linked to its Agent call by meta.toolUseId and by toolUseResult.agentId', async ({
    expect,
  }) => {
    const main = parsedFacts(await transcriptRecords('claude-code-transcripts/session-86f93ed5-main-full.jsonl'))
    const meta = factsOf(
      parseSnapshot(
        `${projects}/-tmp-run/${mainSession}/subagents/agent-${subagent}.meta.json`,
        await readSample('claude-code-transcripts/subagent-agent-aad616394e806288d.meta.json'),
      ),
    )
    const own = parsedFacts(await transcriptRecords('claude-code-transcripts/subagent-agent-aad616394e806288d.jsonl'))
    const call = main.find((fact) => fact.kind === 'action_start' && fact.payload.tool === 'Agent')
    const links = main.filter((fact) => fact.kind === 'agent_start')

    expect(call?.entity_key).toEqual({ kind: 'action', runtime: 'claude', session: mainSession, call: agentCall })
    expect(links).toHaveLength(1)
    expect(links[0]).toMatchObject({
      entity_key: subagentKey(mainSession, subagent),
      speaker: 'runtime',
      urgent: false,
      format_verified: true,
      runtime_ids: { session_id: mainSession, agent_id: null, record_uuid: 'eeaa5b67-3cd5-4da9-8f65-9917210d3231' },
      payload: {
        role: 'subagent',
        agent_type: 'pinger',
        parent: { kind: 'main' },
        spawned_by_call: agentCall,
        background: false,
        depth: null,
      },
    })
    expect(meta).toEqual([
      {
        kind: 'json_snapshot',
        entity_key: subagentKey(mainSession, subagent),
        speaker: 'runtime',
        urgent: false,
        at: observedAt,
        runtime_ids: {
          session_id: mainSession,
          agent_id: subagent,
          thread_id: null,
          turn_id: null,
          prompt_id: null,
          record_uuid: null,
          parent_uuid: null,
          message_id: null,
          call_id: null,
          ordinal: null,
        },
        runtime_env: { cwd: null, version: null, entrypoint: null, originator: null, git_branch: null },
        format_verified: true,
        redelivery_key: null,
        payload: {
          file: 'agent_meta',
          path: `${projects}/-tmp-run/${mainSession}/subagents/agent-${subagent}.meta.json`,
          removed: false,
          content: { agent_type: 'pinger', description: 'Ping the pinger agent', tool_use_id: agentCall, spawn_depth: 1 },
        },
      },
      expect.objectContaining({
        kind: 'agent_start',
        entity_key: subagentKey(mainSession, subagent),
        format_verified: true,
        payload: {
          role: 'subagent',
          service: null,
          agent_type: 'pinger',
          agent_role: null,
          description: 'Ping the pinger agent',
          nickname: null,
          parent: null,
          spawned_by_call: agentCall,
          background: false,
          depth: 1,
        },
      }),
    ])
    expect(own.length).toBeGreaterThan(0)
    expect(own.every((fact) => fact.runtime_ids.session_id === mainSession && fact.runtime_ids.agent_id === subagent)).toBe(
      true,
    )
    for (const fact of [...meta, ...links]) {
      expect(FactDraft.parse(fact)).toEqual(fact)
    }
  })

  test('the SDK subagent meta names the call that spawned the agent seen in the SDK hooks', async ({ expect }) => {
    const sdkSession = '6eaeafd8-aaba-4304-92e9-0f823860947e'
    const sdkAgent = 'a489ecb7791c0c23e'
    const [, start] = factsOf(
      parseSnapshot(
        `${projects}/-tmp-aang-spike-cc-sdk-work/${sdkSession}/subagents/agent-${sdkAgent}.meta.json`,
        await readSample('claude-agent-sdk/transcript-subagent-meta.json'),
      ),
    )
    const hook = await readJsonSample('claude-agent-sdk/hook-command-PreToolUse-subagent.json')
    const [action] = factsOf(parseHookPayload(hook.stdin as JsonObject))

    expect(start).toMatchObject({
      entity_key: subagentKey(sdkSession, sdkAgent),
      payload: { agent_type: 'probe', spawned_by_call: 'toolu_01GCwzBDJaBLNrAKwM82buQy' },
    })
    expect(action?.runtime_ids).toMatchObject({ session_id: sdkSession, agent_id: sdkAgent })
  })

  test('the Agent hooks link a foreground and a background subagent to their calls as they happen', async ({
    expect,
  }) => {
    const [call] = await parseCliHook('PreToolUse.Agent.json')
    const [, foreground] = await parseCliHook('PostToolUse.Agent.completed.json')
    const [started] = await parseCliHook('SubagentStart.json')
    const [, background] = await parseCliHook('PostToolUse.Agent.async_launched.json')
    const [startedInBackground] = await parseCliHook('SubagentStart.background.json')

    expect(foreground).toMatchObject({
      kind: 'agent_start',
      entity_key: started?.entity_key,
      format_verified: true,
      payload: {
        role: 'subagent',
        agent_type: 'echoer',
        parent: { kind: 'main' },
        spawned_by_call: call?.entity_key.kind === 'action' ? call.entity_key.call : undefined,
        background: false,
      },
    })
    expect(background).toMatchObject({
      kind: 'agent_start',
      entity_key: startedInBackground?.entity_key,
      payload: { spawned_by_call: 'toolu_01AA8XhrNqeGRtbxPCzffMAk', background: true },
    })
  })

  test('an agent spawned inside a subagent has that subagent as its parent', async ({ expect }) => {
    const sample = await readJsonSample('claude-code-transcripts/rec-user-tool-result-agent-sync.json')
    const hook = await readJsonSample('claude-code-hooks/PostToolUse.Agent.completed.json')
    const [, fromTranscript] = factsOf(
      claudeAdapter.parse(lineRecord({ payload: JSON.stringify({ ...sample, agentId: 'aparent' }), line: 1 })),
    )
    const [, fromHook] = factsOf(parseHookPayload({ ...hook, agent_id: 'aparent', agent_type: 'planner' }))

    expect(fromTranscript?.payload).toMatchObject({ parent: { kind: 'subagent', agent_id: 'aparent' } })
    expect(fromHook?.payload).toMatchObject({ parent: { kind: 'subagent', agent_id: 'aparent' } })
  })

  test('a result without a spawned agent links nothing', async ({ expect }) => {
    const sample = await readJsonSample('claude-code-transcripts/rec-user-tool-result-agent-sync.json')
    const kindsOf = (fields: JsonObject) =>
      factsOf(claudeAdapter.parse(lineRecord({ payload: JSON.stringify({ ...sample, ...fields }), line: 1 }))).map(
        (fact) => fact.kind,
      )
    const toolUseResult = sample.toolUseResult as JsonObject

    expect(kindsOf({ toolUseResult: 'Error: agent failed' })).toEqual(['action_end'])
    expect(kindsOf({ toolUseResult: { ...toolUseResult, agentId: '' } })).toEqual(['action_end'])
    expect(kindsOf({ toolUseResult: { ...toolUseResult, status: 'killed' } })).toEqual(['action_end', 'agent_start'])
    expect(
      kindsOf({
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_a', content: 'a' },
            { type: 'tool_result', tool_use_id: 'toolu_b', content: 'b' },
          ],
        },
      }),
    ).toEqual(['action_end', 'action_end'])
  })

  test('a hook response of another tool that names an agent links nothing', async ({ expect }) => {
    const hook = await readJsonSample('claude-code-hooks/PostToolUse.Agent.completed.json')
    const kindsOf = (tool: string, response: JsonObject) =>
      factsOf(parseHookPayload({ ...hook, tool_name: tool, tool_use_id: 'lookup-1', tool_response: response })).map(
        (fact) => fact.kind,
      )
    const lookup = { agentId: 'sales-17', name: 'Account manager', status: 'active' }

    expect(kindsOf('mcp__directory__lookup_agent', lookup)).toEqual(['action_end'])
    expect(kindsOf('mcp__directory__lookup_agent', teammateSpawned)).toEqual(['action_end'])
    expect(kindsOf('Bash', hook.tool_response as JsonObject)).toEqual(['action_end'])
    expect(kindsOf('Task', lookup)).toEqual(['action_end', 'agent_start'])
  })

  test('an agent with an unfamiliar status is linked without a guess about the background', async ({ expect }) => {
    const sample = await readJsonSample('claude-code-transcripts/rec-user-tool-result-agent-sync.json')
    const toolUseResult = { ...(sample.toolUseResult as JsonObject), status: 'killed', agentType: null }
    const [, link] = factsOf(
      claudeAdapter.parse(lineRecord({ payload: JSON.stringify({ ...sample, toolUseResult }), line: 1 })),
    )

    expect(link?.payload).toMatchObject({ background: null, agent_type: null, spawned_by_call: agentCall })
  })
})

describe.concurrent('Claude subagents: meta snapshots', () => {
  const metaPath = `${projects}/-work/${session}/subagents/agent-${subagent}.meta.json`

  test('a removed meta file is a removal snapshot of the subagent', ({ expect }) => {
    const [removed] = factsOf(parseSnapshot(metaPath))

    expect(removed).toMatchObject({
      kind: 'json_snapshot',
      entity_key: subagentKey(session, subagent),
      format_verified: true,
      payload: { file: 'agent_meta', path: metaPath, removed: true, content: null },
    })
    expect(factsOf(parseSnapshot(metaPath))).toHaveLength(1)
  })

  test('a meta file with only some fields keeps the rest empty', ({ expect }) => {
    const [snapshot, start] = factsOf(parseSnapshot(metaPath, { agentType: 'pinger', requestShape: 'detached' }))

    expect(snapshot?.payload).toMatchObject({
      content: { agent_type: 'pinger', description: null, tool_use_id: null, spawn_depth: null },
    })
    expect(start?.payload).toMatchObject({ spawned_by_call: null, background: null, depth: null, description: null })
  })

  test('a meta file that is not JSON or breaks its schema is invalid', ({ expect }) => {
    expect(parseSnapshot(metaPath, '{"agentType":')).toMatchObject({ parse_state: 'invalid', reason: /not JSON/ })
    expect(parseSnapshot(metaPath, '[]')).toMatchObject({ parse_state: 'invalid', reason: /subagent meta/ })
    expect(parseSnapshot(metaPath, 'null')).toMatchObject({ parse_state: 'invalid' })
    expect(parseSnapshot(metaPath, { toolUseId: '' })).toMatchObject({ parse_state: 'invalid' })
  })

  test('meta files are recognised on Windows paths', ({ expect }) => {
    const path = `C:\\Users\\user\\.claude\\projects\\C--work\\${session}\\subagents\\agent-${subagent}.meta.json`
    const [snapshot] = factsOf(parseSnapshot(path, { agentType: 'pinger', toolUseId: agentCall }))

    expect(snapshot).toMatchObject({ entity_key: subagentKey(session, subagent), payload: { path } })
  })
})

describe.concurrent('Claude teammates', () => {
  test('a teammate meta file names the teammate by name and team and keeps its transcript agent id', ({
    expect,
  }) => {
    const path = `${projects}/-work/${session}/subagents/agent-${teammateAgent}.meta.json`
    const [snapshot, start] = factsOf(parseSnapshot(path, teammateMeta))

    expect(snapshot).toMatchObject({
      kind: 'json_snapshot',
      entity_key: teammateKey,
      runtime_ids: { session_id: session, agent_id: teammateAgent },
      format_verified: true,
      payload: {
        file: 'agent_meta',
        removed: false,
        content: { agent_type: 'reviewer', description: 'Review the parser', tool_use_id: null, spawn_depth: 1 },
      },
    })
    expect(start).toMatchObject({
      kind: 'agent_start',
      entity_key: teammateKey,
      runtime_ids: { agent_id: teammateAgent },
      format_verified: true,
      payload: {
        role: 'teammate',
        agent_type: 'reviewer',
        nickname: 'rev',
        spawned_by_call: null,
        background: true,
        depth: 1,
      },
    })
  })

  test('the spawn result of a teammate links the same teammate to its call', async ({ expect }) => {
    const sample = await readJsonSample('claude-code-transcripts/rec-user-tool-result-agent-sync.json')
    const hook = await readJsonSample('claude-code-hooks/PostToolUse.Agent.completed.json')
    const [, fromTranscript] = factsOf(
      claudeAdapter.parse(
        lineRecord({ payload: JSON.stringify({ ...sample, sessionId: session, toolUseResult: teammateSpawned }), line: 1 }),
      ),
    )
    const [, fromHook] = factsOf(parseHookPayload({ ...hook, session_id: session, tool_response: teammateSpawned }))

    expect(fromTranscript).toMatchObject({
      kind: 'agent_start',
      entity_key: teammateKey,
      format_verified: true,
      payload: {
        role: 'teammate',
        agent_type: 'reviewer',
        nickname: 'rev',
        parent: { kind: 'main' },
        spawned_by_call: agentCall,
        background: null,
      },
    })
    expect(fromHook).toMatchObject({
      entity_key: teammateKey,
      payload: { spawned_by_call: 'toolu_0189bhdGqDvEoyinZ3s9oobn' },
    })
  })

  test('a teammate spawn without its type keeps an empty type', async ({ expect }) => {
    const hook = await readJsonSample('claude-code-hooks/PostToolUse.Agent.completed.json')
    const [, spawned] = factsOf(
      parseHookPayload({ ...hook, session_id: session, tool_response: { ...teammateSpawned, agent_type: null } }),
    )

    expect(spawned?.payload).toMatchObject({ role: 'teammate', agent_type: null })
  })

  test('the team config is a snapshot of the lead session with the team members', ({ expect }) => {
    const path = '/home/user/.claude/teams/core/config.json'
    const config = {
      name: 'core',
      createdAt: 1_790_805_000_000,
      leadAgentId: 'team-lead@core',
      leadSessionId: session,
      members: [
        {
          agentId: 'team-lead@core',
          name: 'team-lead',
          agentType: 'team-lead',
          joinedAt: 1_790_805_000_000,
          tmuxPaneId: '',
          cwd: '/work',
          subscriptions: [],
          backendType: 'in-process',
        },
        { agentId: 'rev@core', name: 'rev', agentType: 'reviewer', backendType: 'in-process', sessionId: 'other' },
      ],
    }
    const [snapshot] = factsOf(parseSnapshot(path, config))

    expect(snapshot).toMatchObject({
      kind: 'json_snapshot',
      entity_key: { kind: 'session', runtime: 'claude', session },
      runtime_ids: { session_id: session, agent_id: null },
      speaker: 'runtime',
      urgent: false,
      format_verified: true,
      payload: {
        file: 'team',
        path,
        removed: false,
        content: {
          team: 'core',
          members: [
            { name: 'team-lead', agent_id: 'team-lead@core', session_id: null },
            { name: 'rev', agent_id: 'rev@core', session_id: 'other' },
          ],
        },
      },
    })
    expect(snapshot === undefined ? undefined : FactDraft.parse(snapshot)).toEqual(snapshot)
  })

  test('a team config without a name or members takes the team from its directory', ({ expect }) => {
    const [snapshot] = factsOf(
      parseSnapshot('C:\\Users\\user\\.claude\\teams\\core\\config.json', { leadSessionId: session }),
    )

    expect(snapshot?.payload).toMatchObject({ content: { team: 'core', members: [] } })
  })

  test('a team config without its lead session is invalid, a removed one has no session to report to', ({
    expect,
  }) => {
    const path = '/home/user/.claude/teams/core/config.json'

    expect(parseSnapshot(path, { name: 'core', members: [] })).toMatchObject({
      parse_state: 'invalid',
      reason: /team config/,
    })
    expect(parseSnapshot(path)).toEqual({ parse_state: 'parsed', source_ts: null, facts: [] })
  })
})

describe.concurrent('Claude workflows', () => {
  const workflowPath = `${projects}/-work/${session}/workflows/wf_26936a42-d9c.json`
  const journalPath = `${projects}/-work/${session}/subagents/workflows/wf_26936a42-d9c/journal.jsonl`

  const journalLine = (entry: JsonObject | string, path = journalPath) =>
    claudeAdapter.parse(
      lineRecord({ payload: typeof entry === 'string' ? entry : JSON.stringify(entry), line: 1, path }),
    )

  test('agent, team and workflow files nested too deeply to read are unknown', ({ expect }) => {
    const tooDeep = nestedArrays(5000)
    const unread = { parse_state: 'unknown', source_ts: null }
    const metaPath = `${projects}/-work/${session}/subagents/agent-${teammateAgent}.meta.json`
    const teamPath = '/home/user/.claude/teams/core/config.json'

    expect(journalLine({ type: 'result', key: 'k1', agentId: workflowAgent, result: tooDeep })).toEqual(unread)
    expect(journalLine({ type: 'started', key: 'k1', agentId: workflowAgent, extra: tooDeep })).toEqual(unread)
    expect(parseSnapshot(workflowPath, { ...workflowSnapshot, phases: tooDeep })).toEqual(unread)
    expect(parseSnapshot(metaPath, { ...teammateMeta, extra: tooDeep })).toEqual(unread)
    expect(parseSnapshot(teamPath, { name: 'core', leadSessionId: session, extra: tooDeep })).toEqual(unread)
    expect(factsOf(journalLine({ type: 'result', agentId: workflowAgent, result: nestedArrays(100) }))).toMatchObject([
      { kind: 'agent_end', payload: { final_message: JSON.stringify(nestedArrays(100)) } },
    ])
  })

  test('the workflow snapshot keeps its summary, not its script and result, as a session snapshot', ({ expect }) => {
    const [snapshot] = factsOf(parseSnapshot(workflowPath, workflowSnapshot))

    expect(snapshot).toMatchObject({
      kind: 'json_snapshot',
      entity_key: { kind: 'session', runtime: 'claude', session },
      runtime_ids: { session_id: session, agent_id: null },
      format_verified: true,
      payload: {
        file: 'workflow',
        path: workflowPath,
        removed: false,
        content: {
          runId: 'wf_26936a42-d9c',
          taskId: 'task-0001',
          workflowName: 'review-changes',
          status: 'completed',
          summary: 'Two tracks reviewed',
          agentCount: 2,
          totalTokens: 3_338_388,
          totalToolCalls: 1548,
          durationMs: 120_000,
          startTime: 1_790_805_267_999,
          phases: [{ title: 'Review', detail: 'Review each track' }],
        },
      },
    })
    expect(snapshot?.payload).not.toHaveProperty(['content', 'script'])
    expect(snapshot?.payload).not.toHaveProperty(['content', 'result'])
  })

  test('a removed workflow snapshot is reported, a snapshot that is not an object is invalid', ({ expect }) => {
    const [removed] = factsOf(parseSnapshot(workflowPath))

    expect(removed?.payload).toEqual({ file: 'workflow', path: workflowPath, removed: true, content: null })
    expect(parseSnapshot(workflowPath, '["wf"]')).toMatchObject({ parse_state: 'invalid', reason: /workflow/ })
    expect(parseSnapshot(workflowPath, '{"runId":')).toMatchObject({ parse_state: 'invalid', reason: /not JSON/ })
  })

  test('a workflow agent meta starts a subagent without a call', ({ expect }) => {
    const path = `${projects}/-work/${session}/subagents/workflows/wf_26936a42-d9c/agent-${workflowAgent}.meta.json`
    const meta = {
      agentType: 'general-purpose',
      description: 'Review track A',
      workflowPhase: 'Review',
      spawnDepth: 1,
      requestShape: 'background',
      requestNonInteractive: true,
    }
    const [snapshot, start] = factsOf(parseSnapshot(path, meta))
    const [removed] = factsOf(parseSnapshot(path))

    expect(snapshot).toMatchObject({ entity_key: subagentKey(session, workflowAgent), format_verified: true })
    expect(start).toMatchObject({
      kind: 'agent_start',
      entity_key: subagentKey(session, workflowAgent),
      format_verified: true,
      payload: { role: 'subagent', description: 'Review track A', spawned_by_call: null, background: true },
    })
    expect(removed).toMatchObject({ format_verified: true, payload: { removed: true } })
  })

  test('the workflow journal starts and ends its agents, verified by the R.4b recordings', ({ expect }) => {
    const [started] = factsOf(
      journalLine({ type: 'started', key: 'k1', agentId: workflowAgent, label: 'Review track A', phase: 'Review' }),
    )
    const [ended] = factsOf(journalLine({ type: 'result', key: 'k1', agentId: workflowAgent, result: { verdict: 'ok' } }))

    expect(started).toMatchObject({
      kind: 'agent_start',
      entity_key: subagentKey(session, workflowAgent),
      speaker: 'runtime',
      urgent: false,
      format_verified: true,
      runtime_ids: { session_id: session, agent_id: workflowAgent },
      payload: { role: 'subagent', description: 'Review track A', spawned_by_call: null },
    })
    expect(ended).toMatchObject({
      kind: 'agent_end',
      entity_key: subagentKey(session, workflowAgent),
      urgent: true,
      format_verified: true,
      payload: { outcome: 'completed', final_message: '{"verdict":"ok"}', agent_type: null, transcript_path: null },
    })
  })

  test('journal entries with a text result, without a result or label, and the launch', ({ expect }) => {
    const [text] = factsOf(journalLine({ type: 'result', agentId: workflowAgent, result: 'done' }))
    const [empty] = factsOf(journalLine({ type: 'result', agentId: workflowAgent }))
    const [unlabelled] = factsOf(journalLine({ type: 'started', agentId: workflowAgent }))

    expect(text?.payload).toMatchObject({ final_message: 'done' })
    expect(empty?.payload).toMatchObject({ final_message: null })
    expect(unlabelled?.payload).toMatchObject({ description: null })
    expect(journalLine({ type: 'launched' })).toEqual({ parse_state: 'parsed', source_ts: null, facts: [] })
  })

  test('unfamiliar journal entries are unknown, malformed ones invalid', ({ expect }) => {
    expect(journalLine({ type: 'progress', agentId: workflowAgent })).toEqual({ parse_state: 'unknown', source_ts: null })
    expect(journalLine({ agentId: workflowAgent })).toEqual({ parse_state: 'unknown', source_ts: null })
    expect(journalLine('not json')).toMatchObject({ parse_state: 'invalid', reason: /workflow journal line/ })
    expect(journalLine({ type: 'started' })).toMatchObject({ parse_state: 'invalid', reason: /started entry/ })
    expect(journalLine({ type: 'result', agentId: '' })).toMatchObject({ parse_state: 'invalid', reason: /result entry/ })
  })

  test('the journal is recognised on Windows paths, and only under a workflow directory', ({ expect }) => {
    const windows = `C:\\Users\\user\\.claude\\projects\\C--work\\${session}\\subagents\\workflows\\wf_1\\journal.jsonl`
    const elsewhere = `${projects}/-work/${session}/journal.jsonl`

    expect(factsOf(journalLine({ type: 'started', agentId: workflowAgent }, windows))[0]?.entity_key).toEqual(
      subagentKey(session, workflowAgent),
    )
    expect(claudeAdapter.streamKey(windows, [])).toBe(JSON.stringify(['claude', session, 'workflow', 'wf_1', 'journal']))
    expect(journalLine({ type: 'started', agentId: workflowAgent }, elsewhere).parse_state).toBe('unknown')
    expect(claudeAdapter.streamKey(elsewhere, ['{"type":"launched"}'])).toBeNull()
  })

  test('the journal names its stream by its path: one stream per run, the same after the project directory moves', ({
    expect,
  }) => {
    const launched = ['{"type":"launched"}']
    const moved = `${projects}/-moved/${session}/subagents/workflows/wf_26936a42-d9c/journal.jsonl`
    const otherRun = `${projects}/-work/${session}/subagents/workflows/wf_0b5c2a51-7f4/journal.jsonl`
    const stream = claudeAdapter.streamKey(journalPath, launched)
    const line = (path: string) =>
      lineRecord({ payload: launched[0] ?? '', line: 1, path, stream: claudeAdapter.streamKey(path, launched) })

    expect(stream).toBe(JSON.stringify(['claude', session, 'workflow', 'wf_26936a42-d9c', 'journal']))
    expect(claudeAdapter.streamKey(moved, launched)).toBe(stream)
    expect(claudeAdapter.streamKey(otherRun, launched)).not.toBe(stream)
    expect(claudeAdapter.rawKey(line(moved))).toBe(claudeAdapter.rawKey(line(journalPath)))
    expect(claudeAdapter.rawKey(line(otherRun))).not.toBe(claudeAdapter.rawKey(line(journalPath)))
  })
})

describe.concurrent('Claude whole-file snapshots: other files', () => {
  test('files that are not agent meta, workflows or teams stay unknown', ({ expect }) => {
    for (const path of [
      `${projects}/-work/${session}/custom-title.json`,
      `${projects}/-work/${session}/subagents/workflows/wf_1.json`,
      `${projects}/-work/${session}/subagents/agent-x.jsonl`,
      '/home/user/.claude/teams/core/inbox.json',
    ]) {
      expect(parseSnapshot(path, { any: 1 }), path).toEqual({ parse_state: 'unknown', source_ts: null })
      expect(parseSnapshot(path), path).toEqual({ parse_state: 'unknown', source_ts: null })
    }
  })

  test('a stream that was lost is not a snapshot and stays unknown', ({ expect }) => {
    const lost = CollectedRecord.parse({
      channel: 'transcript',
      runtime: 'claude',
      stream: null,
      position: { kind: 'stream_lost', path: `${projects}/-work/${session}.jsonl` },
      hook: null,
      observed_at: observedAt,
      payload: '',
    })

    expect(claudeAdapter.parse(lost)).toEqual({ parse_state: 'unknown', source_ts: null })
  })

  test('a transcript line of another channel is not parsed as a transcript', async ({ expect }) => {
    const line = await readSample('claude-code-transcripts/rec-user-prompt.json')
    const rollout = { ...lineRecord({ payload: line, line: 1 }), channel: 'rollout' as const }

    expect(claudeAdapter.parse(rollout)).toEqual({ parse_state: 'unknown', source_ts: null })
  })
})
