import type { DatabaseSync } from 'node:sqlite'
import { type RawSeq, type RunId, RunKey, type SessionKey, type StreamKey } from '@aang/contract'
import { objectId } from '@aang/contract/ids'
import { decodeJson } from './codec.js'
import { prepareStatement, type WriteContext } from './context.js'

export interface PruneTarget {
  readonly runs: readonly RunId[]
  readonly sessions: readonly SessionKey[]
  readonly streams: readonly StreamKey[]
  readonly records: readonly RawSeq[]
}

export interface PruningWriter {
  readonly remove: (target: PruneTarget) => void
}

export interface PruningRepository {
  readonly writer: (context: WriteContext) => PruningWriter
  readonly vacuum: () => void
}

const listed = (parameter: string): string => `(SELECT value FROM json_each(:${parameter}))`

const ofTargetSession = (column: string): string =>
  `EXISTS (SELECT 1 FROM json_each(:sessions) target
    WHERE json_extract(target.value, '$[0]') = json_extract(${column}, '$.runtime')
      AND json_extract(target.value, '$[1]') = json_extract(${column}, '$.session'))`

const steps: readonly string[] = [
  `DELETE FROM blob_refs WHERE version_id IN ${listed('objects')}`,
  `DELETE FROM links WHERE from_id IN ${listed('objects')} OR to_id IN ${listed('objects')}`,
  `DELETE FROM objects WHERE id IN ${listed('objects')}`,
  `DELETE FROM object_removals WHERE run_id IN ${listed('runs')} OR ${ofTargetSession('entity_key')}`,
  `DELETE FROM raw_records WHERE stream IN ${listed('streams')} OR seq IN ${listed('records')}
    OR seq IN (SELECT seq FROM facts WHERE entity_key IN ${listed('runFacts')})
    OR (channel NOT IN ('snapshot', 'context') AND seq IN (SELECT seq FROM facts WHERE ${ofTargetSession('facts.entity_key')}))`,
  `DELETE FROM facts WHERE json_extract(entity_key, '$.kind') <> 'run' AND ${ofTargetSession('entity_key')}`,
  `DELETE FROM gaps WHERE run_id IN ${listed('runs')} OR session_id IN ${listed('sessionIds')} OR stream IN ${listed('streams')}`,
  `DELETE FROM model_entities WHERE run_id IN ${listed('runs')}`,
  `DELETE FROM model_changes WHERE run_id IN ${listed('runs')}`,
  `DELETE FROM model_versions WHERE run_id IN ${listed('runs')}`,
  `DELETE FROM fact_interpretation WHERE run_id IN ${listed('runs')}`,
  `DELETE FROM observer_calls WHERE run_id IN ${listed('runs')}`,
  `DELETE FROM view_marks WHERE run_id IN ${listed('runs')}`,
  `DELETE FROM attention_views WHERE run_id IN ${listed('runs')}`,
  `DELETE FROM view_rules WHERE run_id IN ${listed('runs')}`,
  `DELETE FROM chat_messages WHERE run_id IN ${listed('runs')}`,
  `DELETE FROM bindings WHERE session_id IN ${listed('sessionIds')} OR target_run_id IN ${listed('runs')}`,
  `DELETE FROM runs WHERE id IN ${listed('runs')}`,
]

const parametersOf = (sql: string): string[] => [...new Set([...sql.matchAll(/:([A-Za-z]+)/g)].map((match) => match[1] ?? ''))]

export const createPruning = (database: DatabaseSync): PruningRepository => {
  const selectObjects = prepareStatement(
    database,
    `SELECT id FROM objects WHERE run_id IN ${listed('runs')} OR ${ofTargetSession('entity_key')}`,
  )
  const selectRunFacts = prepareStatement(
    database,
    "SELECT DISTINCT entity_key FROM facts WHERE json_extract(entity_key, '$.kind') = 'run'",
  )
  const statements = steps.map((sql) => ({ statement: prepareStatement(database, sql), parameters: parametersOf(sql) }))

  const runFactsOf = (runs: readonly RunId[]): string[] => {
    const targets = new Set<string>(runs)
    return (selectRunFacts.all() as { readonly entity_key: string }[]).flatMap(({ entity_key: key }) =>
      targets.has(objectId(RunKey.parse(decodeJson(key)))) ? [key] : [],
    )
  }

  const writer = (context: WriteContext): PruningWriter => ({
    remove: ({ runs, sessions, streams, records }) => {
      context.assertActive()
      const base = {
        runs: JSON.stringify(runs),
        sessions: JSON.stringify(sessions.map(({ runtime, session }) => [runtime, session])),
        sessionIds: JSON.stringify(sessions.map((session) => objectId(session))),
        streams: JSON.stringify(streams),
        records: JSON.stringify(records),
      }
      const objects = (selectObjects.all({ runs: base.runs, sessions: base.sessions }) as { readonly id: string }[]).map(
        ({ id }) => id,
      )
      const values: Readonly<Record<string, string>> = {
        ...base,
        objects: JSON.stringify(objects),
        runFacts: JSON.stringify(runFactsOf(runs)),
      }
      for (const { statement, parameters } of statements) {
        statement.run(Object.fromEntries(parameters.map((name) => [name, values[name] ?? '[]'])))
      }
    },
  })

  return {
    writer,
    vacuum: () => {
      database.exec('VACUUM')
    },
  }
}
