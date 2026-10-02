import type { JsonValue } from '@aang/contract'

export type JsonObject = { readonly [key: string]: JsonValue }

export const parseJson = (text: string): JsonValue | undefined => {
  try {
    return JSON.parse(text) as JsonValue
  } catch {
    return undefined
  }
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
