import type { AgentKey, AgentRef, Fact } from '@aang/contract'
import { agentKey, byContent, type Evidence, ofKind } from './evidence.js'

export interface AgentIdentity {
  readonly of: (fact: Fact) => AgentKey
  readonly resolve: (key: AgentKey) => AgentKey
}

const teammateTranscripts = (items: readonly Evidence[]): Map<string, AgentRef> => {
  const teammates = new Map<string, AgentRef>()
  for (const { fact } of ofKind(items, 'json_snapshot').toSorted(byContent)) {
    const { entity_key: key, runtime_ids: ids, payload } = fact
    if (
      payload.file === 'agent_meta' &&
      key.kind === 'agent' &&
      key.agent.kind === 'teammate' &&
      ids.agent_id !== null &&
      !teammates.has(ids.agent_id)
    ) {
      teammates.set(ids.agent_id, key.agent)
    }
  }
  return teammates
}

export const agentIdentity = (items: readonly Evidence[]): AgentIdentity => {
  const teammates = teammateTranscripts(items)
  const resolve = (key: AgentKey): AgentKey => {
    const teammate = key.agent.kind === 'subagent' ? teammates.get(key.agent.agent_id) : undefined
    return teammate === undefined ? key : { ...key, agent: teammate }
  }
  return { of: (fact) => resolve(agentKey(fact)), resolve }
}

export const announced = (key: AgentKey, items: readonly Evidence[]): boolean =>
  key.agent.kind === 'main' || ofKind(items, 'agent_start').length > 0
