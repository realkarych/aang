import type { JsonValue, RawChannel, RawRecord } from '@aang/contract'

type JsonObject = { readonly [key: string]: JsonValue }

interface ThinkingContainer {
  readonly line: string
  readonly container: string
  readonly items: string
  readonly types: ReadonlySet<string>
}

const containers: ReadonlyMap<RawChannel, ThinkingContainer> = new Map([
  [
    'transcript',
    { line: 'assistant', container: 'message', items: 'content', types: new Set(['thinking', 'redacted_thinking']) },
  ],
  ['rollout', { line: 'compacted', container: 'payload', items: 'replacement_history', types: new Set(['reasoning']) }],
])

const nestingLimit = 256

const isObject = (value: JsonValue | undefined): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const withinNestingLimit = (value: JsonValue): boolean => {
  const pending: { readonly value: JsonValue; readonly depth: number }[] = [{ value, depth: 0 }]
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (typeof next.value === 'object' && next.value !== null) {
      if (next.depth === nestingLimit) {
        return false
      }
      for (const member of Object.values(next.value)) {
        pending.push({ value: member, depth: next.depth + 1 })
      }
    }
  }
  return true
}

const parseObject = (text: string): JsonObject | null => {
  const value = JSON.parse(text) as JsonValue
  return isObject(value) && withinNestingLimit(value) ? value : null
}

const stripped = (line: JsonObject, { line: type, container, items, types }: ThinkingContainer): JsonObject | null => {
  const outer = line['type'] === type ? line[container] : undefined
  const list = isObject(outer) ? outer[items] : undefined
  if (!isObject(outer) || !Array.isArray(list)) {
    return null
  }
  const kept = list.filter((item) => !(isObject(item) && typeof item['type'] === 'string' && types.has(item['type'])))
  return kept.length === list.length ? null : { ...line, [container]: { ...outer, [items]: kept } }
}

export const withoutThinking = ({ channel, payload }: Pick<RawRecord, 'channel' | 'payload'>): string | null => {
  const container = containers.get(channel)
  if (container === undefined) {
    return payload
  }
  const line = parseObject(payload)
  if (line === null) {
    return null
  }
  const result = stripped(line, container)
  return result === null ? payload : JSON.stringify(result)
}
