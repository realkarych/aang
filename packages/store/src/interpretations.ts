import type { DatabaseSync } from 'node:sqlite'
import { FactInterpretation, type FactId, type ObserverCallId, type RunId } from '@aang/contract'
import { prepareStatement, type WriteContext } from './context.js'

export interface InterpretationReader {
  readonly ofRun: (run: RunId) => FactInterpretation[]
  readonly ofCall: (call: ObserverCallId) => FactInterpretation[]
}

export interface InterpretationWriter extends InterpretationReader {
  readonly begin: (run: RunId, call: ObserverCallId, facts: readonly FactId[]) => void
  readonly settle: (call: ObserverCallId, status: 'pending' | 'interpreted') => void
  readonly handover: (from: ObserverCallId, to: ObserverCallId) => number
}

type InterpretationRow = {
  run_id: string
  fact_id: string
  status: string
  attempts: bigint
  observer_call_id: string | null
}

const fromRow = (row: InterpretationRow): FactInterpretation =>
  FactInterpretation.parse({
    run: row.run_id,
    fact: row.fact_id,
    status: row.status,
    attempts: Number(row.attempts),
    observer_call: row.observer_call_id,
  })

export const recoverInterpretations = (database: DatabaseSync): void => {
  database.exec(
    "UPDATE fact_interpretation SET status = 'pending', observer_call_id = NULL WHERE status = 'in_call'",
  )
}

export const createInterpretations = (database: DatabaseSync) => {
  const byRun = prepareStatement(
    database,
    'SELECT * FROM fact_interpretation WHERE run_id = ? ORDER BY fact_id',
  )
  const byCall = prepareStatement(
    database,
    'SELECT * FROM fact_interpretation WHERE observer_call_id = ? ORDER BY fact_id',
  )
  const begin = prepareStatement(
    database,
    `INSERT INTO fact_interpretation (run_id, fact_id, status, attempts, observer_call_id) VALUES (?, ?, 'in_call', 1, ?)
     ON CONFLICT (run_id, fact_id) DO UPDATE SET status = 'in_call', attempts = attempts + 1,
       observer_call_id = excluded.observer_call_id WHERE status <> 'in_call'`,
  )
  const settle = prepareStatement(
    database,
    "UPDATE fact_interpretation SET status = ? WHERE observer_call_id = ? AND status = 'in_call'",
  )
  const handover = prepareStatement(
    database,
    `UPDATE fact_interpretation SET observer_call_id = :to
     WHERE observer_call_id = :from AND status = 'in_call' AND EXISTS (
       SELECT 1 FROM observer_calls previous JOIN observer_calls next ON next.run_id = previous.run_id
       WHERE previous.id = :from AND previous.verdict = 'needs_requested'
         AND next.id = :to AND next.finished_at IS NULL AND previous.run_id = fact_interpretation.run_id
     )`,
  )
  const reader: InterpretationReader = {
    ofRun: (run) => (byRun.all(run) as InterpretationRow[]).map(fromRow),
    ofCall: (call) => (byCall.all(call) as InterpretationRow[]).map(fromRow),
  }
  const writer = (context: WriteContext): InterpretationWriter => ({
    ...reader,
    begin: (run, call, facts) => {
      context.assertActive()
      for (const fact of new Set(facts)) {
        if (begin.run(run, fact, call).changes !== 1n) {
          throw new Error(`fact ${fact} is already in a call`)
        }
      }
    },
    settle: (call, status) => {
      context.assertActive()
      settle.run(status, call)
    },
    handover: (from, to) => {
      context.assertActive()
      return Number(handover.run({ from, to }).changes)
    },
  })
  return { reader, writer }
}
