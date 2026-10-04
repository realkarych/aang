import {
  type Action,
  type ActionId,
  type Agent,
  type AgentId,
  type ArtifactDirection,
  type CheckedCriterion,
  type Criterion,
  type Fact,
  type FactId,
  type GitSnapshot,
  type JsonValue,
  type Link,
  type ModelChange,
  type ModelEntity,
  ModelVersion,
  type ObserverCall,
  type RunId,
  type Stage,
  type StageArtifact,
  type StageId,
  type StageInspector,
  type StageLifecycle,
} from '@aang/contract'
import { objectId } from '@aang/contract/ids'
import type { Store } from '@aang/store'
import { compareText } from '../observations/evidence.js'
import { stageUsage } from '../usage/solver.js'
import { byId, earliest, latest, partsOf, type ReadContext, runOf, stagesOfLink } from './context.js'
import { observerCallsOf } from './observer-calls.js'

const nanosecondsPerMillisecond = 1_000_000n

const successorsOf = (lifecycle: StageLifecycle): StageId[] => {
  switch (lifecycle.state) {
    case 'active':
      return []
    case 'replaced':
      return lifecycle.by
    case 'merged':
      return [lifecycle.into]
    case 'split':
      return lifecycle.into
  }
}

type Span = readonly [bigint, bigint]

const compareTime = (left: bigint, right: bigint): number => (left < right ? -1 : left > right ? 1 : 0)

const activeMs = (actions: readonly Action[]): number | null => {
  const spans = actions
    .flatMap(({ started_at: start, ended_at: end }): Span[] =>
      start !== null && end !== null && end >= start ? [[start, end]] : [],
    )
    .sort(([left], [right]) => compareTime(left, right))
  if (spans.length === 0) {
    return null
  }
  const merged = spans.reduce<Span[]>((joined, span) => {
    const last = joined.at(-1)
    return last !== undefined && span[0] <= last[1]
      ? [...joined.slice(0, -1), [last[0], span[1] > last[1] ? span[1] : last[1]]]
      : [...joined, span]
  }, [])
  return Number(merged.reduce((total, [start, end]) => total + end - start, 0n) / nanosecondsPerMillisecond)
}

const mentions = (value: unknown, stage: StageId): boolean => {
  if (Array.isArray(value)) {
    return value.some((item) => mentions(item, stage))
  }
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const record = value as Record<string, JsonValue>
  return (
    (record['kind'] === 'existing' && record['id'] === stage) ||
    Object.values(record).some((item) => mentions(item, stage))
  )
}

const groundsOf = (stage: Stage): FactId[] =>
  [
    ...new Set([
      ...stage.evidence,
      ...stage.execution.evidence,
      ...(stage.execution_claim?.evidence ?? []),
      ...stage.decision.evidence,
    ]),
  ].sort(compareText)

const concerns = (entity: ModelEntity | null, stage: StageId): boolean => {
  switch (entity?.kind) {
    case 'link':
      return stagesOfLink(entity.value).includes(stage)
    case 'criterion':
    case 'attention_item':
      return entity.value.stage === stage
    default:
      return false
  }
}

const relatedKinds = ['link', 'criterion', 'attention_item'] as const

const byObservation = (left: StageArtifact, right: StageArtifact): number =>
  compareTime(left.version.observed_at, right.version.observed_at) ||
  compareText(left.version.id, right.version.id) ||
  compareText(left.link.id, right.link.id)

const artifactsOf = (
  { store }: ReadContext,
  run: RunId,
  links: readonly Link[],
  stage: StageId,
  direction: ArtifactDirection,
): StageArtifact[] =>
  links
    .flatMap((link) => {
      if (link.kind !== 'artifact' || link.stage !== stage || link.direction !== direction) {
        return []
      }
      const version = store.artifacts.getVersion(link.version)
      return version?.run === run ? [{ link, version }] : []
    })
    .sort(byObservation)

const byTaking = (left: GitSnapshot, right: GitSnapshot): number =>
  compareTime(left.taken_at, right.taken_at) || compareText(left.id, right.id)

const checkedCriterion = (criterion: Criterion, snapshots: readonly GitSnapshot[]): CheckedCriterion => {
  const cited = new Set(criterion.status.evidence)
  return { criterion, snapshots: snapshots.filter(({ fact }) => cited.has(fact)).sort(byTaking) }
}

const checksOf = (store: Store, criterion: Criterion): ActionId[] => [
  ...criterion.carried_checks,
  ...criterion.status.evidence.flatMap((id) => {
    const fact = store.facts.get(id)
    return fact?.entity_key.kind === 'action' ? [objectId(fact.entity_key)] : []
  }),
]

const shownCriterion = (store: Store, criterion: Criterion, stage: StageId, assigned: ReadonlySet<ActionId>): boolean =>
  criterion.stage === stage ||
  (criterion.stage === null &&
    criterion.source === 'contract' &&
    checksOf(store, criterion).some((action) => assigned.has(action)))

const shownKinds: ReadonlySet<ModelChange['target']['kind']> = new Set(['criterion', 'attention_item'])

const historyOf = (
  { store }: ReadContext,
  run: RunId,
  stage: StageId,
  shown: ReadonlySet<string>,
): ModelChange[] =>
  [
    ...store.model.entityChanges(run, { kind: 'stage', id: stage }, ModelVersion.parse(0)),
    ...relatedKinds.flatMap((kind) =>
      store.model
        .kindChanges(run, kind, ModelVersion.parse(0))
        .filter(
          ({ target, before, after }) =>
            (shownKinds.has(target.kind) && shown.has(target.id)) ||
            concerns(before, stage) ||
            concerns(after, stage),
        ),
    ),
  ].sort((left, right) => left.version - right.version || left.index - right.index)

export const stageInspector = (context: ReadContext, run: RunId, id: StageId): StageInspector | null => {
  const { store } = context
  if (runOf(store, run) === null) {
    return null
  }
  const parts = partsOf(store.model.entities(run))
  const stage = parts.stages.find((candidate) => candidate.id === id)
  if (stage === undefined) {
    return null
  }
  const actionIds = new Set<ActionId>(
    parts.links.flatMap((link) => (link.kind === 'assignment' && link.stage === id ? [link.action] : [])),
  )
  const actions = [...actionIds]
    .map((action) => store.observations.getAction(action))
    .filter((action): action is Action => action?.run === run)
    .sort(byId)
  const assigned = new Set(actions.map(({ id: action }) => action))
  const agentIds = new Set<AgentId>([
    ...parts.links.flatMap((link) => (link.kind === 'participation' && link.stage === id ? [link.agent] : [])),
    ...actions.flatMap(({ agent }) => (agent === null ? [] : [agent])),
  ])
  const agents = [...agentIds]
    .map((agent) => store.observations.getAgent(agent))
    .filter((agent): agent is Agent => agent?.run === run)
    .sort(byId)
  const attention = parts.attention.filter(
    (item) => item.stage === id || (item.stage === null && item.action !== null && assigned.has(item.action)),
  )
  const criteria = parts.criteria.filter((criterion) => shownCriterion(store, criterion, id, assigned))
  const history = historyOf(context, run, id, new Set([...attention, ...criteria].map(({ id: shown }) => shown)))
  const shaping = new Set(history.flatMap(({ observer_call: call }) => (call === null ? [] : [call])))
  const calls: ObserverCall[] = observerCallsOf(context, run).filter(
    (call) => shaping.has(call.id) || (call.outcome === 'rejected' && mentions(call.output, id)),
  )
  const ended = actions.length > 0 && actions.every(({ ended_at: end }) => end !== null)
  const snapshots = store.artifacts.snapshots(run)
  return {
    run,
    stage,
    children: parts.stages.filter(({ parent }) => parent === id).map(({ id: child }) => child),
    predecessors: parts.stages
      .filter(({ lifecycle }) => successorsOf(lifecycle).includes(id))
      .map(({ id: predecessor }) => predecessor),
    successors: successorsOf(stage.lifecycle),
    agents,
    actions,
    inputs: artifactsOf(context, run, parts.links, id, 'input'),
    outputs: artifactsOf(context, run, parts.links, id, 'output'),
    dependencies: parts.links.filter(
      (link) => link.kind === 'dependency' && (link.stage === id || link.depends_on === id),
    ),
    criteria: criteria.map((criterion) => checkedCriterion(criterion, snapshots)),
    attention,
    time: {
      started_at: earliest(actions.flatMap(({ started_at: start }) => (start === null ? [] : [start]))),
      ended_at: ended ? latest(actions.flatMap(({ ended_at: end }) => (end === null ? [] : [end]))) : null,
      active_ms: activeMs(actions),
    },
    usage: stageUsage(store, run, id),
    evidence: groundsOf(stage)
      .map((fact) => store.facts.get(fact))
      .filter((fact): fact is Fact => fact !== null),
    history,
    observer_calls: calls,
    change_seq: store.changes.head(),
  }
}
