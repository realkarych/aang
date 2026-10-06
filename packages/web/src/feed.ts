import type {
  AttentionDelta,
  AttentionView,
  FactsDelta,
  ModelChange,
  ModelDelta,
  ModelEntityRef,
  ObservationObjects,
  RunSnapshot,
} from '@aang/contract'
import type { FeedEvent } from './stream.js'

interface Identified {
  readonly id: string
}

const upsert = <T extends Identified>(items: readonly T[], updates: readonly T[]): T[] => {
  if (updates.length === 0) {
    return [...items]
  }
  const byId = new Map(items.map((item) => [item.id, item]))
  for (const update of updates) {
    byId.set(update.id, update)
  }
  return [...byId.values()]
}

const byId = (left: Identified, right: Identified): number => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)

const merged = <T extends Identified>(items: readonly T[], updates: readonly T[]): T[] =>
  upsert(items, updates).sort(byId)

const mergeObjects = (objects: ObservationObjects, delta: FactsDelta): ObservationObjects => {
  const removed = new Set(delta.removed.map(({ id }) => id))
  return {
    sessions: merged(objects.sessions, delta.objects.sessions),
    agents: merged(objects.agents, delta.objects.agents).filter(({ id }) => !removed.has(id)),
    actions: merged(objects.actions, delta.objects.actions),
    questions: merged(objects.questions, delta.objects.questions),
    artifact_versions: merged(objects.artifact_versions, delta.objects.artifact_versions),
    git_snapshots: merged(objects.git_snapshots, delta.objects.git_snapshots),
    usage_records: merged(objects.usage_records, delta.objects.usage_records),
    gaps: merged(objects.gaps, delta.objects.gaps),
  }
}

const applyFacts = (snapshot: RunSnapshot, delta: FactsDelta): RunSnapshot => ({
  ...snapshot,
  plan_facts: upsert(snapshot.plan_facts, delta.facts),
  objects: mergeObjects(snapshot.objects, delta),
})

const replaced = <T extends Identified>(items: readonly T[], target: ModelEntityRef, after: T | null): T[] =>
  after === null ? items.filter(({ id }) => id !== target.id) : upsert(items, [after])

const applyChange = (snapshot: RunSnapshot, { target, after }: ModelChange): RunSnapshot => {
  const { model, attention } = snapshot
  switch (target.kind) {
    case 'run':
      return after?.kind === 'run' ? { ...snapshot, run: after.value } : snapshot
    case 'stage': {
      const stage = after?.kind === 'stage' ? after.value : null
      return { ...snapshot, model: { ...model, stages: replaced(model.stages, target, stage) } }
    }
    case 'criterion': {
      const criterion = after?.kind === 'criterion' ? after.value : null
      return { ...snapshot, model: { ...model, criteria: replaced(model.criteria, target, criterion) } }
    }
    case 'card': {
      const card = after?.kind === 'card' ? after.value : null
      return { ...snapshot, model: { ...model, cards: replaced(model.cards, target, card) } }
    }
    case 'link': {
      const link = after?.kind === 'link' ? after.value : null
      return { ...snapshot, model: { ...model, links: replaced(model.links, target, link) } }
    }
    case 'attention_item': {
      const item = after?.kind === 'attention_item' ? after.value : null
      return { ...snapshot, attention: { ...attention, items: replaced(attention.items, target, item) } }
    }
    case 'binding': {
      const binding = after?.kind === 'binding' ? after.value : null
      return { ...snapshot, bindings: replaced(snapshot.bindings, target, binding) }
    }
    case 'session_membership':
      return snapshot
  }
}

const applyModel = (snapshot: RunSnapshot, delta: ModelDelta): RunSnapshot => {
  const changed = delta.changes.reduce(applyChange, snapshot)
  const { version } = delta.version
  return { ...changed, run: { ...changed.run, version }, summary: { ...changed.summary, version } }
}

const withViews = (views: readonly AttentionView[], updates: readonly AttentionView[]): AttentionView[] => {
  const byItem = new Map(views.map((view) => [view.item, view]))
  for (const update of updates) {
    const known = byItem.get(update.item)
    if (known === undefined || known.change_seq <= update.change_seq) {
      byItem.set(update.item, update)
    }
  }
  return [...byItem.values()]
}

const applyAttention = (snapshot: RunSnapshot, delta: AttentionDelta): RunSnapshot => ({
  ...snapshot,
  attention: {
    items: upsert(snapshot.attention.items, delta.items),
    views: withViews(snapshot.attention.views, delta.views),
  },
})

export const applyAttentionView = (snapshot: RunSnapshot, view: AttentionView): RunSnapshot => ({
  ...snapshot,
  attention: { ...snapshot.attention, views: withViews(snapshot.attention.views, [view]) },
})

export const applyEvent = (snapshot: RunSnapshot, event: FeedEvent): RunSnapshot => {
  switch (event.event) {
    case 'run':
      return {
        ...snapshot,
        summary: event.data.summary,
        view: event.data.view,
        bindings: event.data.bindings,
        change_seq: event.id,
      }
    case 'facts':
      return { ...applyFacts(snapshot, event.data), change_seq: event.id }
    case 'model':
      return { ...applyModel(snapshot, event.data), change_seq: event.id }
    case 'attention':
      return { ...applyAttention(snapshot, event.data), change_seq: event.id }
    case 'chat':
    case 'status':
      return { ...snapshot, change_seq: event.id }
  }
}
