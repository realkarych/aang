import type { AgentId, FactOf, ObservationObjects, PlanItemStatus, PlanSource, RunSnapshot, SessionId } from '@aang/contract'
import { type ReactElement, useId, useState } from 'react'
import { plural } from './format.js'
import { PlanItemGlyph } from './glyphs.js'
import { planItemLabel, planSourceLabel } from './labels.js'
import { Moment } from './moment.js'
import { factOwner, factPlace, placeOf } from './objects.js'

type PlanFact = FactOf<'plan_update'>

export const isPlan = (fact: RunSnapshot['plan_facts'][number]): fact is PlanFact => fact.kind === 'plan_update'

export const newestFirst = (left: PlanFact, right: PlanFact): number =>
  left.at > right.at ? -1 : left.at < right.at ? 1 : right.seq - left.seq

const oldestFirst = (left: PlanFact, right: PlanFact): number => newestFirst(right, left)

const sameRecordForms = { one: 'одинаковая запись', few: 'одинаковые записи', many: 'одинаковых записей' } as const

type PlanFamily = 'tasks' | 'approval' | 'goal' | 'codex'

const familyOf: Readonly<Record<PlanSource, PlanFamily>> = {
  task_tool: 'tasks',
  task_hook: 'tasks',
  exit_plan_mode: 'approval',
  thread_goal: 'goal',
  rollout_plan: 'codex',
}

interface PlanTask {
  id: string | null
  text: string
  status: PlanItemStatus
  description: string | null
}

interface PlanBlock {
  readonly key: string
  readonly family: PlanFamily
  readonly session: SessionId | null
  readonly agent: AgentId | null
  readonly facts: readonly PlanFact[]
  readonly latest: PlanFact
}

const mainAgentOf = (objects: ObservationObjects, session: SessionId | null): AgentId | null =>
  objects.agents.find((agent) => agent.session === session && agent.role === 'main')?.id ?? null

const blocksOf = (facts: readonly PlanFact[], objects: ObservationObjects): PlanBlock[] => {
  const blocks = new Map<string, PlanBlock>()
  for (const fact of facts.toSorted(oldestFirst)) {
    const family = familyOf[fact.payload.source]
    const owner = factOwner(objects, fact.entity_key)
    const agent = owner.agent ?? mainAgentOf(objects, owner.session)
    const key = `${family}:${owner.session ?? ''}:${agent ?? ''}`
    const known = blocks.get(key)?.facts ?? []
    blocks.set(key, { key, family, session: owner.session, agent, facts: [...known, fact], latest: fact })
  }
  return [...blocks.values()].toSorted((left, right) => newestFirst(left.latest, right.latest))
}

const mergedTasks = (facts: readonly PlanFact[]): PlanTask[] => {
  const tasks: PlanTask[] = []
  const byId = new Map<string, PlanTask>()
  const byText = new Map<string, PlanTask>()
  const absorb = (kept: PlanTask, gone: PlanTask): void => {
    kept.description ??= gone.description
    tasks.splice(tasks.indexOf(gone), 1)
    for (const index of [byId, byText]) {
      for (const [key, known] of index) {
        if (known === gone) {
          index.set(key, kept)
        }
      }
    }
  }
  for (const fact of facts) {
    const { items, text: description } = fact.payload
    for (const item of items) {
      const withId = item.id === null ? undefined : byId.get(item.id)
      const withText = item.text === '' ? undefined : byText.get(item.text)
      if (withId !== undefined && withText !== undefined && withId !== withText) {
        absorb(withId, withText)
      }
      const known = withId ?? withText
      const task = known ?? { id: null, text: '', status: item.status, description: null }
      if (known === undefined) {
        tasks.push(task)
      }
      task.status = item.status
      if (item.id !== null) {
        task.id = item.id
        byId.set(item.id, task)
      }
      if (item.text !== '') {
        task.text = item.text
        byText.set(item.text, task)
      }
      if (items.length === 1 && description !== null) {
        task.description = description
      }
    }
  }
  return tasks
}

const blockLabel = ({ family, facts, latest }: PlanBlock): string =>
  family === 'tasks' && facts.some(({ payload }) => payload.source === 'task_tool')
    ? planSourceLabel.task_tool
    : planSourceLabel[latest.payload.source]

const taskText = ({ id, text }: PlanTask): string =>
  text !== '' ? text : id === null ? 'задача без названия' : `задача ${id}`

const TaskList = ({ tasks }: { readonly tasks: readonly PlanTask[] }): ReactElement => (
  <ul className="plan-items">
    {tasks.map((task, index) => (
      <li key={task.id ?? `${String(index)}:${task.text}`} className="plan-item" data-status={task.status}>
        <PlanItemGlyph status={task.status} />
        <span className="plan-item-text">
          {taskText(task)}
          {task.description === null ? null : <span className="plan-item-note">{task.description}</span>}
        </span>
        <span className="plan-item-status">{planItemLabel[task.status]}</span>
      </li>
    ))}
  </ul>
)

const CurrentPlan = ({
  block,
  objects,
  now,
}: {
  readonly block: PlanBlock
  readonly objects: ObservationObjects
  readonly now: bigint
}): ReactElement => {
  const { latest } = block
  const place = block.session === null ? null : placeOf(objects, block.session, block.agent)
  const tasks =
    block.family === 'tasks'
      ? mergedTasks(block.facts)
      : latest.payload.items.map(({ id, text, status }) => ({ id, text, status, description: null }))
  const text = block.family === 'tasks' ? null : latest.payload.text
  const unverified = block.facts.some(({ format_verified: verified }) => !verified)
  return (
    <li className="plan-update">
      <p className="plan-head">
        <span className="plan-source">{blockLabel(block)}</span>
        <Moment at={latest.at} now={now} />
      </p>
      <p className="plan-meta">
        {place === null ? null : <span>{place}</span>}
        {block.facts.length === 1 ? null : <span>{`сведено записей: ${String(block.facts.length)}`}</span>}
        {unverified ? <span className="plan-unverified">формат записи не проверен</span> : null}
      </p>
      {text === null ? null : <p className="plan-text">{text}</p>}
      {tasks.length === 0 ? null : <TaskList tasks={tasks} />}
    </li>
  )
}

export const PlanUpdate = ({
  fact,
  objects,
  now,
  repeated = 1,
}: {
  readonly fact: PlanFact
  readonly objects: ObservationObjects
  readonly now: bigint
  readonly repeated?: number
}): ReactElement => {
  const { payload } = fact
  const place = factPlace(objects, fact.entity_key)
  return (
    <li className="plan-update">
      <p className="plan-head">
        <span className="plan-source">{planSourceLabel[payload.source]}</span>
        <Moment at={fact.at} now={now} />
      </p>
      <p className="plan-meta">
        {place === null ? null : <span>{place}</span>}
        {repeated === 1 ? null : <span>{`${plural(repeated, sameRecordForms)} подряд`}</span>}
        {fact.format_verified ? null : <span className="plan-unverified">формат записи не проверен</span>}
      </p>
      {payload.text === null ? null : <p className="plan-text">{payload.text}</p>}
      {payload.items.length === 0 ? null : (
        <ul className="plan-items">
          {payload.items.map((item, index) => (
            <li key={index} className="plan-item" data-status={item.status}>
              <PlanItemGlyph status={item.status} />
              <span className="plan-item-text">{item.text}</span>
              <span className="plan-item-status">{planItemLabel[item.status]}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

interface Repeat {
  readonly fact: PlanFact
  readonly count: number
}

const sameContent = (left: PlanFact, right: PlanFact): boolean =>
  familyOf[left.payload.source] === familyOf[right.payload.source] &&
  left.payload.text === right.payload.text &&
  JSON.stringify(left.payload.items) === JSON.stringify(right.payload.items)

const repeats = (facts: readonly PlanFact[]): Repeat[] =>
  facts.reduce<Repeat[]>((runs, fact) => {
    const last = runs.at(-1)
    return last !== undefined && sameContent(last.fact, fact)
      ? [...runs.slice(0, -1), { fact: last.fact, count: last.count + 1 }]
      : [...runs, { fact, count: 1 }]
  }, [])

const PlanHistory = ({
  facts,
  objects,
  now,
}: {
  readonly facts: readonly PlanFact[]
  readonly objects: ObservationObjects
  readonly now: bigint
}): ReactElement => {
  const [open, setOpen] = useState(false)
  const list = useId()
  return (
    <div className="plan-history">
      <button
        type="button"
        className="text-button"
        aria-expanded={open}
        aria-controls={list}
        onClick={() => {
          setOpen(!open)
        }}
      >
        {open ? 'Скрыть историю записей' : `История записей: ${String(facts.length)}`}
      </button>
      {open ? (
        <ol id={list} className="plan-updates" aria-label="История записей плана">
          {repeats(facts).map(({ fact, count }) => (
            <PlanUpdate key={fact.id} fact={fact} objects={objects} now={now} repeated={count} />
          ))}
        </ol>
      ) : null}
    </div>
  )
}

export const PlanFacts = ({ snapshot, now }: { readonly snapshot: RunSnapshot; readonly now: bigint }): ReactElement => {
  const heading = useId()
  const facts = snapshot.plan_facts.filter(isPlan).toSorted(newestFirst)
  const blocks = blocksOf(facts, snapshot.objects)
  return (
    <section className="plan" aria-labelledby={heading}>
      <h2 id={heading} className="section-title">
        План решателя
      </h2>
      {facts.length === 0 ? (
        <p className="plan-empty">
          Решатель не объявлял план. Задачи, списки дел и планы на одобрение появятся здесь в том виде, в каком он их
          записал.
        </p>
      ) : (
        <>
          <ol className="plan-updates" aria-label="Текущий план">
            {blocks.map((block) => (
              <CurrentPlan key={block.key} block={block} objects={snapshot.objects} now={now} />
            ))}
          </ol>
          {facts.length === blocks.length ? null : <PlanHistory facts={facts} objects={snapshot.objects} now={now} />}
        </>
      )}
    </section>
  )
}
