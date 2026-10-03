import type { DatabaseSync } from 'node:sqlite'
import {
  CallUsage,
  EpochNs,
  ModelVersion,
  ObserverCallId,
  ObserverErrorClass,
  ObserverInput,
  ObserverRejection,
  RunId,
  type JsonValue,
  type Runtime,
} from '@aang/contract'
import { decodeJson, encodeJson } from './codec.js'
import { prepareStatement, type WriteContext } from './context.js'

export type ObserverCallVerdict = 'accepted' | 'rejected' | 'needs_requested' | 'failed'

export interface ObserverCallError {
  readonly class: ObserverErrorClass
  readonly message: string
}

export interface StoredObserverCall {
  readonly id: ObserverCallId
  readonly run: RunId
  readonly backend: Runtime
  readonly base_version: ModelVersion
  readonly input: ObserverInput
  readonly output: unknown
  readonly verdict: ObserverCallVerdict | null
  readonly reasons: ObserverRejection[]
  readonly error: ObserverCallError | null
  readonly usage: CallUsage | null
  readonly started_at: EpochNs
  readonly finished_at: EpochNs | null
  readonly delay_ms: number | null
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
  readonly error?: ObserverCallError | null
  readonly usage?: CallUsage | null
  readonly delay_ms?: number | null
  readonly at: EpochNs
}

export type ObserverCheckKind = 'probe' | 'auth_status'

export interface ObserverCheck {
  readonly id: ObserverCallId
  readonly kind: ObserverCheckKind
  readonly backend: Runtime
  readonly input: ObserverInput | null
  readonly output: JsonValue | null
  readonly verdict: 'accepted' | 'failed'
  readonly error: ObserverCallError | null
  readonly usage: CallUsage | null
  readonly started_at: EpochNs
  readonly finished_at: EpochNs
}

export interface LatestObserverCall {
  readonly id: ObserverCallId
  readonly started_at: EpochNs
}

export interface ObserverSpending {
  readonly tokens: number
  readonly earliest: EpochNs | null
}

export interface ObserverCallReader {
  readonly get: (id: ObserverCallId) => StoredObserverCall | null
  readonly unfinished: () => ObserverCallId[]
  readonly latest: (run: RunId) => LatestObserverCall | null
  readonly checks: () => ObserverCheck[]
  readonly spending: (since: EpochNs) => ObserverSpending
}

export interface ObserverCallWriter extends ObserverCallReader {
  readonly start: (call: ObserverCallStart) => void
  readonly finish: (result: ObserverCallResult) => void
  readonly check: (check: ObserverCheck) => void
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
  error_class: string | null
  error_message: string | null
  usage: string | null
  started_at: bigint
  finished_at: bigint | null
  delay_ms: bigint | null
}

type CheckRow = {
  id: string
  kind: ObserverCheckKind
  backend: Runtime
  input: string | null
  output: string | null
  verdict: 'accepted' | 'failed'
  error_class: string | null
  error_message: string | null
  usage: string | null
  started_at: bigint
  finished_at: bigint
}

const errorOf = (row: { error_class: string | null; error_message: string | null }): ObserverCallError | null =>
  row.error_class === null || row.error_message === null
    ? null
    : { class: ObserverErrorClass.parse(row.error_class), message: row.error_message }

const usageOf = (usage: string | null): CallUsage | null => (usage === null ? null : CallUsage.parse(decodeJson(usage)))

const outputOf = (output: string | null): unknown => (output === null ? null : decodeJson(output))

const tokens = ['uncached_input_tokens', 'cache_read_input_tokens', 'cache_write_input_tokens', 'output_tokens']
  .map((field) => `COALESCE(json_extract(usage, '$.tokens.${field}'), 0)`)
  .join(' + ')

export const createObserverCalls = (database: DatabaseSync) => {
  const select = prepareStatement(database, "SELECT * FROM observer_calls WHERE id = ? AND kind = 'batch'")
  const selectUnfinished = prepareStatement(
    database,
    "SELECT id FROM observer_calls WHERE kind = 'batch' AND finished_at IS NULL ORDER BY started_at, id",
  )
  const selectLatest = prepareStatement(
    database,
    "SELECT id, started_at FROM observer_calls WHERE run_id = ? AND kind = 'batch' ORDER BY started_at DESC, rowid DESC LIMIT 1",
  )
  const selectChecks = prepareStatement(
    database,
    "SELECT * FROM observer_calls WHERE kind <> 'batch' ORDER BY started_at, id",
  )
  const selectSpending = prepareStatement(
    database,
    `SELECT COALESCE(SUM(${tokens}), 0) AS tokens, MIN(finished_at) AS earliest FROM observer_calls
     WHERE finished_at >= ? AND kind IN ('batch', 'probe') AND usage IS NOT NULL`,
  )
  const insert = prepareStatement(
    database,
    `INSERT INTO observer_calls (id, kind, run_id, backend, base_version, input, started_at, change_seq)
     VALUES (?, 'batch', ?, ?, ?, ?, ?, ?)`,
  )
  const insertCheck = prepareStatement(
    database,
    `INSERT INTO observer_calls (id, kind, backend, input, output, verdict, error_class, error_message, usage, started_at,
       finished_at, change_seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const finish = prepareStatement(
    database,
    `UPDATE observer_calls SET output = ?, verdict = ?, reasons = ?, error_class = ?, error_message = ?, usage = ?,
       finished_at = ?, delay_ms = ?, change_seq = ?
     WHERE id = ? AND kind = 'batch' AND finished_at IS NULL`,
  )
  const reader: ObserverCallReader = {
    unfinished: () => (selectUnfinished.all() as { id: string }[]).map(({ id }) => ObserverCallId.parse(id)),
    latest: (run) => {
      const row = selectLatest.get(run) as { id: string; started_at: bigint } | undefined
      return row === undefined ? null : { id: ObserverCallId.parse(row.id), started_at: EpochNs.parse(row.started_at) }
    },
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
            output: outputOf(row.output),
            verdict: row.verdict,
            reasons: ObserverRejection.array().parse(decodeJson(row.reasons)),
            error: errorOf(row),
            usage: usageOf(row.usage),
            started_at: EpochNs.parse(row.started_at),
            finished_at: row.finished_at === null ? null : EpochNs.parse(row.finished_at),
            delay_ms: row.delay_ms === null ? null : Number(row.delay_ms),
          }
    },
    checks: () =>
      (selectChecks.all() as CheckRow[]).map((row) => ({
        id: ObserverCallId.parse(row.id),
        kind: row.kind,
        backend: row.backend,
        input: row.input === null ? null : ObserverInput.parse(decodeJson(row.input)),
        output: row.output === null ? null : (decodeJson(row.output) as JsonValue),
        verdict: row.verdict,
        error: errorOf(row),
        usage: usageOf(row.usage),
        started_at: EpochNs.parse(row.started_at),
        finished_at: EpochNs.parse(row.finished_at),
      })),
    spending: (since) => {
      const row = selectSpending.get(since) as { tokens: bigint | number; earliest: bigint | null }
      return { tokens: Number(row.tokens), earliest: row.earliest === null ? null : EpochNs.parse(row.earliest) }
    },
  }
  const writer = (context: WriteContext): ObserverCallWriter => ({
    ...reader,
    start: ({ id, backend, input, at }) => {
      context.assertActive()
      insert.run(id, input.run.id, backend, input.model.version, encodeJson(input), at, context.nextChangeSeq())
    },
    finish: ({ id, output, verdict, reasons, error = null, usage = null, delay_ms: delay = null, at }) => {
      context.assertActive()
      const result = finish.run(
        encodeJson(output),
        verdict,
        encodeJson(reasons),
        error?.class ?? null,
        error?.message ?? null,
        usage === null ? null : encodeJson(usage),
        at,
        delay,
        context.nextChangeSeq(),
        id,
      )
      if (result.changes !== 1n) {
        throw new Error(`observer call ${id} is missing or already finished`)
      }
    },
    check: ({ id, kind, backend, input, output, verdict, error, usage, started_at: started, finished_at: finished }) => {
      context.assertActive()
      insertCheck.run(
        id,
        kind,
        backend,
        input === null ? null : encodeJson(input),
        output === null ? null : encodeJson(output),
        verdict,
        error?.class ?? null,
        error?.message ?? null,
        usage === null ? null : encodeJson(usage),
        started,
        finished,
        context.nextChangeSeq(),
      )
    },
  })
  return { reader, writer }
}
