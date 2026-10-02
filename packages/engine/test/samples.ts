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

export const claudeSubagentTranscript = (session: ClaudeSession): string[] =>
  sampleLines('claude-code-transcripts/subagent-agent-aad616394e806288d.jsonl').map((line) =>
    rewriteClaudeLine(line, session),
  )

export const claudeHook = (name: string, { session, cwd }: ClaudeSession): string =>
  JSON.stringify({ ...parseObject(readSample(`claude-code-hooks/${name}`)), session_id: session, cwd })

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
