import type {
  Action,
  ActionMaterial,
  EpochNs,
  JsonValue,
  MaterialUnavailableReason,
  ObserverMaterial,
  ObserverNeed,
  Truncation,
} from '@aang/contract'
import { canonicalJson } from '@aang/contract/ids'
import type { InputScope, ScopeReader } from './scope.js'
import { withoutThinking } from './thinking.js'

export interface MaterialLimits {
  readonly needs: number
  readonly textLength: number
}

const defaultLimits: MaterialLimits = { needs: 8, textLength: 4_000 }

const nanosecondsPerMillisecond = 1_000_000n

const isoTime = (time: EpochNs): string => new Date(Number(time / nanosecondsPerMillisecond)).toISOString()

const optionalTime = (time: EpochNs | null): string | null => (time === null ? null : isoTime(time))

interface Clipped<T> {
  readonly value: T
  readonly truncated: Truncation[]
}

const clipText = (text: string, path: string, limit: number): Clipped<string> =>
  text.length > limit
    ? { value: text.slice(0, limit), truncated: [{ path, length: text.length }] }
    : { value: text, truncated: [] }

const clipJson = (value: JsonValue, path: string, limit: number): Clipped<JsonValue> => {
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

const unavailable = (request: ObserverNeed, reason: MaterialUnavailableReason): ObserverMaterial => ({
  kind: 'unavailable',
  request,
  reason,
})

const actionMaterial = (reader: ScopeReader, action: Action, limit: number): ActionMaterial => {
  const start = action.input_fact === null ? null : reader.facts.get(action.input_fact)
  const end = action.output_fact === null ? null : reader.facts.get(action.output_fact)
  const output =
    end?.kind === 'action_end'
      ? end.payload.output
      : end?.kind === 'tool_batch_end'
        ? (end.payload.calls.find(({ call_id }) => call_id === action.key.call)?.response ?? null)
        : null
  const input = clipJson(start?.kind === 'action_start' ? start.payload.input : null, 'input', limit)
  const clippedOutput = output === null ? null : clipText(output, 'output', limit)
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
    output: clippedOutput?.value ?? null,
    truncated: [...input.truncated, ...(clippedOutput?.truncated ?? [])],
  }
}

const resolveNeed = (
  reader: ScopeReader,
  scope: InputScope,
  need: ObserverNeed,
  limit: number,
): ObserverMaterial => {
  switch (need.kind) {
    case 'raw_record': {
      const record = reader.rawRecords.get(need.seq)
      if (record === null) {
        return unavailable(need, 'not_found')
      }
      const exclusion = scope.record(record)
      if (exclusion !== null) {
        return unavailable(need, exclusion)
      }
      const payload = clipText(withoutThinking(record.payload), 'payload', limit)
      return {
        kind: 'raw_record',
        seq: record.seq,
        channel: record.channel,
        observed_at: isoTime(record.observed_at),
        payload: payload.value,
        truncated: payload.truncated[0] ?? null,
      }
    }
    case 'action': {
      const action = reader.observations.getAction(need.action)
      if (action === null) {
        return unavailable(need, 'not_found')
      }
      const exclusion = scope.action(action)
      return exclusion === null ? actionMaterial(reader, action, limit) : unavailable(need, exclusion)
    }
    case 'artifact_version':
    case 'context':
      return unavailable(need, 'not_found')
  }
}

export const resolveObserverNeeds = (
  reader: ScopeReader,
  scope: InputScope,
  needs: readonly ObserverNeed[],
  limits: MaterialLimits = defaultLimits,
): ObserverMaterial[] => {
  if (![limits.needs, limits.textLength].every((value) => Number.isSafeInteger(value) && value > 0)) {
    throw new RangeError('material limits must be positive integers')
  }
  const unique = new Map(needs.map((need) => [canonicalJson(need), need]))
  return [...unique.values()].slice(0, limits.needs).map((need) => resolveNeed(reader, scope, need, limits.textLength))
}
