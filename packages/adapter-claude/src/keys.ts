import {
  type ActionKey,
  type AgentKey,
  type AgentRef,
  type CollectedRecord,
  DedupeKey,
  type FactEntityKey,
  type JsonValue,
  type MessageKey,
  type QuestionKey,
  type SessionKey,
  StreamKey,
  type UsageKey,
} from '@aang/contract'
import { canonicalJson, contentHash } from '@aang/contract/ids'
import { isJsonObject, parseJson, stringField } from './json.js'

const runtime = 'claude'

const composite = (parts: readonly JsonValue[]): string => canonicalJson([runtime, ...parts])

export const sessionKey = (session: string): SessionKey => ({ kind: 'session', runtime, session })

export const agentRef = (agent: string | null): AgentRef =>
  agent === null ? { kind: 'main' } : { kind: 'subagent', agent_id: agent }

const agentKeyOf = (session: string, agent: AgentRef): AgentKey => ({ kind: 'agent', runtime, session, agent })

export const agentKey = (session: string, agent: string | null): AgentKey => agentKeyOf(session, agentRef(agent))

export const teammateKey = (session: string, name: string, team: string): AgentKey =>
  agentKeyOf(session, { kind: 'teammate', name, team })

export const ownerKey = (session: string, agent: string | null): FactEntityKey =>
  agent === null ? sessionKey(session) : agentKey(session, agent)

export const actionKey = (session: string, call: string): ActionKey => ({ kind: 'action', runtime, session, call })

export const messageKey = (session: string, message: string): MessageKey => ({
  kind: 'message',
  runtime,
  session,
  message,
})

export const questionKey = (session: string, question: string): QuestionKey => ({
  kind: 'question',
  runtime,
  session,
  question,
})

export const usageKey = (session: string, usage: string): UsageKey => ({ kind: 'usage', runtime, session, usage })

const streamOf = (session: string, agent: string | null): StreamKey =>
  StreamKey.parse(composite(agent === null ? [session, 'main'] : [session, 'agent', agent]))

const firstString = (records: readonly JsonValue[], field: string): string | null =>
  records.map((record) => stringField(record, field)).find((value) => value !== null) ?? null

export const streamKey = (firstLines: readonly string[]): StreamKey | null => {
  const records = firstLines.map(parseJson).filter(isJsonObject)
  const session = firstString(records, 'sessionId')
  return session === null ? null : streamOf(session, firstString(records, 'agentId'))
}

const dedupe = (parts: readonly JsonValue[]): DedupeKey => DedupeKey.parse(composite(parts))

export const rawKey = (record: CollectedRecord): DedupeKey => {
  const { position, payload } = record
  switch (position.kind) {
    case 'spool':
      return dedupe(['hook', position.file])
    case 'line': {
      const line = parseJson(payload)
      const session = stringField(line, 'sessionId')
      const uuid = stringField(line, 'uuid')
      return session !== null && uuid !== null
        ? dedupe(['record', session, uuid])
        : dedupe(['line', record.stream ?? position.path, position.line, contentHash(payload)])
    }
    default:
      return dedupe([record.channel, { ...position }, contentHash(payload)])
  }
}
