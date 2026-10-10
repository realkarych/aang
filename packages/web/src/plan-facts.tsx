import type { AgentId, FactOf, ObservationObjects, PlanItemStatus, PlanSource, RunSnapshot, SessionId } from '@aang/contract'
import { type ReactElement, type ReactNode, useId, useState } from 'react'
import { plural } from './format.js'
import { PlanItemGlyph } from './glyphs.js'
import { planItemLabel, planSourceLabel } from './labels.js'
import { Moment } from './moment.js'
import { factAction, factOwner, factPlace, placeOf } from './objects.js'

type PlanFact = FactOf<'plan_update'>

type PlanItem = PlanFact['payload']['items'][number]

export const isPlan = (fact: RunSnapshot['plan_facts'][number]): fact is PlanFact => fact.kind === 'plan_update'

export const newestFirst = (left: PlanFact, right: PlanFact): number =>
  left.at > right.at ? -1 : left.at < right.at ? 1 : right.seq - left.seq

const oldestFirst = (left: PlanFact, right: PlanFact): number => newestFirst(right, left)

const sameRecordForms = { one: 'одинаковая запись', few: 'одинаковые записи', many: 'одинаковых записей' } as const

type PlanFamily = 'tasks' | 'todos' | 'approval' | 'goal' | 'codex'

const familyOf: Readonly<Record<PlanSource, PlanFamily>> = {
  task_tool: 'tasks',
  task_hook: 'tasks',
  exit_plan_mode: 'approval',
  thread_goal: 'goal',
  rollout_plan: 'codex',
}

const todoTool = 'TodoWrite'

interface PlanRecord {
  readonly fact: PlanFact
  readonly family: PlanFamily
  readonly session: SessionId | null
  readonly agent: AgentId | null
  readonly call: string | null
}

const mainAgentOf = (objects: ObservationObjects, session: SessionId | null): AgentId | null =>
  objects.agents.find((agent) => agent.session === session && agent.role === 'main')?.id ?? null

const recordOf =
  (objects: ObservationObjects) =>
  (fact: PlanFact): PlanRecord => {
    const owner = factOwner(objects, fact.entity_key)
    const tool = factAction(objects, fact.entity_key)?.tool
    return {
      fact,
      family: tool === todoTool ? 'todos' : familyOf[fact.payload.source],
      session: owner.session,
      agent: owner.agent ?? mainAgentOf(objects, owner.session),
      call: fact.entity_key.kind === 'action' ? JSON.stringify(fact.entity_key) : null,
    }
  }

const ownerKey = ({ session, agent }: PlanRecord): string => `${session ?? ''}:${agent ?? ''}`

interface PlanBlock {
  readonly key: string
  readonly family: PlanFamily
  readonly session: SessionId | null
  readonly agent: AgentId | null
  readonly records: readonly PlanRecord[]
  readonly latest: PlanFact
}

const blocksOf = (records: readonly PlanRecord[]): PlanBlock[] => {
  const blocks = new Map<string, PlanBlock>()
  for (const record of records.toSorted((left, right) => oldestFirst(left.fact, right.fact))) {
    const { family, session, agent, fact } = record
    const key = `${family}:${ownerKey(record)}`
    const known = blocks.get(key)?.records ?? []
    blocks.set(key, { key, family, session, agent, records: [...known, record], latest: fact })
  }
  return [...blocks.values()].toSorted((left, right) => newestFirst(left.latest, right.latest))
}

interface PlanTask {
  readonly id: string | null
  readonly text: string
  readonly status: PlanItemStatus
  readonly description: string | null
}

interface TrackedTask {
  id: string | null
  text: string
  status: PlanItemStatus
  description: string | null
  created: boolean
}

const taskUpdated = (
  tasks: TrackedTask[],
  id: string,
  { text, status }: PlanItem,
  description: string | null,
): void => {
  const known = tasks.find((task) => task.id === id)
  if (known === undefined) {
    tasks.push({ id, text, status, description, created: false })
    return
  }
  known.text = text === '' ? known.text : text
  known.status = status === 'unknown' ? known.status : status
  known.description = description ?? known.description
}

const onlyMatch = (task: TrackedTask, candidates: readonly TrackedTask[]): TrackedTask | undefined => {
  const named = candidates.filter((candidate) => task.text !== '' && candidate.text === task.text)
  const described =
    named.length === 1
      ? named
      : named.filter((candidate) => task.description !== null && candidate.description === task.description)
  return described.length === 1 ? described[0] : undefined
}

const createdPair = (tasks: readonly TrackedTask[]): readonly [TrackedTask, TrackedTask] | undefined => {
  const created = tasks.filter((task) => task.id === null)
  const updated = tasks.filter((task) => task.id !== null && !task.created)
  for (const update of updated) {
    const origin = onlyMatch(update, created)
    if (origin !== undefined && onlyMatch(origin, updated) === update) {
      return [origin, update]
    }
  }
  return undefined
}

const linkCreated = (tasks: TrackedTask[]): void => {
  const pair = createdPair(tasks)
  if (pair === undefined) {
    return
  }
  const [origin, update] = pair
  const [kept, dropped] = tasks.indexOf(origin) < tasks.indexOf(update) ? [origin, update] : [update, origin]
  Object.assign(kept, {
    id: update.id,
    text: update.text,
    status: update.status === 'unknown' ? origin.status : update.status,
    description: update.description ?? origin.description,
    created: true,
  })
  tasks.splice(tasks.indexOf(dropped), 1)
  linkCreated(tasks)
}

const mergedTasks = (records: readonly PlanRecord[]): PlanTask[] => {
  const tasks: TrackedTask[] = []
  const applied = new Set<string>()
  for (const { fact, call } of records) {
    if (call !== null && applied.has(call)) {
      continue
    }
    if (call !== null) {
      applied.add(call)
    }
    for (const item of fact.payload.items) {
      if (item.id === null) {
        tasks.push({ id: null, text: item.text, status: item.status, description: fact.payload.text, created: true })
      } else {
        taskUpdated(tasks, item.id, item, fact.payload.text)
      }
      linkCreated(tasks)
    }
  }
  return tasks
}

const blockLabel = ({ family, records, latest }: PlanBlock): string =>
  family === 'tasks' && records.some(({ fact }) => fact.payload.source === 'task_tool')
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
  const merged = block.family === 'tasks'
  const tasks = merged
    ? mergedTasks(block.records)
    : latest.payload.items.map(({ id, text, status }) => ({ id, text, status, description: null }))
  const text = merged ? null : latest.payload.text
  const shown = merged ? block.records.map(({ fact }) => fact) : [latest]
  const unverified = shown.some(({ format_verified: verified }) => !verified)
  return (
    <li className="plan-update">
      <p className="plan-head">
        <span className="plan-source">{blockLabel(block)}</span>
        <Moment at={latest.at} now={now} />
      </p>
      <p className="plan-meta">
        {place === null ? null : <span>{place}</span>}
        {block.records.length === 1 ? null : <span>{`сведено записей: ${String(block.records.length)}`}</span>}
        {unverified ? <span className="plan-unverified">формат записи не проверен</span> : null}
      </p>
      {text === null ? null : <p className="plan-text">{text}</p>}
      {block.family === 'todos' && tasks.length === 0 ? <p className="plan-text">Список дел пуст</p> : null}
      {tasks.length === 0 ? null : <TaskList tasks={tasks} />}
    </li>
  )
}

export const PlanUpdate = ({
  fact,
  objects,
  now,
  children,
}: {
  readonly fact: PlanFact
  readonly objects: ObservationObjects
  readonly now: bigint
  readonly children?: ReactNode
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
        {children}
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

const sameRecord = (left: PlanRecord, right: PlanRecord): boolean =>
  left.family === right.family &&
  ownerKey(left) === ownerKey(right) &&
  left.fact.payload.source === right.fact.payload.source &&
  left.fact.format_verified === right.fact.format_verified &&
  left.fact.payload.text === right.fact.payload.text &&
  JSON.stringify(left.fact.payload.items) === JSON.stringify(right.fact.payload.items)

type Repeat = readonly [PlanRecord, ...PlanRecord[]]

const repeats = (records: readonly PlanRecord[]): Repeat[] =>
  records.reduce<Repeat[]>((runs, record) => {
    const last = runs.at(-1)
    return last !== undefined && sameRecord(last[0], record)
      ? [...runs.slice(0, -1), [...last, record]]
      : [...runs, [record]]
  }, [])

const Repeated = ({
  records,
  objects,
  now,
}: {
  readonly records: Repeat
  readonly objects: ObservationObjects
  readonly now: bigint
}): ReactElement => {
  const [open, setOpen] = useState(false)
  const [first, ...rest] = records
  return (
    <>
      <PlanUpdate fact={first.fact} objects={objects} now={now}>
        {rest.length === 0 ? null : (
          <button
            type="button"
            className="text-button"
            aria-expanded={open}
            onClick={() => {
              setOpen(!open)
            }}
          >
            {`${plural(records.length, sameRecordForms)} подряд`}
          </button>
        )}
      </PlanUpdate>
      {open ? rest.map(({ fact }) => <PlanUpdate key={fact.id} fact={fact} objects={objects} now={now} />) : null}
    </>
  )
}

const PlanHistory = ({
  records,
  objects,
  now,
}: {
  readonly records: readonly PlanRecord[]
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
        {open ? 'Скрыть историю записей' : `История записей: ${String(records.length)}`}
      </button>
      {open ? (
        <ol id={list} className="plan-updates" aria-label="История записей плана">
          {repeats(records).map((run) => (
            <Repeated key={run[0].fact.id} records={run} objects={objects} now={now} />
          ))}
        </ol>
      ) : null}
    </div>
  )
}

export const PlanFacts = ({ snapshot, now }: { readonly snapshot: RunSnapshot; readonly now: bigint }): ReactElement => {
  const heading = useId()
  const records = snapshot.plan_facts.filter(isPlan).toSorted(newestFirst).map(recordOf(snapshot.objects))
  const blocks = blocksOf(records)
  return (
    <section className="plan" aria-labelledby={heading}>
      <h2 id={heading} className="section-title">
        План решателя
      </h2>
      {records.length === 0 ? (
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
          {records.length === blocks.length ? null : (
            <PlanHistory records={records} objects={snapshot.objects} now={now} />
          )}
        </>
      )}
    </section>
  )
}
