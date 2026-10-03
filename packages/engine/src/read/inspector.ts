import {
  type Action,
  type ActionId,
  type Agent,
  type AgentId,
  type AttentionItemId,
  type Fact,
  type FactId,
  type JsonValue,
  type ModelChange,
  type ModelEntity,
  ModelVersion,
  type ObserverCall,
  type RunId,
  type Stage,
  type StageId,
  type StageInspector,
  type StageLifecycle,
  type UsageTotals,
} from '@aang/contract'
import { compareText } from '../observations/evidence.js'
import { byId, earliest, latest, partsOf, type ReadContext, runOf, stagesOfLink } from './context.js'
import { observerCallsOf } from './observer-calls.js'

const nanosecondsPerMillisecond = 1_000_000n

const noUsage: UsageTotals = {
  tokens: {
    uncached_input_tokens: 0,
    cache_read_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: null,
  },
  records: 0,
  output_lower_bound: false,
  cost_usd: null,
}

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

const activeMs = (actions: readonly Action[]): number | null => {
  const spans = actions
    .flatMap(({ started_at: start, ended_at: end }): Span[] =>
      start !== null && end !== null && end >= start ? [[start, end]] : [],
    )
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
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

const historyOf = (
  { store }: ReadContext,
  run: RunId,
  stage: StageId,
  shown: ReadonlySet<AttentionItemId>,
): ModelChange[] =>
  [
    ...store.model.entityChanges(run, { kind: 'stage', id: stage }, ModelVersion.parse(0)),
    ...relatedKinds.flatMap((kind) =>
      store.model
        .kindChanges(run, kind, ModelVersion.parse(0))
        .filter(
          ({ target, before, after }) =>
            (target.kind === 'attention_item' && shown.has(target.id)) ||
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
  const history = historyOf(context, run, id, new Set(attention.map(({ id: item }) => item)))
  const shaping = new Set(history.flatMap(({ observer_call: call }) => (call === null ? [] : [call])))
  const calls: ObserverCall[] = observerCallsOf(context, run).filter(
    (call) => shaping.has(call.id) || (call.outcome === 'rejected' && mentions(call.output, id)),
  )
  const ended = actions.length > 0 && actions.every(({ ended_at: end }) => end !== null)
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
    inputs: [],
    outputs: [],
    dependencies: parts.links.filter(
      (link) => link.kind === 'dependency' && (link.stage === id || link.depends_on === id),
    ),
    criteria: parts.criteria
      .filter(({ stage: owner }) => owner === id)
      .map((criterion) => ({ criterion, snapshots: [] })),
    attention,
    time: {
      started_at: earliest(actions.flatMap(({ started_at: start }) => (start === null ? [] : [start]))),
      ended_at: ended ? latest(actions.flatMap(({ ended_at: end }) => (end === null ? [] : [end]))) : null,
      active_ms: activeMs(actions),
    },
    usage: { stage: noUsage, unassigned_in_sessions: noUsage },
    evidence: groundsOf(stage)
      .map((fact) => store.facts.get(fact))
      .filter((fact): fact is Fact => fact !== null),
    history,
    observer_calls: calls,
    change_seq: store.changes.head(),
  }
}
