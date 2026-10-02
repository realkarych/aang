import type { CollectedRecord, ParseResult } from '@aang/contract'
import { z } from 'zod'
import { interAgentMessage } from './agents.js'
import { customToolCall, functionCall, toolOutput } from './calls.js'
import type { LineContext, LineFacts, LineParser } from './facts.js'
import { parseHook } from './hooks.js'
import { itemCompleted } from './items.js'
import { readLine } from './line.js'
import { compacted, sessionMeta, taskComplete, taskStarted, turnAborted, turnContext } from './session.js'
import { decodeStream } from './stream.js'
import { tokenCount, tokenUsageRecord } from './usage.js'

const Typed = z.looseObject({ type: z.string() })

const ignored: LineParser = () => []

const byPayloadType =
  (parsers: ReadonlyMap<string, LineParser>): LineParser =>
  (context) => {
    const typed = Typed.safeParse(context.line.payload)
    return typed.success ? (parsers.get(typed.data.type)?.(context) ?? null) : null
  }

const eventMessage = byPayloadType(
  new Map([
    ['task_started', taskStarted],
    ['task_complete', taskComplete],
    ['turn_aborted', turnAborted],
    ['item_completed', itemCompleted],
    ['token_count', tokenCount],
  ]),
)

const responseItem = byPayloadType(
  new Map([
    ['message', ignored],
    ['reasoning', ignored],
    ['function_call', functionCall],
    ['custom_tool_call', customToolCall],
    ['function_call_output', toolOutput],
    ['custom_tool_call_output', toolOutput],
    ['agent_message', interAgentMessage],
  ]),
)

const lineParsers: ReadonlyMap<string, LineParser> = new Map([
  ['session_meta', sessionMeta],
  ['turn_context', turnContext],
  ['event_msg', eventMessage],
  ['response_item', responseItem],
  ['token_usage_record', tokenUsageRecord],
  ['compacted', compacted],
  ['inter_agent_communication_metadata', ignored],
])

const parseLine = (context: LineContext): LineFacts => lineParsers.get(context.line.type)?.(context) ?? null

export const parse = (record: CollectedRecord): ParseResult => {
  if (record.channel === 'hook' && record.position.kind === 'spool') {
    return parseHook(record, record.position.file)
  }
  if (record.channel !== 'rollout' || record.position.kind !== 'line') {
    return { parse_state: 'unknown', source_ts: null }
  }
  const reading = readLine(record.payload)
  if (reading.kind === 'malformed') {
    return { parse_state: 'invalid', reason: reading.reason }
  }
  if (reading.kind === 'unrecognized') {
    return { parse_state: 'unknown', source_ts: reading.at }
  }
  const { line } = reading
  const stream = decodeStream(record.stream)
  const facts = stream === null ? null : parseLine({ stream, line })
  return facts === null
    ? { parse_state: 'unknown', source_ts: line.at }
    : { parse_state: 'parsed', source_ts: line.at, facts }
}
