import { readFileSync } from 'node:fs'
import type { JsonValue, SpoolEnv } from '@aang/contract'
import { spoolEnvKeys } from '@aang/contract'

type JsonObject = { readonly [key: string]: JsonValue }

const samplesRoot = new URL('../../../docs/research/samples/', import.meta.url)

const readSample = (path: string): string => readFileSync(new URL(path, samplesRoot), 'utf8')

const sampleLines = (path: string): string[] =>
  readSample(path)
    .split('\n')
    .filter((line) => line !== '')

const asObject = (value: JsonValue | undefined): JsonObject => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('expected a JSON object')
  }
  return value
}

const parseObject = (text: string): JsonObject => asObject(JSON.parse(text) as JsonValue)

export interface ClaudeSession {
  readonly session: string
  readonly cwd: string
  readonly entrypoint?: string
}

const rewriteClaudeLine = (line: string, { session, cwd, entrypoint }: ClaudeSession): string => {
  const record = parseObject(line)
  return JSON.stringify({
    ...record,
    ...('sessionId' in record ? { sessionId: session } : {}),
    ...('cwd' in record ? { cwd } : {}),
    ...('entrypoint' in record && entrypoint !== undefined ? { entrypoint } : {}),
  })
}

export const claudeTranscript = (session: ClaudeSession): string[] =>
  sampleLines('claude-code-transcripts/session-86f93ed5-main-full.jsonl').map((line) =>
    rewriteClaudeLine(line, session),
  )

const forkOwnLines = 39

export const claudeForkTranscript = (session: ClaudeSession, own = ''): string[] =>
  sampleLines('claude-code-transcripts/session-cdfb3544-fork-full.jsonl').map((line, index) => {
    const rewritten = rewriteClaudeLine(line, session)
    if (own === '' || index + 1 < forkOwnLines) {
      return rewritten
    }
    const record = parseObject(rewritten)
    const message = record['message']
    return JSON.stringify({
      ...record,
      ...(typeof record['uuid'] === 'string' ? { uuid: `${record['uuid']}-${own}` } : {}),
      ...(typeof message === 'object' &&
      message !== null &&
      !Array.isArray(message) &&
      typeof message['id'] === 'string'
        ? { message: { ...message, id: `${message['id']}-${own}` } }
        : {}),
    })
  })

const renumbered = (line: string, copy: number): string => {
  if (copy === 0) {
    return line
  }
  const record = parseObject(line)
  const suffix = (field: string): JsonObject =>
    typeof record[field] === 'string' ? { [field]: `${record[field]}-${String(copy)}` } : {}
  return JSON.stringify({ ...record, ...suffix('uuid'), ...suffix('parentUuid') })
}

export const claudeSubagentTranscript = (session: ClaudeSession, copies = 1): string[] => {
  const lines = sampleLines('claude-code-transcripts/subagent-agent-aad616394e806288d.jsonl').map((line) =>
    rewriteClaudeLine(line, session),
  )
  return Array.from({ length: copies }, (_, copy) => lines.map((line) => renumbered(line, copy))).flat()
}

export const claudeHook = (name: string, { session, cwd }: ClaudeSession, changes: JsonObject = {}): string =>
  JSON.stringify({ ...parseObject(readSample(`claude-code-hooks/${name}`)), session_id: session, cwd, ...changes })

export const claudeHookWithoutCwd = (name: string, session: string): string =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries({ ...parseObject(readSample(`claude-code-hooks/${name}`)), session_id: session }).filter(
        ([key]) => key !== 'cwd',
      ),
    ),
  )

const envelopeEnv = parseObject(readSample('claude-code-hooks/envelope.command.SessionStart.plugin.json'))['env']

export const claudeHookEnv: SpoolEnv = Object.fromEntries(
  spoolEnvKeys.flatMap((key) => {
    const value = asObject(envelopeEnv)[key]
    return typeof value === 'string' ? [[key, value]] : []
  }),
)

export interface CodexSession {
  readonly thread: string
  readonly cwd: string
  readonly sessionMeta?: JsonObject
}

const rewriteCodexLine = (line: string, { thread, cwd, sessionMeta = {} }: CodexSession): string => {
  const record = parseObject(line)
  const payload = asObject(record['payload'])
  switch (record['type']) {
    case 'session_meta':
      return JSON.stringify({ ...record, payload: { ...payload, id: thread, session_id: thread, cwd, ...sessionMeta } })
    case 'turn_context':
      return JSON.stringify({ ...record, payload: { ...payload, cwd } })
    default:
      return JSON.stringify(record)
  }
}

export const codexRollout = (session: CodexSession): string[] =>
  sampleLines('codex-cli/rollout/rollout-real-exec-then-resume-with-compaction.jsonl').map((line) =>
    rewriteCodexLine(line, session),
  )

export interface CodexChild {
  readonly root: string
  readonly thread: string
  readonly cwd: string
}

export const codexChildRollout = ({ root, thread, cwd }: CodexChild): string[] => {
  const meta = parseObject(readSample('codex-cli/rollout/session_meta.subagent.thread_spawn.mock.json'))
  const spawn = asObject(asObject(asObject(meta['payload'])['source'])['subagent'])
  const payload = {
    ...asObject(meta['payload']),
    id: thread,
    session_id: root,
    cwd,
    source: { subagent: { ...spawn, thread_spawn: { ...asObject(spawn['thread_spawn']), parent_thread_id: root } } },
  }
  const body = codexRollout({ thread, cwd }).slice(1, 12)
  return [JSON.stringify({ ...meta, payload }), ...body]
}

export interface CodexHookSession {
  readonly session: string
  readonly cwd: string
}

export const codexHook = (name: string, { session, cwd }: CodexHookSession, changes: JsonObject = {}): string => {
  const sample = parseObject(readSample(`codex-cli/hooks/${name}`))
  return JSON.stringify({ ...asObject(sample['stdin']), session_id: session, cwd, ...changes })
}

export const codexGuardianRollout = ({ root, thread, cwd }: CodexChild): string[] => {
  const meta = parseObject(readSample('codex-cli/rollout/session_meta.guardian.mock.json'))
  const payload = { ...asObject(meta['payload']), id: thread, session_id: root, parent_thread_id: root, cwd }
  return [JSON.stringify({ ...meta, payload })]
}

export interface CodexSpawn {
  readonly root: string
  readonly child: string
  readonly call: string
  readonly ordinal: number
}

const codexItem = (sample: string, ordinal: number, payload: (value: JsonObject) => JsonObject): string => {
  const line = parseObject(readSample(`codex-cli/rollout/${sample}`))
  return JSON.stringify({ ...line, ordinal, payload: payload(asObject(line['payload'])) })
}

export const codexSpawnLines = ({ root, child, call, ordinal }: CodexSpawn): string[] => [
  codexItem('response_item.function_call.spawn_agent.mock.json', ordinal, (payload) => ({ ...payload, call_id: call })),
  codexItem('event_msg.item_completed.SubAgentActivity.started.mock.json', ordinal + 1, (payload) => ({
    ...payload,
    thread_id: root,
    item: { ...asObject(payload['item']), id: call, agent_thread_id: child },
  })),
]

export const claudeAgentMeta = (): string =>
  readSample('claude-code-transcripts/subagent-agent-aad616394e806288d.meta.json')

export const claudeAgentTranscript = (session: ClaudeSession, agent: string): string[] =>
  claudeSubagentTranscript(session).map((line) => {
    const record = parseObject(line)
    return JSON.stringify('agentId' in record ? { ...record, agentId: agent } : record)
  })

const workflowRecording = new URL('../../../fixtures/sessions/claude/2.1.289/claude_cli/macos/workflow/', import.meta.url)

interface PlaybackStep {
  readonly kind: string
  readonly target?: { readonly path: string }
  readonly source?: string
}

export interface RecordedJournal {
  readonly run: string
  readonly appends: readonly (readonly string[])[]
}

export const recordedWorkflowJournal = (): RecordedJournal => {
  const { steps } = JSON.parse(readFileSync(new URL('playback.json', workflowRecording), 'utf8')) as {
    readonly steps: readonly PlaybackStep[]
  }
  const appends = steps.flatMap(({ kind, target, source }) =>
    kind === 'append' && target?.path.endsWith('/journal.jsonl') === true && source !== undefined
      ? [{ path: target.path, source }]
      : [],
  )
  const run = appends[0]?.path.split('/').at(-2)
  if (run === undefined) {
    throw new Error('the workflow recording has no journal')
  }
  return {
    run,
    appends: appends.map(({ source }) =>
      readFileSync(new URL(source, workflowRecording), 'utf8')
        .split('\n')
        .filter((line) => line !== ''),
    ),
  }
}

export const claudeWorkflowJournal = (agents: readonly string[]): string[] => [
  JSON.stringify({ type: 'launched' }),
  ...agents.map((agent) => JSON.stringify({ type: 'started', key: `v2:${agent}`, agentId: agent, label: agent, phase: 'Echo' })),
  ...agents.map((agent) => JSON.stringify({ type: 'result', key: `v2:${agent}`, agentId: agent, result: agent })),
]
