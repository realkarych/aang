import type {
  EpochNs,
  JournalRates,
  JournalTotals,
  RunId,
  RunUsage,
  UsageQuery,
  UsageRate,
  UsageReport,
  UsageTotals,
} from '@aang/contract'
import type { Store } from '@aang/store'
import { compareText } from '../observations/evidence.js'
import { observerCallSpans } from '../read/observer-calls.js'
import { callsUsage, chatCalls, observerUsage, probeCalls, type SpentCall } from './calls.js'
import { type UsagePeriod, within } from './period.js'
import { solverUsage } from './solver.js'
import { sumTotals } from './totals.js'

interface RunReading {
  readonly usage: RunUsage
  readonly observer: readonly SpentCall[]
  readonly chat: readonly SpentCall[]
  readonly hours: readonly number[]
  readonly first: EpochNs | null
  readonly touched: boolean
}

const observerCalls = (store: Store, run: RunId, period: UsagePeriod): SpentCall[] =>
  observerCallSpans(store, run).flatMap(({ call, started_at: started, ended_at: ended, usages }): SpentCall[] =>
    ended !== null && within(period, ended)
      ? [{ started_at: started, ended_at: ended, usages, lag_ms: call.delay_ms }]
      : [],
  )

const readRun = (store: Store, run: RunId, period: UsagePeriod): RunReading => {
  const solver = solverUsage(store, run, { period })
  const observer = observerCalls(store, run, period)
  const chat = chatCalls(store.observerCalls, run, period)
  return {
    usage: {
      run,
      solver: solver.journal,
      observer: observerUsage(observer),
      chat: callsUsage(chat),
      duration_ms: solver.time.duration_ms,
      active_hours: solver.active_hours.length,
    },
    observer,
    chat,
    hours: solver.active_hours,
    first: solver.time.started_at,
    touched:
      solver.active_hours.length > 0 || solver.journal.totals.records > 0 || observer.length > 0 || chat.length > 0,
  }
}

const order = (left: EpochNs | null, right: EpochNs | null): number =>
  left === right ? 0 : left === null ? 1 : right === null || left < right ? -1 : 1

const byFirstActivity = (left: RunReading, right: RunReading): number =>
  order(left.first, right.first) || compareText(left.usage.run, right.usage.run)

const rateOf = (totals: UsageTotals, hours: number): UsageRate => {
  const { tokens } = totals
  return {
    tokens: {
      uncached_input_tokens: tokens.uncached_input_tokens / hours,
      cache_read_input_tokens: tokens.cache_read_input_tokens / hours,
      cache_write_input_tokens: tokens.cache_write_input_tokens / hours,
      output_tokens: tokens.output_tokens / hours,
      reasoning_output_tokens: tokens.reasoning_output_tokens === null ? null : tokens.reasoning_output_tokens / hours,
    },
    records: totals.records / hours,
    output_lower_bound: totals.output_lower_bound,
    cost_usd: totals.cost_usd === null ? null : totals.cost_usd / hours,
  }
}

const ratesOf = ({ solver, observer, chat }: JournalTotals, hours: number): JournalRates | null =>
  hours === 0 ? null : { solver: rateOf(solver, hours), observer: rateOf(observer, hours), chat: rateOf(chat, hours) }

export const usageReport = (store: Store, query: UsageQuery): UsageReport | null => {
  const period: UsagePeriod = { from: query.from ?? null, to: query.to ?? null }
  const known = new Set(store.model.runs().map(({ id }) => id))
  if (query.run !== undefined && !known.has(query.run)) {
    return null
  }
  const runs = (query.run === undefined ? [...known] : [query.run])
    .map((run) => readRun(store, run, period))
    .filter(({ touched }) => query.run !== undefined || touched)
    .sort(byFirstActivity)
  const observer = observerUsage(runs.flatMap((run) => run.observer))
  const probes = query.run === undefined ? callsUsage(probeCalls(store.observerCalls, period)) : null
  const chat = callsUsage(runs.flatMap((run) => run.chat))
  const totals: JournalTotals = {
    solver: sumTotals(runs.map(({ usage }) => usage.solver.totals)),
    observer: sumTotals([observer.totals, ...(probes === null ? [] : [probes.totals])]),
    chat: chat.totals,
  }
  const hours = new Set(runs.flatMap((run) => run.hours)).size
  return {
    from: period.from,
    to: period.to,
    runs: runs.map(({ usage }) => usage),
    observer,
    probes,
    chat,
    totals,
    active_hours: hours,
    per_active_hour: ratesOf(totals, hours),
  }
}
