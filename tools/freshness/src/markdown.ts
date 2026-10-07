import type { ChangeAuthor } from '@aang/contract'
import type { BackendReport, BackendSpending, EventStatus, Percentile, Rate, Report, ReportedEvent, Spending } from './report.js'

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

const amount = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 })

const tokens = (value: number): string => amount.format(value)

const dollars = (value: number | null): string => (value === null ? none : `$${value.toFixed(2).replace('.', ',')}`)

const hours = (ms: number): string => (ms / 3_600_000).toFixed(2).replace('.', ',')

const journalText = { observer: 'наблюдатель', chat: 'чат', checks: 'пробы и auth status' } as const

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
  rate === null ? [none, none, none] : [rate.calls.toFixed(1).replace('.', ','), tokens(rate.tokens), dollars(rate.cost_usd)]

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
    '## Расход',
    '',
    'Расход вызовов — по данным CLI в журнале вызовов демона. Час прогона — сумма длительностей проигранных прогонов backend, активный час — время, когда шёл хотя бы один его прогон. Деньги — только у Claude, по прейскуранту; при подписке это не списание.',
    '',
    ...table(
      ['Backend', 'Прогоны', 'Часы прогонов', 'Активные часы'],
      report.spending.map(({ runtime, runs, run_ms: runMs, active_ms: activeMs }) => [runtime, String(runs), hours(runMs), hours(activeMs)]),
    ),
    '',
    ...table(
      ['Backend', 'Журнал', 'Вызовы', 'Вход без кэша', 'Чтение кэша', 'Запись кэша', 'Вывод', 'Рассуждения', 'Всего токенов', 'Стоимость'],
      report.spending.flatMap((spending) =>
        (['observer', 'chat', 'checks'] as const).map((journal) => spendingRow(spending.runtime, journal, spending[journal])),
      ),
    ),
    '',
    ...table(
      ['Backend', 'Журнал', 'Вызовов на час прогона', 'Токенов на час прогона', 'Стоимость часа прогона', 'Вызовов на активный час', 'Токенов на активный час', 'Стоимость активного часа'],
      report.spending.flatMap(rateRows),
    ),
    '',
    ...table(
      ['Backend', 'Вопросы', 'Ответы', 'Ошибки', 'Не заданы', 'Недостаточно данных', 'p50 ответа, с', 'p95 ответа, с', 'Токенов на ответ', 'Стоимость ответа'],
      report.spending.map(questionRow),
    ),
    '',
    `По учёту расхода демона (U.1) активных часов — ${String(report.active_hours.hours)}: это календарные часы, в которых была активность решателя.`,
    '',
  ].join('\n')
