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

const lostSourceForms = { one: 'источник потерян', few: 'источника потеряны', many: 'источников потеряно' } as const
const problemForms = { one: 'проблема', few: 'проблемы', many: 'проблем' } as const
const unknownRecordForms = { one: 'нераспознанная', few: 'нераспознанные', many: 'нераспознанных' } as const

const sourceGapKinds: ReadonlySet<GapKind> = new Set([
  'source_lost',
  'read_failed',
  'unknown_stream_layout',
  'stream_changed_after_prune',
])
const spoolGapKinds: ReadonlySet<GapKind> = new Set(['spool_over_threshold', 'spool_expired'])

const observerLevel = ({ state }: ObserverState): Level =>
  state === 'ok' ? 'normal' : state === 'unavailable' ? 'warning' : 'caution'

const interpreting = ({ state }: ObserverState): boolean => state === 'ok' || state === 'lagging'

const retryDetails = (state: ObserverState): LampDetail[] =>
  state.state === 'unavailable' && state.retry_at !== null
    ? [detail(`${retryLabel[state.reason]} — в ${clockTime(state.retry_at)}.`, 'warning')]
    : []

const pausedDetails = (state: ObserverState): LampDetail[] =>
  interpreting(state)
    ? []
    : [detail('Факты и пункты внимания продолжают поступать, этапы обновятся, когда наблюдатель вернётся.')]

const catchUpDetails = ({ deferred_facts: deferred }: ObserverRunState): LampDetail[] =>
  deferred === 0
    ? []
    : [
        detail(
          `Догоняющий режим: ${plural(deferred, earlyFactForms)} наблюдатель видит только сводкой — счётчиками по агентам и инструментам, без подробностей.`,
          'caution',
        ),
      ]

const linkLamp = ({ statusFailing, runsFailing, focus }: LampInput): Lamp => {
  if (statusFailing) {
    return lamp('link', 'Связь', 'нет связи с демоном', 'warning', [
      detail('Демон не отвечает. Проверьте его командой aang status; данные на экране могут устареть.', 'warning'),
    ])
  }
  if (runsFailing && focus === null) {
    return lamp('link', 'Связь', 'список не обновляется', 'warning', [
      detail('Демон не отдал список прогонов. aang повторяет запрос; список на экране может устареть.', 'warning'),
    ])
  }
  switch (focus?.connection) {
    case undefined:
      return lamp('link', 'Связь', 'есть', 'normal')
    case 'loading':
      return lamp('link', 'Связь', 'подключение', 'normal')
    case 'live':
      return runsFailing
        ? lamp('link', 'Связь', 'ответвления не обновляются', 'caution', [
            detail('Изменения прогона приходят по мере записи событий.'),
            detail(
              'Демон не отдал список прогонов. aang повторяет запрос; ответвления и названия связанных прогонов могут устареть.',
              'caution',
            ),
          ])
        : lamp('link', 'Связь', 'поток подключён', 'normal', [
            detail('Изменения прогона приходят по мере записи событий.'),
          ])
    case 'reconnecting':
      return lamp('link', 'Связь', 'переподключение', 'caution', [
        detail('Поток изменений прерван. aang переподключится и дочитает пропущенное.', 'caution'),
      ])
    case 'missing':
      return lamp('link', 'Связь', 'прогон не найден', 'warning', [
        detail('Демон не знает этот прогон: он удалён или ещё не принят заново.', 'warning'),
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
      `${backendName(backend)}, модель ${backend.model}: ${observerStateLabel(backend.state)}.`,
      observerLevel(backend.state),
    ),
  )
  const focused = focus?.run ?? null
  if (focused !== null) {
    const { observer } = focused.summary
    return lamp('observer', 'Наблюдатель', observerStateLabel(observer.state), observerLevel(observer.state), [
      ...retryDetails(observer.state),
      ...pausedDetails(observer.state),
      ...(observer.isolation_unverified ? [detail('Изоляция наблюдателя не подтверждена.', 'caution')] : []),
      ...catchUpDetails(observer),
      ...(observer.not_interpreted_facts > 0
        ? [detail(`Не интерпретировано: ${plural(observer.not_interpreted_facts, factForms)}.`, 'caution')]
        : []),
      ...backendDetails,
    ])
  }
  const backend = worstOf(backends, ({ state }) => observerLevel(state))
  if (backend !== null) {
    return lamp(
      'observer',
      'Наблюдатель',
      `${runtimeLabel[backend.vendor]}: ${observerStateLabel(backend.state)}`,
      observerLevel(backend.state),
      backendDetails,
    )
  }
  const states = (runs ?? []).map(({ observer }) => observer.state)
  const shown = worstOf(states, observerLevel)
  if (shown === null) {
    return lamp('observer', 'Наблюдатель', 'нет данных', 'normal')
  }
  const same = states.filter((state) => observerStateLabel(state) === observerStateLabel(shown)).length
  return lamp('observer', 'Наблюдатель', observerStateLabel(shown), observerLevel(shown), [
    detail(`Так в ${plural(same, runInForms)} из ${String(states.length)}.`),
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
            `Ждут наблюдателя: ${plural(observer.pending_facts, factForms)}, старейший — ${duration(oldest, now)} назад.`,
            lagging ? 'caution' : 'normal',
          ),
        ]
  return lamp(
    'model',
    'Модель',
    updated === null ? 'не строилась' : `обновлена ${relativeTime(updated, now)}`,
    lagging || unbuilt ? 'caution' : 'normal',
    [
      detail(`Версия карты ${String(version)}.`),
      ...(updated === null ? [] : [detail(`Последнее обновление: ${absoluteTime(updated)}.`)]),
      ...pending,
      ...(observer.deferred_facts === 0
        ? []
        : [detail('Ранние факты карта учитывает только по сводке, с пониженной детализацией.', 'caution')]),
    ],
  )
}

const modeExplanation: Readonly<Record<SupportMode, string>> = {
  full: 'hooks и файлы сессии',
  files_only: 'hooks не активны, события берутся из файлов сессии',
  hooks_only: 'файл сессии не найден, видны только события hooks',
}

const modeLamp = ({ summary, sessions }: FocusedRun): Lamp => {
  const modes = summary.support_modes
  if (modes.length === 0) {
    return lamp('mode', 'Режим', 'нет сессий', 'normal')
  }
  const limited = modes.filter((mode) => mode !== 'full')
  return lamp(
    'mode',
    'Режим',
    (limited.length > 0 ? limited : modes).map((mode) => supportModeLabel[mode]).join(', '),
    limited.length > 0 ? 'caution' : 'normal',
    sessions.map(({ key, support_mode: mode }) =>
      detail(
        `Сессия ${key.session.slice(0, 8)}: ${supportModeLabel[mode]} — ${modeExplanation[mode]}.`,
        mode === 'full' ? 'normal' : 'caution',
      ),
    ),
  )
}

const installationLevel = (hooks: HookInstallation): Level =>
  hooks === 'not_installed' || hooks === 'untrusted' || hooks === 'disabled' ? 'caution' : 'normal'

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
      ? [detail(`${name}: hooks не активны в ${sessionsIn(idle.length)}, режим «только файлы».`, 'caution')]
      : []),
    ...(twice.length > 0 ? [detail(`${name}: двойная регистрация hooks в ${sessionsIn(twice.length)}.`, 'caution')] : []),
  ]
}

const hooksLamp = ({ status }: LampInput): Lamp => {
  if (status === null) {
    return lamp('hooks', 'Hooks', 'нет данных', 'normal')
  }
  const inactive = status.runtimes.reduce((total, runtime) => total + runtime.hooks_inactive_sessions.length, 0)
  const details = status.runtimes.flatMap(runtimeHookDetails)
  if (inactive > 0) {
    return lamp('hooks', 'Hooks', `не активны в ${sessionsIn(inactive)}`, 'caution', details)
  }
  const missing = status.runtimes.find(({ hooks }) => installationLevel(hooks) !== 'normal')
  if (missing !== undefined) {
    const value = `${runtimeLabel[missing.runtime]}: ${hookInstallationLabel[missing.hooks]}`
    return lamp('hooks', 'Hooks', value, 'caution', details)
  }
  return lamp(
    'hooks',
    'Hooks',
    status.runtimes.every(({ hooks }) => hooks === 'active') ? 'активны' : 'нет неактивных',
    worst(details.map(({ level }) => level)),
    details,
  )
}

const gapDetail = (gap: Gap): LampDetail =>
  detail(
    `${gapLabel[gap.kind]}${gap.details === null ? '' : `: ${gap.details}`} — с ${clockTime(gap.detected_at)}.`,
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
    ...(lostRuns > 0 ? [detail(`Источник потерян в ${plural(lostRuns, runInForms)}.`, 'warning')] : []),
  ]
  if (lost > 0 || lostRuns > 0) {
    return lamp(
      'sources',
      'Источники',
      plural(Math.max(lost, lostRuns), lostSourceForms),
      'warning',
      details,
    )
  }
  if (gaps.length > 0) {
    return lamp('sources', 'Источники', plural(gaps.length, problemForms), 'caution', details)
  }
  return lamp('sources', 'Источники', 'в порядке', 'normal')
}

const recordsLamp = ({ status, focus }: LampInput): Lamp => {
  const focused = focus?.run ?? null
  const unknown =
    focused === null
      ? (status?.unknown_records ?? 0)
      : focused.sessions.reduce((total, { unknown_records: count }) => total + count, 0)
  if (unknown === 0) {
    return lamp('records', 'Записи', 'все распознаны', 'normal')
  }
  return lamp(
    'records',
    'Записи',
    plural(unknown, unknownRecordForms),
    'caution',
    [
      detail(
        'Записи неизвестного формата сохранены в журнале, но фактов из них нет: часть работы может быть не видна.',
        'caution',
      ),
    ],
  )
}

const spoolLamp = ({ status, now }: LampInput): Lamp => {
  if (status === null) {
    return lamp('spool', 'Spool', 'нет данных', 'normal')
  }
  const { spool } = status
  const usage = detail(
    `${plural(spool.files, fileForms)}, ${bytes(spool.bytes)} при пороге ${bytes(spool.threshold_bytes)}.`,
  )
  const gaps = openGaps(status.gaps, spoolGapKinds)
    .filter(({ kind }) => kind !== 'spool_over_threshold')
    .map(gapDetail)
  if (spool.over_threshold) {
    return lamp('spool', 'Spool', 'превышен порог', 'warning', [
      usage,
      detail('Аренда снята: hooks не пишут в spool.', 'warning'),
      detail(`После порога прибавилось ${bytes(spool.growth_since_threshold_bytes ?? 0)}.`),
      ...gaps,
    ])
  }
  if (spool.stopped) {
    return lamp('spool', 'Spool', 'запись остановлена', 'caution', [
      usage,
      detail('Демон остановлен командой aang stop: hooks не пишут в spool до aang start.', 'caution'),
      ...gaps,
    ])
  }
  if (spool.lease_expires_at === null || spool.lease_expires_at < now) {
    return lamp('spool', 'Spool', 'нет аренды', 'caution', [
      usage,
      detail('Аренды spool нет: hooks не пишут события.', 'caution'),
      ...gaps,
    ])
  }
  return lamp(
    'spool',
    'Spool',
    spool.files === 0 ? 'пуст' : `${plural(spool.files, fileForms)}, ${bytes(spool.bytes)}`,
    gaps.length > 0 ? 'caution' : 'normal',
    [usage, detail(`Аренда действует до ${clockTime(spool.lease_expires_at)}.`), ...gaps],
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
    'Версии',
    doubtful.length === 0 ? 'проверены' : `${plural(doubtful.length, versionForms)} без полной поддержки`,
    doubtful.length === 0 ? 'normal' : 'caution',
    versions.map(({ key, status: support, sessions }) =>
      detail(
        `${supportKeyLabel(key)}: ${supportStatusLabel[support]}, ${plural(sessions, sessionForms)}.`,
        support === 'full' ? 'normal' : 'caution',
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
    'Не наблюдаемо',
    surfaces.map((surface) => notObservableLabel[surface]).join(', '),
    'caution',
    surfaces.map((surface) =>
      detail(`${notObservableLabel[surface]}: события этого режима aang не получает.`, 'caution'),
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
