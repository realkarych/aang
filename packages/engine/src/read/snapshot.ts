import {
  type Action,
  type Agent,
  type ChangeSeq,
  type Fact,
  type FactsDelta,
  type Gap,
  type ModelChange,
  type ModelDelta,
  ModelVersion,
  type ModelVersionRecord,
  type ObservationObjects,
  type ObservationRemoval,
  type Question,
  type Run,
  type RunDelta,
  type RunId,
  type RunSnapshot,
  type RunsResponse,
  type Session,
  type UsageRecord,
} from '@aang/contract'
import type { Observation, StoredObservationRemoval } from '@aang/store'
import { compareText } from '../observations/evidence.js'
import { reparseBoundary } from '../reparse/boundary.js'
import { byId, InvalidPositionError, origin, partsOf, planKinds, precedesPrune, type ReadContext, runOf } from './context.js'
import { type RunState, summaryOf } from './summary.js'

export type RunFeedEvent =
  | { readonly event: 'facts'; readonly id: ChangeSeq; readonly data: FactsDelta }
  | { readonly event: 'model'; readonly id: ChangeSeq; readonly data: ModelDelta }

export interface RunFeed {
  readonly position: ChangeSeq
  readonly events: readonly RunFeedEvent[]
  readonly run: RunDelta
}

const isSession = (object: Observation): object is Session => object.key.kind === 'session'
const isAgent = (object: Observation): object is Agent => object.key.kind === 'agent'
const isAction = (object: Observation): object is Action => object.key.kind === 'action'
const isQuestion = (object: Observation): object is Question => object.key.kind === 'question'
const isUsage = (object: Observation): object is UsageRecord => object.key.kind === 'usage'

const objectsOf = (objects: readonly Observation[], gaps: readonly Gap[]): ObservationObjects => ({
  sessions: objects.filter(isSession),
  agents: objects.filter(isAgent),
  actions: objects.filter(isAction),
  questions: objects.filter(isQuestion),
  artifact_versions: [],
  git_snapshots: [],
  usage_records: objects.filter(isUsage),
  gaps: [...gaps],
})

const sortedObjects = (objects: ObservationObjects): ObservationObjects => ({
  sessions: objects.sessions.toSorted(byId),
  agents: objects.agents.toSorted(byId),
  actions: objects.actions.toSorted(byId),
  questions: objects.questions.toSorted(byId),
  artifact_versions: objects.artifact_versions.toSorted(byId),
  git_snapshots: objects.git_snapshots.toSorted(byId),
  usage_records: objects.usage_records.toSorted(byId),
  gaps: objects.gaps.toSorted(byId),
})

const stateOf = ({ store }: ReadContext, run: Run, members: readonly Observation[]): RunState => ({
  run,
  parts: partsOf(store.model.entities(run.id)),
  sessions: members.filter(isSession),
  agents: members.filter(isAgent),
})

const summaryStateOf = (context: ReadContext, run: Run): RunState =>
  stateOf(context, run, context.store.observations.ofRun(run.id, origin, ['session', 'agent']))

const runDelta = (context: ReadContext, state: RunState): RunDelta => ({
  summary: summaryOf(context, state),
  view: { rules: [], mark: null, zone: [] },
  bindings: state.parts.bindings,
})

export const runSnapshot = (context: ReadContext, id: RunId): RunSnapshot | null => {
  const { store } = context
  const run = runOf(store, id)
  if (run === null) {
    return null
  }
  const objects = store.observations.ofRun(id, origin)
  const state = stateOf(context, run, objects)
  const { parts } = state
  return {
    run,
    summary: summaryOf(context, state),
    model: { stages: parts.stages, criteria: parts.criteria, cards: parts.cards, links: parts.links },
    objects: sortedObjects(objectsOf(objects, store.gaps.ofRun(id, origin))),
    plan_facts: store.facts.ofRun(id, origin, planKinds).map(({ fact }) => fact),
    attention: { items: parts.attention, views: [] },
    view: { rules: [], mark: null, zone: [] },
    bindings: parts.bindings,
    change_seq: store.changes.head(),
  }
}

export const listRuns = (context: ReadContext): RunsResponse => {
  const { store } = context
  const runs = store.model.runs().map((run) => summaryOf(context, summaryStateOf(context, run)))
  return {
    runs: runs.sort(
      (left, right) =>
        (left.last_event_at > right.last_event_at ? -1 : left.last_event_at < right.last_event_at ? 1 : 0) ||
        compareText(left.id, right.id),
    ),
    change_seq: store.changes.head(),
  }
}

type FactsItem =
  | { readonly kind: 'fact'; readonly seq: ChangeSeq; readonly fact: Fact }
  | { readonly kind: 'object'; readonly seq: ChangeSeq; readonly object: Observation }
  | { readonly kind: 'gap'; readonly seq: ChangeSeq; readonly gap: Gap }
  | { readonly kind: 'removal'; readonly seq: ChangeSeq; readonly removal: StoredObservationRemoval }

type FeedItem = FactsItem | { readonly kind: 'model'; readonly seq: ChangeSeq; readonly version: ModelVersionRecord }

const removalOf = ({ kind, id, replaced_by: replacedBy }: StoredObservationRemoval): ObservationRemoval => ({
  kind,
  id,
  replaced_by: replacedBy,
})

const factsDelta = (run: RunId, items: readonly FactsItem[]): FactsDelta => {
  const facts: Fact[] = []
  const objects: Observation[] = []
  const gaps: Gap[] = []
  const removed: ObservationRemoval[] = []
  for (const item of items) {
    switch (item.kind) {
      case 'fact':
        facts.push(item.fact)
        break
      case 'object':
        objects.push(item.object)
        break
      case 'gap':
        gaps.push(item.gap)
        break
      case 'removal':
        removed.push(removalOf(item.removal))
        break
    }
  }
  return { run, facts, objects: objectsOf(objects, gaps), removed }
}

const versionChanges = (changes: readonly ModelChange[]): Map<ModelVersion, ModelChange[]> => {
  const byVersion = new Map<ModelVersion, ModelChange[]>()
  for (const change of changes) {
    const own = byVersion.get(change.version)
    if (own === undefined) {
      byVersion.set(change.version, [change])
    } else {
      own.push(change)
    }
  }
  return byVersion
}

export const runFeed = (context: ReadContext, id: RunId, after: ChangeSeq): RunFeed | null => {
  const { store } = context
  const position = store.changes.head()
  if (after > position) {
    throw new InvalidPositionError(`position ${String(after)} is ahead of the change feed at ${String(position)}`)
  }
  const reparsed = reparseBoundary(store.settings)
  if (reparsed !== null && after < reparsed) {
    throw new InvalidPositionError(`position ${String(after)} precedes the reparse at ${String(reparsed)}`, 'reparsed')
  }
  const run = runOf(store, id)
  if (run === null) {
    return null
  }
  if (precedesPrune(store, run, after)) {
    throw new InvalidPositionError(`position ${String(after)} precedes the prune of the run ${id}`)
  }
  const versions = store.model.versions(id, after)
  const first = versions[0]
  const changes =
    first === undefined
      ? new Map<ModelVersion, ModelChange[]>()
      : versionChanges(store.model.changes(id, ModelVersion.parse(first.version - 1)))
  const items: FeedItem[] = [
    ...store.facts
      .ofRun(id, after, planKinds)
      .map(({ change_seq: seq, fact }): FeedItem => ({ kind: 'fact', seq, fact })),
    ...store.observations
      .ofRun(id, after)
      .map((object): FeedItem => ({ kind: 'object', seq: object.change_seq, object })),
    ...store.gaps.ofRun(id, after).map((gap): FeedItem => ({ kind: 'gap', seq: gap.change_seq, gap })),
    ...store.observations
      .removalsOfRun(id, after)
      .map((removal): FeedItem => ({ kind: 'removal', seq: removal.change_seq, removal })),
    ...versions.map((version): FeedItem => ({ kind: 'model', seq: version.change_seq, version })),
  ].sort((left, right) => left.seq - right.seq)
  const events: RunFeedEvent[] = []
  let group: FactsItem[] = []
  const flush = (): void => {
    const last = group.at(-1)
    if (last !== undefined) {
      events.push({ event: 'facts', id: last.seq, data: factsDelta(id, group) })
      group = []
    }
  }
  for (const item of items) {
    if (item.kind === 'model') {
      flush()
      events.push({
        event: 'model',
        id: item.seq,
        data: { run: id, version: item.version, changes: changes.get(item.version.version) ?? [] },
      })
    } else {
      group.push(item)
    }
  }
  flush()
  return { position, events, run: runDelta(context, summaryStateOf(context, run)) }
}
