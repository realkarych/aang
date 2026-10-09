import type { ChangeAuthor } from '@aang/contract'
import type { BackendReport, EventStatus, Percentile, Report, ReportedEvent } from './report.js'

const statusText: Readonly<Record<EventStatus, string>> = {
  met: 'выполнено',
  late: 'после окна, нарушение',
  missed: 'не выполнено, нарушение',
  unmatched: 'событие не найдено, нарушение',
  held_before: 'выполнено до события, разметка некорректна',
  unassessed: 'ждёт оценки разметчика',
}

const authorText: Readonly<Record<ChangeAuthor, string>> = {
  rule: 'правило',
  observer: 'наблюдатель',
  user: 'пользователь',
}

const none = '—'

const seconds = (ms: number | null): string => (ms === null ? none : (ms / 1000).toFixed(1).replace('.', ','))

const percent = (share: number | null): string => (share === null ? none : `${String(Math.round(share * 100))} %`)

const percentile = (p95: Percentile | null): string =>
  p95 === null ? none : p95.kind === 'latency' ? `${seconds(p95.ms)} с` : 'за окном (нарушение)'

const verdict = (met: boolean | null): string => (met === null ? none : met ? 'да' : 'нет')

const row = (cells: readonly string[]): string => `| ${cells.map((cell) => cell.replaceAll('|', '\\|')).join(' | ')} |`

const table = (header: readonly string[], rows: readonly (readonly string[])[]): string[] => [
  row(header),
  row(header.map(() => '---')),
  ...rows.map(row),
]

const backendRow = (backend: BackendReport): string[] => [
  backend.runtime,
  backend.cli_version ?? none,
  backend.model,
  backend.effort ?? 'умолчание CLI',
  `${seconds(backend.target_p95_ms)} с`,
  percentile(backend.p95),
  verdict(backend.target_met),
  percent(backend.within_target),
  `${String(backend.met)} из ${String(backend.assessed)}`,
  String(backend.violations),
  String(backend.unassessed),
  String(backend.held_before),
  backend.full_latency.p95_ms === null ? none : `${seconds(backend.full_latency.p95_ms)} с (${String(backend.full_latency.events)})`,
  `${percent(backend.needs.share)} (${String(backend.needs.events)})`,
]

const eventRow = (event: ReportedEvent): string[] => [
  event.recording,
  event.label,
  event.method === 'predicate' ? 'предикат' : 'разметчик',
  statusText[event.status],
  seconds(event.latency_ms),
  seconds(event.full_latency_ms),
  seconds(event.needs_ms),
  event.version === null ? none : String(event.version),
  event.author === null ? none : authorText[event.author],
]

export const renderReport = (report: Report): string =>
  [
    `# Замер свежести: ${report.profile}`,
    '',
    `- Профиль нагрузки зафиксирован ${report.fixed_at}, замер начат ${report.measured_at} и длился ${seconds(report.duration_ms)} с.`,
    `- Окно замера ${seconds(report.window_ms)} с, масштаб времени записей ${String(report.time_scale)}.`,
    `- Демон ${report.daemon_version}.`,
    '',
    '## Записи',
    '',
    ...table(
      ['Запись', 'Рантайм', 'Старт, с'],
      report.recordings.map(({ recording, runtime, start_ms: start }) => [recording, runtime, seconds(start)]),
    ),
    '',
    '## Итог по backend',
    '',
    'Нарушение — ожидание не выполнено в окне замера. p95 считается по оценённым событиям, невыполненные события стоят в нём за окном. Полная задержка идёт от времени самого события; в скобках — число событий с известным временем. Доля дозапросов — доля времени `needs` в задержке выполненных событий; в скобках — число событий с дозапросом.',
    '',
    ...table(
      [
        'Backend',
        'CLI',
        'Модель',
        'Effort',
        'Ориентир p95',
        'p95',
        'Ориентир выполнен',
        'В пределах ориентира',
        'Выполнено',
        'Нарушения',
        'Без оценки',
        'Выполнено до события',
        'Полная задержка p95',
        'Доля дозапросов',
      ],
      report.backends.map(backendRow),
    ),
    '',
    '## Контрольные события',
    '',
    ...table(
      ['Запись', 'Событие', 'Способ', 'Итог', 'Задержка, с', 'Полная, с', 'Дозапросы, с', 'Версия', 'Автор'],
      report.events.map(eventRow),
    ),
    '',
    '## Наблюдатель',
    '',
    ...table(
      ['Backend', 'Вызовы', 'Приняты', 'Отклонены', 'Ошибки', 'С дозапросом'],
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
      ['Backend', 'Состояние', 'Время, с', 'Доля'],
      report.backends.flatMap(({ runtime, states }) =>
        states.map(({ state, ms, share }) => [runtime, state, seconds(ms), percent(share)]),
      ),
    ),
    '',
  ].join('\n')
