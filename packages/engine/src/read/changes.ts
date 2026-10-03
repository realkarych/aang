import type {
  ActionId,
  AgentActivity,
  AgentId,
  AttentionItem,
  ChangesResponse,
  Criterion,
  CriterionId,
  FactId,
  ModelChange,
  ModelChangeRef,
  ModelEntity,
  RunId,
  Stage,
  StageId,
  ViewPosition,
} from '@aang/contract'
import { canonicalJson, objectId } from '@aang/contract/ids'
import type { Store } from '@aang/store'
import { compareText, grouped } from '../observations/evidence.js'
import { InvalidPositionError, partsOf, planKinds, precedesPrune, type ReadContext, runOf, stagesOfLink } from './context.js'

interface Transition<T> {
  readonly before: T | null
  readonly after: T
  readonly changes: ModelChangeRef[]
}

interface Use {
  readonly agent: AgentId | null
  readonly tool: string
}

const changesOf = (journal: readonly ModelChange[], kind: ModelEntity['kind']) =>
  grouped(
    journal.filter(({ target }) => target.kind === kind),
    ({ target }) => target.id,
  )

const transitions = <T extends { readonly id: string }>(
  journal: readonly ModelChange[],
  kind: 'stage' | 'criterion',
  valueOf: (entity: ModelEntity | null) => T | null,
  touched: (change: ModelChange) => readonly string[],
  current: readonly T[],
): Transition<T>[] => {
  const changes = new Map<string, ModelChange[]>()
  for (const change of journal) {
    for (const id of touched(change)) {
      const own = changes.get(id)
      if (own === undefined) {
        changes.set(id, [change])
      } else {
        own.push(change)
      }
    }
  }
  return current.flatMap((after) => {
    const own = changes.get(after.id)
    if (own === undefined) {
      return []
    }
    const first = own.find(({ target }) => target.kind === kind)
    return [
      {
        before: first === undefined ? after : valueOf(first.before),
        after,
        changes: own.map(({ version, index }) => ({ version, index })),
      },
    ]
  })
}

const linkedStages = (entity: ModelEntity | null): StageId[] =>
  entity?.kind === 'link' ? stagesOfLink(entity.value) : []

const touchedStages = ({ target, before, after }: ModelChange): StageId[] =>
  target.kind === 'stage' ? [target.id] : [...new Set([...linkedStages(before), ...linkedStages(after)])]

const touchedCriteria = ({ target }: ModelChange): CriterionId[] => (target.kind === 'criterion' ? [target.id] : [])

const stageOf = (entity: ModelEntity | null): Stage | null => (entity?.kind === 'stage' ? entity.value : null)

const criterionOf = (entity: ModelEntity | null): Criterion | null =>
  entity?.kind === 'criterion' ? entity.value : null

const itemOf = (entity: ModelEntity | null): AttentionItem | null =>
  entity?.kind === 'attention_item' ? entity.value : null

const closes = ({ before, after }: ModelChange): boolean => {
  const previous = itemOf(before)
  const next = itemOf(after)
  return next !== null && next.resolution !== 'open' && (previous === null || previous.resolution === 'open')
}

const attentionChanges = (journal: readonly ModelChange[], items: readonly AttentionItem[]) => {
  const changes = changesOf(journal, 'attention_item')
  const touched = items.flatMap((item) => {
    const own = changes.get(item.id)
    return own === undefined ? [] : [{ item, own }]
  })
  return {
    opened: touched
      .filter(({ item, own }) => item.resolution === 'open' && own.some(({ before }) => before === null))
      .map(({ item }) => item),
    closed: touched.filter(({ item, own }) => item.resolution !== 'open' && own.some(closes)).map(({ item }) => item),
  }
}

const activityOf = (store: Store, run: RunId, from: ViewPosition): AgentActivity[] => {
  const recent = store.facts.ofRun(run, from.change_seq)
  const fresh = new Set<FactId>(recent.map(({ fact }) => fact.id))
  const seen = new Set<ActionId>()
  const uses: Use[] = []
  for (const { fact } of recent) {
    const key = fact.entity_key
    if (key.kind !== 'action' || seen.has(objectId(key))) {
      continue
    }
    seen.add(objectId(key))
    const action = store.observations.getAction(objectId(key))
    if (action?.run === run && !action.inherited && store.facts.ofEntity(key).every(({ id }) => fresh.has(id))) {
      uses.push({ agent: action.agent, tool: action.tool })
    }
  }
  return [...grouped(uses, ({ agent }) => canonicalJson(agent)).values()]
    .map((members): AgentActivity => ({
      agent: members[0].agent,
      actions: members.length,
      tools: [...grouped(members, ({ tool }) => tool)]
        .map(([tool, calls]) => ({ tool, count: calls.length }))
        .sort((left, right) => right.count - left.count || compareText(left.tool, right.tool)),
    }))
    .sort((left, right) => compareText(left.agent ?? '', right.agent ?? ''))
}

export const runChanges = ({ store }: ReadContext, run: RunId, from: ViewPosition): ChangesResponse | null => {
  if (runOf(store, run) === null) {
    return null
  }
  const head = store.model.head(run)
  const position = store.changes.head()
  if (from.version > head || from.change_seq > position) {
    throw new InvalidPositionError(
      `position ${String(from.version)}/${String(from.change_seq)} is ahead of ${String(head)}/${String(position)}`,
    )
  }
  if (precedesPrune(store, from.change_seq)) {
    throw new InvalidPositionError(
      `position ${String(from.version)}/${String(from.change_seq)} precedes the latest prune`,
    )
  }
  const parts = partsOf(store.model.entities(run))
  const journal = store.model.changes(run, from.version)
  const created = new Set(
    journal.flatMap(({ target, before }) => (target.kind === 'card' && before === null ? [target.id] : [])),
  )
  return {
    run,
    from: { version: from.version, change_seq: from.change_seq },
    to: { version: head, change_seq: position },
    stages: transitions(journal, 'stage', stageOf, touchedStages, parts.stages),
    criteria: transitions(journal, 'criterion', criterionOf, touchedCriteria, parts.criteria),
    cards: parts.cards.filter(({ id }) => created.has(id)),
    plan_facts: store.facts.ofRun(run, from.change_seq, planKinds).map(({ fact }) => fact),
    artifact_versions: [],
    attention: attentionChanges(journal, parts.attention),
    activity: activityOf(store, run, from),
  }
}
