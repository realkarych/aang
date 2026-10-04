import {
  type CallsUsage,
  type CostStatePayload,
  endpoints,
  type EpochNs,
  type Latency,
  type ObserverUsage,
  type RunUsage,
  type SessionUsage,
  type TokenUsage,
  type UsageQuery,
  type UsageRate,
  type UsageReport,
  type UsageTotals,
} from '@aang/contract'
import { readDaemon } from './admin.js'
import type { Output } from './output.js'

interface Amounts {
  readonly tokens: Readonly<Record<keyof TokenUsage, number | null>>
  readonly records: number
  readonly output_lower_bound: boolean
  readonly cost_usd: number | null
}

const amount = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 })
const money = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })
const secondsOf = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })

const moneyNote = 'money is at list prices; with a subscription it is not a charge'

const isoOf = (at: EpochNs): string => new Date(Number(at / 1_000_000n)).toISOString()

const periodLine = ({ from, to }: UsageReport): string => {
  if (from === null) {
    return to === null ? 'usage over all time' : `usage until ${isoOf(to)}`
  }
  return to === null ? `usage from ${isoOf(from)}` : `usage from ${isoOf(from)} to ${isoOf(to)}`
}

const plural = (count: number, noun: string): string => `${amount.format(count)} ${noun}${count === 1 ? '' : 's'}`

const durationOf = (ms: number): string => {
  const seconds = Math.floor(ms / 1000)
  const parts = [
    [Math.floor(seconds / 3600), 'h'],
    [Math.floor((seconds % 3600) / 60), 'min'],
    [seconds % 60, 's'],
  ] as const
  const shown = parts.filter(([value]) => value > 0).map(([value, unit]) => `${String(value)} ${unit}`)
  return shown.length === 0 ? '0 s' : shown.join(' ')
}

const tokensOf = ({ tokens, records, output_lower_bound: lowerBound, cost_usd: cost }: Amounts, counted: boolean): string =>
  [
    `${amount.format(tokens.uncached_input_tokens ?? 0)} input`,
    `${amount.format(tokens.cache_read_input_tokens ?? 0)} cache read`,
    `${amount.format(tokens.cache_write_input_tokens ?? 0)} cache write`,
    `${lowerBound ? 'at least ' : ''}${amount.format(tokens.output_tokens ?? 0)} output`,
    ...(counted ? [plural(records, 'record')] : []),
    ...(cost === null ? [] : [`$${money.format(cost)}`]),
  ].join(', ')

const waitOf = (ms: number): string => (ms < 60_000 ? `${secondsOf.format(ms / 1000)} s` : durationOf(ms))

const latencyOf = (label: string, latency: Latency | null): string[] =>
  latency === null
    ? []
    : [`${label} p50 ${waitOf(latency.p50)}, p95 ${waitOf(latency.p95)}, max ${waitOf(latency.max)}`]

const callsOf = (usage: CallsUsage | ObserverUsage): string =>
  [
    plural(usage.calls, 'call'),
    ...latencyOf('latency', usage.latency_ms),
    ...('lag_ms' in usage ? latencyOf('lag', usage.lag_ms) : []),
  ].join('; ')

const journalLine = (label: string, totals: UsageTotals | UsageRate, counted: boolean): string =>
  `${label}: ${tokensOf(totals, counted)}`

const callsLine = (label: string, usage: CallsUsage | ObserverUsage): string =>
  `${label}: ${tokensOf(usage.totals, false)}; ${callsOf(usage)}`

const costStateOf = ({ total_cost_usd: cost, models }: CostStatePayload): Amounts => {
  const sum = (field: keyof TokenUsage): number => models.reduce((total, { tokens }) => total + (tokens[field] ?? 0), 0)
  return {
    tokens: {
      uncached_input_tokens: sum('uncached_input_tokens'),
      cache_read_input_tokens: sum('cache_read_input_tokens'),
      cache_write_input_tokens: sum('cache_write_input_tokens'),
      output_tokens: sum('output_tokens'),
      reasoning_output_tokens: null,
    },
    records: 0,
    output_lower_bound: false,
    cost_usd: cost,
  }
}

const sessionLines = ({ session, cost_state: costState, cost_state_final: final }: SessionUsage): string[] =>
  costState === null
    ? []
    : [
        `    session ${session}: Claude Code reports ${tokensOf(costStateOf(costState), false)}; ${
          final ? 'final' : 'not final: a running interactive session writes its total at exit'
        }`,
      ]

const runLines = (usage: RunUsage): string[] => [
  '',
  usage.active_hours === 0
    ? `run ${usage.run}: no solver activity`
    : `run ${usage.run}: ${durationOf(usage.duration_ms)} from the first to the last activity, ${plural(usage.active_hours, 'active hour')}`,
  `  ${journalLine('solver', usage.solver.totals, true)}`,
  ...usage.solver.stages.map(({ stage, totals }) => `    ${journalLine(`stage ${stage}`, totals, true)}`),
  ...(usage.solver.stages.length === 0 ? [] : [`    ${journalLine('not assigned to stages', usage.solver.unassigned, true)}`]),
  ...usage.solver.sessions.flatMap(sessionLines),
  `  ${callsLine('observer', usage.observer)}`,
  `  ${callsLine('chat', usage.chat)}`,
]

const hasMoney = (report: UsageReport): boolean =>
  [report.totals.solver, report.totals.observer, report.totals.chat].some(({ cost_usd: cost }) => cost !== null) ||
  report.runs.some(({ solver }) => solver.sessions.some(({ cost_state: state }) => (state?.total_cost_usd ?? null) !== null))

const reportLines = (report: UsageReport): string[] => [
  periodLine(report),
  `active hours: ${amount.format(report.active_hours)}`,
  '',
  journalLine('solver', report.totals.solver, true),
  journalLine('observer', report.totals.observer, false),
  journalLine('chat', report.totals.chat, false),
  ...(report.per_active_hour === null
    ? []
    : [
        '',
        'per active hour',
        `  ${journalLine('solver', report.per_active_hour.solver, true)}`,
        `  ${journalLine('observer', report.per_active_hour.observer, false)}`,
        `  ${journalLine('chat', report.per_active_hour.chat, false)}`,
      ]),
  '',
  `observer calls: ${callsOf(report.observer)}`,
  report.probes === null ? 'probes: not attributed to runs' : `probes: ${callsOf(report.probes)}`,
  `chat calls: ${callsOf(report.chat)}`,
  ...report.runs.flatMap(runLines),
  ...(hasMoney(report) ? ['', moneyNote] : []),
]

export const reportUsage = async (output: Output, query: UsageQuery): Promise<number> => {
  for (const line of reportLines(await readDaemon(endpoints.usage, query))) {
    output.out(line)
  }
  return 0
}
