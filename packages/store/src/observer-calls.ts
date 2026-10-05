import type { DatabaseSync } from 'node:sqlite'
import {
  CallUsage,
  ChangeSeq,
  type ChatInput,
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
  readonly error?: ObserverCallError | null
  readonly usage?: CallUsage | null
  readonly delay_ms?: number | null
  readonly at: EpochNs
}

export interface ObserverCallProgress {
  readonly last_accepted_at: EpochNs | null
  readonly change_seq: ChangeSeq | null
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

export interface ChatCallRecord {
  readonly id: ObserverCallId
  readonly run: RunId
  readonly backend: Runtime
  readonly base_version: ModelVersion
  readonly previous: ObserverCallId | null
  readonly input: ChatInput
  readonly output: JsonValue | null
  readonly verdict: ObserverCallVerdict
  readonly error: ObserverCallError | null
  readonly usage: CallUsage | null
  readonly started_at: EpochNs
  readonly finished_at: EpochNs
}

export interface StoredChatCall {
  readonly id: ObserverCallId
  readonly run: RunId
  readonly backend: Runtime
  readonly base_version: ModelVersion
  readonly previous: ObserverCallId | null
  readonly verdict: ObserverCallVerdict
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
  readonly ofRun: (run: RunId) => StoredObserverCall[]
  readonly progress: (run: RunId) => ObserverCallProgress
  readonly unfinished: () => ObserverCallId[]
  readonly latest: (run: RunId) => LatestObserverCall | null
  readonly checks: () => ObserverCheck[]
  readonly chats: (run: RunId) => StoredChatCall[]
  readonly spending: (since: EpochNs) => ObserverSpending
}

export interface ObserverCallWriter extends ObserverCallReader {
  readonly start: (call: ObserverCallStart) => void
  readonly finish: (result: ObserverCallResult) => void
  readonly charge: (id: ObserverCallId, usage: CallUsage) => void
  readonly check: (check: ObserverCheck) => void
  readonly chat: (call: ChatCallRecord) => void
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
  change_seq: bigint
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

type ChatRow = {
  id: string
  run_id: string
  backend: Runtime
  base_version: bigint
  previous_id: string | null
  verdict: ObserverCallVerdict
  error_class: string | null
  error_message: string | null
  usage: string | null
  started_at: bigint
  finished_at: bigint
}

type PreviousChatRow = {
  run_id: string
  base_version: bigint
  verdict: ObserverCallVerdict
  finished_at: bigint
  followed: bigint
}

const errorOf = (row: { error_class: string | null; error_message: string | null }): ObserverCallError | null =>
  row.error_class === null || row.error_message === null
    ? null
    : { class: ObserverErrorClass.parse(row.error_class), message: row.error_message }

const usageOf = (usage: string | null): CallUsage | null => (usage === null ? null : CallUsage.parse(decodeJson(usage)))

const outputOf = (output: string | null): unknown => (output === null ? null : decodeJson(output))

const toCall = (row: CallRow): StoredObserverCall => ({
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
  change_seq: ChangeSeq.parse(Number(row.change_seq)),
})

const toChat = (row: ChatRow): StoredChatCall => ({
  id: ObserverCallId.parse(row.id),
  run: RunId.parse(row.run_id),
  backend: row.backend,
  base_version: ModelVersion.parse(Number(row.base_version)),
  previous: row.previous_id === null ? null : ObserverCallId.parse(row.previous_id),
  verdict: row.verdict,
  error: errorOf(row),
  usage: usageOf(row.usage),
  started_at: EpochNs.parse(row.started_at),
  finished_at: EpochNs.parse(row.finished_at),
})

const previousProblem = (call: ChatCallRecord, previous: PreviousChatRow | undefined): string | null => {
  if (previous === undefined) {
    return 'is not a chat call'
  }
  if (previous.run_id !== call.run) {
    return 'belongs to another run'
  }
  if (Number(previous.base_version) !== call.base_version) {
    return 'answered another model version'
  }
  if (previous.verdict !== 'needs_requested') {
    return 'did not request materials'
  }
  if (previous.followed !== 0n) {
    return 'already has its follow-up'
  }
  return previous.finished_at > call.started_at ? 'finished after the follow-up started' : null
}

const tokens = ['uncached_input_tokens', 'cache_read_input_tokens', 'cache_write_input_tokens', 'output_tokens']
  .map((field) => `COALESCE(json_extract(usage, '$.tokens.${field}'), 0)`)
  .join(' + ')

export const createObserverCalls = (database: DatabaseSync) => {
  const select = prepareStatement(database, "SELECT * FROM observer_calls WHERE id = ? AND kind = 'batch'")
  const selectOfRun = prepareStatement(
    database,
    "SELECT * FROM observer_calls WHERE run_id = ? AND kind = 'batch' ORDER BY started_at, id",
  )
  const selectProgress = prepareStatement(
    database,
    `SELECT MAX(finished_at) FILTER (WHERE verdict = 'accepted') AS last_accepted_at, MAX(change_seq) AS change_seq
     FROM observer_calls WHERE run_id = ? AND kind = 'batch'`,
  )
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
    "SELECT * FROM observer_calls WHERE kind IN ('probe', 'auth_status') ORDER BY started_at, id",
  )
  const selectChats = prepareStatement(
    database,
    `SELECT id, run_id, backend, base_version, previous_id, verdict, error_class, error_message, usage, started_at,
       finished_at
     FROM observer_calls WHERE run_id = ? AND kind = 'chat' ORDER BY started_at, id`,
  )
  const selectPrevious = prepareStatement(
    database,
    `SELECT run_id, base_version, verdict, finished_at,
       EXISTS (SELECT 1 FROM observer_calls follow WHERE follow.previous_id = call.id) AS followed
     FROM observer_calls call WHERE id = ? AND kind = 'chat'`,
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
  const insertChat = prepareStatement(
    database,
    `INSERT INTO observer_calls (id, kind, run_id, previous_id, backend, base_version, input, output, verdict, error_class,
       error_message, usage, started_at, finished_at, change_seq)
     VALUES (?, 'chat', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const finish = prepareStatement(
    database,
    `UPDATE observer_calls SET output = ?, verdict = ?, reasons = ?, error_class = ?, error_message = ?, usage = ?,
       finished_at = ?, delay_ms = ?, change_seq = ?
     WHERE id = ? AND kind = 'batch' AND finished_at IS NULL`,
  )
  const charge = prepareStatement(
    database,
    `UPDATE observer_calls SET usage = ?, change_seq = ?
     WHERE id = ? AND kind = 'batch' AND finished_at IS NOT NULL AND usage IS NULL`,
  )
  const reader: ObserverCallReader = {
    unfinished: () => (selectUnfinished.all() as { id: string }[]).map(({ id }) => ObserverCallId.parse(id)),
    latest: (run) => {
      const row = selectLatest.get(run) as { id: string; started_at: bigint } | undefined
      return row === undefined ? null : { id: ObserverCallId.parse(row.id), started_at: EpochNs.parse(row.started_at) }
    },
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
    chats: (run) => (selectChats.all(run) as ChatRow[]).map(toChat),
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
    charge: (id, usage) => {
      context.assertActive()
      if (charge.run(encodeJson(usage), context.nextChangeSeq(), id).changes !== 1n) {
        throw new Error(`observer call ${id} is not finished or already has its usage`)
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
    chat: (call) => {
      context.assertActive()
      if (call.previous !== null) {
        const problem = previousProblem(call, selectPrevious.get(call.previous) as PreviousChatRow | undefined)
        if (problem !== null) {
          throw new Error(`chat call ${call.id} follows ${call.previous}, which ${problem}`)
        }
      }
      insertChat.run(
        call.id,
        call.run,
        call.previous,
        call.backend,
        call.base_version,
        encodeJson(call.input),
        call.output === null ? null : encodeJson(call.output),
        call.verdict,
        call.error?.class ?? null,
        call.error?.message ?? null,
        call.usage === null ? null : encodeJson(call.usage),
        call.started_at,
        call.finished_at,
        context.nextChangeSeq(),
      )
    },
  })
  return { reader, writer }
}
