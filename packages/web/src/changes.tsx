import type {
  AgentActivity,
  ArtifactRef,
  ArtifactVersion,
  AttentionItem,
  Card,
  ChangesResponse,
  CriterionStatus,
  CriterionTransition,
  Execution,
  ModelChange,
  ObservationObjects,
  RunId,
  RunSnapshot,
  Stage,
  StageId,
  StageLifecycle,
  StageTransition,
  ViewMark,
} from '@aang/contract'
import { type ReactElement, type ReactNode, useId } from 'react'
import { DecisionBadge, ExecutionBadge } from './badges.js'
import { plural } from './format.js'
import { AttentionGlyph, type ChangeKind, ChangeGlyph, CriterionGlyph } from './glyphs.js'
import { type Grounding, Grounds, JournalGrounds, journalKey, Original } from './change-grounds.js'
import {
  actionForms,
  attentionAuthorLabel,
  attentionKindLabel,
  criterionStatusLabel,
  resolutionLabel,
  retentionLabel,
} from './labels.js'
import { LongText } from './long-text.js'
import { Moment } from './moment.js'
import { agentTitle, attentionPlace, placeOf } from './objects.js'
import { isPlan, newestFirst, PlanUpdate } from './plan-facts.js'

interface Context {
  readonly run: RunId
  readonly objects: ObservationObjects
  readonly stages: ReadonlyMap<StageId, Stage>
  readonly now: bigint
  readonly onSignedOut: () => void
}

const observed = { kind: 'observed' } as const

const sameExecution = (left: Execution, right: Execution): boolean => JSON.stringify(left) === JSON.stringify(right)

type Revised = Exclude<StageLifecycle, { readonly state: 'active' }>

const revisionOf = ({ before, after }: StageTransition): Revised | null =>
  after.lifecycle.state !== 'active' && before?.lifecycle.state !== after.lifecycle.state ? after.lifecycle : null

const revisions: ReadonlySet<ModelChange['op']> = new Set(['stage.replace', 'stage.merge', 'stage.split'])

const anyChange = (): boolean => true

export const changeCount = (changes: ChangesResponse): number =>
  changes.stages.length +
  changes.criteria.length +
  changes.cards.length +
  changes.artifact_versions.length +
  changes.attention.opened.length +
  changes.attention.closed.length +
  changes.plan_facts.filter(isPlan).length +
  changes.activity.length

const Mark = ({ change, label }: { readonly change: ChangeKind; readonly label: string }): ReactElement => (
  <span className="change-mark">
    <ChangeGlyph change={change} />
    {label}
  </span>
)

const Section = ({ title, children }: { readonly title: string; readonly children: ReactNode }): ReactElement => {
  const heading = useId()
  return (
    <section className="since-section" aria-labelledby={heading}>
      <h3 id={heading} className="since-section-title">
        {title}
      </h3>
      {children}
    </section>
  )
}

const stageName = (context: Context, id: StageId): string => {
  const stage = context.stages.get(id)
  return stage === undefined ? 'этап без названия' : `«${stage.title}»`
}

const AttentionChange = ({
  item,
  change,
  context,
}: {
  readonly item: AttentionItem
  readonly change: 'new' | 'closed'
  readonly context: Context
}): ReactElement => {
  const place = attentionPlace(context.objects, item)
  return (
    <li className="change-item" data-change={change}>
      <Mark change={change} label={change === 'new' ? 'открыт' : 'закрыт'} />
      <div className="change-body">
        <p className="change-title">
          <span className="change-kind">
            <AttentionGlyph kind={item.kind} />
            {attentionKindLabel[item.kind]}
          </span>
          {change === 'closed' ? <span className="change-note">{resolutionLabel[item.resolution]}</span> : null}
        </p>
        <div className="change-quote">
          <LongText text={item.text} className="change-quote-text" />
        </div>
        <p className="change-meta">
          {place === null ? null : <span>{place}</span>}
          <span>{attentionAuthorLabel[item.author]}</span>
          <span>
            открыт <Moment at={item.opened_at} now={context.now} />
          </span>
          {item.closed_at === null ? null : (
            <span>
              закрыт <Moment at={item.closed_at} now={context.now} />
            </span>
          )}
        </p>
        <Grounds
          grounds={[item]}
          journal={[]}
          objects={context.objects}
          now={context.now}
          onSignedOut={context.onSignedOut}
        />
      </div>
    </li>
  )
}

interface Revision {
  readonly change: ChangeKind
  readonly label: string
  readonly by: string
}

const lifecycleChange = (lifecycle: Revised): Revision => {
  switch (lifecycle.state) {
    case 'replaced':
      return {
        change: 'replaced',
        label: 'заменён',
        by: lifecycle.by.length === 1 ? 'заменён этапом' : 'заменён этапами',
      }
    case 'merged':
      return { change: 'merged', label: 'объединён', by: 'объединён в этап' }
    case 'split':
      return { change: 'split', label: 'разделён', by: 'разделён на этапы' }
  }
}

const successors = (lifecycle: Revised): readonly StageId[] => {
  switch (lifecycle.state) {
    case 'replaced':
      return lifecycle.by
    case 'merged':
      return [lifecycle.into]
    case 'split':
      return lifecycle.into
  }
}

const RevisedStage = ({
  transition,
  lifecycle,
  context,
}: {
  readonly transition: StageTransition
  readonly lifecycle: Revised
  readonly context: Context
}): ReactElement => {
  const { after } = transition
  const { change, label, by } = lifecycleChange(lifecycle)
  return (
    <li className="change-item" data-change={change}>
      <Mark change={change} label={label} />
      <div className="change-body">
        <p className="change-title">Этап «{after.title}»</p>
        <p className="change-line">
          {by} {successors(lifecycle).map((id) => stageName(context, id)).join(', ')}
        </p>
        <JournalGrounds
          key={journalKey(transition.changes)}
          run={context.run}
          stage={after.id}
          journal={transition.changes}
          select={({ op, target }) => revisions.has(op) && target.kind === 'stage' && target.id === after.id}
          objects={context.objects}
          now={context.now}
          onSignedOut={context.onSignedOut}
        />
      </div>
    </li>
  )
}

const criterionTone: Readonly<Record<CriterionStatus, string>> = {
  not_checked: 'idle',
  confirmed: 'done',
  passed_unversioned: 'hold',
  partial: 'hold',
  failed: 'fail',
  stale: 'ask',
  reported_done: 'idle',
}

const CriterionBadge = ({ status }: { readonly status: CriterionStatus }): ReactElement => (
  <span className="badge" data-tone={criterionTone[status]}>
    <CriterionGlyph status={status} />
    {criterionStatusLabel[status]}
  </span>
)

const Transition = ({ before, after }: { readonly before: ReactNode; readonly after: ReactNode }): ReactElement => (
  <span className="transition">
    {before === null ? null : (
      <>
        <span className="was">
          <span className="visually-hidden">было: </span>
          {before}
        </span>
        <ChangeGlyph change="changed" />
        <span className="visually-hidden">стало: </span>
      </>
    )}
    {after}
  </span>
)

const CriterionChange = ({
  transition,
  context,
}: {
  readonly transition: CriterionTransition
  readonly context: Context
}): ReactElement => {
  const { before, after } = transition
  const fresh = before === null
  return (
    <li className="change-item" data-change={fresh ? 'new' : 'changed'}>
      <Mark change={fresh ? 'new' : 'changed'} label={fresh ? 'новый' : 'изменён'} />
      <div className="change-body">
        <p className="change-title">Критерий «{after.text}»</p>
        <p className="change-line">
          <Transition
            before={
              before === null || before.status.value === after.status.value ? null : (
                <CriterionBadge status={before.status.value} />
              )
            }
            after={<CriterionBadge status={after.status.value} />}
          />
        </p>
        <Grounds
          grounds={[after.status]}
          journal={transition.changes}
          objects={context.objects}
          now={context.now}
          onSignedOut={context.onSignedOut}
        />
      </div>
    </li>
  )
}

const StageGrounds = ({
  transition,
  grounds,
  context,
}: {
  readonly transition: StageTransition
  readonly grounds: readonly Grounding[]
  readonly context: Context
}): ReactElement =>
  grounds.length === 0 ? (
    <JournalGrounds
      key={journalKey(transition.changes)}
      run={context.run}
      stage={transition.after.id}
      journal={transition.changes}
      select={anyChange}
      objects={context.objects}
      now={context.now}
      onSignedOut={context.onSignedOut}
    />
  ) : (
    <Grounds
      grounds={grounds}
      journal={transition.changes}
      objects={context.objects}
      now={context.now}
      onSignedOut={context.onSignedOut}
    />
  )

const StageChange = ({
  transition,
  context,
}: {
  readonly transition: StageTransition
  readonly context: Context
}): ReactElement => {
  const { before, after } = transition
  const fresh = before === null
  const renamed = before !== null && before.title !== after.title
  const described =
    fresh || renamed || before.summary !== after.summary || before.expected_result !== after.expected_result
  const moved = before !== null && !sameExecution(before.execution.value, after.execution.value)
  const decided = after.decision.value !== 'none' && before?.decision.value !== after.decision.value
  const detail = after.summary ?? after.expected_result
  const grounds = [
    ...(described ? [after] : []),
    ...(fresh || moved ? [after.execution] : []),
    ...(decided ? [after.decision] : []),
  ]
  return (
    <li className="change-item" data-change={fresh ? 'new' : 'changed'}>
      <Mark change={fresh ? 'new' : 'changed'} label={fresh ? 'новый' : 'изменён'} />
      <div className="change-body">
        <p className="change-title">
          {renamed ? (
            <Transition before={<span>«{before.title}»</span>} after={<span>«{after.title}»</span>} />
          ) : (
            <span>«{after.title}»</span>
          )}
        </p>
        <p className="change-line">
          <Transition
            before={moved ? <ExecutionBadge execution={before.execution.value} /> : null}
            after={<ExecutionBadge execution={after.execution.value} />}
          />
          {decided ? <DecisionBadge decision={after.decision.value} basis={after.decision.basis} /> : null}
        </p>
        {detail === null ? null : <p className="change-text">{detail}</p>}
        <StageGrounds transition={transition} grounds={grounds} context={context} />
      </div>
    </li>
  )
}

const CardChange = ({ card, context }: { readonly card: Card; readonly context: Context }): ReactElement => (
  <li className="change-item" data-change="new">
    <Mark change="new" label="новая" />
    <div className="change-body">
      <div className="change-quote">
        <LongText text={card.text} className="change-quote-text" />
      </div>
      {card.stages.length === 0 ? null : (
        <p className="change-meta">
          <span>
            {card.stages.length === 1 ? 'этап' : 'этапы'} {card.stages.map((id) => stageName(context, id)).join(', ')}
          </span>
        </p>
      )}
      <Grounds
        grounds={[card]}
        journal={[]}
        objects={context.objects}
        now={context.now}
        onSignedOut={context.onSignedOut}
      />
      <Original source={card.source} objects={context.objects} now={context.now} onSignedOut={context.onSignedOut} />
    </div>
  </li>
)

const artifactName = (ref: ArtifactRef): string => {
  switch (ref.kind) {
    case 'file':
      return ref.path
    case 'url':
    case 'pull_request':
      return ref.url
    case 'commit':
      return `${ref.repository} ${ref.sha.slice(0, 12)}`
  }
}

const ArtifactChange = ({
  version,
  context,
}: {
  readonly version: ArtifactVersion
  readonly context: Context
}): ReactElement => {
  const action = context.objects.actions.find(({ id }) => id === version.produced_by)
  const place = action === undefined ? null : placeOf(context.objects, action.session, action.agent)
  const evidence = action === undefined ? [] : [action.input_fact, action.output_fact].filter((fact) => fact !== null)
  return (
    <li className="change-item" data-change="new">
      <Mark change="new" label="новая версия" />
      <div className="change-body">
        <p className="change-title">
          <code className="change-artifact">{artifactName(version.ref)}</code>
        </p>
        <p className="change-meta">
          {action === undefined ? null : <span>записал {action.tool}</span>}
          {place === null ? null : <span>{place}</span>}
          <Moment at={version.observed_at} now={context.now} />
          <span>{retentionLabel[version.retention.kind]}</span>
        </p>
        <Grounds
          grounds={[{ basis: observed, evidence }]}
          journal={[]}
          objects={context.objects}
          now={context.now}
          onSignedOut={context.onSignedOut}
        />
      </div>
    </li>
  )
}

const toolCounts = (activity: AgentActivity): string =>
  activity.tools.map(({ tool, count }) => `${tool} ${String(count)}`).join(', ')

const Activity = ({
  activity,
  objects,
}: {
  readonly activity: AgentActivity
  readonly objects: ObservationObjects
}): ReactElement => {
  const agent = objects.agents.find(({ id }) => id === activity.agent)
  const place = agent === undefined ? null : placeOf(objects, agent.session, null)
  return (
    <li className="activity">
      <span className="activity-agent">{agent === undefined ? 'Без известного агента' : agentTitle(agent)}</span>
      {place === null ? null : <span className="activity-place">{place}</span>}
      <span className="activity-count">{plural(activity.actions, actionForms)}</span>
      <span className="activity-tools">{toolCounts(activity)}</span>
    </li>
  )
}

const ChangeList = ({
  changes,
  context,
}: {
  readonly changes: ChangesResponse
  readonly context: Context
}): ReactElement => {
  const { opened, closed } = changes.attention
  const decisions = changes.stages.flatMap((transition) => {
    const lifecycle = revisionOf(transition)
    return lifecycle === null ? [] : [{ transition, lifecycle }]
  })
  const stages = changes.stages.filter((transition) => revisionOf(transition) === null)
  const plans = changes.plan_facts.filter(isPlan).toSorted(newestFirst)
  return (
    <>
      {opened.length + closed.length === 0 ? null : (
        <Section title="Вопросы и запросы">
          <ol className="changes">
            {opened.map((item) => (
              <AttentionChange key={item.id} item={item} change="new" context={context} />
            ))}
            {closed.map((item) => (
              <AttentionChange key={item.id} item={item} change="closed" context={context} />
            ))}
          </ol>
        </Section>
      )}
      {decisions.length + changes.criteria.length === 0 ? null : (
        <Section title="Пересмотренные решения">
          <ol className="changes">
            {decisions.map(({ transition, lifecycle }) => (
              <RevisedStage
                key={transition.after.id}
                transition={transition}
                lifecycle={lifecycle}
                context={context}
              />
            ))}
            {changes.criteria.map((transition) => (
              <CriterionChange key={transition.after.id} transition={transition} context={context} />
            ))}
          </ol>
        </Section>
      )}
      {stages.length === 0 ? null : (
        <Section title="Этапы">
          <ol className="changes">
            {stages.map((transition) => (
              <StageChange key={transition.after.id} transition={transition} context={context} />
            ))}
          </ol>
        </Section>
      )}
      {changes.cards.length === 0 ? null : (
        <Section title="Итоги решателя">
          <ol className="changes">
            {changes.cards.map((card) => (
              <CardChange key={card.id} card={card} context={context} />
            ))}
          </ol>
        </Section>
      )}
      {changes.artifact_versions.length === 0 ? null : (
        <Section title="Результаты">
          <ol className="changes">
            {changes.artifact_versions.map((version) => (
              <ArtifactChange key={version.id} version={version} context={context} />
            ))}
          </ol>
        </Section>
      )}
      {plans.length === 0 ? null : (
        <Section title="План решателя">
          <ol className="plan-updates">
            {plans.map((fact) => (
              <PlanUpdate key={fact.id} fact={fact} objects={context.objects} now={context.now} />
            ))}
          </ol>
        </Section>
      )}
      {changes.activity.length === 0 ? null : (
        <Section title="Действия агентов">
          <ul className="activities">
            {changes.activity.map((activity) => (
              <Activity key={activity.agent ?? 'none'} activity={activity} objects={context.objects} />
            ))}
          </ul>
        </Section>
      )}
    </>
  )
}

const stagesOf = (snapshot: RunSnapshot, changes: ChangesResponse | null): Map<StageId, Stage> =>
  new Map([
    ...snapshot.model.stages.map((stage) => [stage.id, stage] as const),
    ...(changes?.stages ?? []).map(({ after }) => [after.id, after] as const),
  ])

export interface ChangesViewProps {
  readonly snapshot: RunSnapshot
  readonly mark: ViewMark | null
  readonly changes: ChangesResponse | null
  readonly failing: boolean
  readonly now: bigint
  readonly onSignedOut: () => void
}

const Body = ({ snapshot, mark, changes, failing, now, onSignedOut }: ChangesViewProps): ReactElement => {
  if (mark === null) {
    return (
      <div className="since-empty">
        <p>
          Прогон ещё не отмечен просмотренным. Отметьте его, когда разберёте текущее состояние: при возвращении здесь
          будет видно, что изменилось после отметки.
        </p>
        <p className="since-hint">
          Отметка нужна только вам: она не одобряет результат и ничего не отправляет решателю.
        </p>
      </div>
    )
  }
  if (changes === null) {
    return failing ? (
      <p className="since-trouble" role="alert">
        Изменения не получены: демон не ответил. Повтор через 2 с.
      </p>
    ) : (
      <p className="loading">Загрузка изменений…</p>
    )
  }
  if (changeCount(changes) === 0) {
    return (
      <p className="since-empty">
        С отметки ничего не изменилось. Новые результаты, вопросы и пересмотренные решения появятся здесь.
      </p>
    )
  }
  const context: Context = {
    run: snapshot.run.id,
    objects: snapshot.objects,
    stages: stagesOf(snapshot, changes),
    now,
    onSignedOut,
  }
  return <ChangeList changes={changes} context={context} />
}

export const ChangesView = (props: ChangesViewProps): ReactElement => {
  const heading = useId()
  const { mark, changes, failing, now } = props
  return (
    <section className="since" aria-labelledby={heading}>
      <h2 id={heading} className="visually-hidden">
        С последнего просмотра
      </h2>
      {mark === null ? null : (
        <p className="since-span">
          Изменения после отметки <Moment at={mark.marked_at} now={now} />: версия карты {mark.version}
          {changes === null || changes.to.version === mark.version ? null : ` → ${String(changes.to.version)}`}
        </p>
      )}
      {failing && changes !== null ? (
        <p className="since-trouble" role="alert">
          Изменения не обновляются: демон не ответил. Повтор через 2 с.
        </p>
      ) : null}
      <Body {...props} />
    </section>
  )
}
