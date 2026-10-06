import type { Fact, JsonValue } from '@aang/contract'
import { outcomeLabel } from './labels.js'

const detailFields = ['command', 'cmd', 'file_path', 'path', 'pattern', 'url', 'query', 'prompt', 'subject'] as const

const textOf = (value: JsonValue | undefined): string | null => {
  if (typeof value === 'string') {
    return value.trim() === '' ? null : value
  }
  return Array.isArray(value) && value.every((part): part is string => typeof part === 'string')
    ? value.join(' ')
    : null
}

export const inputDetail = (input: JsonValue): string | null => {
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

const joined = (...parts: readonly (string | null)[]): string | null => {
  const present = parts.filter((part): part is string => part !== null && part.trim() !== '')
  return present.length === 0 ? null : present.join(' ')
}

export const factExcerpt = (fact: Fact): string | null => {
  switch (fact.kind) {
    case 'prompt':
    case 'message':
      return fact.payload.text
    case 'action_start':
      return joined(fact.payload.tool, inputDetail(fact.payload.input))
    case 'action_end':
      return joined(
        outcomeLabel[fact.payload.outcome],
        fact.payload.exit_code === null ? null : `код выхода ${String(fact.payload.exit_code)}`,
        fact.payload.output,
      )
    case 'permission_request':
      return joined(fact.payload.tool, inputDetail(fact.payload.input))
    case 'question_asked':
      return fact.payload.questions.map(({ text }) => text).join('\n')
    case 'question_answered':
      return fact.payload.answers.map(({ answer }) => answer).join('\n')
    case 'plan_update':
      return fact.payload.text ?? fact.payload.items.map(({ text }) => text).join('\n')
    case 'git_snapshot':
      return joined(
        fact.payload.head === null ? 'HEAD неизвестен' : `HEAD ${fact.payload.head.slice(0, 12)}`,
        fact.payload.clean ? 'дерево чистое' : 'есть изменения под масками',
      )
    case 'notification':
      return fact.payload.message
    case 'agent_start':
      return joined(fact.payload.agent_type, fact.payload.description)
    case 'agent_end':
      return fact.payload.final_message
    case 'compaction':
      return fact.payload.summary
    case 'runtime_error':
      return fact.payload.message
    default:
      return null
  }
}
