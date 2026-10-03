import {
  type Agent,
  AgentKey,
  type AgentRef,
  type AgentRole,
  EpochNs,
  FactDraft,
  FileCursor,
  GapKey,
  NormalizerVersion,
  RawRecordDraft,
  type RuntimeEnv,
  type RuntimeIds,
  SessionKey,
  StreamKey,
} from '@aang/contract'
import { objectId, runId } from '@aang/contract/ids'
import type { GapDraft } from '@aang/store'

export const mainStream = StreamKey.parse('claude:s1:main')
export const subagentStream = StreamKey.parse('claude:s1:a7')
export const transcriptPath = '/home/u/.claude/projects/p/s1.jsonl'
export const normalizerVersion = NormalizerVersion.parse(3)

const startedAt = 1_759_370_000_123_456_789n

export const instant = (offset: bigint): EpochNs => EpochNs.parse(startedAt + offset)

export const transcriptRecord = (
  line: number,
  overrides: Partial<RawRecordDraft> = {},
): RawRecordDraft =>
  RawRecordDraft.parse({
    dedupe_key: `claude:s1:u${String(line)}`,
    channel: 'transcript',
    runtime: 'claude',
    stream: mainStream,
    position: { kind: 'line', path: transcriptPath, offset: (line - 1) * 120, line },
    hook: null,
    observed_at: startedAt + BigInt(line),
    source_ts: startedAt - 1_000_000n,
    payload: `{"uuid":"u${String(line)}","type":"assistant","message":{"content":"готово ✓"}}`,
    parse_state: 'parsed',
    ...overrides,
  })

export const hookRecord = (file: string): RawRecordDraft =>
  RawRecordDraft.parse({
    dedupe_key: `hook:${file}`,
    channel: 'hook',
    runtime: 'claude',
    stream: null,
    position: { kind: 'spool', file },
    hook: {
      registration: 'plugin',
      env: { CLAUDE_CODE_SESSION_ID: 's1', CLAUDE_PLUGIN_ROOT: '/home/u/.aang/claude-plugin' },
    },
    observed_at: startedAt + 500n,
    source_ts: null,
    payload: '﻿{"hook_event_name":"PermissionRequest","tool_name":"Bash"}\u0000',
    parse_state: 'unknown',
  })

export const snapshotRecord = (key: string): RawRecordDraft =>
  RawRecordDraft.parse({
    dedupe_key: `snapshot:${key}`,
    channel: 'snapshot',
    runtime: null,
    stream: null,
    position: { kind: 'daemon' },
    hook: null,
    observed_at: startedAt + 900n,
    source_ts: null,
    payload: '{"head":"4f1c2a9","entries":[]}',
    parse_state: 'invalid',
  })

const runtimeIds = (record: string): RuntimeIds => ({
  session_id: 's1',
  agent_id: null,
  thread_id: null,
  turn_id: null,
  prompt_id: null,
  record_uuid: record,
  parent_uuid: null,
  message_id: null,
  call_id: null,
  ordinal: null,
})

const runtimeEnv: RuntimeEnv = {
  cwd: '/work/p',
  version: '2.1.0',
  entrypoint: 'cli',
  originator: null,
  git_branch: 'main',
}

export const messageFact = (message: string, text: string): FactDraft =>
  FactDraft.parse({
    kind: 'message',
    entity_key: { kind: 'message', runtime: 'claude', session: 's1', message },
    speaker: 'solver',
    urgent: false,
    at: startedAt,
    runtime_ids: runtimeIds(message),
    runtime_env: runtimeEnv,
    format_verified: true,
    redelivery_key: null,
    payload: { text, final: false, audience: 'user', model: 'claude-opus-5-5' },
  })

export const permissionFact = (call: string): FactDraft =>
  FactDraft.parse({
    kind: 'runtime_event',
    entity_key: { kind: 'action', runtime: 'claude', session: 's1', call },
    speaker: 'runtime',
    urgent: true,
    at: startedAt + 500n,
    runtime_ids: { ...runtimeIds(call), call_id: call },
    runtime_env: runtimeEnv,
    format_verified: false,
    redelivery_key: `PermissionRequest:${call}`,
    payload: { event: 'PermissionRequest', data: { tool_name: 'Bash', input: { command: 'ls -la' }, attempt: 1 } },
  })

export const registryFact = (): FactDraft =>
  FactDraft.parse({
    kind: 'json_snapshot',
    entity_key: { kind: 'session', runtime: 'claude', session: 's1' },
    speaker: 'runtime',
    urgent: false,
    at: startedAt + 700n,
    runtime_ids: runtimeIds('registry'),
    runtime_env: runtimeEnv,
    format_verified: true,
    redelivery_key: null,
    payload: {
      file: 'registry',
      path: '/home/u/.claude/sessions/4242.json',
      removed: false,
      content: {
        pid: 4242,
        session_id: 's1',
        kind: 'interactive',
        entrypoint: 'cli',
        status: 'waiting',
        waiting_for: 'permission',
        cwd: '/work/p',
        version: '2.1.0',
        status_updated_at: startedAt + 650n,
      },
    },
  })

export const transcriptCursor = (line: number, overrides: Partial<FileCursor> = {}): FileCursor =>
  FileCursor.parse({
    path: transcriptPath,
    dev: 16_777_232n,
    ino: 91_234_567n,
    stream: mainStream,
    offset: line * 120,
    line,
    size: line * 120 + 40,
    last_ordinal: null,
    ...overrides,
  })

export const sourceLostGap = (overrides: Partial<GapDraft> = {}): GapDraft => ({
  key: GapKey.parse({ kind: 'gap', gap: 'source_lost', subject: mainStream }),
  run: null,
  session: null,
  stream: mainStream,
  details: 'transcript removed and not found in projects/',
  detected_at: instant(1_000n),
  closed_at: null,
  ...overrides,
})

export type AgentDraft = Omit<Agent, 'change_seq'>

const sessionKey = SessionKey.parse({ kind: 'session', runtime: 'claude', session: 's1' })

export const agentDraft = (role: AgentRole, agent: AgentRef, overrides: Partial<AgentDraft> = {}): AgentDraft => {
  const key = AgentKey.parse({ kind: 'agent', runtime: 'claude', session: 's1', agent })
  return {
    id: objectId(key),
    key,
    session: objectId(sessionKey),
    run: runId(sessionKey),
    role,
    service: null,
    agent_type: null,
    agent_role: null,
    name: agent.kind === 'teammate' ? agent.name : null,
    description: null,
    parent: null,
    spawned_by: null,
    execution: { state: 'running' },
    thread_total: null,
    started_at: instant(100n),
    ended_at: null,
    ...overrides,
  }
}
