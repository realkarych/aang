import type {
  Action,
  Agent,
  AgentId,
  AttentionItem,
  EpochNs,
  FactId,
  ObservationObjects,
  Question,
  QuestionId,
  RunSnapshot,
  Session,
} from '@aang/contract'
import { Fragment, type ReactElement, Suspense, use, useId, useState } from 'react'
import { actionInput } from './action-input.js'
import { ActionBadge, DecisionBadge, ExecutionBadge, FreshnessBadge } from './badges.js'
import { absoluteTime, clockTime, dayTime, duration, plural } from './format.js'
import {
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

const stepsBySession = (objects: ObservationObjects, session: Session): Map<AgentId | null, Step[]> => {
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
    if (action.session === session.id) {
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
  const input = use(actionInput(fact, now))
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

const ActionStep = ({ action, now }: { readonly action: Action; readonly now: bigint }): ReactElement => {
  const step: Step = { kind: 'action', action }
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

interface StepsProps {
  readonly steps: readonly Step[]
  readonly label: string
  readonly asked: ReadonlyMap<QuestionId, string>
  readonly now: bigint
}

const Steps = ({ steps, label, asked, now }: StepsProps): ReactElement | null => {
  const [expanded, setExpanded] = useState(false)
  if (steps.length === 0) {
    return null
  }
  const cut = steps.length - recentSteps
  const shown = expanded ? steps : steps.filter((step, index) => index >= cut || isActive(step))
  const hidden = steps.length - shown.length
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
      {shown.map((step) =>
        step.kind === 'action' ? (
          <ActionStep key={step.action.id} action={step.action} now={now} />
        ) : (
          <QuestionStep
            key={step.question.id}
            question={step.question}
            text={step.question.text ?? asked.get(step.question.id) ?? null}
            now={now}
          />
        ),
      )}
    </ol>
  )
}

const AgentNode = ({
  tree,
  asked,
  now,
}: {
  readonly tree: AgentTree
  readonly asked: ReadonlyMap<QuestionId, string>
  readonly now: bigint
}): ReactElement => {
  const { agent } = tree
  const title = agentTitle(agent)
  const name = useId()
  return (
    <li className="agent" data-role={agent.role} aria-labelledby={name}>
      <div className="agent-head">
        <span id={name} className="agent-name">
          {title}
        </span>
        {agent.role === 'main' ? null : <span className="agent-role">{agentRole(agent)}</span>}
        <ExecutionBadge execution={agent.execution} />
      </div>
      {agent.description === null ? null : <p className="agent-description">{agent.description}</p>}
      <Steps steps={tree.steps} label={title} asked={asked} now={now} />
      {tree.children.length === 0 ? null : (
        <ul className="agents" aria-label={`Агенты, запущенные: ${title}`}>
          {tree.children.map((child) => (
            <AgentNode key={child.agent.id} tree={child} asked={asked} now={now} />
          ))}
        </ul>
      )}
    </li>
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

const SessionBlock = ({
  session,
  objects,
  asked,
  now,
}: {
  readonly session: Session
  readonly objects: ObservationObjects
  readonly asked: ReadonlyMap<QuestionId, string>
  readonly now: bigint
}): ReactElement => {
  const heading = useId()
  const steps = stepsBySession(objects, session)
  const loose = (steps.get(null) ?? []).toSorted(chronological)
  const title = sessionTitle(session)
  return (
    <li className="session" aria-labelledby={heading}>
      <SessionHead session={session} heading={heading} now={now} />
      <ul className="agents" aria-label={`Агенты: ${title}`}>
        {agentTrees(objects, session, steps).map((tree) => (
          <AgentNode key={tree.agent.id} tree={tree} asked={asked} now={now} />
        ))}
      </ul>
      {loose.length === 0 ? null : (
        <div className="loose">
          <p className="agent-name">Шаги без известного агента</p>
          <Steps steps={loose} label={`${title} без агента`} asked={asked} now={now} />
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
  const asked = askedTexts(snapshot.attention.items)
  return (
    <section className="trace" aria-labelledby={heading}>
      <h2 id={heading} className="section-title">
        Сессии и агенты
      </h2>
      <ol className="sessions">
        {objects.sessions.map((session) => (
          <SessionBlock key={session.id} session={session} objects={objects} asked={asked} now={now} />
        ))}
      </ol>
    </section>
  )
}
