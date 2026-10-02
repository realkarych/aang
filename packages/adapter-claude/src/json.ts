import type { JsonValue } from '@aang/contract'

export type JsonObject = { readonly [key: string]: JsonValue }

const nestingLimit = 256

interface Nested {
  readonly value: JsonValue
  readonly depth: number
}

export const parseJson = (text: string): JsonValue | undefined => {
  try {
    return JSON.parse(text) as JsonValue
  } catch {
    return undefined
  }
}

export const withinNestingLimit = (value: JsonValue): boolean => {
  const pending: Nested[] = [{ value, depth: 0 }]
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

export const isJsonObject = (value: JsonValue | undefined): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const stringField = (value: JsonValue | undefined, field: string): string | null => {
  if (!isJsonObject(value)) {
    return null
  }
  const member = value[field]
  return typeof member === 'string' && member.length > 0 ? member : null
}
