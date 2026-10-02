import { JsonValue } from '@aang/contract'
import { z } from 'zod'

const nestingLimit = 256

interface Nested {
  readonly value: unknown
  readonly depth: number
}

export const readJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export const withinNestingLimit = (value: unknown): boolean => {
  const pending: Nested[] = [{ value, depth: 0 }]
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (typeof next.value === 'object' && next.value !== null) {
      if (next.depth === nestingLimit) {
        return false
      }
      const members: unknown[] = Object.values(next.value)
      for (const member of members) {
        pending.push({ value: member, depth: next.depth + 1 })
      }
    }
  }
  return true
}

export const BoundedJson = z.unknown().refine(withinNestingLimit).pipe(JsonValue)
