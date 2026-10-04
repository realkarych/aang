import type { Agent, AgentId, FactEntityKey, ObservationObjects, Session, SessionId } from '@aang/contract'
import { serviceAgentLabel } from './labels.js'

export const shortSession = ({ key }: Pick<Session, 'key'>): string => key.session.slice(0, 8)

export const sessionTitle = (session: Pick<Session, 'key'>): string => `Сессия ${shortSession(session)}`

const named = (text: string | null): string | null => (text === null || text.trim() === '' ? null : text)

export const agentTitle = (agent: Agent): string => {
  const ref = agent.key.agent
  switch (ref.kind) {
    case 'main':
      return 'Основной агент'
    case 'teammate':
      return `${ref.name}@${ref.team}`
    case 'service':
      return serviceAgentLabel[ref.service]
    case 'subagent':
    case 'thread':
      return named(agent.agent_type) ?? named(agent.name) ?? 'Субагент без типа'
  }
}

const agentPhrase = (agent: Agent): string => (agent.role === 'main' ? 'основной агент' : agentTitle(agent))

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

export const factPlace = (objects: ObservationObjects, key: FactEntityKey): string | null => {
  if (key.kind === 'run') {
    return null
  }
  const session = objects.sessions.find((candidate) => candidate.key.session === key.session) ?? null
  const action = key.kind === 'action' ? objects.actions.find((candidate) => sameKey(candidate.key, key)) : undefined
  const agent = key.kind === 'agent' ? objects.agents.find((candidate) => sameKey(candidate.key, key)) : undefined
  return placeOf(objects, session?.id ?? null, action?.agent ?? agent?.id ?? null)
}
