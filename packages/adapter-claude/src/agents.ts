import type { AgentKey, AgentStartPayload, FactDraft, JsonValue } from '@aang/contract'
import { z } from 'zod'
import { fact, type FactOrigin } from './facts.js'
import { name, optionalText } from './fields.js'
import { agentKey, agentRef, teammateKey } from './keys.js'

const SpawnedSubagent = z.looseObject({ agentId: name, agentType: optionalText, status: optionalText })

const SpawnedTeammate = z.looseObject({
  status: z.literal('teammate_spawned'),
  name,
  team_name: name,
  agent_type: optionalText,
})

const backgroundByStatus: ReadonlyMap<string, boolean> = new Map([
  ['async_launched', true],
  ['completed', false],
])

type StartedAgentFields = Partial<AgentStartPayload> & Pick<AgentStartPayload, 'role'>

export const startedAgent = (fields: StartedAgentFields): AgentStartPayload => ({
  service: null,
  agent_type: null,
  agent_role: null,
  description: null,
  nickname: null,
  parent: null,
  spawned_by_call: null,
  background: null,
  depth: null,
  ...fields,
})

const spawnFact = (origin: FactOrigin, entity: AgentKey, payload: AgentStartPayload): FactDraft =>
  fact(origin, { kind: 'agent_start', entity_key: entity, speaker: 'runtime', urgent: false, payload })

export const spawnedAgents = (
  origin: FactOrigin,
  session: string,
  call: string,
  result: JsonValue | undefined,
): FactDraft[] => {
  const parent = agentRef(origin.ids.agent_id)
  const teammate = SpawnedTeammate.safeParse(result)
  if (teammate.success) {
    const { name: member, team_name: team, agent_type: type } = teammate.data
    return [
      spawnFact(
        origin,
        teammateKey(session, member, team),
        startedAgent({ role: 'teammate', agent_type: type ?? null, nickname: member, parent, spawned_by_call: call }),
      ),
    ]
  }
  const subagent = SpawnedSubagent.safeParse(result)
  if (!subagent.success) {
    return []
  }
  const { agentId: agent, agentType: type, status } = subagent.data
  return [
    spawnFact(
      origin,
      agentKey(session, agent),
      startedAgent({
        role: 'subagent',
        agent_type: type ?? null,
        parent,
        spawned_by_call: call,
        background: (typeof status === 'string' ? backgroundByStatus.get(status) : undefined) ?? null,
      }),
    ),
  ]
}
