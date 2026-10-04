import type { RunId, RunSnapshot, RunSummary } from '@aang/contract'
import type { ReactElement } from 'react'
import { AttentionZone } from './attention-zone.js'
import { AttentionBadge, ExecutionBadge, FreshnessBadge } from './badges.js'
import { absoluteTime } from './format.js'
import { basisLabel, runtimeLabel, supportModeLabel } from './labels.js'
import { MapSection } from './map-section.js'
import { Moment } from './moment.js'
import { PlanFacts } from './plan-facts.js'
import { listHref, runHref, useNavigate } from './route.js'
import { runTitle, untitledRun } from './run-list.js'
import { Trace } from './trace.js'
import type { RunFeedState } from './use-run-feed.js'

interface RunLinkProps {
  readonly id: RunId
  readonly runs: readonly RunSummary[] | null
  readonly unknown: string
}

const RunLink = ({ id, runs, unknown }: RunLinkProps): ReactElement => {
  const navigate = useNavigate()
  const known = runs?.find((run) => run.id === id)
  return (
    <a href={runHref(id)} onClick={navigate}>
      {known === undefined ? unknown : (runTitle(known) ?? untitledRun(known))}
    </a>
  )
}

interface FactsProps {
  readonly snapshot: RunSnapshot
  readonly runs: readonly RunSummary[] | null
  readonly now: bigint
}

const Facts = ({ snapshot, runs, now }: FactsProps): ReactElement => {
  const { summary } = snapshot
  const forks = (runs ?? []).filter(({ forked_from: source }) => source === summary.id)
  return (
    <dl className="facts">
      <div>
        <dt>Состояние</dt>
        <dd>
          <ExecutionBadge execution={summary.execution} />
        </dd>
      </div>
      <div>
        <dt>Свежесть</dt>
        <dd>
          <FreshnessBadge freshness={summary.freshness} />
        </dd>
      </div>
      <div>
        <dt>Режим</dt>
        <dd>{summary.support_modes.map((mode) => supportModeLabel[mode]).join(', ')}</dd>
      </div>
      <div>
        <dt>Внимание</dt>
        <dd>
          <AttentionBadge attention={summary.attention} />
        </dd>
      </div>
      <div>
        <dt>Сессии</dt>
        <dd className="number">{summary.sessions}</dd>
      </div>
      <div>
        <dt>Агенты</dt>
        <dd className="number">{summary.agents}</dd>
      </div>
      <div>
        <dt>Версия карты</dt>
        <dd className="number">{summary.version}</dd>
      </div>
      <div>
        <dt>Начат</dt>
        <dd>{absoluteTime(summary.created_at)}</dd>
      </div>
      <div>
        <dt>Последнее событие</dt>
        <dd>
          <Moment at={summary.last_event_at} now={now} />
        </dd>
      </div>
      {summary.forked_from === null ? null : (
        <div>
          <dt>Ответвление от</dt>
          <dd>
            <RunLink id={summary.forked_from} runs={runs} unknown="исходный прогон" />
          </dd>
        </div>
      )}
      {forks.length === 0 ? null : (
        <div>
          <dt>Ответвления</dt>
          <dd>
            <ul className="run-links">
              {forks.map(({ id }) => (
                <li key={id}>
                  <RunLink id={id} runs={runs} unknown="ответвление" />
                </li>
              ))}
            </ul>
          </dd>
        </div>
      )}
      {summary.start_pruned ? (
        <div>
          <dt>Начало</dt>
          <dd>удалено командой aang prune</dd>
        </div>
      ) : null}
    </dl>
  )
}

const Missing = (): ReactElement => {
  const navigate = useNavigate()
  return (
    <div className="empty">
      <h2>Прогон не найден</h2>
      <p>
        Демон не знает этот прогон: он удалён или ещё не принят заново после перезапуска. Страница обновится сама, когда
        прогон появится.
      </p>
      <p>
        <a href={listHref} onClick={navigate}>
          К списку прогонов
        </a>
      </p>
    </div>
  )
}

export interface RunPageProps {
  readonly feed: RunFeedState
  readonly runs: readonly RunSummary[] | null
  readonly now: bigint
}

export const RunPage = ({ feed, runs, now }: RunPageProps): ReactElement => {
  const { snapshot, connection } = feed
  if (snapshot === null) {
    return connection === 'missing' ? <Missing /> : <p className="loading">Загрузка прогона…</p>
  }
  const { summary, run } = snapshot
  const title = runTitle(summary)
  return (
    <article className="run">
      <header className="run-head">
        <p className="run-origin">
          {title === null ? <span>цель не определена</span> : <span>{runtimeLabel[summary.runtime]}</span>}
        </p>
        <h1 className="run-title">{title ?? <span className="untitled">{untitledRun(summary)}</span>}</h1>
        {run.brief === null || run.brief.text === title ? null : (
          <p className="brief">
            {run.brief.text}
            <span className="basis">{basisLabel[run.brief.basis.kind]}</span>
          </p>
        )}
        <Facts snapshot={snapshot} runs={runs} now={now} />
      </header>
      <AttentionZone snapshot={snapshot} now={now} />
      <MapSection snapshot={snapshot} />
      <div className="run-body">
        <Trace snapshot={snapshot} now={now} />
        <PlanFacts snapshot={snapshot} now={now} />
      </div>
    </article>
  )
}
