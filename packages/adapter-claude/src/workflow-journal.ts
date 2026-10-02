import type { CollectedRecord, JsonValue, ParseResult } from '@aang/contract'
import { z } from 'zod'
import { startedAgent } from './agents.js'
import { fact, fileOrigin, invalid, parsed, schemaViolation, unknown } from './facts.js'
import { name } from './fields.js'
import { isJsonObject, type JsonObject, parseJson } from './json.js'
import { agentKey } from './keys.js'
import type { WorkflowJournal } from './paths.js'

const Started = z.looseObject({ agentId: name, label: z.string().nullish() })

const Result = z.looseObject({ agentId: name, result: z.json().optional() })

type EntryParser = (entry: JsonObject, journal: WorkflowJournal, record: CollectedRecord) => ParseResult

const resultText = (result: JsonValue | undefined): string | null => {
  if (result === undefined || result === null) {
    return null
  }
  return typeof result === 'string' ? result : JSON.stringify(result)
}

const entryParsers: ReadonlyMap<string, EntryParser> = new Map<string, EntryParser>([
  ['launched', () => parsed(null, [])],
  [
    'started',
    (entry, journal, record) => {
      const started = Started.safeParse(entry)
      if (!started.success) {
        return schemaViolation('workflow journal started entry', started.error)
      }
      const { agentId: agent, label } = started.data
      return parsed(null, [
        fact(
          fileOrigin(record, journal.session, agent),
          {
            kind: 'agent_start',
            entity_key: agentKey(journal.session, agent),
            speaker: 'runtime',
            urgent: false,
            payload: startedAgent({ role: 'subagent', description: label ?? null }),
          },
          { verified: false },
        ),
      ])
    },
  ],
  [
    'result',
    (entry, journal, record) => {
      const result = Result.safeParse(entry)
      if (!result.success) {
        return schemaViolation('workflow journal result entry', result.error)
      }
      const { agentId: agent } = result.data
      return parsed(null, [
        fact(
          fileOrigin(record, journal.session, agent),
          {
            kind: 'agent_end',
            entity_key: agentKey(journal.session, agent),
            speaker: 'runtime',
            urgent: true,
            payload: {
              outcome: 'completed',
              final_message: resultText(result.data.result),
              agent_type: null,
              transcript_path: null,
            },
          },
          { verified: false },
        ),
      ])
    },
  ],
])

export const parseWorkflowJournalLine = (record: CollectedRecord, journal: WorkflowJournal): ParseResult => {
  const entry = parseJson(record.payload)
  if (!isJsonObject(entry)) {
    return invalid('workflow journal line is not a JSON object')
  }
  const parser = typeof entry.type === 'string' ? entryParsers.get(entry.type) : undefined
  return parser === undefined ? unknown(null) : parser(entry, journal, record)
}
