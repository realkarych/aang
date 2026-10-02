import { isDeepStrictEqual } from 'node:util'
import type { JsonValue } from '@aang/contract'

type JsonObject = { readonly [key: string]: JsonValue }

const thinkingTypes: ReadonlySet<string> = new Set([
  'thinking',
  'redacted_thinking',
  'reasoning',
  'Reasoning',
  'agent_reasoning',
  'agent_reasoning_delta',
  'agent_reasoning_raw_content',
  'agent_reasoning_raw_content_delta',
  'agent_reasoning_section_break',
])

const isObject = (value: JsonValue): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const thinkingType = (value: JsonValue): string | null =>
  isObject(value) && typeof value['type'] === 'string' && thinkingTypes.has(value['type']) ? value['type'] : null

const strip = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) {
    return value.filter((item) => thinkingType(item) === null).map(strip)
  }
  if (!isObject(value)) {
    return value
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, member]) => {
      const type = thinkingType(member)
      return [key, type === null ? strip(member) : { type }]
    }),
  )
}

export const withoutThinking = (payload: string): string => {
  try {
    const parsed = JSON.parse(payload) as JsonValue
    const stripped = strip(parsed)
    return isDeepStrictEqual(parsed, stripped) ? payload : JSON.stringify(stripped)
  } catch {
    return payload
  }
}
