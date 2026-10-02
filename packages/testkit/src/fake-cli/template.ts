import type { JsonValue } from '@aang/contract'

export class TemplateError extends Error {
  override readonly name = 'TemplateError'
}

const inputKey = '$input'
const wildcard = '*'

type JsonObject = { readonly [key: string]: JsonValue }

const isObject = (value: JsonValue): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const segments = (pointer: string): string[] => {
  if (pointer === '') {
    return []
  }
  if (!pointer.startsWith('/')) {
    throw new TemplateError(`input pointer ${pointer} must start with /`)
  }
  return pointer
    .slice(1)
    .split('/')
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'))
}

const child = (value: JsonValue, segment: string): JsonValue | undefined => {
  if (Array.isArray(value)) {
    return /^(?:0|[1-9][0-9]*)$/.test(segment) ? value[Number(segment)] : undefined
  }
  return isObject(value) && Object.hasOwn(value, segment) ? value[segment] : undefined
}

const select = (value: JsonValue, path: readonly string[], pointer: string): JsonValue[] => {
  const [segment, ...rest] = path
  if (segment === undefined) {
    return [value]
  }
  if (segment === wildcard) {
    if (!Array.isArray(value)) {
      throw new TemplateError(`input pointer ${pointer} expands ${wildcard} over a non-array`)
    }
    return value.flatMap((item) => select(item, rest, pointer))
  }
  const next = child(value, segment)
  if (next === undefined) {
    throw new TemplateError(`input pointer ${pointer} does not resolve in the input`)
  }
  return select(next, rest, pointer)
}

const resolvePointer = (input: JsonValue, pointer: string): JsonValue => {
  const path = segments(pointer)
  const values = select(input, path, pointer)
  return path.includes(wildcard) ? values : (values[0] ?? null)
}

const reference = (template: JsonObject): string | undefined => {
  const keys = Object.keys(template)
  const pointer = template[inputKey]
  return keys.length === 1 && typeof pointer === 'string' ? pointer : undefined
}

export const renderTemplate = (template: JsonValue, input: JsonValue | undefined): JsonValue => {
  if (Array.isArray(template)) {
    return template.map((item) => renderTemplate(item, input))
  }
  if (!isObject(template)) {
    return template
  }
  const pointer = reference(template)
  if (pointer === undefined) {
    return Object.fromEntries(Object.entries(template).map(([key, value]) => [key, renderTemplate(value, input)]))
  }
  if (input === undefined) {
    throw new TemplateError(`the prompt carries no JSON document for input pointer ${pointer}`)
  }
  return resolvePointer(input, pointer)
}

const documentStarts = (prompt: string): number[] => [
  0,
  ...[...prompt.matchAll(/\n(?=[[{])/g)].map((match) => match.index + 1),
]

export const extractInput = (prompt: string): JsonValue | undefined => {
  for (const start of documentStarts(prompt)) {
    try {
      return JSON.parse(prompt.slice(start)) as JsonValue
    } catch {
      continue
    }
  }
  return undefined
}
