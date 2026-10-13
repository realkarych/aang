import type {
  Gap,
  GapKind,
  HookInstallation,
  ObserverBackendStatus,
  ObserverRunState,
  ObserverState,
  RunSummary,
  RuntimeStatus,
  Session,
  StatusResponse,
  SupportMode,
} from '@aang/contract'
import { absoluteTime, bytes, clockTime, duration, plural, relativeTime } from './format.js'
import {
  earlyFactForms,
  factForms,
  fileForms,
  gapLabel,
  hookInstallationLabel,
  notObservableLabel,
  observerStateLabel,
  retryLabel,
  runInForms,
  runtimeLabel,
  sessionForms,
  sessionsIn,
  supportKeyLabel,
  supportModeLabel,
  supportStatusLabel,
  versionForms,
} from './labels.js'
import type { FeedConnection } from './use-run-feed.js'

export type Level = 'normal' | 'caution' | 'warning'

export type LampId =
  | 'link'
  | 'observer'
  | 'model'
  | 'mode'
  | 'hooks'
  | 'sources'
  | 'records'
  | 'spool'
  | 'versions'
  | 'coverage'

export interface LampDetail {
  readonly text: string
  readonly level: Level
}

export interface Lamp {
  readonly id: LampId
  readonly label: string
  readonly value: string
  readonly level: Level
  readonly details: readonly LampDetail[]
}

export interface FocusedRun {
  readonly summary: RunSummary
  readonly sessions: readonly Session[]
  readonly gaps: readonly Gap[]
}

export interface RunFocus {
  readonly connection: FeedConnection
  readonly run: FocusedRun | null
}

export interface LampInput {
  readonly status: StatusResponse | null
  readonly statusFailing: boolean
  readonly runs: readonly RunSummary[] | null
  readonly runsFailing: boolean
  readonly focus: RunFocus | null
  readonly now: bigint
}

const rank: Readonly<Record<Level, number>> = { normal: 0, caution: 1, warning: 2 }

const worst = (levels: readonly Level[]): Level =>
  levels.reduce<Level>((top, level) => (rank[level] > rank[top] ? level : top), 'normal')

const detail = (text: string, level: Level = 'normal'): LampDetail => ({ text, level })

const lamp = (id: LampId, label: string, value: string, level: Level, details: readonly LampDetail[] = []): Lamp => ({
  id,
  label,
  value,
  level,
  details,
})

const modelLagLimitNs = 30_000_000_000n

const lostSourceForms = { one: 'source lost', other: 'sources lost' } as const
const problemForms = { one: 'problem', other: 'problems' } as const
const unknownRecordForms = { one: 'unrecognized record', other: 'unrecognized records' } as const

const sourceGapKinds: ReadonlySet<GapKind> = new Set([
  'source_lost',
  'read_failed',
  'unknown_stream_layout',
  'stream_changed_after_prune',
])
const spoolGapKinds: ReadonlySet<GapKind> = new Set(['spool_over_threshold', 'spool_expired'])

const observerLevel = ({ state }: ObserverState): Level =>
  state === 'ok' ? 'normal' : state === 'unavailable' ? 'warning' : 'caution'

const admissionFailed = (backends: readonly ObserverBackendStatus[]): boolean =>
  backends.some(({ admission }) => admission?.outcome === 'failed')

const stateLevel = (state: ObserverState, failedAdmission: boolean): Level =>
  state.state === 'disabled' && state.reason === 'version_not_admitted' && !failedAdmission
    ? 'normal'
    : observerLevel(state)

const backendLevel = (backend: ObserverBackendStatus, runs: readonly RunSummary[] | null): Level =>
  backend.state.state === 'disabled' && backend.state.reason === 'cli_missing'
    ? (runs ?? []).some(({ runtime }) => runtime === backend.vendor)
      ? 'caution'
      : 'normal'
    : stateLevel(backend.state, admissionFailed([backend]))

const interpreting = ({ state }: ObserverState): boolean => state === 'ok' || state === 'lagging'

const retryDetails = (state: ObserverState): LampDetail[] =>
  state.state === 'unavailable' && state.retry_at !== null
    ? [detail(`${retryLabel[state.reason]} at ${clockTime(state.retry_at)}.`, 'warning')]
    : []

const pausedDetails = (state: ObserverState): LampDetail[] =>
  interpreting(state)
    ? []
    : [detail('Facts and attention items keep arriving; stages will update when the observer is back.')]

const catchUpDetails = ({ deferred_facts: deferred }: ObserverRunState): LampDetail[] =>
  deferred === 0
    ? []
    : [
        detail(
          `Catching up: the observer sees ${plural(deferred, earlyFactForms)} only as a summary, counts per agent and tool, without details.`,
          'caution',
        ),
      ]

const linkLamp = ({ statusFailing, runsFailing, focus }: LampInput): Lamp => {
  if (statusFailing) {
    return lamp('link', 'Link', 'no connection to the daemon', 'warning', [
      detail('The daemon is not responding. Check it with aang status; the data on screen may be stale.', 'warning'),
    ])
  }
  if (runsFailing && focus === null) {
    return lamp('link', 'Link', 'list not updating', 'warning', [
      detail('The daemon did not return the run list. aang keeps retrying; the list on screen may be stale.', 'warning'),
    ])
  }
  switch (focus?.connection) {
    case undefined:
      return lamp('link', 'Link', 'connected', 'normal')
    case 'loading':
      return lamp('link', 'Link', 'connecting', 'normal')
    case 'live':
      return runsFailing
        ? lamp('link', 'Link', 'branches not updating', 'caution', [
            detail('Run changes arrive as events are recorded.'),
            detail(
              'The daemon did not return the run list. aang keeps retrying; branches and names of linked runs may be stale.',
              'caution',
            ),
          ])
        : lamp('link', 'Link', 'stream connected', 'normal', [
            detail('Run changes arrive as events are recorded.'),
          ])
    case 'reconnecting':
      return lamp('link', 'Link', 'reconnecting', 'caution', [
        detail('The change stream was interrupted. aang will reconnect and catch up on what it missed.', 'caution'),
      ])
    case 'missing':
      return lamp('link', 'Link', 'run not found', 'warning', [
        detail('The daemon does not know this run: it was deleted or has not been re-admitted yet.', 'warning'),
      ])
  }
}

const backendName = ({ vendor, cli_version: version }: ObserverBackendStatus): string =>
  version === null ? runtimeLabel[vendor] : `${runtimeLabel[vendor]} ${version}`

const worstOf = <T>(items: readonly T[], levelOf: (item: T) => Level): T | null =>
  items.reduce<T | null>((top, item) => (top === null || rank[levelOf(item)] > rank[levelOf(top)] ? item : top), null)

const observerLamp = ({ status, runs, focus }: LampInput): Lamp => {
  const backends = status?.observer.backends ?? []
  const backendDetails = backends.map((backend) =>
    detail(
      `${backendName(backend)}, model ${backend.model}: ${observerStateLabel(backend.state)}.`,
      backendLevel(backend, runs),
    ),
  )
  const focused = focus?.run ?? null
  if (focused !== null) {
    const { observer } = focused.summary
    return lamp('observer', 'Observer', observerStateLabel(observer.state), stateLevel(observer.state, admissionFailed(backends)), [
      ...retryDetails(observer.state),
      ...pausedDetails(observer.state),
      ...(observer.isolation_unverified ? [detail('Observer isolation is not confirmed.', 'caution')] : []),
      ...catchUpDetails(observer),
      ...(observer.not_interpreted_facts > 0
        ? [detail(`Not interpreted: ${plural(observer.not_interpreted_facts, factForms)}.`, 'caution')]
        : []),
      ...backendDetails,
    ])
  }
  const backend = worstOf(backends, (shown) => backendLevel(shown, runs))
  if (backend !== null) {
    return lamp(
      'observer',
      'Observer',
      `${runtimeLabel[backend.vendor]}: ${observerStateLabel(backend.state)}`,
      backendLevel(backend, runs),
      backendDetails,
    )
  }
  const states = (runs ?? []).map(({ observer }) => observer.state)
  const shown = worstOf(states, observerLevel)
  if (shown === null) {
    return lamp('observer', 'Observer', 'no data', 'normal')
  }
  const same = states.filter((state) => observerStateLabel(state) === observerStateLabel(shown)).length
  return lamp('observer', 'Observer', observerStateLabel(shown), observerLevel(shown), [
    detail(`Same in ${plural(same, runInForms)} of ${String(states.length)}.`),
  ])
}

const modelLamp = ({ summary }: FocusedRun, now: bigint): Lamp => {
  const { observer, version } = summary
  const updated = observer.last_success_at
  const oldest = observer.pending_facts > 0 ? observer.oldest_pending_at : null
  const lagging = oldest !== null && (now - oldest >= modelLagLimitNs || !interpreting(observer.state))
  const unbuilt = updated === null && (observer.pending_facts > 0 || observer.state.state !== 'ok')
  const pending =
    oldest === null
      ? []
      : [
          detail(
            `Waiting for the observer: ${plural(observer.pending_facts, factForms)}, oldest ${duration(oldest, now)} ago.`,
            lagging ? 'caution' : 'normal',
          ),
        ]
  return lamp(
    'model',
    'Model',
    updated === null ? 'not built' : `updated ${relativeTime(updated, now)}`,
    lagging || unbuilt ? 'caution' : 'normal',
    [
      detail(`Map version ${String(version)}.`),
      ...(updated === null ? [] : [detail(`Last update: ${absoluteTime(updated)}.`)]),
      ...pending,
      ...(observer.deferred_facts === 0
        ? []
        : [detail('The map counts early facts only through a summary, with less detail.', 'caution')]),
    ],
  )
}

const modeExplanation: Readonly<Record<SupportMode, string>> = {
  full: 'hooks and session files',
  files_only: 'hooks inactive, events come from session files',
  hooks_only: 'session file not found, only hook events are visible',
}

const modeLamp = ({ summary, sessions }: FocusedRun): Lamp => {
  const modes = summary.support_modes
  if (modes.length === 0) {
    return lamp('mode', 'Mode', 'no sessions', 'normal')
  }
  const limited = modes.filter((mode) => mode !== 'full')
  return lamp(
    'mode',
    'Mode',
    (limited.length > 0 ? limited : modes).map((mode) => supportModeLabel[mode]).join(', '),
    limited.length > 0 ? 'caution' : 'normal',
    sessions.map(({ key, support_mode: mode }) =>
      detail(
        `Session ${key.session.slice(0, 8)}: ${supportModeLabel[mode]}: ${modeExplanation[mode]}.`,
        mode === 'full' ? 'normal' : 'caution',
      ),
    ),
  )
}

const installationLevel = (hooks: HookInstallation): Level =>
  hooks === 'untrusted' || hooks === 'disabled' ? 'caution' : 'normal'

const runtimeHookDetails = ({
  runtime,
  hooks,
  hooks_inactive_sessions: idle,
  double_registration_sessions: twice,
}: RuntimeStatus): LampDetail[] => {
  const name = runtimeLabel[runtime]
  return [
    detail(`${name}: ${hookInstallationLabel[hooks]}.`, installationLevel(hooks)),
    ...(idle.length > 0
      ? [detail(`${name}: hooks inactive in ${sessionsIn(idle.length)}, "files only" mode.`, 'caution')]
      : []),
    ...(twice.length > 0 ? [detail(`${name}: hooks registered twice in ${sessionsIn(twice.length)}.`, 'caution')] : []),
  ]
}

const hooksLamp = ({ status }: LampInput): Lamp => {
  if (status === null) {
    return lamp('hooks', 'Hooks', 'no data', 'normal')
  }
  const inactive = status.runtimes.reduce((total, runtime) => total + runtime.hooks_inactive_sessions.length, 0)
  const details = status.runtimes.flatMap(runtimeHookDetails)
  if (inactive > 0) {
    return lamp('hooks', 'Hooks', `inactive in ${sessionsIn(inactive)}`, 'caution', details)
  }
  const missing = status.runtimes.find(({ hooks }) => installationLevel(hooks) !== 'normal')
  if (missing !== undefined) {
    const value = `${runtimeLabel[missing.runtime]}: ${hookInstallationLabel[missing.hooks]}`
    return lamp('hooks', 'Hooks', value, 'caution', details)
  }
  return lamp(
    'hooks',
    'Hooks',
    status.runtimes.every(({ hooks }) => hooks === 'active') ? 'active' : 'none inactive',
    worst(details.map(({ level }) => level)),
    details,
  )
}

const gapDetail = (gap: Gap): LampDetail =>
  detail(
    `${gapLabel[gap.kind]}${gap.details === null ? '' : `: ${gap.details}`} since ${clockTime(gap.detected_at)}.`,
    gap.kind === 'source_lost' ? 'warning' : 'caution',
  )

const openGaps = (gaps: readonly Gap[], kinds: ReadonlySet<GapKind>): Gap[] =>
  gaps.filter(({ kind, closed_at: closed }) => closed === null && kinds.has(kind))

const sourcesLamp = ({ status, runs, focus }: LampInput): Lamp => {
  const known = [...(status?.gaps ?? []), ...(focus?.run?.gaps ?? [])]
  const gaps = [...new Map(openGaps(known, sourceGapKinds).map((gap) => [gap.id, gap])).values()]
  const lost = gaps.filter(({ kind }) => kind === 'source_lost').length
  const lostRuns = focus === null ? (runs ?? []).filter(({ freshness }) => freshness === 'lost').length : 0
  const details = [
    ...gaps.map(gapDetail),
    ...(lostRuns > 0 ? [detail(`Source lost in ${plural(lostRuns, runInForms)}.`, 'warning')] : []),
  ]
  if (lost > 0 || lostRuns > 0) {
    return lamp(
      'sources',
      'Sources',
      plural(Math.max(lost, lostRuns), lostSourceForms),
      'warning',
      details,
    )
  }
  if (gaps.length > 0) {
    return lamp('sources', 'Sources', plural(gaps.length, problemForms), 'caution', details)
  }
  return lamp('sources', 'Sources', 'fine', 'normal')
}

const unknownRecordsNote = detail(
  'Records in an unknown format are kept in the journal but yield no facts: some work may not be visible.',
  'caution',
)

const recordsLamp = ({ status, focus }: LampInput): Lamp => {
  const total = status?.unknown_records ?? 0
  const focused = focus?.run ?? null
  if (focused === null) {
    return total === 0
      ? lamp('records', 'Records', 'all recognized', 'normal')
      : lamp('records', 'Records', `${plural(total, unknownRecordForms)} in total`, 'caution', [unknownRecordsNote])
  }
  const unknown = focused.sessions.reduce((sum, { unknown_records: count }) => sum + count, 0)
  const elsewhere =
    total > unknown
      ? [detail(`Unrecognized records in total: ${String(total)}, in this run: ${String(unknown)}.`)]
      : []
  return unknown === 0
    ? lamp('records', 'Records', 'all recognized in this run', 'normal', elsewhere)
    : lamp('records', 'Records', `${plural(unknown, unknownRecordForms)} in this run`, 'caution', [
        unknownRecordsNote,
        ...elsewhere,
      ])
}

const spoolLamp = ({ status, now }: LampInput): Lamp => {
  if (status === null) {
    return lamp('spool', 'Spool', 'no data', 'normal')
  }
  const { spool } = status
  const usage = detail(
    `${plural(spool.files, fileForms)}, ${bytes(spool.bytes)} of a ${bytes(spool.threshold_bytes)} threshold.`,
  )
  const gaps = openGaps(status.gaps, spoolGapKinds)
    .filter(({ kind }) => kind !== 'spool_over_threshold')
    .map(gapDetail)
  if (spool.over_threshold) {
    return lamp('spool', 'Spool', 'over threshold', 'warning', [
      usage,
      detail('Lease released: hooks do not write to the spool.', 'warning'),
      detail(`Grew by ${bytes(spool.growth_since_threshold_bytes ?? 0)} past the threshold.`),
      ...gaps,
    ])
  }
  if (spool.stopped) {
    return lamp('spool', 'Spool', 'writing stopped', 'caution', [
      usage,
      detail('The daemon was stopped with aang stop: hooks do not write to the spool until aang start.', 'caution'),
      ...gaps,
    ])
  }
  if (spool.lease_expires_at === null || spool.lease_expires_at < now) {
    return lamp('spool', 'Spool', 'no lease', 'caution', [
      usage,
      detail('No spool lease: hooks do not write events.', 'caution'),
      ...gaps,
    ])
  }
  return lamp(
    'spool',
    'Spool',
    spool.files === 0 ? 'empty' : `${plural(spool.files, fileForms)}, ${bytes(spool.bytes)}`,
    gaps.length > 0 ? 'caution' : 'normal',
    [usage, detail(`Lease valid until ${clockTime(spool.lease_expires_at)}.`), ...gaps],
  )
}

const versionsLamp = ({ status }: LampInput): Lamp | null => {
  const versions = status?.versions ?? []
  if (versions.length === 0) {
    return null
  }
  const doubtful = versions.filter(({ status: support }) => support !== 'full')
  return lamp(
    'versions',
    'Versions',
    doubtful.length === 0 ? 'verified' : `${plural(doubtful.length, versionForms)} without full support`,
    doubtful.some(({ status: support }) => support === 'limited') ? 'caution' : 'normal',
    versions.map(({ key, status: support, sessions }) =>
      detail(
        `${supportKeyLabel(key)}: ${supportStatusLabel[support]}, ${plural(sessions, sessionForms)}.`,
        support === 'limited' ? 'caution' : 'normal',
      ),
    ),
  )
}

const coverageLamp = ({ status }: LampInput): Lamp | null => {
  const surfaces = status?.not_observable ?? []
  if (surfaces.length === 0) {
    return null
  }
  return lamp(
    'coverage',
    'Not observable',
    surfaces.map((surface) => notObservableLabel[surface]).join(', '),
    'caution',
    surfaces.map((surface) =>
      detail(`${notObservableLabel[surface]}: aang receives no events from this mode.`, 'caution'),
    ),
  )
}

export const lampsOf = (input: LampInput): Lamp[] => {
  const run = input.focus?.run ?? null
  return [
    linkLamp(input),
    observerLamp(input),
    ...(run === null ? [] : [modelLamp(run, input.now), modeLamp(run)]),
    hooksLamp(input),
    sourcesLamp(input),
    recordsLamp(input),
    spoolLamp(input),
    versionsLamp(input),
    coverageLamp(input),
  ].filter((shown) => shown !== null)
}

export const problemsOf = (lamps: readonly Lamp[]): Lamp[] =>
  lamps.filter(({ id, level }) => level !== 'normal' && id !== 'coverage')
