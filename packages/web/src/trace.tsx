import type {
  Action,
  ActionId,
  Agent,
  AgentId,
  AttentionItem,
  DetailLevel,
  EpochNs,
  FactId,
  ObservationObjects,
  Question,
  QuestionId,
  RunSnapshot,
  Session,
} from '@aang/contract'
import { Fragment, type ReactElement, Suspense, use, useId, useMemo, useState } from 'react'
import { actionInput } from './action-input.js'
import { ActionBadge, DecisionBadge, ExecutionBadge, FreshnessBadge } from './badges.js'
import { absoluteTime, clockTime, dayTime, duration, plural } from './format.js'
import { useGeneration } from './generation.js'
import {
  actionForms,
  agentForms,
  launchLabel,
  questionKindLabel,
  runtimeLabel,
  stepForms,
  supportModeLabel,
  surfaceLabel,
} from './labels.js'
import { LongText } from './long-text.js'
import { Moment } from './moment.js'
import { agentRole, agentTitle, sessionTitle, shortSession } from './objects.js'
import { attentionForms, detailLevelLabel, totalsText } from './view-labels.js'
import { concealedActions, grouped, type Grouped, isHidden, type PlacementOf, placementsOf } from './view-placement.js'

type Step =
  | { readonly kind: 'action'; readonly action: Action }
  | { readonly kind: 'question'; readonly question: Question }

interface AgentTree {
  readonly agent: Agent
  readonly steps: readonly Step[]
  readonly children: readonly AgentTree[]
}

const recentSteps = 6

const compareIds = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)

const compareMoments = (left: EpochNs | null, right: EpochNs | null): number => {
  if (left === right) {
    return 0
  }
  if (left === null || right === null) {
    return left === null ? -1 : 1
  }
  return left < right ? -1 : 1
}

const stepAt = (step: Step): EpochNs | null =>
  step.kind === 'action' ? (step.action.started_at ?? step.action.ended_at) : step.question.asked_at

const stepId = (step: Step): string => (step.kind === 'action' ? step.action.id : step.question.id)

const chronological = (left: Step, right: Step): number =>
  compareMoments(stepAt(left), stepAt(right)) || compareIds(stepId(left), stepId(right))

const isActive = (step: Step): boolean =>
  step.kind === 'action'
    ? step.action.execution.state === 'running' || step.action.execution.state === 'waiting'
    : step.question.decision.value === 'requested'

const agentOrder = (left: Agent, right: Agent): number =>
  Number(right.role === 'main') - Number(left.role === 'main') ||
  compareMoments(left.started_at, right.started_at) ||
  compareIds(left.id, right.id)

const stepsBySession = (
  objects: ObservationObjects,
  session: Session,
  concealed: ReadonlySet<ActionId>,
): Map<AgentId | null, Step[]> => {
  const agents = new Set(objects.agents.filter((agent) => agent.session === session.id).map(({ id }) => id))
  const steps = new Map<AgentId | null, Step[]>()
  const add = (agent: AgentId | null, step: Step): void => {
    const owner = agent !== null && agents.has(agent) ? agent : null
    const own = steps.get(owner)
    if (own === undefined) {
      steps.set(owner, [step])
    } else {
      own.push(step)
    }
  }
  for (const action of objects.actions) {
    if (action.session === session.id && !concealed.has(action.id)) {
      add(action.agent, { kind: 'action', action })
    }
  }
  for (const question of objects.questions) {
    if (question.session === session.id) {
      add(question.agent, { kind: 'question', question })
    }
  }
  return steps
}

const agentTrees = (
  objects: ObservationObjects,
  session: Session,
  steps: ReadonlyMap<AgentId | null, Step[]>,
): AgentTree[] => {
  const agents = objects.agents.filter((agent) => agent.session === session.id).toSorted(agentOrder)
  const known = new Set(agents.map(({ id }) => id))
  const grow = (agent: Agent): AgentTree => ({
    agent,
    steps: (steps.get(agent.id) ?? []).toSorted(chronological),
    children: agents.filter(({ parent }) => parent === agent.id).map(grow),
  })
  return agents.filter(({ parent }) => parent === null || !known.has(parent)).map(grow)
}

const InputText = ({ fact, now }: { readonly fact: FactId; readonly now: bigint }): ReactElement | null => {
  const { inputs } = useGeneration()
  const input = use(actionInput(inputs, fact, now))
  if (input === null || (input.detail === null && input.description === null)) {
    return null
  }
  return (
    <>
      {input.detail === null ? null : (
        <code className="step-detail" title={input.detail}>
          {input.detail}
        </code>
      )}
      {input.description === null ? null : <span className="step-description">{input.description}</span>}
    </>
  )
}

const StepTime = ({
  at,
  active,
  now,
}: {
  readonly at: EpochNs | null
  readonly active: boolean
  readonly now: bigint
}): ReactElement =>
  at === null ? (
    <span className="step-time" />
  ) : (
    <time className="step-time" dateTime={new Date(Number(at / 1_000_000n)).toISOString()} title={absoluteTime(at)}>
      {active ? duration(at, now) : clockTime(at)}
    </time>
  )

const ToolName = ({ tool }: { readonly tool: string }): ReactElement => (
  <>
    {tool.split('/').map((part, index) => (
      <Fragment key={index}>
        {index === 0 ? null : '/'}
        {index === 0 ? null : <wbr />}
        {part}
      </Fragment>
    ))}
  </>
)

const ActionStep = ({
  action,
  placement,
  now,
}: {
  readonly action: Action
  readonly placement: PlacementOf
  readonly now: bigint
}): ReactElement => {
  const step: Step = { kind: 'action', action }
  const placed = placement({ kind: 'action', id: action.id })
  const visibility = placed?.visibility ?? null
  const folded = visibility?.state === 'collapsed' ? visibility.totals : null
  const detail = placed?.detail ?? null
  const inside = placed?.attention.length ?? 0
  return (
    <li className="step">
      <span className="step-state">
        <ActionBadge action={action} />
      </span>
      <span className="step-tool" title={action.tool}>
        <ToolName tool={action.tool} />
      </span>
      <span className="step-body">
        {action.input_fact === null ? null : (
          <Suspense fallback={null}>
            <InputText fact={action.input_fact} now={now} />
          </Suspense>
        )}
        {action.inherited ? <span className="step-note">унаследовано из исходной сессии</span> : null}
        {folded === null ? null : (
          <span className="step-note">{`свёрнуто правилом вида: ${totalsText(folded)}`}</span>
        )}
        {detail === null ? null : (
          <span className="step-note">{`детализация: ${detailLevelLabel[detail.level]}`}</span>
        )}
        {inside === 0 ? null : (
          <span className="step-note">{`${plural(inside, attentionForms)} внутри — в зоне внимания`}</span>
        )}
      </span>
      <StepTime at={stepAt(step)} active={isActive(step)} now={now} />
    </li>
  )
}

const QuestionStep = ({
  question,
  text,
  now,
}: {
  readonly question: Question
  readonly text: string | null
  readonly now: bigint
}): ReactElement => (
  <li className="step" data-kind="question">
    <span className="step-state">
      <DecisionBadge decision={question.decision.value} basis={question.decision.basis} />
    </span>
    <span className="step-tool">{questionKindLabel[question.kind]}</span>
    <span className="step-body">{text === null ? null : <LongText text={text} className="step-question" />}</span>
    <StepTime at={question.asked_at} active={isActive({ kind: 'question', question })} now={now} />
  </li>
)

interface TraceContext {
  readonly asked: ReadonlyMap<QuestionId, string>
  readonly placement: PlacementOf
  readonly now: bigint
}

const StepItem = ({ step, context }: { readonly step: Step; readonly context: TraceContext }): ReactElement =>
  step.kind === 'action' ? (
    <ActionStep action={step.action} placement={context.placement} now={context.now} />
  ) : (
    <QuestionStep
      question={step.question}
      text={step.question.text ?? context.asked.get(step.question.id) ?? null}
      now={context.now}
    />
  )

const stepGroup = (placement: PlacementOf, step: Step): string | null =>
  step.kind === 'action' ? (placement({ kind: 'action', id: step.action.id })?.group?.name ?? null) : null

const entryActive = (entry: Grouped<Step>): boolean =>
  entry.kind === 'one' ? isActive(entry.item) : entry.items.some(isActive)

const groupStepForms = { one: 'шаг', few: 'шага', many: 'шагов' } as const

interface StepsProps {
  readonly steps: readonly Step[]
  readonly label: string
  readonly context: TraceContext
}

const Steps = ({ steps, label, context }: StepsProps): ReactElement | null => {
  const [expanded, setExpanded] = useState(false)
  if (steps.length === 0) {
    return null
  }
  const entries = grouped(steps, (step) => stepGroup(context.placement, step))
  const cut = entries.length - recentSteps
  const shown = expanded ? entries : entries.filter((entry, index) => index >= cut || entryActive(entry))
  const hidden = entries.length - shown.length
  return (
    <ol className="steps" aria-label={`Шаги: ${label}`}>
      {hidden === 0 && !expanded ? null : (
        <li className="steps-toggle">
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setExpanded(!expanded)
            }}
          >
            {expanded ? 'Скрыть ранние шаги' : `Показать ${plural(hidden, stepForms)}`}
          </button>
        </li>
      )}
      {shown.map((entry) =>
        entry.kind === 'one' ? (
          <StepItem key={stepId(entry.item)} step={entry.item} context={context} />
        ) : (
          <li key={`group:${entry.name}`} className="step-group">
            <p className="group-name">{`Группа «${entry.name}» · ${plural(entry.items.length, groupStepForms)}`}</p>
            <ol className="steps" aria-label={`Шаги группы «${entry.name}»`}>
              {entry.items.map((step) => (
                <StepItem key={stepId(step)} step={step} context={context} />
              ))}
            </ol>
          </li>
        ),
      )}
    </ol>
  )
}

const AgentNode = ({
  tree,
  level,
  context,
}: {
  readonly tree: AgentTree
  readonly level: DetailLevel
  readonly context: TraceContext
}): ReactElement => {
  const { agent } = tree
  const title = agentTitle(agent)
  const name = useId()
  const placed = context.placement({ kind: 'agent', id: agent.id })
  const visibility = placed?.visibility ?? null
  const folded = visibility?.state === 'collapsed' ? visibility : null
  const detail = placed?.detail ?? null
  const depth = detail?.level ?? level
  const inside = placed?.attention.length ?? 0
  return (
    <li className="agent" data-role={agent.role} aria-labelledby={name}>
      <div className="agent-head">
        <span id={name} className="agent-name">
          {title}
        </span>
        {agent.role === 'main' ? null : <span className="agent-role">{agentRole(agent)}</span>}
        <ExecutionBadge execution={agent.execution} />
        {folded === null ? null : (
          <span className="agent-fold">{folded.rule === null ? 'свёрнут по умолчанию' : 'свёрнут правилом вида'}</span>
        )}
        {detail === null ? null : (
          <span className="agent-fold">{`детализация: ${detailLevelLabel[detail.level]}`}</span>
        )}
      </div>
      {agent.description === null ? null : <p className="agent-description">{agent.description}</p>}
      {folded === null ? (
        <>
          {depth === 'all_actions' ? <Steps steps={tree.steps} label={title} context={context} /> : null}
          {depth === 'stages' ? null : (
            <AgentList trees={tree.children} label={`Агенты, запущенные: ${title}`} level={depth} context={context} />
          )}
        </>
      ) : (
        <p className="agent-totals">{totalsText(folded.totals)}</p>
      )}
      {inside === 0 ? null : (
        <p className="agent-attention">{`${plural(inside, attentionForms)} внутри — в зоне внимания`}</p>
      )}
    </li>
  )
}

const AgentList = ({
  trees,
  label,
  level,
  context,
  always = false,
}: {
  readonly trees: readonly AgentTree[]
  readonly label: string
  readonly level: DetailLevel
  readonly context: TraceContext
  readonly always?: boolean
}): ReactElement | null => {
  const shown = trees.filter(({ agent }) => !isHidden(context.placement({ kind: 'agent', id: agent.id })))
  const entries = grouped(shown, ({ agent }) => context.placement({ kind: 'agent', id: agent.id })?.group?.name ?? null)
  return entries.length === 0 && !always ? null : (
    <ul className="agents" aria-label={label}>
      {entries.map((entry) =>
        entry.kind === 'one' ? (
          <AgentNode key={entry.item.agent.id} tree={entry.item} level={level} context={context} />
        ) : (
          <li key={`group:${entry.name}`} className="agent-group">
            <p className="group-name">{`Группа «${entry.name}» · ${plural(entry.items.length, agentForms)}`}</p>
            <ul className="agents" aria-label={`Агенты группы «${entry.name}»`}>
              {entry.items.map((tree) => (
                <AgentNode key={tree.agent.id} tree={tree} level={level} context={context} />
              ))}
            </ul>
          </li>
        ),
      )}
    </ul>
  )
}

const surfaceOf = (session: Session): string => {
  const { surface, version } = session
  const name =
    surface === null
      ? runtimeLabel[session.key.runtime]
      : `${surfaceLabel[surface.surface]}${surface.basis === 'assumed' ? ' (предположительно)' : ''}`
  return version === null ? name : `${name} ${version}`
}

const SessionHead = ({
  session,
  heading,
  now,
}: {
  readonly session: Session
  readonly heading: string
  readonly now: bigint
}): ReactElement => (
  <header className="session-head">
    <h3 id={heading} className="session-title">
      Сессия <code>{shortSession(session)}</code>
    </h3>
    <ul className="session-state" aria-label="Состояние сессии">
      <li>
        <ExecutionBadge execution={session.execution} />
      </li>
      <li>
        <FreshnessBadge freshness={session.freshness} />
      </li>
      <li className="session-mode">режим {supportModeLabel[session.support_mode]}</li>
    </ul>
    <p className="session-origin">
      <span>{surfaceOf(session)}</span>
      {session.cwd === null ? null : <code className="session-cwd">{session.cwd}</code>}
      {session.git_branch === null ? null : <span>ветка {session.git_branch}</span>}
      <span>
        последнее событие <Moment at={session.last_event_at} now={now} />
      </span>
    </p>
    {session.launches.length === 0 ? null : (
      <p className="session-launches">
        {[...new Set(session.launches.map(({ launch, at }) => `${launchLabel[launch]} ${dayTime(at)}`))].join(', ')}
      </p>
    )}
  </header>
)

const hiddenText = (objects: ObservationObjects, session: Session, placement: PlacementOf): string | null => {
  const agents = objects.agents.filter(
    ({ id, session: owner }) => owner === session.id && isHidden(placement({ kind: 'agent', id })),
  ).length
  const actions = objects.actions.filter(
    ({ id, session: owner }) => owner === session.id && isHidden(placement({ kind: 'action', id })),
  ).length
  const parts = [
    ...(agents === 0 ? [] : [plural(agents, agentForms)]),
    ...(actions === 0 ? [] : [plural(actions, actionForms)]),
  ]
  return parts.length === 0 ? null : `Скрыто правилами вида: ${parts.join(', ')}. Их вопросы остаются в зоне внимания.`
}

const SessionBlock = ({
  session,
  objects,
  concealed,
  context,
}: {
  readonly session: Session
  readonly objects: ObservationObjects
  readonly concealed: ReadonlySet<ActionId>
  readonly context: TraceContext
}): ReactElement => {
  const heading = useId()
  const steps = stepsBySession(objects, session, concealed)
  const loose = (steps.get(null) ?? []).toSorted(chronological)
  const title = sessionTitle(session)
  const hidden = hiddenText(objects, session, context.placement)
  return (
    <li className="session" aria-labelledby={heading}>
      <SessionHead session={session} heading={heading} now={context.now} />
      {hidden === null ? null : <p className="session-hidden">{hidden}</p>}
      <AgentList
        trees={agentTrees(objects, session, steps)}
        label={`Агенты: ${title}`}
        level="all_actions"
        context={context}
        always
      />
      {loose.length === 0 ? null : (
        <div className="loose">
          <p className="agent-name">Шаги без известного агента</p>
          <Steps steps={loose} label={`${title} без агента`} context={context} />
        </div>
      )}
    </li>
  )
}

const askedTexts = (items: readonly AttentionItem[]): Map<QuestionId, string> =>
  new Map(items.flatMap(({ question, text }) => (question === null ? [] : [[question, text] as const])))

export const Trace = ({ snapshot, now }: { readonly snapshot: RunSnapshot; readonly now: bigint }): ReactElement => {
  const heading = useId()
  const { objects } = snapshot
  const placement = useMemo(() => placementsOf(snapshot.view), [snapshot.view])
  const concealed = useMemo(() => concealedActions(objects.actions, placement), [objects.actions, placement])
  const context: TraceContext = { asked: askedTexts(snapshot.attention.items), placement, now }
  return (
    <section className="trace" aria-labelledby={heading}>
      <h2 id={heading} className="section-title">
        Сессии и агенты
      </h2>
      <ol className="sessions">
        {objects.sessions.map((session) => (
          <SessionBlock key={session.id} session={session} objects={objects} concealed={concealed} context={context} />
        ))}
      </ol>
    </section>
  )
}
