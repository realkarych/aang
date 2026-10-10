import {
  type CallsUsage,
  EpochNs,
  type JournalRates,
  type Latency,
  type Link,
  type RunId,
  type RunSnapshot,
  type RunSummary,
  type RunUsage,
  type Session,
  type SessionUsage,
  type TokenUsage,
  type UsageQuery,
  type UsageRate,
  type UsageReport,
  type UsageTotals,
} from '@aang/contract'
import { Fragment, type ReactElement, type ReactNode, useId } from 'react'
import { absoluteTime, elapsed, type Forms, money, plural, rate, wait, whole } from './format.js'
import { LevelGlyph } from './glyphs.js'
import { runtimeLabel } from './labels.js'
import { type UsagePeriod, usageHref, usagePeriods, useNavigate } from './route.js'
import { runTitle, untitledRun } from './run-list.js'
import { fullHint, shortIds } from './short-ids.js'
import './usage.css'

type Amounts = UsageTotals | UsageRate

type TokenField = 'uncached_input_tokens' | 'cache_read_input_tokens' | 'cache_write_input_tokens' | 'output_tokens'

const tokenRows: readonly (readonly [TokenField, string])[] = [
  ['uncached_input_tokens', 'Ввод без кэша'],
  ['cache_read_input_tokens', 'Чтение кэша'],
  ['cache_write_input_tokens', 'Запись в кэш'],
  ['output_tokens', 'Вывод'],
]

const responseForms = { one: 'ответ модели', few: 'ответа модели', many: 'ответов модели' } as const
const callForms = { one: 'вызов', few: 'вызова', many: 'вызовов' } as const
const probeForms = { one: 'проверка допуска', few: 'проверки допуска', many: 'проверок допуска' } as const
const hourForms = { one: 'активный час', few: 'активных часа', many: 'активных часов' } as const

const periodLabel: Readonly<Record<UsagePeriod, string>> = {
  all: 'Всё время',
  day: '24 часа',
  week: '7 дней',
  month: '30 дней',
}

const dayNs = 86_400_000_000_000n

const periodSpanNs: Readonly<Record<Exclude<UsagePeriod, 'all'>, bigint>> = {
  day: dayNs,
  week: 7n * dayNs,
  month: 30n * dayNs,
}

export const usageQuery = (period: UsagePeriod, run: RunId | null, now: bigint): UsageQuery => ({
  ...(run === null ? {} : { run }),
  ...(period === 'all' ? {} : { from: EpochNs.parse(now - periodSpanNs[period]) }),
})

const inputOf = ({ tokens }: Amounts): number =>
  tokens.uncached_input_tokens + tokens.cache_read_input_tokens + tokens.cache_write_input_tokens

const outputOf = ({ tokens, output_lower_bound: lowerBound }: Amounts, format: (value: number) => string): string =>
  lowerBound ? `не меньше ${format(tokens.output_tokens)}` : format(tokens.output_tokens)

const summed = (parts: readonly TokenUsage[], cost: number | null): UsageTotals => {
  const sum = (field: TokenField): number => parts.reduce((total, tokens) => total + tokens[field], 0)
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

interface Column {
  readonly label: string
  readonly amounts: Amounts
  readonly format: (value: number) => string
  readonly responses?: number
}

const AmountTable = ({
  caption,
  columns,
}: {
  readonly caption: string
  readonly columns: readonly Column[]
}): ReactElement => {
  const paid = columns.some(({ amounts }) => amounts.cost_usd !== null)
  const counted = columns.some(({ responses }) => responses !== undefined)
  return (
    <table className="amounts">
      <caption className="visually-hidden">{caption}</caption>
      <thead>
        <tr>
          <td />
          {columns.map(({ label }) => (
            <th key={label} scope="col">
              {label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {tokenRows.map(([field, label]) => (
          <tr key={field}>
            <th scope="row">{label}</th>
            {columns.map((column) => (
              <td key={column.label}>
                {field === 'output_tokens'
                  ? outputOf(column.amounts, column.format)
                  : column.format(column.amounts.tokens[field])}
              </td>
            ))}
          </tr>
        ))}
        {counted ? (
          <tr>
            <th scope="row">Ответов модели</th>
            {columns.map(({ label, responses }) => (
              <td key={label}>{responses === undefined ? '—' : whole(responses)}</td>
            ))}
          </tr>
        ) : null}
        {paid ? (
          <tr className="amounts-money">
            <th scope="row">Деньги</th>
            {columns.map(({ label, amounts }) => (
              <td key={label}>{amounts.cost_usd === null ? '—' : money(amounts.cost_usd)}</td>
            ))}
          </tr>
        ) : null}
      </tbody>
    </table>
  )
}

const spread = ({ p50, p95, max }: Latency): string =>
  `медиана ${wait(p50)}, p95 ${wait(p95)}, максимум ${wait(max)}`

const amountsLine = (amounts: Amounts): string =>
  [
    `ввод ${whole(inputOf(amounts))}`,
    `вывод ${outputOf(amounts, whole)}`,
    ...(amounts.cost_usd === null ? [] : [money(amounts.cost_usd)]),
  ].join(', ')

interface LedgerProps {
  readonly title: string
  readonly who: string
  readonly count: string
  readonly totals: UsageTotals
  readonly perHour: UsageRate | null
  readonly children?: ReactNode
}

const Ledger = ({ title, who, count, totals, perHour, children }: LedgerProps): ReactElement => {
  const heading = useId()
  return (
    <section className="ledger" aria-labelledby={heading}>
      <header className="ledger-head">
        <h2 id={heading} className="ledger-title">
          {title}
        </h2>
        <p className="ledger-who">{who}</p>
      </header>
      <p className="ledger-count">{count}</p>
      <AmountTable
        caption={`${title}: расход`}
        columns={[
          { label: 'Всего', amounts: totals, format: whole },
          ...(perHour === null ? [] : [{ label: 'В активный час', amounts: perHour, format: rate }]),
        ]}
      />
      {children}
    </section>
  )
}

interface CallFact {
  readonly term: string
  readonly value: string | null
}

const CallFacts = ({ facts }: { readonly facts: readonly CallFact[] }): ReactElement | null => {
  const shown = facts.flatMap(({ term, value }) => (value === null ? [] : [{ term, value }]))
  return shown.length === 0 ? null : (
    <dl className="ledger-calls">
      {shown.map(({ term, value }) => (
        <div key={term}>
          <dt>{term}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  )
}

const latencyFact = (term: string, latency: Latency | null): CallFact => ({
  term,
  value: latency === null ? null : spread(latency),
})

const probesFact = (probes: CallsUsage | null): CallFact => ({
  term: 'Проверки допуска',
  value:
    probes === null || probes.calls === 0
      ? null
      : `${plural(probes.calls, callForms)} вне прогонов: ${amountsLine(probes.totals)}`,
})

const Journals = ({ report }: { readonly report: UsageReport }): ReactElement => {
  const { totals, observer, probes, chat } = report
  const rates: JournalRates | null = report.per_active_hour
  const observerCount = [
    plural(observer.calls, callForms),
    ...(probes === null || probes.calls === 0 ? [] : [plural(probes.calls, probeForms)]),
  ].join(' и ')
  return (
    <div className="ledgers" role="group" aria-label="Журналы расхода">
      <Ledger
        title="Решатель"
        who="Claude Code и Codex в ваших сессиях"
        count={plural(totals.solver.records, responseForms)}
        totals={totals.solver}
        perHour={rates?.solver ?? null}
      />
      <Ledger
        title="Наблюдатель"
        who="вызовы aang, которые строят карту"
        count={observerCount}
        totals={totals.observer}
        perHour={rates?.observer ?? null}
      >
        <CallFacts
          facts={[
            latencyFact('Задержка вызова', observer.latency_ms),
            latencyFact('Отставание карты', observer.lag_ms),
            probesFact(probes),
          ]}
        />
      </Ledger>
      <Ledger
        title="Чат"
        who="ответы на ваши вопросы о прогоне"
        count={plural(chat.calls, callForms)}
        totals={totals.chat}
        perHour={rates?.chat ?? null}
      >
        <CallFacts facts={[latencyFact('Задержка ответа', chat.latency_ms)]} />
      </Ledger>
    </div>
  )
}

const PeriodSwitch = ({ run, period }: { readonly run: RunId | null; readonly period: UsagePeriod }): ReactElement => {
  const navigate = useNavigate()
  return (
    <nav className="periods" aria-label="Период">
      {usagePeriods.map((option) => (
        <a
          key={option}
          href={usageHref(run, option)}
          onClick={navigate}
          aria-current={option === period ? 'page' : undefined}
        >
          {periodLabel[option]}
        </a>
      ))}
    </nav>
  )
}

const periodText = ({ from }: UsageReport): string => (from === null ? 'за всё время' : `с ${absoluteTime(from)}`)

const hoursText = (hours: number): string =>
  hours === 0 ? 'нет: расход на активный час не считается' : plural(hours, hourForms)

const moneyShown = ({ totals, runs }: UsageReport): boolean =>
  [totals.solver, totals.observer, totals.chat].some(({ cost_usd: cost }) => cost !== null) ||
  runs.some(({ solver }) =>
    solver.sessions.some(({ cost_state: state }) => state !== null && state.total_cost_usd !== null),
  )

const Notes = ({
  report,
  cumulative = false,
}: {
  readonly report: UsageReport
  readonly cumulative?: boolean
}): ReactElement => (
  <footer className="usage-notes">
    <p>
      Журналы решателя, наблюдателя и чата ведутся отдельно и не складываются: каждый ответ модели учтён один раз в
      своём журнале.
    </p>
    {report.totals.solver.output_lower_bound ? (
      <p>
        «Не меньше» — нижняя оценка вывода: у части ответов нет завершающей записи, и модель могла вывести больше.
      </p>
    ) : null}
    {cumulative ? (
      <p>Итог Claude Code и итог треда относятся ко всей сессии или треду, а не только к выбранному периоду.</p>
    ) : null}
    {moneyShown(report) ? (
      <p>Деньги — по прейскуранту, как их сообщает рантайм; при подписке это не списание. Codex сообщает только токены.</p>
    ) : null}
  </footer>
)

const Trouble = ({ children }: { readonly children: string }): ReactElement => (
  <p className="list-trouble" role="status">
    <LevelGlyph level="warning" />
    <span>{children}</span>
  </p>
)

const Pending = ({ failing }: { readonly failing: boolean }): ReactElement =>
  failing ? (
    <Trouble>Не удалось загрузить отчёт о расходе. aang повторяет запрос.</Trouble>
  ) : (
    <p className="loading">Загрузка расхода…</p>
  )

const Stale = ({ failing }: { readonly failing: boolean }): ReactElement | null =>
  failing ? <Trouble>Не удалось обновить отчёт о расходе. Показаны прежние данные, они могут устареть.</Trouble> : null

const runName = (run: RunId, summary: RunSummary | undefined): ReactNode => {
  if (summary === undefined) {
    return `Прогон ${run.slice(0, 8)}`
  }
  return runTitle(summary) ?? <span className="untitled">{untitledRun(summary)}</span>
}

const JournalCell = ({ count, amounts }: { readonly count: string | null; readonly amounts: Amounts }): ReactElement =>
  count === null ? (
    <span className="quiet">нет</span>
  ) : (
    <span className="journal-cell">
      <span>{amountsLine(amounts)}</span>
      <span className="journal-count">{count}</span>
    </span>
  )

const countOf = (count: number, forms: Forms): string | null =>
  count === 0 ? null : plural(count, forms)

const RunRow = ({
  usage,
  summary,
  period,
}: {
  readonly usage: RunUsage
  readonly summary: RunSummary | undefined
  readonly period: UsagePeriod
}): ReactElement => {
  const navigate = useNavigate()
  const { solver, observer, chat } = usage
  return (
    <tr>
      <td className="run-cell">
        <a className="run-link" href={usageHref(usage.run, period)} onClick={navigate}>
          {runName(usage.run, summary)}
        </a>
        {summary === undefined ? null : <span className="run-origin">{runtimeLabel[summary.runtime]}</span>}
      </td>
      <td data-label="Время">
        {usage.active_hours === 0 ? (
          <span className="quiet">нет активности решателя</span>
        ) : (
          <span className="journal-cell">
            <span>{elapsed(usage.duration_ms)}</span>
            <span className="journal-count">{plural(usage.active_hours, hourForms)}</span>
          </span>
        )}
      </td>
      <td data-label="Решатель">
        <JournalCell count={countOf(solver.totals.records, responseForms)} amounts={solver.totals} />
      </td>
      <td data-label="Наблюдатель">
        <JournalCell count={countOf(observer.calls, callForms)} amounts={observer.totals} />
      </td>
      <td data-label="Чат">
        <JournalCell count={countOf(chat.calls, callForms)} amounts={chat.totals} />
      </td>
    </tr>
  )
}

const RunTable = ({
  report,
  runs,
  period,
}: {
  readonly report: UsageReport
  readonly runs: readonly RunSummary[]
  readonly period: UsagePeriod
}): ReactElement => {
  const heading = useId()
  const known = new Map(runs.map((summary) => [summary.id, summary]))
  return (
    <section className="usage-section" aria-labelledby={heading}>
      <h2 id={heading} className="usage-title">
        Прогоны
      </h2>
      {report.runs.length === 0 ? (
        <p className="section-lead">За этот период нет ни активности решателя, ни вызовов наблюдателя и чата.</p>
      ) : (
        <table className="runs usage-runs">
          <caption className="visually-hidden">Расход по прогонам</caption>
          <thead>
            <tr>
              <th scope="col">Прогон</th>
              <th scope="col">Время</th>
              <th scope="col">Решатель</th>
              <th scope="col">Наблюдатель</th>
              <th scope="col">Чат</th>
            </tr>
          </thead>
          <tbody>
            {report.runs.map((usage) => (
              <RunRow key={usage.run} usage={usage} summary={known.get(usage.run)} period={period} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

export interface UsageOverviewProps {
  readonly report: UsageReport | null
  readonly failing: boolean
  readonly runs: readonly RunSummary[]
  readonly period: UsagePeriod
}

export const UsageOverview = ({ report, failing, runs, period }: UsageOverviewProps): ReactElement => (
  <article className="usage">
    <header className="run-head usage-head">
      <h1 className="run-title">Расход</h1>
      <PeriodSwitch run={null} period={period} />
      {report === null ? null : (
        <dl className="facts">
          <div>
            <dt>Период</dt>
            <dd>{periodText(report)}</dd>
          </div>
          <div>
            <dt>Активные часы решателя</dt>
            <dd>{hoursText(report.active_hours)}</dd>
          </div>
        </dl>
      )}
    </header>
    {report === null ? (
      <Pending failing={failing} />
    ) : (
      <>
        <Stale failing={failing} />
        <Journals report={report} />
        <RunTable report={report} runs={runs} period={period} />
        <Notes report={report} />
      </>
    )}
  </article>
)

const StageRow = ({ name, totals }: { readonly name: ReactNode; readonly totals: UsageTotals }): ReactElement => (
  <tr>
    <th scope="row">{name}</th>
    {tokenRows.map(([field]) => (
      <td key={field} className="number">
        {field === 'output_tokens' ? outputOf(totals, whole) : whole(totals.tokens[field])}
      </td>
    ))}
    <td className="number">{whole(totals.records)}</td>
  </tr>
)

const StageUsage = ({ usage, snapshot }: { readonly usage: RunUsage; readonly snapshot: RunSnapshot }): ReactElement => {
  const heading = useId()
  const titles = new Map(snapshot.model.stages.map(({ id, title }) => [id, title]))
  const { stages, unassigned } = usage.solver
  return (
    <section className="usage-section" aria-labelledby={heading}>
      <h2 id={heading} className="usage-title">
        Решатель по этапам
      </h2>
      <p className="section-lead">
        Этапу засчитан ответ модели, все действия которого относятся к этому этапу; остальное не привязано, aang не
        делит расход догадкой. Этапы строит наблюдатель: пока карты нет, весь расход решателя не привязан.
      </p>
      <div className="usage-scroll">
        <table className="stage-usage">
          <caption className="visually-hidden">Решатель по этапам</caption>
          <thead>
            <tr>
              <th scope="col">Этап</th>
              {tokenRows.map(([field, label]) => (
                <th key={field} scope="col" className="number">
                  {label}
                </th>
              ))}
              <th scope="col" className="number">
                Ответов модели
              </th>
            </tr>
          </thead>
          <tbody>
            {stages.map(({ stage, totals }) => {
              const title = titles.get(stage) ?? 'Этап снят с карты'
              return <StageRow key={stage} name={<span title={fullHint(title)}>{shortIds(title)}</span>} totals={totals} />
            })}
            <StageRow name={<span className="quiet">Не привязано к этапам</span>} totals={unassigned} />
          </tbody>
        </table>
      </div>
    </section>
  )
}

const shortSession = (session: Session | undefined, usage: SessionUsage): string =>
  (session?.key.session ?? usage.session).slice(0, 8)

const costStateNotes = ({ cost_state: state, cost_state_final: final, fork }: SessionUsage): string[] => {
  if (state === null) {
    return [
      'Итога Claude Code пока нет: интерактивная сессия записывает его только при выходе. До выхода нет денег и расхода на сжатие контекста.',
    ]
  }
  return [
    final
      ? 'Итог окончательный: Claude Code записал его, когда запуск завершился.'
      : 'Итог промежуточный: сессия продолжилась после его записи, Claude Code обновит итог при выходе.',
    ...(fork ? ['Итог Claude Code включает историю, унаследованную при ответвлении; в «Учтено aang» её нет.'] : []),
  ]
}

const threadNote =
  'Итог треда — накопительный итог Codex для треда без записей usage; журнал решателя его не включает.'

const desktopNote =
  'Расход вспомогательной модели сводок Claude Desktop недоступен: её вызовы видны только в потоке движка Desktop, который aang не читает. Входит ли этот расход в итог Claude Code, не установлено.'

const SessionLedger = ({
  usage,
  session,
}: {
  readonly usage: SessionUsage
  readonly session: Session | undefined
}): ReactElement => {
  const name = shortSession(session, usage)
  const threads = usage.thread_totals
  const claude = usage.cost_state !== null || session?.key.runtime === 'claude'
  const notes = [
    ...(claude ? costStateNotes(usage) : []),
    ...(session?.surface?.surface === 'claude_desktop' ? [desktopNote] : []),
    ...(threads.length === 0 ? [] : [threadNote]),
  ]
  return (
    <li className="usage-session">
      <h3 className="usage-session-title">
        Сессия <code>{name}</code>
      </h3>
      <AmountTable
        caption={`Сессия ${name}: расход`}
        columns={[
          { label: 'Учтено aang', amounts: usage.totals, format: whole, responses: usage.totals.records },
          ...(usage.cost_state !== null
            ? [{ label: 'Итог Claude Code', amounts: summed(usage.cost_state.models.map(({ tokens }) => tokens), usage.cost_state.total_cost_usd), format: whole }]
            : []),
          ...(threads.length === 0 ? [] : [{ label: 'Итог треда', amounts: summed(threads.map(({ tokens }) => tokens), null), format: whole }]),
        ]}
      />
      {notes.length === 0 ? null : (
        <ul className="usage-session-notes">
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
    </li>
  )
}

const SessionUsages = ({
  usage,
  snapshot,
}: {
  readonly usage: RunUsage
  readonly snapshot: RunSnapshot
}): ReactElement => {
  const heading = useId()
  const sessions = new Map(snapshot.objects.sessions.map((session) => [session.id, session]))
  return (
    <section className="usage-section" aria-labelledby={heading}>
      <h2 id={heading} className="usage-title">
        Сессии
      </h2>
      <p className="section-lead">
        aang считает каждый ответ модели один раз. Итог Claude Code и итог треда Codex — накопительные данные
        рантайма: они показаны рядом для сверки и с журналами не складываются.
      </p>
      <ul className="usage-sessions">
        {usage.solver.sessions.map((session) => (
          <SessionLedger key={session.session} usage={session} session={sessions.get(session.session)} />
        ))}
      </ul>
    </section>
  )
}

type CommonOrigin = Extract<Link, { readonly kind: 'common_origin' }>

const isCommonOrigin = (link: Link): link is CommonOrigin => link.kind === 'common_origin'

const OriginLead = ({
  snapshot,
  common,
  runs,
  period,
}: {
  readonly snapshot: RunSnapshot
  readonly common: CommonOrigin | undefined
  readonly runs: readonly RunSummary[]
  readonly period: UsagePeriod
}): ReactNode => {
  const navigate = useNavigate()
  const runLink = (run: RunSummary): ReactElement => (
    <a href={usageHref(run.id, period)} onClick={navigate}>
      {runTitle(run) ?? untitledRun(run)}
    </a>
  )
  const forked = snapshot.summary.forked_from
  if (forked !== null) {
    const parent = runs.find(({ id }) => id === forked)
    return parent === undefined ? 'Ответвлён от другого прогона.' : <>Ответвлён от прогона {runLink(parent)}.</>
  }
  if (common === undefined || common.sessions.length === 0) {
    return 'Общее происхождение: сессий с той же историей aang пока не видит.'
  }
  const relatives = common.sessions.flatMap((session) => runs.find(({ root_session: root }) => root === session) ?? [])
  const [candidate] = relatives
  if (candidate === undefined) {
    return 'Общее происхождение с другими сессиями.'
  }
  if (common.parent_candidate !== null) {
    return (
      <>
        Общее происхождение. Предположительный источник — прогон {runLink(candidate)}: из видимых сессий ту же
        историю содержит только он, но и он может оказаться ответвлением.
      </>
    )
  }
  return (
    <>
      Общее происхождение с {relatives.length === 1 ? 'прогоном' : 'прогонами'}{' '}
      {relatives.map((run, index) => (
        <Fragment key={run.id}>
          {index === 0 ? null : ', '}
          {runLink(run)}
        </Fragment>
      ))}
      ; источник не установлен.
    </>
  )
}

const Origin = ({
  snapshot,
  runs,
  period,
}: {
  readonly snapshot: RunSnapshot
  readonly runs: readonly RunSummary[]
  readonly period: UsagePeriod
}): ReactElement | null => {
  const common = snapshot.model.links.find(isCommonOrigin)
  if (snapshot.summary.forked_from === null && common === undefined) {
    return null
  }
  return (
    <p className="usage-origin">
      <OriginLead snapshot={snapshot} common={common} runs={runs} period={period} />
      {common === undefined ? null : ' Унаследованная история здесь не учитывается.'}
    </p>
  )
}

export interface RunUsagePageProps {
  readonly run: RunId
  readonly report: UsageReport | null
  readonly failing: boolean
  readonly snapshot: RunSnapshot | null
  readonly runs: readonly RunSummary[]
  readonly period: UsagePeriod
}

export const RunUsagePage = ({ run, report, failing, snapshot, runs, period }: RunUsagePageProps): ReactElement => {
  const usage = report?.runs.find((entry) => entry.run === run) ?? null
  const title = snapshot === null ? null : runTitle(snapshot.summary)
  return (
    <article className="usage">
      <header className="run-head usage-head">
        <p className="run-origin">
          <span>Расход прогона</span>
          {snapshot === null ? null : <span>{runtimeLabel[snapshot.summary.runtime]}</span>}
        </p>
        <h1 className="run-title">
          {snapshot === null ? 'Прогон' : (title ?? <span className="untitled">{untitledRun(snapshot.summary)}</span>)}
        </h1>
        <PeriodSwitch run={run} period={period} />
        {report === null || usage === null ? null : (
          <dl className="facts">
            <div>
              <dt>Период</dt>
              <dd>{periodText(report)}</dd>
            </div>
            <div>
              <dt>Длительность</dt>
              <dd>
                {usage.active_hours === 0
                  ? 'нет активности решателя'
                  : `${elapsed(usage.duration_ms)} от первой до последней активности`}
              </dd>
            </div>
            <div>
              <dt>Активные часы решателя</dt>
              <dd>{hoursText(usage.active_hours)}</dd>
            </div>
          </dl>
        )}
        {snapshot === null ? null : <Origin snapshot={snapshot} runs={runs} period={period} />}
      </header>
      {report === null || usage === null || snapshot === null ? (
        <Pending failing={failing} />
      ) : (
        <>
          <Stale failing={failing} />
          <Journals report={report} />
          <StageUsage usage={usage} snapshot={snapshot} />
          <SessionUsages usage={usage} snapshot={snapshot} />
          <Notes
            report={report}
            cumulative={
              report.from !== null &&
              usage.solver.sessions.some(
                ({ cost_state: state, thread_totals: threads }) => state !== null || threads.length > 0,
              )
            }
          />
        </>
      )}
    </article>
  )
}
