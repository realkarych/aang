import type { DatabaseSync } from 'node:sqlite'
import {
  EpochNs,
  FactId,
  FactInterpretation,
  ObserverCallId,
  RawSeq,
  RunId,
} from '@aang/contract'
import { prepareStatement, type WriteContext } from './context.js'

export interface PendingFact {
  readonly fact: FactId
  readonly seq: RawSeq
  readonly at: EpochNs
  readonly observed_at: EpochNs
  readonly urgent: boolean
  readonly bytes: number
  readonly attempts: number
  readonly observer_call: ObserverCallId | null
}

export type ClosedStatus = 'deferred' | 'not_interpreted'

export interface InterpretationQueue {
  readonly pending: number
  readonly deferred: number
  readonly not_interpreted: number
  readonly oldest_pending_at: EpochNs | null
}

export interface InterpretationReader {
  readonly ofRun: (run: RunId) => FactInterpretation[]
  readonly ofCall: (call: ObserverCallId) => FactInterpretation[]
  readonly queueOf: (run: RunId) => InterpretationQueue
  readonly pendingRuns: () => RunId[]
  readonly pending: (run: RunId) => PendingFact[]
}

export interface InterpretationWriter extends InterpretationReader {
  readonly begin: (run: RunId, call: ObserverCallId, facts: readonly FactId[]) => void
  readonly settle: (call: ObserverCallId, status: 'pending' | 'interpreted') => void
  readonly handover: (from: ObserverCallId, to: ObserverCallId) => number
  readonly queue: (run: RunId, facts: readonly FactId[]) => void
  readonly withdraw: (run: RunId, facts: readonly FactId[]) => void
  readonly close: (run: RunId, facts: readonly FactId[], status: ClosedStatus) => number
  readonly release: (call: ObserverCallId) => number
  readonly exhaust: (call: ObserverCallId, attempts: number) => FactId[]
}

type QueueRow = {
  readonly pending: bigint
  readonly deferred: bigint
  readonly not_interpreted: bigint
  readonly oldest_pending_at: bigint | null
}

type InterpretationRow = {
  run_id: string
  fact_id: string
  status: string
  attempts: bigint
  observer_call_id: string | null
}

type PendingRow = {
  fact_id: string
  seq: bigint
  occurred_at: bigint
  observed_at: bigint
  urgent: bigint
  bytes: bigint
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

const fromPendingRow = (row: PendingRow): PendingFact => ({
  fact: FactId.parse(row.fact_id),
  seq: RawSeq.parse(Number(row.seq)),
  at: EpochNs.parse(row.occurred_at),
  observed_at: EpochNs.parse(row.observed_at),
  urgent: row.urgent === 1n,
  bytes: Number(row.bytes),
  attempts: Number(row.attempts),
  observer_call: row.observer_call_id === null ? null : ObserverCallId.parse(row.observer_call_id),
})

export const recoverInterpretations = (database: DatabaseSync): void => {
  database.exec(
    "UPDATE fact_interpretation SET status = 'pending', attempts = MAX(attempts - 1, 0) WHERE status = 'in_call'",
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
  const selectQueue = prepareStatement(
    database,
    `SELECT
       COUNT(*) FILTER (WHERE i.status IN ('pending', 'in_call')) AS pending,
       COUNT(*) FILTER (WHERE i.status = 'deferred') AS deferred,
       COUNT(*) FILTER (WHERE i.status = 'not_interpreted') AS not_interpreted,
       MIN(f.occurred_at) FILTER (WHERE i.status IN ('pending', 'in_call')) AS oldest_pending_at
     FROM fact_interpretation i LEFT JOIN facts f ON f.id = i.fact_id
     WHERE i.run_id = ?`,
  )
  const pendingRuns = prepareStatement(
    database,
    `WITH RECURSIVE runs (id) AS (
       SELECT MIN(run_id) FROM fact_interpretation
       UNION ALL
       SELECT (SELECT MIN(run_id) FROM fact_interpretation WHERE run_id > runs.id) FROM runs WHERE runs.id IS NOT NULL
     )
     SELECT id FROM runs WHERE id IS NOT NULL AND EXISTS (
       SELECT 1 FROM fact_interpretation WHERE run_id = runs.id AND status = 'pending'
     )`,
  )
  const pending = prepareStatement(
    database,
    `SELECT i.fact_id, f.seq, f.occurred_at, r.observed_at, f.urgent, length(CAST(f.payload AS BLOB)) AS bytes, i.attempts,
       i.observer_call_id
     FROM fact_interpretation i JOIN facts f ON f.id = i.fact_id JOIN raw_records r ON r.seq = f.seq
     WHERE i.run_id = ? AND i.status = 'pending'
     ORDER BY f.seq, f.record_index`,
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
  const queue = prepareStatement(
    database,
    `INSERT INTO fact_interpretation (run_id, fact_id, status, attempts, observer_call_id) VALUES (?, ?, 'pending', 0, NULL)
     ON CONFLICT (run_id, fact_id) DO UPDATE SET status = 'pending', attempts = 0, observer_call_id = NULL
       WHERE status <> 'in_call'`,
  )
  const withdraw = prepareStatement(
    database,
    "DELETE FROM fact_interpretation WHERE run_id = ? AND fact_id = ? AND status IN ('pending', 'deferred')",
  )
  const close = prepareStatement(
    database,
    "UPDATE fact_interpretation SET status = ? WHERE run_id = ? AND fact_id = ? AND status = 'pending'",
  )
  const release = prepareStatement(
    database,
    `UPDATE fact_interpretation SET status = 'pending', attempts = MAX(attempts - 1, 0)
     WHERE observer_call_id = ? AND status = 'in_call'`,
  )
  const exhaust = prepareStatement(
    database,
    `UPDATE fact_interpretation SET status = 'not_interpreted'
     WHERE observer_call_id = ? AND status = 'pending' AND attempts >= ?
     RETURNING fact_id`,
  )
  const reader: InterpretationReader = {
    ofRun: (run) => (byRun.all(run) as InterpretationRow[]).map(fromRow),
    ofCall: (call) => (byCall.all(call) as InterpretationRow[]).map(fromRow),
    queueOf: (run) => {
      const row = selectQueue.get(run) as QueueRow
      return {
        pending: Number(row.pending),
        deferred: Number(row.deferred),
        not_interpreted: Number(row.not_interpreted),
        oldest_pending_at: row.oldest_pending_at === null ? null : EpochNs.parse(row.oldest_pending_at),
      }
    },
    pendingRuns: () => (pendingRuns.all() as { id: string }[]).map(({ id }) => RunId.parse(id)),
    pending: (run) => (pending.all(run) as PendingRow[]).map(fromPendingRow),
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
    queue: (run, facts) => {
      context.assertActive()
      for (const fact of new Set(facts)) {
        queue.run(run, fact)
      }
    },
    withdraw: (run, facts) => {
      context.assertActive()
      for (const fact of new Set(facts)) {
        withdraw.run(run, fact)
      }
    },
    close: (run, facts, status) => {
      context.assertActive()
      return [...new Set(facts)].reduce((closed, fact) => closed + Number(close.run(status, run, fact).changes), 0)
    },
    release: (call) => {
      context.assertActive()
      return Number(release.run(call).changes)
    },
    exhaust: (call, attempts) => {
      context.assertActive()
      return (exhaust.all(call, attempts) as { fact_id: string }[]).map(({ fact_id }) => FactId.parse(fact_id))
    },
  })
  return { reader, writer }
}
