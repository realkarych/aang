import type {
  Action,
  Agent,
  AttentionItem,
  FactId,
  RunId,
  RunSnapshot,
  Stage,
  StageId,
  StageInspector as Inspected,
  UsageTotals,
} from '@aang/contract'
import { type ReactElement, type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { ActionBadge, DecisionBadge, ExecutionBadge } from './badges.js'
import { inputDetail } from './fact-excerpt.js'
import { absoluteTime, clockTime, plural } from './format.js'
import { AttentionGlyph, LevelGlyph } from './glyphs.js'
import { BasisLine, Grounds, Groundwork, shortId } from './grounds.js'
import { agentRoleLabel, attentionAuthorLabel, attentionKindLabel, executionLabel } from './labels.js'
import { agentTitle } from './objects.js'
import { stageHref, useSelect } from './route.js'
import { factSource } from './sources.js'
import { StageArtifacts } from './stage-artifacts.js'
import { StageCriteria } from './stage-criteria.js'
import { RejectedCalls, StageHistory } from './stage-history.js'
import { priorityLabel, resolutionLabel, stageOriginLabel } from './stage-labels.js'
import { useRead } from './use-read.js'
import type { RunFeedState } from './use-run-feed.js'
import { useStage } from './use-stage.js'
import './inspector.css'

export interface StageInspectorProps {
  readonly run: RunId
  readonly stage: StageId
  readonly feed: RunFeedState
  readonly onSignedOut: () => void
  readonly onClose: () => void
}

const recentActions = 8

const actionForms = { one: 'раннее действие', few: 'ранних действия', many: 'ранних действий' } as const

const tokenFormat = new Intl.NumberFormat('ru')

const tokens = (value: number): string => tokenFormat.format(value)

const costFormat = new Intl.NumberFormat('ru', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 })

const Section = ({
  title,
  count,
  children,
}: {
  readonly title: string
  readonly count?: number
  readonly children: ReactNode
}): ReactElement => {
  const heading = useId()
  return (
    <section className="inspector-section" aria-labelledby={heading}>
      <h3 id={heading} className="inspector-section-title">
        {title}
        {count === undefined || count === 0 ? null : <span className="inspector-count">{count}</span>}
      </h3>
      {children}
    </section>
  )
}

const StageLink = ({
  run,
  stage,
  titles,
}: {
  readonly run: RunId
  readonly stage: StageId
  readonly titles: ReadonlyMap<StageId, string>
}): ReactElement => {
  const select = useSelect()
  return (
    <a className="stage-link" href={stageHref(run, stage)} onClick={select}>
      {titles.get(stage) ?? `этап ${shortId(stage)}`}
    </a>
  )
}

const lifecycleNote = (stage: Stage): string | null => {
  switch (stage.lifecycle.state) {
    case 'active':
      return null
    case 'replaced':
      return 'Этап заменён'
    case 'merged':
      return 'Этап объединён с другими'
    case 'split':
      return 'Этап разделён'
  }
}

const Axes = ({ stage }: { readonly stage: Stage }): ReactElement => (
  <dl className="axes">
    <div>
      <dt>Выполнение</dt>
      <dd>
        <ExecutionBadge execution={stage.execution.value} />
        {stage.execution.basis.kind === 'observed' ? null : <BasisLine basis={stage.execution.basis} />}
      </dd>
    </div>
    <div>
      <dt>Основание</dt>
      <dd>
        <BasisLine basis={stage.basis} />
      </dd>
    </div>
    <div>
      <dt>Решение человека</dt>
      <dd>
        <DecisionBadge decision={stage.decision} />
      </dd>
    </div>
  </dl>
)

const Warnings = ({ stage, attention }: { readonly stage: Stage; readonly attention: readonly AttentionItem[] }): ReactElement | null => {
  const claim = stage.execution_claim
  const conflict = claim !== null && claim.value.state !== stage.execution.value.state ? claim : null
  const failedCheck = attention.some(({ kind, resolution }) => kind === 'failed_check' && resolution === 'open')
  if (conflict === null && !failedCheck) {
    return null
  }
  return (
    <ul className="inspector-warnings">
      {conflict === null ? null : (
        <li>
          <LevelGlyph level="caution" />
          <span>
            Наблюдатель утверждает: «{executionLabel(conflict.value)}», а по событиям этап «
            {executionLabel(stage.execution.value)}». Показано наблюдаемое.
          </span>
        </li>
      )}
      {failedCheck ? (
        <li data-level="warning">
          <LevelGlyph level="warning" />
          <span>
            {stage.execution.value.state === 'done' ? 'Завершён, но есть упавшая проверка' : 'Есть упавшая проверка'}
          </span>
        </li>
      ) : null}
    </ul>
  )
}

const Purpose = ({ stage }: { readonly stage: Stage }): ReactElement | null =>
  stage.expected_result === null && stage.summary === null ? null : (
    <dl className="purpose">
      {stage.expected_result === null ? null : (
        <div>
          <dt>Ожидаемый результат</dt>
          <dd>{stage.expected_result}</dd>
        </div>
      )}
      {stage.summary === null ? null : (
        <div>
          <dt>Сводка</dt>
          <dd>{stage.summary}</dd>
        </div>
      )}
    </dl>
  )

const AttentionEntry = ({ item }: { readonly item: AttentionItem }): ReactElement => (
  <li className="attention-entry" data-open={item.resolution === 'open'}>
    <p className="attention-kind">
      <AttentionGlyph kind={item.kind} />
      <span>{attentionKindLabel[item.kind]}</span>
      <span>{item.resolution === 'open' && item.runtime_wait === 'active' ? 'ждёт ответа' : resolutionLabel[item.resolution]}</span>
      <span>{attentionAuthorLabel[item.author]}</span>
      {item.priority === null ? null : <span>рекомендация: приоритет {priorityLabel[item.priority.value]}</span>}
    </p>
    <p className="attention-text">{item.text}</p>
    {item.likely_resolved === null ? null : <p className="attention-note">Вероятно, уже отвечен: пункт остаётся открытым до снятия.</p>}
    <Grounds basis={item.basis} evidence={item.evidence} label={`${attentionKindLabel[item.kind]}: ${item.text}`} />
  </li>
)

const AttentionList = ({ items }: { readonly items: readonly AttentionItem[] }): ReactElement => {
  const ordered = items.toSorted(
    (left, right) => Number(right.resolution === 'open') - Number(left.resolution === 'open') || Number(left.opened_at - right.opened_at),
  )
  return (
    <ul className="attention-list">
      {ordered.map((item) => (
        <AttentionEntry key={item.id} item={item} />
      ))}
    </ul>
  )
}

const activeTime = (milliseconds: number): string => {
  const seconds = Math.round(milliseconds / 1_000)
  if (seconds < 60) {
    return `${String(seconds)} с`
  }
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${String(minutes)} мин ${String(seconds % 60)} с` : `${String(Math.floor(minutes / 60))} ч ${String(minutes % 60)} мин`
}

const UsageRow = ({ label, totals }: { readonly label: string; readonly totals: UsageTotals }): ReactElement => (
  <tr>
    <th scope="row">{label}</th>
    <td className="number">{tokens(totals.tokens.uncached_input_tokens)}</td>
    <td className="number">{tokens(totals.tokens.cache_read_input_tokens + totals.tokens.cache_write_input_tokens)}</td>
    <td className="number">
      {tokens(totals.tokens.output_tokens)}
      {totals.output_lower_bound ? <span className="lower-bound"> не меньше</span> : null}
    </td>
    <td className="number">{totals.records}</td>
  </tr>
)

const TimeAndUsage = ({ inspected }: { readonly inspected: Inspected }): ReactElement => {
  const { time, usage } = inspected
  const costs = [usage.stage.cost_usd, usage.unassigned_in_sessions.cost_usd].filter((cost): cost is number => cost !== null)
  return (
    <>
      {time.started_at === null ? (
        <p className="section-empty">К этапу не привязано действий со временем.</p>
      ) : (
        <dl className="figures">
          <div>
            <dt>Начало</dt>
            <dd>{absoluteTime(time.started_at)}</dd>
          </div>
          <div>
            <dt>Конец</dt>
            <dd>{time.ended_at === null ? 'ещё идёт' : absoluteTime(time.ended_at)}</dd>
          </div>
          <div>
            <dt>Активное время</dt>
            <dd>{time.active_ms === null ? '—' : activeTime(time.active_ms)}</dd>
          </div>
        </dl>
      )}
      <table className="usage">
        <caption>Расход решателя, токены</caption>
        <thead>
          <tr>
            <td />
            <th scope="col" className="number">
              Вход
            </th>
            <th scope="col" className="number">
              Кеш
            </th>
            <th scope="col" className="number">
              Выход
            </th>
            <th scope="col" className="number">
              Записей
            </th>
          </tr>
        </thead>
        <tbody>
          <UsageRow label="Этап" totals={usage.stage} />
          <UsageRow label="Не привязано к этапам" totals={usage.unassigned_in_sessions} />
        </tbody>
      </table>
      <p className="usage-note">
        «Не привязано к этапам» — расход сессий этапа, который нельзя целиком отнести ни к одному этапу.
        {costs.length === 0 ? null : (
          <>
            {' '}
            Стоимость {costFormat.format(costs.reduce((sum, cost) => sum + cost, 0))} — по прейскуранту; при подписке это не
            списание.
          </>
        )}
      </p>
    </>
  )
}

const ActionDetail = ({ fact }: { readonly fact: FactId }): ReactElement | null => {
  const read = useRead(factSource, fact)
  if (read.kind !== 'ready' || read.value.kind !== 'action_start') {
    return null
  }
  const detail = inputDetail(read.value.payload.input)
  return detail === null ? null : (
    <code className="action-detail" title={detail}>
      {detail}
    </code>
  )
}

const ActionEntry = ({ action }: { readonly action: Action }): ReactElement => {
  const at = action.started_at ?? action.ended_at
  return (
    <li className="action-entry">
      <span className="action-state">
        <ActionBadge action={action} />
      </span>
      <span className="action-tool">{action.tool}</span>
      <span className="action-body">
        {action.input_fact === null ? null : <ActionDetail fact={action.input_fact} />}
        {action.inherited ? <span className="action-note">унаследовано из исходной сессии</span> : null}
      </span>
      {at === null ? <span /> : <time className="action-time">{clockTime(at)}</time>}
    </li>
  )
}

const compareStart = (left: Action, right: Action): number => {
  const a = left.started_at ?? left.ended_at
  const b = right.started_at ?? right.ended_at
  return a === b ? (left.id < right.id ? -1 : 1) : a === null ? -1 : b === null ? 1 : a < b ? -1 : 1
}

const Participants = ({ agents, actions }: { readonly agents: readonly Agent[]; readonly actions: readonly Action[] }): ReactElement => {
  const [all, setAll] = useState(false)
  const ordered = actions.toSorted(compareStart)
  const hidden = all ? 0 : Math.max(0, ordered.length - recentActions)
  const shown = ordered.slice(hidden)
  if (agents.length === 0 && actions.length === 0) {
    return <p className="section-empty">Наблюдатель не привязал к этапу агентов и действий.</p>
  }
  return (
    <>
      {agents.length === 0 ? null : (
        <ul className="participants" aria-label="Агенты этапа">
          {agents.map((agent) => (
            <li key={agent.id}>
              <span className="participant-name">{agentTitle(agent)}</span>
              {agent.role === 'main' ? null : <span className="participant-role">{agentRoleLabel[agent.role]}</span>}
              <ExecutionBadge execution={agent.execution} />
            </li>
          ))}
        </ul>
      )}
      {actions.length === 0 ? null : (
        <ol className="action-list" aria-label="Действия этапа">
          {hidden === 0 && !all ? null : (
            <li className="action-toggle">
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  setAll(!all)
                }}
              >
                {all ? 'Скрыть ранние действия' : `Показать ${plural(hidden, actionForms)}`}
              </button>
            </li>
          )}
          {shown.map((action) => (
            <ActionEntry key={action.id} action={action} />
          ))}
        </ol>
      )}
    </>
  )
}

const RelationRow = ({ label, children }: { readonly label: string; readonly children: ReactNode }): ReactElement => (
  <div>
    <dt>{label}</dt>
    <dd>{children}</dd>
  </div>
)

const StageLinks = ({
  run,
  stages,
  titles,
}: {
  readonly run: RunId
  readonly stages: readonly StageId[]
  readonly titles: ReadonlyMap<StageId, string>
}): ReactElement => (
  <ul className="stage-links">
    {stages.map((stage) => (
      <li key={stage}>
        <StageLink run={run} stage={stage} titles={titles} />
      </li>
    ))}
  </ul>
)

const successorLabel = (stage: Stage): string => {
  switch (stage.lifecycle.state) {
    case 'merged':
      return 'Объединён в'
    case 'split':
      return 'Разделён на'
    default:
      return 'Заменён на'
  }
}

const Relations = ({
  run,
  inspected,
  titles,
}: {
  readonly run: RunId
  readonly inspected: Inspected
  readonly titles: ReadonlyMap<StageId, string>
}): ReactElement => {
  const { stage, children, predecessors, successors, dependencies } = inspected
  const needs = dependencies.flatMap((link) => (link.kind === 'dependency' && link.stage === stage.id ? [link.depends_on] : []))
  const neededBy = dependencies.flatMap((link) => (link.kind === 'dependency' && link.depends_on === stage.id ? [link.stage] : []))
  const rows: [string, readonly StageId[]][] = [
    ['Входит в', stage.parent === null ? [] : [stage.parent]],
    ['Подэтапы', children],
    ['Зависит от', needs],
    ['Нужен для', neededBy],
    ['Пришёл на смену', predecessors],
    [successorLabel(stage), successors],
  ]
  const present = rows.filter(([, stages]) => stages.length > 0)
  if (present.length === 0) {
    return <p className="section-empty">Связей с другими этапами нет.</p>
  }
  return (
    <dl className="relations">
      {present.map(([label, stages]) => (
        <RelationRow key={label} label={label}>
          <StageLinks run={run} stages={stages} titles={titles} />
        </RelationRow>
      ))}
    </dl>
  )
}

const Statements = ({ stage }: { readonly stage: Stage }): ReactElement => {
  const claim = stage.execution_claim
  return (
    <ul className="statements">
      <li>
        <p className="statement">Этап и его описание</p>
        <Grounds basis={stage.basis} evidence={stage.evidence} label="Этап и его описание" />
      </li>
      <li>
        <p className="statement">Выполнение: {executionLabel(stage.execution.value)}</p>
        <Grounds basis={stage.execution.basis} evidence={stage.execution.evidence} label="Выполнение" />
      </li>
      {claim === null ? null : (
        <li>
          <p className="statement">Утверждение наблюдателя: {executionLabel(claim.value)}</p>
          <Grounds basis={claim.basis} evidence={claim.evidence} label="Утверждение наблюдателя" />
        </li>
      )}
      <li>
        <p className="statement">Решение человека</p>
        <Grounds basis={stage.decision.basis} evidence={stage.decision.evidence} label="Решение человека" />
      </li>
    </ul>
  )
}

const Body = ({
  run,
  inspected,
  titles,
  objects,
}: {
  readonly run: RunId
  readonly inspected: Inspected
  readonly titles: ReadonlyMap<StageId, string>
  readonly objects: RunSnapshot['objects'] | null
}): ReactElement => {
  const { stage, attention, criteria, inputs, outputs, history, evidence } = inspected
  const rejected = inspected.observer_calls.filter(({ outcome }) => outcome === 'rejected')
  return (
    <Groundwork value={{ objects, known: new Map(evidence.map((fact) => [fact.id, fact])) }}>
      <Axes stage={stage} />
      <Warnings stage={stage} attention={attention} />
      <Purpose stage={stage} />
      {attention.length === 0 ? null : (
        <Section title="Внимание" count={attention.filter(({ resolution }) => resolution === 'open').length}>
          <AttentionList items={attention} />
        </Section>
      )}
      <Section title="Критерии" count={criteria.length}>
        <StageCriteria criteria={criteria} />
      </Section>
      <Section title="Входы и выходы" count={inputs.length + outputs.length}>
        <StageArtifacts inputs={inputs} outputs={outputs} actions={objects?.actions ?? inspected.actions} />
      </Section>
      <Section title="Время и расход">
        <TimeAndUsage inspected={inspected} />
      </Section>
      <Section title="Участники и действия">
        <Participants agents={inspected.agents} actions={inspected.actions} />
      </Section>
      <Section title="Связи">
        <Relations run={run} inspected={inspected} titles={titles} />
      </Section>
      <Section title="Основания" count={evidence.length}>
        <Statements stage={stage} />
      </Section>
      <Section title="История" count={history.length}>
        <StageHistory history={history} />
      </Section>
      {rejected.length === 0 ? null : (
        <Section title="Отклонённые ответы наблюдателя" count={rejected.length}>
          <RejectedCalls calls={rejected} />
        </Section>
      )}
    </Groundwork>
  )
}

export const StageInspector = ({ run, stage, feed, onSignedOut, onClose }: StageInspectorProps): ReactElement => {
  const { snapshot, generation } = feed
  const load = useStage(run, stage, { generation, seq: snapshot?.change_seq ?? null }, onSignedOut)
  const heading = useRef<HTMLHeadingElement>(null)
  const titleId = useId()
  const stages = snapshot?.model.stages ?? []
  const titles = new Map(stages.map(({ id, title }) => [id, title]))
  const known = load.kind === 'ready' ? load.inspector.stage : (stages.find(({ id }) => id === stage) ?? null)

  useEffect(() => {
    heading.current?.focus()
  }, [])

  return (
    <aside
      className="inspector"
      aria-labelledby={titleId}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          onClose()
        }
      }}
    >
      <header className="inspector-head">
        <div className="inspector-heading">
          <p className="inspector-kind">
            <span>Этап</span>
            {known === null ? null : <span>{stageOriginLabel[known.origin]}</span>}
            {known === null || lifecycleNote(known) === null ? null : <span className="inspector-lifecycle">{lifecycleNote(known)}</span>}
          </p>
          <h2 id={titleId} ref={heading} tabIndex={-1} className="inspector-title">
            {known?.title ?? `Этап ${shortId(stage)}`}
          </h2>
        </div>
        <button type="button" className="inspector-close" onClick={onClose}>
          Закрыть
        </button>
      </header>
      {load.kind === 'ready' && load.failing ? (
        <p className="inspector-trouble" role="status">
          Связь с демоном прервалась: показано последнее полученное состояние, обновление повторяется.
        </p>
      ) : null}
      {load.kind === 'ready' ? (
        <Body run={run} inspected={load.inspector} titles={titles} objects={snapshot?.objects ?? null} />
      ) : load.kind === 'missing' ? (
        <p className="inspector-trouble">
          В этом прогоне нет этапа <code>{shortId(stage)}</code>: ссылка устарела или прогон собран заново.
        </p>
      ) : load.kind === 'failing' ? (
        <p className="inspector-trouble" role="status">
          Не удалось загрузить этап, повтор через секунду.
        </p>
      ) : (
        <p className="loading">Загрузка этапа…</p>
      )}
    </aside>
  )
}
