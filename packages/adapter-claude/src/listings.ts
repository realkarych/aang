import type { DefinitionListingPayload, FactDraft, FactEntityKey } from '@aang/contract'
import { z } from 'zod'
import { fact, type FactOrigin } from './facts.js'
import { name } from './fields.js'

type Definition = DefinitionListingPayload['definitions'][number]

const AgentListing = z.object({
  type: z.literal('agent_listing_delta'),
  addedTypes: z.array(name),
  addedLines: z.array(z.string()),
})

const SkillListing = z.object({ type: z.literal('skill_listing'), content: z.string(), names: z.array(name) })

export const DefinitionListing = z.discriminatedUnion('type', [AgentListing, SkillListing])
type DefinitionListing = z.infer<typeof DefinitionListing>

export const definitionListingTypes: readonly string[] = DefinitionListing.options.map(
  (option) => option.shape.type.value,
)

const entryPrefix = (definition: string): string => `- ${definition}: `

const agentDefinitions = ({ addedTypes, addedLines }: z.infer<typeof AgentListing>): Definition[] =>
  addedTypes.flatMap((type) => {
    const prefix = entryPrefix(type)
    const line = addedLines.find((entry) => entry.startsWith(prefix))
    return line === undefined ? [] : [{ name: type, description: line.slice(prefix.length) }]
  })

const skillDefinitions = ({ content, names }: z.infer<typeof SkillListing>): Definition[] => {
  const definitions: { name: string; lines: string[] }[] = []
  for (const line of content.split('\n')) {
    const skill = names.find((listed) => line.startsWith(entryPrefix(listed)))
    if (skill !== undefined) {
      definitions.push({ name: skill, lines: [line.slice(entryPrefix(skill).length)] })
    } else {
      definitions.at(-1)?.lines.push(line)
    }
  }
  return definitions.map(({ name: skill, lines }) => ({ name: skill, description: lines.join('\n').trimEnd() }))
}

const listed = (listing: DefinitionListing): DefinitionListingPayload =>
  listing.type === 'agent_listing_delta'
    ? { catalog: 'agents', definitions: agentDefinitions(listing) }
    : { catalog: 'skills', definitions: skillDefinitions(listing) }

export const definitionListingFacts = (
  origin: FactOrigin,
  owner: FactEntityKey,
  listing: DefinitionListing,
): FactDraft[] => {
  const payload = listed(listing)
  return payload.definitions.length === 0
    ? []
    : [fact(origin, { kind: 'definition_listing', entity_key: owner, speaker: 'runtime', urgent: false, payload })]
}
