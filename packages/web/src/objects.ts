import type {
  Agent,
  AgentId,
  AttentionItem,
  FactEntityKey,
  ObservationObjects,
  Session,
  SessionId,
} from '@aang/contract'
import { agentRoleLabel, serviceAgentLabel } from './labels.js'

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
      return named(agent.agent_type) ?? named(agent.name) ?? 'Субагент без типа'
    case 'thread':
      return named(agent.name) ?? named(agent.agent_type) ?? 'Субагент без типа'
  }
}

export const agentRole = (agent: Agent): string => {
  const kind = agentRoleLabel[agent.role]
  const type = named(agent.agent_type)
  return type === null || type === agentTitle(agent) ? kind : `${kind}, тип ${type}`
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

export const attentionPlace = (objects: ObservationObjects, item: AttentionItem): string | null => {
  const question = objects.questions.find(({ id }) => id === item.question)
  const action = objects.actions.find(({ id }) => id === item.action)
  const source = question ?? action
  return source === undefined ? null : placeOf(objects, source.session, source.agent)
}
