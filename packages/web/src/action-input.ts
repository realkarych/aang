import type { JsonValue } from '@aang/contract'

const detailFields = ['command', 'cmd', 'file_path', 'path', 'pattern', 'url', 'query', 'prompt', 'subject'] as const

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
