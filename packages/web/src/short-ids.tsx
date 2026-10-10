import { createContext, type ReactElement, useContext } from 'react'

const derivedId = /\b[0-9a-f]{32}\b/

const derivedIds = new RegExp(derivedId.source, 'g')

const splitIds = new RegExp(`(${derivedId.source})`)

const shortId = (id: string): string => id.slice(0, 8)

export type AgentIds = ReadonlySet<string>

export const agentIds = (agents: readonly { readonly id: string }[]): AgentIds => new Set(agents.map(({ id }) => id))

export const KnownAgents = createContext<AgentIds>(new Set())

export const useKnownAgents = (): AgentIds => useContext(KnownAgents)

export const shortIds = (text: string, agents: AgentIds): string =>
  text.replace(derivedIds, (id) => (agents.has(id) ? shortId(id) : id))

export const fullHint = (text: string, agents: AgentIds): string | undefined =>
  shortIds(text, agents) === text ? undefined : text

export const StageName = ({ title }: { readonly title: string }): ReactElement => {
  const agents = useKnownAgents()
  return <span title={fullHint(title, agents)}>{`«${shortIds(title, agents)}»`}</span>
}

export const ShortIds = ({ text }: { readonly text: string }): ReactElement => {
  const agents = useKnownAgents()
  return (
    <>
      {text.split(splitIds).map((part, index) =>
        index % 2 === 1 && agents.has(part) ? (
          <span key={index} title={part}>
            {shortId(part)}
          </span>
        ) : (
          part
        ),
      )}
    </>
  )
}
