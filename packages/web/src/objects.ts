import type {
  Action,
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

export interface FactOwner {
  readonly session: SessionId | null
  readonly agent: AgentId | null
}

export const factAction = (objects: ObservationObjects, key: FactEntityKey): Action | null =>
  key.kind === 'action' ? (objects.actions.find((candidate) => sameKey(candidate.key, key)) ?? null) : null

export const factOwner = (objects: ObservationObjects, key: FactEntityKey): FactOwner => {
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

export const attentionPlace = (objects: ObservationObjects, item: AttentionItem): string | null => {
  const question = objects.questions.find(({ id }) => id === item.question)
  const action = objects.actions.find(({ id }) => id === item.action)
  const source = question ?? action
  return source === undefined ? null : placeOf(objects, source.session, source.agent)
}
