import type { FactsDelta, ModelChange, RunSnapshot, SessionId } from '@aang/contract'
import type { RunFeed } from '@aang/engine'

interface Identified {
  readonly id: string
}

const byId = (left: Identified, right: Identified): number => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)

const merge = <T extends Identified>(list: readonly T[], values: readonly T[], removed = new Set<string>()): T[] => {
  const merged = new Map(list.map((value) => [value.id, value]))
  for (const value of values) {
    merged.set(value.id, value)
  }
  for (const id of removed) {
    merged.delete(id)
  }
  return [...merged.values()].sort(byId)
}

const replace = <T extends Identified>(list: readonly T[], id: string, value: T | null): T[] =>
  merge(
    list.filter((entry) => entry.id !== id),
    value === null ? [] : [value],
  )

const withoutSession = (snapshot: RunSnapshot, session: SessionId): RunSnapshot => {
  const { objects } = snapshot
  const foreign = <T extends { readonly session: SessionId | null }>(list: readonly T[]): T[] =>
    list.filter((entry) => entry.session !== session)
  return {
    ...snapshot,
    objects: {
      ...objects,
      sessions: objects.sessions.filter(({ id }) => id !== session),
      agents: foreign(objects.agents),
      actions: foreign(objects.actions),
      questions: foreign(objects.questions),
      usage_records: foreign(objects.usage_records),
      gaps: foreign(objects.gaps),
    },
  }
}

const applyChange = (snapshot: RunSnapshot, { target, after }: ModelChange): RunSnapshot => {
  const { model, attention } = snapshot
  switch (target.kind) {
    case 'run':
      return after?.kind === 'run' ? { ...snapshot, run: after.value } : snapshot
    case 'stage':
      return {
        ...snapshot,
        model: { ...model, stages: replace(model.stages, target.id, after?.kind === 'stage' ? after.value : null) },
      }
    case 'criterion':
      return {
        ...snapshot,
        model: {
          ...model,
          criteria: replace(model.criteria, target.id, after?.kind === 'criterion' ? after.value : null),
        },
      }
    case 'card':
      return {
        ...snapshot,
        model: { ...model, cards: replace(model.cards, target.id, after?.kind === 'card' ? after.value : null) },
      }
    case 'link':
      return {
        ...snapshot,
        model: { ...model, links: replace(model.links, target.id, after?.kind === 'link' ? after.value : null) },
      }
    case 'attention_item':
      return {
        ...snapshot,
        attention: {
          ...attention,
          items: replace(attention.items, target.id, after?.kind === 'attention_item' ? after.value : null),
        },
      }
    case 'binding':
      return {
        ...snapshot,
        bindings: replace(snapshot.bindings, target.id, after?.kind === 'binding' ? after.value : null),
      }
    case 'session_membership':
      return after === null ? withoutSession(snapshot, target.id) : snapshot
  }
}

const applyFacts = (snapshot: RunSnapshot, { facts, objects, removed }: FactsDelta): RunSnapshot => {
  const known = new Set(snapshot.plan_facts.map(({ id }) => id))
  const gone = new Set(removed.map(({ id }) => id))
  const current = snapshot.objects
  return {
    ...snapshot,
    plan_facts: [...snapshot.plan_facts, ...facts.filter(({ id, kind }) => kind === 'plan_update' && !known.has(id))],
    objects: {
      sessions: merge(current.sessions, objects.sessions),
      agents: merge(current.agents, objects.agents, gone),
      actions: merge(current.actions, objects.actions),
      questions: merge(current.questions, objects.questions),
      artifact_versions: merge(current.artifact_versions, objects.artifact_versions),
      git_snapshots: merge(current.git_snapshots, objects.git_snapshots),
      usage_records: merge(current.usage_records, objects.usage_records),
      gaps: merge(current.gaps, objects.gaps),
    },
  }
}

export const applyFeed = (snapshot: RunSnapshot, feed: RunFeed): RunSnapshot => {
  const replayed = feed.events.reduce(
    (view, event) =>
      event.event === 'facts' ? applyFacts(view, event.data) : event.data.changes.reduce(applyChange, view),
    snapshot,
  )
  return {
    ...replayed,
    summary: feed.run.summary,
    view: feed.run.view,
    bindings: feed.run.bindings,
    change_seq: feed.position,
  }
}
