import type {
  Action,
  ActionId,
  ActionMaterial,
  ArtifactVersionId,
  ArtifactVersionMaterial,
  EpochNs,
  Fact,
  JsonValue,
  MaterialUnavailableReason,
  ObserverMaterial,
  ObserverNeed,
  RawRecordMaterial,
  RawSeq,
  RunContext,
  Truncation,
} from '@aang/contract'
import { canonicalJson } from '@aang/contract/ids'
import { storedRunContext } from './context.js'
import type { InputScope, ScopeReader } from './scope.js'
import { withoutThinking } from './thinking.js'

export interface MaterialLimits {
  readonly needs: number
  readonly textLength: number
}

export const defaultMaterialLimits: MaterialLimits = { needs: 8, textLength: 16_000 }

const nanosecondsPerMillisecond = 1_000_000n

export const isoTime = (time: EpochNs): string => new Date(Number(time / nanosecondsPerMillisecond)).toISOString()

const optionalTime = (time: EpochNs | null): string | null => (time === null ? null : isoTime(time))

export interface Clipped<T> {
  readonly value: T
  readonly truncated: Truncation[]
}

export const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value))

const highSurrogate = (code: number): boolean => code >= 0xd8_00 && code <= 0xdb_ff

export const prefixOf = (text: string, limit: number): string =>
  text.slice(0, limit > 0 && highSurrogate(text.charCodeAt(limit - 1)) ? limit - 1 : limit)

export const clipText = (text: string, path: string, limit: number): Clipped<string> => {
  if (text.length <= limit) {
    return { value: text, truncated: [] }
  }
  const value = prefixOf(text, limit)
  const truncation = { path, length: text.length }
  return jsonBytes(value) + jsonBytes(truncation) < jsonBytes(text)
    ? { value, truncated: [truncation] }
    : { value: text, truncated: [] }
}

export const clipJson = (value: JsonValue, path: string, limit: number): Clipped<JsonValue> => {
  if (typeof value === 'string') {
    return clipText(value, path, limit)
  }
  if (value === null || typeof value !== 'object') {
    return { value, truncated: [] }
  }
  const members = Object.entries(value).map(
    ([key, member]) => [key, clipJson(member, `${path}.${key}`, limit)] as const,
  )
  const truncated = members.flatMap(([, member]) => member.truncated)
  return Array.isArray(value)
    ? { value: members.map(([, member]) => member.value), truncated }
    : { value: Object.fromEntries(members.map(([key, member]) => [key, member.value])), truncated }
}

const clipEntries = (context: RunContext, limit: number): RunContext => ({
  ...context,
  entries: context.entries.map((entry) => {
    const { value, truncated } = clipText(entry.text, 'text', limit)
    const [truncation] = truncated
    return truncation === undefined ? entry : { ...entry, text: value, truncated: entry.truncated ?? truncation }
  }),
})

export const clipContext = (context: RunContext | null, limit: number): RunContext | null =>
  context === null ? null : clipEntries(context, limit)

const unavailable = (request: ObserverNeed, reason: MaterialUnavailableReason): ObserverMaterial => ({
  kind: 'unavailable',
  request,
  reason,
})

interface ActionOutput {
  readonly text: string | null
  readonly result: JsonValue
}

const actionOutput = (end: Fact | null, call: string): ActionOutput => {
  switch (end?.kind) {
    case 'action_end':
      return { text: end.payload.output, result: end.payload.result }
    case 'tool_batch_end':
      return { text: end.payload.calls.find(({ call_id }) => call_id === call)?.response ?? null, result: null }
    default:
      return { text: null, result: null }
  }
}

const clipOutput = ({ text, result }: ActionOutput, limit: number): Clipped<string | null> => {
  const output = text === null ? null : clipText(text, 'output', limit)
  if (result === null) {
    return { value: output?.value ?? null, truncated: output?.truncated ?? [] }
  }
  const structured = clipJson(result, 'result', limit)
  return {
    value: JSON.stringify({ output: output?.value ?? null, result: structured.value }),
    truncated: [...(output?.truncated ?? []), ...structured.truncated],
  }
}

export const actionMaterial = (reader: Pick<ScopeReader, 'facts'>, action: Action, limit: number): ActionMaterial => {
  const start = action.input_fact === null ? null : reader.facts.get(action.input_fact)
  const end = action.output_fact === null ? null : reader.facts.get(action.output_fact)
  const input = clipJson(start?.kind === 'action_start' ? start.payload.input : null, 'input', limit)
  const output = clipOutput(actionOutput(end, action.key.call), limit)
  return {
    kind: 'action',
    action: action.id,
    tool: action.tool,
    action_kind: action.action_kind,
    agent: action.agent,
    started_at: optionalTime(action.started_at),
    ended_at: optionalTime(action.ended_at),
    outcome: action.outcome?.value ?? null,
    input: input.value,
    output: output.value,
    truncated: [...input.truncated, ...output.truncated],
  }
}

export type Resolved<M> = M | MaterialUnavailableReason

export const isUnavailable = <M>(resolved: Resolved<M>): resolved is MaterialUnavailableReason =>
  typeof resolved === 'string'

export const rawRecordMaterial = (
  reader: ScopeReader,
  scope: InputScope,
  seq: RawSeq,
  limit: number,
): Resolved<RawRecordMaterial> => {
  const record = reader.rawRecords.get(seq)
  if (record === null) {
    return 'not_found'
  }
  const exclusion = scope.record(record)
  if (exclusion !== null) {
    return exclusion
  }
  const stripped = withoutThinking(record)
  if (stripped === null) {
    return 'out_of_scope'
  }
  const payload = clipText(stripped, 'payload', limit)
  return {
    kind: 'raw_record',
    seq: record.seq,
    channel: record.channel,
    observed_at: isoTime(record.observed_at),
    payload: payload.value,
    truncated: payload.truncated[0] ?? null,
  }
}

export const requestedAction = (
  reader: ScopeReader,
  scope: InputScope,
  id: ActionId,
  limit: number,
): Resolved<ActionMaterial> => {
  const action = reader.observations.getAction(id)
  if (action === null) {
    return 'not_found'
  }
  return scope.action(action) ?? actionMaterial(reader, action, limit)
}

const contentDecoder = new TextDecoder()

export const artifactVersionMaterial = (
  reader: ScopeReader,
  scope: InputScope,
  id: ArtifactVersionId,
  limit: number,
): Resolved<ArtifactVersionMaterial> => {
  const version = reader.artifacts.getVersion(id)
  if (version === null) {
    return 'not_found'
  }
  const exclusion = scope.version(version)
  if (exclusion !== null) {
    return exclusion
  }
  const { retention } = version
  if (retention.kind !== 'action_payload' && retention.kind !== 'file_read') {
    return 'not_retained'
  }
  const stored = reader.artifacts.blob(retention.blob)
  if (stored === null) {
    return 'not_retained'
  }
  const content = clipText(contentDecoder.decode(stored), 'content', limit)
  return {
    kind: 'artifact_version',
    version: version.id,
    ref: version.ref,
    retention: retention.kind,
    read_at: retention.kind === 'file_read' ? isoTime(retention.read_at) : null,
    content: content.value,
    truncated: content.truncated[0] ?? null,
  }
}

const materialOf = <M extends ObserverMaterial>(need: ObserverNeed, resolved: Resolved<M>): ObserverMaterial =>
  isUnavailable(resolved) ? unavailable(need, resolved) : resolved

const resolveNeed = (
  reader: ScopeReader,
  scope: InputScope,
  need: ObserverNeed,
  limit: number,
): ObserverMaterial => {
  switch (need.kind) {
    case 'raw_record':
      return materialOf(need, rawRecordMaterial(reader, scope, need.seq, limit))
    case 'action':
      return materialOf(need, requestedAction(reader, scope, need.action, limit))
    case 'context': {
      const record = reader.rawRecords.get(need.seq)
      if (record?.channel !== 'context') {
        return unavailable(need, 'not_found')
      }
      const exclusion = scope.record(record)
      const context = storedRunContext(reader.rawRecords, need.seq)
      if (exclusion !== null || context === null) {
        return unavailable(need, exclusion ?? 'not_found')
      }
      return { kind: 'context', context: clipEntries(context, limit) }
    }
    case 'artifact_version':
      return materialOf(need, artifactVersionMaterial(reader, scope, need.version, limit))
  }
}

export const resolveObserverNeeds = (
  reader: ScopeReader,
  scope: InputScope,
  needs: readonly ObserverNeed[],
  limits: MaterialLimits = defaultMaterialLimits,
): ObserverMaterial[] => {
  if (![limits.needs, limits.textLength].every((value) => Number.isSafeInteger(value) && value > 0)) {
    throw new RangeError('material limits must be positive integers')
  }
  const unique = new Map(needs.map((need) => [canonicalJson(need), need]))
  return [...unique.values()].slice(0, limits.needs).map((need) => resolveNeed(reader, scope, need, limits.textLength))
}
