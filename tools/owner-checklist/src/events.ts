import { spoolEnvKeys } from '@aang/contract'
import type { SpoolRecord } from './spool.js'

export type FieldValue = string | number | boolean | readonly BatchCall[]

export interface BatchCall {
  readonly tool_name: string | null
  readonly tool_use_id: string | null
  readonly response: string
}

export interface ChecklistEvent {
  readonly file: string
  readonly receivedNs: bigint
  readonly runtime: string
  readonly registration: string
  readonly env: Readonly<Record<string, string>>
  readonly event: string | null
  readonly sessionId: string | null
  readonly fields: Readonly<Record<string, FieldValue>>
  readonly problem: string | null
}

type JsonObject = Record<string, unknown>

const copiedTextFields = [
  'source',
  'reason',
  'notification_type',
  'tool_name',
  'tool_use_id',
  'agent_id',
  'agent_type',
  'permission_mode',
  'cwd',
  'transcript_path',
  'agent_transcript_path',
  'prompt_id',
  'turn_id',
  'trigger',
  'model',
  'mcp_server_name',
] as const

const copiedScalarFields = ['stop_hook_active', 'duration_ms'] as const

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const objectField = (value: JsonObject, name: string): JsonObject | null => {
  const field = value[name]
  return isObject(field) ? field : null
}

const textOf = (value: unknown): string | null => (typeof value === 'string' ? value : null)

const responseKind = (value: unknown): string => {
  if (value === undefined) {
    return 'absent'
  }
  if (value === null) {
    return 'null'
  }
  if (Array.isArray(value)) {
    return 'array'
  }
  return typeof value === 'string' ? 'text' : typeof value
}

const batchCalls = (value: unknown): BatchCall[] =>
  (Array.isArray(value) ? (value as unknown[]) : []).filter(isObject).map((call) => ({
    tool_name: textOf(call.tool_name),
    tool_use_id: textOf(call.tool_use_id),
    response: responseKind(call.tool_response),
  }))

const hasField = (value: JsonObject | null, name: string): boolean => value !== null && value[name] !== undefined

const safeFields = (payload: JsonObject): Record<string, FieldValue> => {
  const fields: Record<string, FieldValue> = {}
  for (const name of copiedTextFields) {
    const value = textOf(payload[name])
    if (value !== null) {
      fields[name] = value
    }
  }
  for (const name of copiedScalarFields) {
    const value = payload[name]
    if (typeof value === 'number' || typeof value === 'boolean') {
      fields[name] = value
    }
  }
  const input = objectField(payload, 'tool_input')
  const response = objectField(payload, 'tool_response')
  if (input !== null && Array.isArray(input.questions)) {
    fields.questions = input.questions.length
  }
  if (hasField(input, 'answers') || hasField(response, 'answers')) {
    fields.answers = true
  }
  if (input !== null && typeof input.plan === 'string') {
    fields.plan_length = input.plan.length
  }
  const planResponseFile = payload.tool_name === 'ExitPlanMode' && hasField(response, 'filePath')
  if (hasField(input, 'planFilePath') || hasField(response, 'planFilePath') || planResponseFile) {
    fields.plan_file_path = true
  }
  if (response !== null && typeof response.afkTimeoutMs === 'number') {
    fields.afk_timeout_ms = response.afkTimeoutMs
  }
  if (input !== null && typeof input.subagent_type === 'string') {
    fields.subagent_type = input.subagent_type
  }
  if (input !== null && typeof input.run_in_background === 'boolean') {
    fields.run_in_background = input.run_in_background
  }
  if (response !== null && typeof response.agentId === 'string') {
    fields.response_agent_id = response.agentId
  }
  if (response !== null && typeof response.status === 'string') {
    fields.response_status = response.status
  }
  if (Array.isArray(payload.background_tasks)) {
    fields.background_tasks = payload.background_tasks.length
  }
  if (Array.isArray(payload.session_crons)) {
    fields.session_crons = payload.session_crons.length
  }
  if (Array.isArray(payload.tool_calls)) {
    fields.tool_calls = batchCalls(payload.tool_calls)
  }
  return fields
}

const forwardedEnv = (env: Readonly<Record<string, string>>): Record<string, string> =>
  Object.fromEntries(spoolEnvKeys.flatMap((name) => (env[name] === undefined ? [] : [[name, env[name]]])))

export const checklistEvent = (record: SpoolRecord): ChecklistEvent => {
  const payload = isObject(record.payload) ? record.payload : null
  return {
    file: record.file,
    receivedNs: record.receivedNs,
    runtime: record.runtime,
    registration: record.registration,
    env: forwardedEnv(record.env),
    event: payload === null ? null : textOf(payload.hook_event_name),
    sessionId: payload === null ? null : textOf(payload.session_id),
    fields: payload === null ? {} : safeFields(payload),
    problem: record.problem ?? (payload === null ? 'payload is not a JSON object' : null),
  }
}

export const isoTime = (ns: bigint): string => {
  const milliseconds = ns / 1_000_000n
  const fraction = (ns % 1_000_000_000n).toString().padStart(9, '0')
  return `${new Date(Number(milliseconds)).toISOString().slice(0, 19)}.${fraction}Z`
}

export const textField = (event: ChecklistEvent, name: string): string | null => {
  const value = event.fields[name]
  return typeof value === 'string' ? value : null
}

export const numberField = (event: ChecklistEvent, name: string): number | null => {
  const value = event.fields[name]
  return typeof value === 'number' ? value : null
}

export const isBatchCalls = (value: FieldValue | undefined): value is readonly BatchCall[] => Array.isArray(value)

export const callsOf = (event: ChecklistEvent): readonly BatchCall[] => {
  const value = event.fields.tool_calls
  return isBatchCalls(value) ? value : []
}
