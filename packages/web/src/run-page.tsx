import type { BasisKind, RunSnapshot } from '@aang/contract'
import type { ReactElement } from 'react'
import { AttentionBadge, ExecutionBadge, FreshnessBadge } from './badges.js'
import { absoluteTime } from './format.js'
import { runtimeLabel, supportModeLabel } from './labels.js'
import { Moment } from './moment.js'
import { listHref, runHref, useNavigate } from './route.js'
import { runTitle, untitledRun } from './run-list.js'
import type { RunFeedState } from './use-run-feed.js'

const basisLabel: Readonly<Record<BasisKind, string>> = {
  observed: 'наблюдаемое событие',
  claimed: 'заявление решателя',
  interpreted: 'интерпретация aang',
}

const Facts = ({ snapshot, now }: { readonly snapshot: RunSnapshot; readonly now: bigint }): ReactElement => {
  const navigate = useNavigate()
  const { summary } = snapshot
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
          <dt>Ответвление</dt>
          <dd>
            <a href={runHref(summary.forked_from)} onClick={navigate}>
              исходный прогон
            </a>
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

export const RunPage = ({ feed, now }: { readonly feed: RunFeedState; readonly now: bigint }): ReactElement => {
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
        <Facts snapshot={snapshot} now={now} />
      </header>
    </article>
  )
}
