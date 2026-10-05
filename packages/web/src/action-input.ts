import type { ActionStartPayload, FactId, JsonValue } from '@aang/contract'
import { readFact } from './api.js'
import { nowNs } from './format.js'

export interface ActionInput {
  readonly detail: string | null
  readonly description: string | null
}

const detailFields = ['command', 'cmd', 'file_path', 'path', 'pattern', 'url', 'query', 'prompt', 'subject'] as const

const factTimeoutMs = 10_000

const factRetryNs = 5_000_000_000n

const textOf = (value: JsonValue | undefined): string | null => {
  if (typeof value === 'string') {
    return value.trim() === '' ? null : value
  }
  return Array.isArray(value) && value.every((part): part is string => typeof part === 'string')
    ? value.join(' ')
    : null
}

export const detailOf = (input: JsonValue): string | null => {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return textOf(input)
  }
  for (const field of detailFields) {
    const text = textOf(input[field])
    if (text !== null) {
      return text
    }
  }
  return null
}

const inputOf = ({ input, description }: ActionStartPayload): ActionInput => {
  const detail = detailOf(input)
  return { detail, description: description === detail ? null : description }
}

const requests = new Map<FactId, Promise<ActionInput | null>>()

const failures = new Map<FactId, bigint>()

const settled = (id: FactId, now: bigint): boolean => {
  const failedAt = failures.get(id)
  return failedAt === undefined || now - failedAt < factRetryNs
}

export const actionInput = (id: FactId, now: bigint): Promise<ActionInput | null> => {
  const known = requests.get(id)
  if (known !== undefined && settled(id, now)) {
    return known
  }
  failures.delete(id)
  const request = readFact(id, AbortSignal.timeout(factTimeoutMs)).then(
    (fact) => (fact.kind === 'action_start' ? inputOf(fact.payload) : null),
    () => {
      failures.set(id, nowNs())
      return null
    },
  )
  requests.set(id, request)
  return request
}
