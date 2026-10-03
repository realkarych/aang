import type { PlayerStep } from '@aang/testkit'
import type { CapturedArtifact } from './capture.js'

interface Schema {
  readonly fields: readonly string[]
  readonly attributes?: ReadonlySet<string>
}

const claudeRecord: Schema = {
  fields: [
    'type', 'subtype', 'level', 'mode', 'kind', 'status', 'userType', 'entrypoint', 'promptSource', 'permissionMode', 'operation',
    'toolDenialKind', 'turnOrigin', 'renderedRole', 'requestShape', 'origin.kind', 'attachment.type', 'compactMetadata.trigger',
    'message.type', 'message.role', 'message.model', 'message.stop_reason', 'message.content.type', 'message.content.name',
    'message.content.content.type', 'message.content.input.status', 'message.content.input.todos.status',
    'toolUseResult.type', 'toolUseResult.status', 'toolUseResult.content.type', 'toolUseResult.statusChange.from', 'toolUseResult.statusChange.to',
  ],
}

const codexRollout: Schema = {
  fields: [
    'type', 'payload.type', 'payload.role', 'payload.name', 'payload.namespace', 'payload.status', 'payload.reason', 'payload.phase',
    'payload.originator', 'payload.source', 'payload.thread_source', 'payload.model', 'payload.effort', 'payload.approval_policy',
    'payload.approvals_reviewer', 'payload.sandbox_policy.type', 'payload.permission_profile.type', 'payload.collaboration_mode.mode',
    'payload.collaboration_mode_kind', 'payload.content.type', 'payload.output.type', 'payload.item.type', 'payload.item.status',
    'payload.item.phase', 'payload.item.delivery', 'payload.item.kind', 'payload.item.tool', 'payload.item.content.type',
  ],
}

const hookPayload: Schema = {
  fields: [
    'hook_event_name', 'source', 'tool_name', 'notification_type', 'action', 'trigger', 'permission_mode', 'reason', 'memory_type',
    'load_reason', 'stop_reason', 'model', 'background_tasks.type', 'background_tasks.status', 'tool_input.status', 'tool_input.todos.status',
    'tool_input.plan.status', 'tool_response.type', 'tool_response.status', 'tool_response.content.type', 'tool_calls.tool_name',
    'tool_calls.tool_input.status', 'tool_calls.tool_response.type',
  ],
}

const hookEnvelope: Schema = {
  fields: ['env.CLAUDE_CODE_ENTRYPOINT', 'env.AI_AGENT', 'env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE'],
}

const otlpEnvelope: Schema = {
  fields: [
    'resourceLogs.scopeLogs.scope.name', 'resourceLogs.scopeLogs.logRecords.severityText',
    'resourceSpans.scopeSpans.scope.name', 'resourceSpans.scopeSpans.spans.name',
    'resourceMetrics.scopeMetrics.scope.name', 'resourceMetrics.scopeMetrics.metrics.name',
  ],
  attributes: new Set([
    'event.name', 'event.kind', 'decision', 'source', 'originator', 'tool_name', 'tool_namespace', 'service.name', 'terminal.type', 'model',
    'slug', 'approval_policy', 'sandbox_policy', 'reasoning_effort', 'model_reasoning_effort', 'reasoning_summary', 'kind', 'state',
    'startup.phase', 'startup.status', 'success', 'env', 'telemetry.sdk.name', 'telemetry.sdk.language',
  ]),
}

const processOutput: Schema = {
  fields: [...claudeRecord.fields, 'item.type', 'item.status', 'method'],
}

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> => value !== null && typeof value === 'object' && !Array.isArray(value)

const valuesAt = (value: unknown, path: readonly string[]): string[] => {
  if (Array.isArray(value)) return value.flatMap((item: unknown) => valuesAt(item, path))
  if (typeof value === 'string') return path.length === 0 ? [value] : []
  const [key, ...rest] = path
  return key !== undefined && isObject(value) && Object.hasOwn(value, key) ? valuesAt(value[key], rest) : []
}

const attributeValues = (value: unknown, keys: ReadonlySet<string>): string[] => {
  if (Array.isArray(value)) return value.flatMap((item: unknown) => attributeValues(item, keys))
  if (!isObject(value)) return []
  const { key, value: content } = value
  const own = typeof key === 'string' && keys.has(key) && isObject(content) && typeof content['stringValue'] === 'string' ? [content['stringValue']] : []
  return [...own, ...Object.values(value).flatMap((nested) => attributeValues(nested, keys))]
}

const parse = (text: string): unknown => {
  try { return JSON.parse(text) } catch { return undefined }
}

const records = (content: string): unknown[] => {
  const whole = parse(content)
  return whole !== undefined ? [whole] : content.split('\n').map(parse).filter((record) => record !== undefined)
}

const valuesOf = (record: unknown, schema: Schema): string[] => [
  ...schema.fields.flatMap((field) => valuesAt(record, field.split('.'))),
  ...schema.attributes === undefined ? [] : attributeValues(record, schema.attributes),
]

const schemaOf = (step: PlayerStep): Schema | undefined => {
  switch (step.kind) {
    case 'hook': return hookPayload
    case 'otlp': return otlpEnvelope
    case 'write':
    case 'append': return step.target.root === 'claude' ? claudeRecord : step.target.root === 'codex' ? codexRollout : undefined
    default: return undefined
  }
}

export const protocolValues = (artifacts: readonly CapturedArtifact[], steps: readonly PlayerStep[]): Set<string> => {
  const schemas = new Map<string, Schema>()
  for (const { source } of artifacts) if (source.startsWith('output/')) schemas.set(source, processOutput)
  for (const step of steps) {
    const schema = schemaOf(step)
    if (schema !== undefined && 'source' in step) schemas.set(step.source, schema)
  }
  const values = new Set<string>()
  for (const { source, content } of artifacts) {
    const schema = schemas.get(source)
    if (schema !== undefined) for (const record of records(content)) for (const value of valuesOf(record, schema)) values.add(value)
  }
  for (const step of steps) if (step.kind === 'hook') for (const value of valuesOf(step, hookEnvelope)) values.add(value)
  return values
}
