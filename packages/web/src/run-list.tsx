import type { RunSummary, WatchState } from '@aang/contract'
import type { ReactElement } from 'react'
import { AttentionBadge, ExecutionBadge, FreshnessBadge } from './badges.js'
import { dayTime } from './format.js'
import { LevelGlyph } from './glyphs.js'
import { runtimeLabel, supportModeLabel } from './labels.js'
import { Moment } from './moment.js'
import { runHref, useNavigate } from './route.js'

export const runTitle = ({ goal, brief }: Pick<RunSummary, 'goal' | 'brief'>): string | null => goal ?? brief

export const untitledRun = ({ runtime, created_at: created }: Pick<RunSummary, 'runtime' | 'created_at'>): string =>
  `${runtimeLabel[runtime]}, начат ${dayTime(created)}`

const EmptyList = ({ watch }: { readonly watch: WatchState | null }): ReactElement => (
  <div className="empty">
    <h2>Прогонов пока нет</h2>
    {watch === null ? null : watch.all ? (
      <p>aang наблюдает все каталоги. Запустите Claude Code или Codex, и прогон появится здесь.</p>
    ) : watch.roots.length === 0 ? (
      <p>
        Ни один каталог не отслеживается. Добавьте проект командой <code>aang watch &lt;каталог&gt;</code> и запустите в
        нём Claude Code или Codex.
      </p>
    ) : (
      <>
        <p>Запустите Claude Code или Codex в отслеживаемом каталоге, и прогон появится здесь.</p>
        <ul className="roots">
          {watch.roots.map((root) => (
            <li key={root}>
              <code>{root}</code>
            </li>
          ))}
        </ul>
      </>
    )}
  </div>
)

const forkOrigin = (source: RunSummary | undefined): string =>
  source === undefined ? 'ответвление' : `ответвление от «${runTitle(source) ?? untitledRun(source)}»`

interface RunRowProps {
  readonly run: RunSummary
  readonly runs: readonly RunSummary[]
  readonly now: bigint
}

const RunRow = ({ run, runs, now }: RunRowProps): ReactElement => {
  const navigate = useNavigate()
  const title = runTitle(run)
  return (
    <tr>
      <td data-label="Состояние">
        <ExecutionBadge execution={run.execution} />
      </td>
      <td className="run-cell">
        <a className="run-link" href={runHref(run.id)} onClick={navigate}>
          {title ?? <span className="untitled">{untitledRun(run)}</span>}
        </a>
        <span className="run-origin">
          {title === null ? <span>цель не определена</span> : <span>{runtimeLabel[run.runtime]}</span>}
          {run.forked_from === null ? null : (
            <span>{forkOrigin(runs.find(({ id }) => id === run.forked_from))}</span>
          )}
          {run.start_pruned ? <span>начало удалено</span> : null}
        </span>
      </td>
      <td data-label="Внимание">
        <AttentionBadge attention={run.attention} />
      </td>
      <td data-label="Свежесть">
        <FreshnessBadge freshness={run.freshness} />
      </td>
      <td data-label="Режим">{run.support_modes.map((mode) => supportModeLabel[mode]).join(', ')}</td>
      <td data-label="Сессии" className="number">
        {run.sessions}
      </td>
      <td data-label="Агенты" className="number">
        {run.agents}
      </td>
      <td data-label="Последнее событие">
        <Moment at={run.last_event_at} now={now} />
      </td>
    </tr>
  )
}

const ListTrouble = ({ children }: { readonly children: string }): ReactElement => (
  <p className="list-trouble" role="status">
    <LevelGlyph level="warning" />
    <span>{children}</span>
  </p>
)

const RunTable = ({ runs, now }: { readonly runs: readonly RunSummary[]; readonly now: bigint }): ReactElement => (
  <table className="runs">
    <caption className="visually-hidden">Прогоны</caption>
    <thead>
      <tr>
        <th scope="col">Состояние</th>
        <th scope="col">Прогон</th>
        <th scope="col">Внимание</th>
        <th scope="col">Свежесть</th>
        <th scope="col">Режим</th>
        <th scope="col" className="number">
          Сессии
        </th>
        <th scope="col" className="number">
          Агенты
        </th>
        <th scope="col">Последнее событие</th>
      </tr>
    </thead>
    <tbody>
      {runs.map((run) => (
        <RunRow key={run.id} run={run} runs={runs} now={now} />
      ))}
    </tbody>
  </table>
)

export interface RunListProps {
  readonly runs: readonly RunSummary[] | null
  readonly failing: boolean
  readonly watch: WatchState | null
  readonly now: bigint
}

export const RunList = ({ runs, failing, watch, now }: RunListProps): ReactElement => {
  if (runs === null) {
    return failing ? (
      <ListTrouble>Не удалось загрузить список прогонов. aang повторяет запрос.</ListTrouble>
    ) : (
      <p className="loading">Загрузка прогонов…</p>
    )
  }
  return (
    <>
      {failing ? (
        <ListTrouble>Не удалось обновить список прогонов. Показаны прежние данные, они могут устареть.</ListTrouble>
      ) : null}
      {runs.length === 0 ? <EmptyList watch={watch} /> : <RunTable runs={runs} now={now} />}
    </>
  )
}
