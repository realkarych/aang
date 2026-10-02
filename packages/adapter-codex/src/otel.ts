import {
  type CollectedRecord,
  type DecisionSource,
  EpochNs,
  type FactDraft,
  type ParseResult,
  type PermissionDecision,
} from '@aang/contract'
import { z } from 'zod'
import { qualifiedTool } from './calls.js'
import { actionEntity, emptyEnv, emptyIds, fact } from './facts.js'
import { readJson } from './json.js'
import { decodeStream, type ThreadStream } from './stream.js'

const toolDecisionEvent = 'codex.tool_decision'
const unsetTime = 0n

const Token = z.string().regex(/^[^:\s]+$/)

const Attribute = z.looseObject({ key: z.string(), value: z.looseObject({ stringValue: z.string() }) })

const LogRecord = z.looseObject({
  timeUnixNano: z.unknown().optional(),
  observedTimeUnixNano: z.unknown().optional(),
  attributes: z.array(z.unknown()).catch([]),
})
type LogRecord = z.infer<typeof LogRecord>

const ToolDecision = z.looseObject({
  'event.name': z.literal(toolDecisionEvent),
  'conversation.id': Token,
  call_id: z.string().min(1),
  decision: z.string(),
  source: z.string().optional(),
  tool_name: z.string().optional(),
  tool_namespace: z.string().optional(),
  originator: z.string().optional(),
  'app.version': z.string().optional(),
})
type ToolDecision = z.infer<typeof ToolDecision>

interface DecisionReading {
  readonly decision: PermissionDecision
  readonly verified: boolean
}

const decisions: ReadonlyMap<string, DecisionReading> = new Map([
  ['approved', { decision: 'approved', verified: true }],
  ['approved_for_session', { decision: 'approved_for_session', verified: true }],
  ['approved_with_amendment', { decision: 'approved_with_amendment', verified: true }],
  ['denied', { decision: 'denied', verified: true }],
  ['approved_mcp_policy_amendment', { decision: 'approved_with_amendment', verified: false }],
  ['approved_with_network_policy_allow', { decision: 'approved_with_amendment', verified: false }],
  ['denied_with_network_policy_deny', { decision: 'denied', verified: false }],
  ['abort', { decision: 'aborted', verified: false }],
])

const unknownDecision: DecisionReading = { decision: 'unknown', verified: false }

const sources: ReadonlyMap<string, DecisionSource> = new Map([
  ['User', 'user'],
  ['Config', 'config'],
  ['AutomatedReviewer', 'automated_reviewer'],
])

type OtelReading =
  | { readonly kind: 'malformed' }
  | { readonly kind: 'other'; readonly at: EpochNs | null }
  | { readonly kind: 'decision'; readonly log: LogRecord; readonly event: ToolDecision; readonly at: EpochNs | null }

const instant = (value: unknown): EpochNs | null => {
  const time = EpochNs.safeParse(value).data
  return time === undefined || time === unsetTime ? null : time
}

const attributesOf = (log: LogRecord): Record<string, string> =>
  Object.fromEntries(
    log.attributes.flatMap((entry) => {
      const attribute = Attribute.safeParse(entry).data
      return attribute === undefined ? [] : [[attribute.key, attribute.value.stringValue]]
    }),
  )

const readOtel = (payload: string): OtelReading => {
  const log = LogRecord.safeParse(readJson(payload)).data
  if (log === undefined) {
    return { kind: 'malformed' }
  }
  const at = instant(log.timeUnixNano) ?? instant(log.observedTimeUnixNano)
  const event = ToolDecision.safeParse(attributesOf(log)).data
  return event === undefined ? { kind: 'other', at } : { kind: 'decision', log, event, at }
}

const toolOf = ({ tool_name: name, tool_namespace: namespace }: ToolDecision): string | null =>
  name === undefined || name === '' ? null : qualifiedTool(namespace, name)

const conversationStream = (record: CollectedRecord, event: ToolDecision): ThreadStream | null => {
  const stream = decodeStream(record.stream)
  return stream?.thread === event['conversation.id'] ? stream : null
}

const decisionFact = (record: CollectedRecord, stream: ThreadStream, event: ToolDecision, at: EpochNs | null): FactDraft => {
  const reading = decisions.get(event.decision) ?? unknownDecision
  const source = event.source === undefined ? undefined : sources.get(event.source)
  return fact(
    'permission_decision',
    {
      entity: actionEntity(stream, event.call_id),
      speaker: source === 'user' ? 'human' : 'runtime',
      urgent: false,
      at: at ?? record.observed_at,
      ids: { ...emptyIds, session_id: stream.session, thread_id: stream.thread, call_id: event.call_id },
      env: { ...emptyEnv, version: event['app.version'] ?? null, originator: event.originator ?? null },
      verified: reading.verified && source !== undefined,
    },
    { decision: reading.decision, source: source ?? 'unknown', tool: toolOf(event) },
  )
}

export const parseOtel = (record: CollectedRecord): ParseResult => {
  const reading = readOtel(record.payload)
  if (reading.kind === 'malformed') {
    return { parse_state: 'invalid', reason: 'otel payload is not a JSON object' }
  }
  if (reading.kind === 'other') {
    return { parse_state: 'unknown', source_ts: reading.at }
  }
  const stream = conversationStream(record, reading.event)
  return stream === null
    ? { parse_state: 'unknown', source_ts: reading.at }
    : { parse_state: 'parsed', source_ts: reading.at, facts: [decisionFact(record, stream, reading.event, reading.at)] }
}

const KeyParts = z.tuple([Token, Token, Token])

export const otelKeyParts = (payload: string): readonly string[] | null => {
  const reading = readOtel(payload)
  if (reading.kind !== 'decision') {
    return null
  }
  const { event, log } = reading
  const parts = KeyParts.safeParse([event['conversation.id'], event.call_id, event.decision]).data
  return parts === undefined ? null : [...parts, String(instant(log.timeUnixNano) ?? unsetTime)]
}
