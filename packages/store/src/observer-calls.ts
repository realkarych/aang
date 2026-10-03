import type { DatabaseSync } from 'node:sqlite'
import {
  ChangeSeq,
  EpochNs,
  ModelVersion,
  ObserverCallId,
  ObserverInput,
  ObserverRejection,
  RunId,
  type Runtime,
} from '@aang/contract'
import { decodeJson, encodeJson } from './codec.js'
import { prepareStatement, type WriteContext } from './context.js'

export type ObserverCallVerdict = 'accepted' | 'rejected' | 'needs_requested'

export interface StoredObserverCall {
  readonly id: ObserverCallId
  readonly run: RunId
  readonly backend: Runtime
  readonly base_version: ModelVersion
  readonly input: ObserverInput
  readonly output: unknown
  readonly verdict: ObserverCallVerdict | null
  readonly reasons: ObserverRejection[]
  readonly started_at: EpochNs
  readonly finished_at: EpochNs | null
  readonly change_seq: ChangeSeq
}

export interface ObserverCallStart {
  readonly id: ObserverCallId
  readonly backend: Runtime
  readonly input: ObserverInput
  readonly at: EpochNs
}

export interface ObserverCallResult {
  readonly id: ObserverCallId
  readonly output: unknown
  readonly verdict: ObserverCallVerdict
  readonly reasons: readonly ObserverRejection[]
  readonly at: EpochNs
}

export interface ObserverCallProgress {
  readonly last_accepted_at: EpochNs | null
  readonly change_seq: ChangeSeq | null
}

export interface ObserverCallReader {
  readonly get: (id: ObserverCallId) => StoredObserverCall | null
  readonly ofRun: (run: RunId) => StoredObserverCall[]
  readonly progress: (run: RunId) => ObserverCallProgress
}

export interface ObserverCallWriter extends ObserverCallReader {
  readonly start: (call: ObserverCallStart) => void
  readonly finish: (result: ObserverCallResult) => void
}

type CallRow = {
  id: string
  run_id: string
  backend: Runtime
  base_version: bigint
  input: string
  output: string | null
  verdict: ObserverCallVerdict | null
  reasons: string
  started_at: bigint
  finished_at: bigint | null
  change_seq: bigint
}

const toCall = (row: CallRow): StoredObserverCall => ({
  id: ObserverCallId.parse(row.id),
  run: RunId.parse(row.run_id),
  backend: row.backend,
  base_version: ModelVersion.parse(Number(row.base_version)),
  input: ObserverInput.parse(decodeJson(row.input)),
  output: row.output === null ? null : decodeJson(row.output),
  verdict: row.verdict,
  reasons: ObserverRejection.array().parse(decodeJson(row.reasons)),
  started_at: EpochNs.parse(row.started_at),
  finished_at: row.finished_at === null ? null : EpochNs.parse(row.finished_at),
  change_seq: ChangeSeq.parse(Number(row.change_seq)),
})

export const createObserverCalls = (database: DatabaseSync) => {
  const select = prepareStatement(database, 'SELECT * FROM observer_calls WHERE id = ?')
  const selectOfRun = prepareStatement(
    database,
    'SELECT * FROM observer_calls WHERE run_id = ? ORDER BY started_at, id',
  )
  const selectProgress = prepareStatement(
    database,
    `SELECT MAX(finished_at) FILTER (WHERE verdict = 'accepted') AS last_accepted_at, MAX(change_seq) AS change_seq
     FROM observer_calls WHERE run_id = ?`,
  )
  const insert = prepareStatement(
    database,
    `INSERT INTO observer_calls (id, run_id, backend, base_version, input, started_at, change_seq)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
  const finish = prepareStatement(
    database,
    `UPDATE observer_calls SET output = ?, verdict = ?, reasons = ?, finished_at = ?, change_seq = ?
     WHERE id = ? AND finished_at IS NULL`,
  )
  const reader: ObserverCallReader = {
    get: (id) => {
      const row = select.get(id) as CallRow | undefined
      return row === undefined ? null : toCall(row)
    },
    ofRun: (run) => (selectOfRun.all(run) as CallRow[]).map(toCall),
    progress: (run) => {
      const row = selectProgress.get(run) as { last_accepted_at: bigint | null; change_seq: bigint | null }
      return {
        last_accepted_at: row.last_accepted_at === null ? null : EpochNs.parse(row.last_accepted_at),
        change_seq: row.change_seq === null ? null : ChangeSeq.parse(Number(row.change_seq)),
      }
    },
  }
  const writer = (context: WriteContext): ObserverCallWriter => ({
    ...reader,
    start: ({ id, backend, input, at }) => {
      context.assertActive()
      insert.run(
        id,
        input.run.id,
        backend,
        input.model.version,
        encodeJson(input),
        at,
        context.nextChangeSeq(),
      )
    },
    finish: ({ id, output, verdict, reasons, at }) => {
      context.assertActive()
      const result = finish.run(
        encodeJson(output),
        verdict,
        encodeJson(reasons),
        at,
        context.nextChangeSeq(),
        id,
      )
      if (result.changes !== 1n) {
        throw new Error(`observer call ${id} is missing or already finished`)
      }
    },
  })
  return { reader, writer }
}
