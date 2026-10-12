import type {
  Action,
  Agent,
  AgentId,
  FactEntityKey,
  ObservationObjects,
  Session,
  SessionId,
} from '@aang/contract'
import { serviceAgentLabel } from './labels.js'

const shortSession = ({ key }: Pick<Session, 'key'>): string => key.session.slice(0, 8)

const sessionTitle = (session: Pick<Session, 'key'>): string => `Session ${shortSession(session)}`

const named = (text: string | null): string | null => (text === null || text.trim() === '' ? null : text)

const agentTitle = (agent: Agent): string => {
  const ref = agent.key.agent
  switch (ref.kind) {
    case 'main':
      return 'Main agent'
    case 'teammate':
      return `${ref.name}@${ref.team}`
    case 'service':
      return serviceAgentLabel[ref.service]
    case 'subagent':
      return named(agent.agent_type) ?? named(agent.name) ?? 'Untyped subagent'
    case 'thread':
      return named(agent.name) ?? named(agent.agent_type) ?? 'Untyped subagent'
  }
}

const agentPhrase = (agent: Agent): string => (agent.role === 'main' ? 'main agent' : agentTitle(agent))

export const placeOf = (
  objects: ObservationObjects,
  session: SessionId | null,
  agent: AgentId | null,
): string | null => {
  const owner = objects.sessions.find(({ id }) => id === session)
  const actor = objects.agents.find(({ id }) => id === agent)
  const parts = [
    ...(owner === undefined ? [] : [sessionTitle(owner)]),
    ...(actor === undefined ? [] : [agentPhrase(actor)]),
  ]
  return parts.length === 0 ? null : parts.join(', ')
}

const sameKey = (left: FactEntityKey, right: FactEntityKey): boolean => JSON.stringify(left) === JSON.stringify(right)

export interface FactOwner {
  readonly session: SessionId | null
  readonly agent: AgentId | null
}

const factAction = (objects: ObservationObjects, key: FactEntityKey): Action | null =>
  key.kind === 'action' ? (objects.actions.find((candidate) => sameKey(candidate.key, key)) ?? null) : null

const factOwner = (objects: ObservationObjects, key: FactEntityKey): FactOwner => {
  if (key.kind === 'run') {
    return { session: null, agent: null }
  }
  const session = objects.sessions.find((candidate) => candidate.key.session === key.session) ?? null
  const action = factAction(objects, key)
  const agent = key.kind === 'agent' ? objects.agents.find((candidate) => sameKey(candidate.key, key)) : undefined
  return { session: session?.id ?? null, agent: action?.agent ?? agent?.id ?? null }
}

export const factPlace = (objects: ObservationObjects, key: FactEntityKey): string | null => {
  if (key.kind === 'run') {
    return null
  }
  const { session, agent } = factOwner(objects, key)
  return placeOf(objects, session, agent)
}
