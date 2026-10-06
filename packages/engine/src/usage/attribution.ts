import type { ActionId, RunId, Session, StageId, UsageRecord } from '@aang/contract'
import { objectId } from '@aang/contract/ids'
import type { ModelReader } from '@aang/store'
import { type AgentIdentity, agentIdentity } from '../observations/agents.js'
import { type Evidence, type ObservationSource, ofKind, sessionEvidence } from '../observations/evidence.js'
import { isFork, isInherited, lineageOf } from '../observations/lineage.js'

export interface SessionReading {
  readonly session: Session
  readonly own: readonly Evidence[]
  readonly identity: AgentIdentity
  readonly fork: boolean
}

export type StageOf = (record: UsageRecord) => StageId | null

const noActions: ReadonlySet<ActionId> = new Set()

export const readSession = (source: ObservationSource, session: Session): SessionReading => {
  const evidence = sessionEvidence(source, session.key)
  const lineage = lineageOf(source, session.key, evidence)
  const inherited = isInherited(lineage)
  const own = evidence.filter((item) => !inherited(item))
  return { session, own, identity: agentIdentity(session.key, own), fork: isFork(lineage) }
}

const addTo = <K, V>(groups: Map<K, Set<V>>, key: K, value: V): void => {
  const group = groups.get(key)
  if (group === undefined) {
    groups.set(key, new Set([value]))
  } else {
    group.add(value)
  }
}

const responseActions = ({ session, own }: SessionReading): ((record: UsageRecord) => ReadonlySet<ActionId>) => {
  const claude = session.key.runtime === 'claude'
  const actions = new Map<string, Set<ActionId>>()
  for (const { fact } of ofKind(own, 'action_start')) {
    const response = claude ? fact.runtime_ids.message_id : fact.runtime_ids.turn_id
    if (fact.entity_key.kind === 'action' && response !== null) {
      addTo(actions, response, objectId(fact.entity_key))
    }
  }
  const turns = new Map<string, string>()
  for (const { fact } of ofKind(own, 'usage')) {
    const turn = fact.runtime_ids.turn_id
    if (fact.entity_key.kind === 'usage' && turn !== null && !turns.has(fact.entity_key.usage)) {
      turns.set(fact.entity_key.usage, turn)
    }
  }
  return ({ key }) => {
    const response = claude ? key.usage : turns.get(key.usage)
    return (response === undefined ? undefined : actions.get(response)) ?? noActions
  }
}

export const assignedStages = (model: ModelReader, run: RunId): Map<ActionId, Set<StageId>> => {
  const assigned = new Map<ActionId, Set<StageId>>()
  for (const entity of model.entities(run)) {
    if (entity.kind === 'link' && entity.value.kind === 'assignment') {
      addTo(assigned, entity.value.action, entity.value.stage)
    }
  }
  return assigned
}

const soleStage = (actions: ReadonlySet<ActionId>, assigned: ReadonlyMap<ActionId, ReadonlySet<StageId>>): StageId | null => {
  let stage: StageId | null = null
  for (const action of actions) {
    const stages = assigned.get(action)
    const [only] = stages ?? []
    if (stages?.size !== 1 || only === undefined || (stage !== null && only !== stage)) {
      return null
    }
    stage = only
  }
  return stage
}

export const stageAttribution = (
  readings: ReadonlyMap<string, SessionReading>,
  assigned: ReadonlyMap<ActionId, ReadonlySet<StageId>>,
): StageOf => {
  const responses = new Map([...readings].map(([id, reading]) => [id, responseActions(reading)]))
  return (record) => soleStage(responses.get(record.session)?.(record) ?? noActions, assigned)
}
