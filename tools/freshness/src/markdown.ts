import type { ChangeAuthor } from '@catacomb/contract'
import type { BackendReport, BackendSpending, EventStatus, Percentile, Rate, Report, ReportedEvent, Spending } from './report.js'

const statusText: Readonly<Record<EventStatus, string>> = {
  met: 'met',
  late: 'after the window, violation',
  missed: 'missed, violation',
  unmatched: 'event not found, violation',
  held_before: 'met before the event, annotation invalid',
  mismatched: 'description does not match the recording, annotation invalid',
  unassessed: 'awaiting the annotator',
}

const authorText: Readonly<Record<ChangeAuthor, string>> = {
  rule: 'rule',
  observer: 'observer',
  user: 'user',
}

const none = '—'

const seconds = (ms: number | null): string => (ms === null ? none : (ms / 1000).toFixed(1))

const percent = (share: number | null): string => (share === null ? none : `${String(Math.round(share * 100))}%`)

const percentile = (p95: Percentile | null): string =>
  p95 === null ? none : p95.kind === 'latency' ? `${seconds(p95.ms)} s` : 'beyond the window (violation)'

const verdict = (met: boolean | null): string => (met === null ? none : met ? 'yes' : 'no')

const row = (cells: readonly string[]): string => `| ${cells.map((cell) => cell.replaceAll('|', '\\|')).join(' | ')} |`

const amount = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })

const tokens = (value: number): string => amount.format(value)

const dollars = (value: number | null): string => (value === null ? none : `$${value.toFixed(2)}`)

const hours = (ms: number): string => (ms / 3_600_000).toFixed(2)

const journalText = { observer: 'observer', chat: 'chat', checks: 'probes and auth status' } as const

const spendingRow = (runtime: string, journal: keyof typeof journalText, spending: Spending): string[] => [
  runtime,
  journalText[journal],
  String(spending.calls),
  tokens(spending.uncached_input_tokens),
  tokens(spending.cache_read_input_tokens),
  tokens(spending.cache_write_input_tokens),
  tokens(spending.output_tokens),
  tokens(spending.reasoning_output_tokens),
  tokens(spending.tokens),
  dollars(spending.cost_usd),
]

const rateCells = (rate: Rate | null): string[] =>
  rate === null ? [none, none, none] : [rate.calls.toFixed(1), tokens(rate.tokens), dollars(rate.cost_usd)]

const rateRows = (spending: BackendSpending): string[][] =>
  (['observer', 'chat'] as const).map((journal) => [
    spending.runtime,
    journalText[journal],
    ...rateCells(spending.per_run_hour[journal]),
    ...rateCells(spending.per_active_hour[journal]),
  ])

const questionRow = ({ runtime, questions, chat }: BackendSpending): string[] => [
  runtime,
  String(questions.asked),
  String(questions.answered),
  String(questions.failed),
  String(questions.not_asked),
  String(questions.insufficient_data),
  seconds(questions.latency_p50_ms),
  seconds(questions.latency_p95_ms),
  questions.answered === 0 ? none : tokens(chat.tokens / questions.answered),
  questions.answered === 0 || chat.cost_usd === null ? none : dollars(chat.cost_usd / questions.answered),
]

const table = (header: readonly string[], rows: readonly (readonly string[])[]): string[] => [
  row(header),
  row(header.map(() => '---')),
  ...rows.map(row),
]

const backendRow = (backend: BackendReport): string[] => [
  backend.runtime,
  backend.cli_version ?? none,
  backend.model,
  backend.effort ?? 'CLI default',
  `${seconds(backend.target_p95_ms)} s`,
  percentile(backend.p95),
  verdict(backend.target_met),
  percent(backend.within_target),
  `${String(backend.met)} of ${String(backend.assessed)}`,
  String(backend.violations),
  String(backend.unassessed),
  String(backend.held_before),
  String(backend.mismatched),
  backend.full_latency.p95_ms === null ? none : `${seconds(backend.full_latency.p95_ms)} s (${String(backend.full_latency.events)})`,
  `${percent(backend.needs.share)} (${String(backend.needs.events)})`,
]

const eventRow = (event: ReportedEvent): string[] => [
  event.recording,
  event.label,
  event.method === 'predicate' ? 'predicate' : 'annotator',
  statusText[event.status],
  seconds(event.latency_ms),
  seconds(event.full_latency_ms),
  seconds(event.needs_ms),
  event.version === null ? none : String(event.version),
  event.author === null ? none : authorText[event.author],
]

export const renderReport = (report: Report): string =>
  [
    `# Freshness measurement: ${report.profile}`,
    '',
    `- Workload profile fixed at ${report.fixed_at}; the measurement started at ${report.measured_at} and lasted ${seconds(report.duration_ms)} s.`,
    `- Measurement window ${seconds(report.window_ms)} s, recording time scale ${String(report.time_scale)}.`,
    `- Daemon ${report.daemon_version}.`,
    '',
    '## Recordings',
    '',
    ...table(
      ['Recording', 'Runtime', 'Start, s'],
      report.recordings.map(({ recording, runtime, start_ms: start }) => [recording, runtime, seconds(start)]),
    ),
    '',
    '## Backend summary',
    '',
    'A violation is an expectation not met within the measurement window. p95 is computed over assessed events, with missed events counted as beyond the window. Events met before the event or not matching the recording are annotation defects and are excluded from p95. Full latency runs from the time of the event itself; the number in parentheses is the count of events with a known time. Follow-up share is the share of `needs` time in the latency of met events; the number in parentheses is the count of events with a follow-up.',
    '',
    ...table(
      [
        'Backend',
        'CLI',
        'Model',
        'Effort',
        'Target p95',
        'p95',
        'Target met',
        'Within target',
        'Met',
        'Violations',
        'Unassessed',
        'Met before the event',
        'Does not match the recording',
        'Full latency p95',
        'Follow-up share',
      ],
      report.backends.map(backendRow),
    ),
    '',
    '## Control events',
    '',
    ...table(
      ['Recording', 'Event', 'Method', 'Outcome', 'Latency, s', 'Full, s', 'Follow-ups, s', 'Version', 'Author'],
      report.events.map(eventRow),
    ),
    '',
    '## Observer',
    '',
    ...table(
      ['Backend', 'Calls', 'Accepted', 'Rejected', 'Failed', 'With follow-up'],
      report.backends.map(({ runtime, calls }) => [
        runtime,
        String(calls.total),
        String(calls.accepted),
        String(calls.rejected),
        String(calls.failed),
        String(calls.with_needs),
      ]),
    ),
    '',
    ...table(
      ['Backend', 'State', 'Time, s', 'Share'],
      report.backends.flatMap(({ runtime, states }) =>
        states.map(({ state, ms, share }) => [runtime, state, seconds(ms), percent(share)]),
      ),
    ),
    '',
    '## Spending',
    '',
    'Call spending comes from CLI data in the daemon call journal. A run hour is the sum of the durations of the played runs of the backend; an active hour is the time when at least one of its runs was in progress. Money is shown only for Claude, at list prices; under a subscription it is not a charge.',
    '',
    ...table(
      ['Backend', 'Runs', 'Run hours', 'Active hours'],
      report.spending.map(({ runtime, runs, run_ms: runMs, active_ms: activeMs }) => [runtime, String(runs), hours(runMs), hours(activeMs)]),
    ),
    '',
    ...table(
      ['Backend', 'Journal', 'Calls', 'Uncached input', 'Cache read', 'Cache write', 'Output', 'Reasoning', 'Total tokens', 'Cost'],
      report.spending.flatMap((spending) =>
        (['observer', 'chat', 'checks'] as const).map((journal) => spendingRow(spending.runtime, journal, spending[journal])),
      ),
    ),
    '',
    ...table(
      ['Backend', 'Journal', 'Calls per run hour', 'Tokens per run hour', 'Cost per run hour', 'Calls per active hour', 'Tokens per active hour', 'Cost per active hour'],
      report.spending.flatMap(rateRows),
    ),
    '',
    ...table(
      ['Backend', 'Questions', 'Answers', 'Failed', 'Not asked', 'Insufficient data', 'Answer p50, s', 'Answer p95, s', 'Tokens per answer', 'Cost per answer'],
      report.spending.map(questionRow),
    ),
    '',
    `Per the daemon spending accounting (U.1), active hours: ${String(report.active_hours.hours)}; these are calendar hours with solver activity.`,
    '',
  ].join('\n')
