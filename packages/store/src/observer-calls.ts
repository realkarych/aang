import type { DatabaseSync } from 'node:sqlite'
import {
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

export interface StoredObserverCall {
  readonly id: ObserverCallId
  readonly run: RunId
  readonly backend: Runtime
  readonly base_version: ModelVersion
  readonly input: ObserverInput
  readonly output: unknown
  readonly verdict: 'accepted' | 'rejected' | null
  readonly reasons: ObserverRejection[]
  readonly started_at: EpochNs
  readonly finished_at: EpochNs | null
}

export interface ObserverCallStart {
  readonly id: ObserverCallId
  readonly input: ObserverInput
  readonly at: EpochNs
}

export interface ObserverCallResult {
  readonly id: ObserverCallId
  readonly output: unknown
  readonly verdict: 'accepted' | 'rejected'
  readonly reasons: readonly ObserverRejection[]
  readonly at: EpochNs
}

export interface ObserverCallReader {
  readonly get: (id: ObserverCallId) => StoredObserverCall | null
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
  verdict: 'accepted' | 'rejected' | null
  reasons: string
  started_at: bigint
  finished_at: bigint | null
}

export const createObserverCalls = (database: DatabaseSync) => {
  const select = prepareStatement(database, 'SELECT * FROM observer_calls WHERE id = ?')
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
      return row === undefined
        ? null
        : {
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
          }
    },
  }
  const writer = (context: WriteContext): ObserverCallWriter => ({
    ...reader,
    start: ({ id, input, at }) => {
      context.assertActive()
      insert.run(
        id,
        input.run.id,
        input.run.runtime,
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
