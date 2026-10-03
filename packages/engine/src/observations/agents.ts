import type { AgentId, AgentKey, AgentRef, Fact, FactId, SessionKey } from '@aang/contract'
import { objectId } from '@aang/contract/ids'
import type { Transaction } from '@aang/store'
import { agentKey, byContent, type Evidence, ofKind } from './evidence.js'

export interface Refinement {
  readonly from: AgentKey
  readonly to: AgentKey
  readonly evidence: readonly FactId[]
}

export interface AgentIdentity {
  readonly of: (fact: Fact) => AgentKey
  readonly resolve: (key: AgentKey) => AgentKey
  readonly refinements: readonly Refinement[]
}

type TeammateRef = Extract<AgentRef, { kind: 'teammate' }>

interface Teammate {
  readonly agent: TeammateRef
  readonly fact: FactId
}

const teammateTranscripts = (items: readonly Evidence[]): Map<string, Teammate> => {
  const teammates = new Map<string, Teammate>()
  for (const { fact } of ofKind(items, 'json_snapshot').toSorted(byContent)) {
    const { entity_key: key, runtime_ids: ids, payload } = fact
    if (
      payload.file === 'agent_meta' &&
      key.kind === 'agent' &&
      key.agent.kind === 'teammate' &&
      ids.agent_id !== null &&
      !teammates.has(ids.agent_id)
    ) {
      teammates.set(ids.agent_id, { agent: key.agent, fact: fact.id })
    }
  }
  return teammates
}

export const agentIdentity = ({ runtime, session }: SessionKey, items: readonly Evidence[]): AgentIdentity => {
  const teammates = teammateTranscripts(items)
  const resolve = (key: AgentKey): AgentKey => {
    const teammate = key.agent.kind === 'subagent' ? teammates.get(key.agent.agent_id) : undefined
    return teammate === undefined ? key : { ...key, agent: teammate.agent }
  }
  return {
    of: (fact) => resolve(agentKey(fact)),
    resolve,
    refinements: [...teammates].map(([file, { agent, fact }]) => ({
      from: { kind: 'agent', runtime, session, agent: { kind: 'subagent', agent_id: file } },
      to: { kind: 'agent', runtime, session, agent },
      evidence: [fact],
    })),
  }
}

export const compactionStop = (key: AgentKey, items: readonly Evidence[]): boolean =>
  key.agent.kind === 'subagent' &&
  items.every(({ fact }) => fact.kind === 'agent_end' && fact.payload.agent_type === '')

export interface Replacement {
  readonly retired: AgentId
  readonly replaced_by: AgentId
  readonly evidence: readonly FactId[]
}

export const retireRefined = (transaction: Transaction, identity: AgentIdentity): Replacement[] =>
  identity.refinements.flatMap(({ from, to, evidence }) => {
    const retired = objectId(from)
    if (transaction.observations.getAgent(retired) === null) {
      return []
    }
    const replacedBy = objectId(to)
    transaction.observations.remove({ kind: 'agent', id: retired, replaced_by: replacedBy })
    return [{ retired, replaced_by: replacedBy, evidence }]
  })
