import {
  type ChatCitation,
  ChatInput,
  type ChatMaterial,
  type ChatOutput,
  type JournalMaterial,
  type JsonValue,
  type RunAgentBrief,
  type StageId,
  type ViewSelector,
} from '@aang/contract'
import { ScenarioError } from '../fake-cli/scenario-error.js'

const citedPerKind = 3

export const readChatInput = (input: JsonValue | undefined): ChatInput => {
  const parsed = ChatInput.safeParse(input)
  if (!parsed.success) {
    throw new ScenarioError(`the prompt carries no chat input: ${parsed.error.message}`)
  }
  return parsed.data
}

const unanswerable = (answer: string): ChatOutput => ({
  needs: [],
  answer,
  citations: [],
  insufficient_data: true,
  view_rule: null,
})

const focusCitations = (input: ChatInput): ChatCitation[] => {
  const { focus } = input
  if (focus.kind === 'stage') {
    return [
      { kind: 'stage', id: focus.stage },
      ...focus.facts.slice(0, citedPerKind).map(({ id }): ChatCitation => ({ kind: 'fact', id })),
      ...focus.actions.slice(0, citedPerKind).map(({ action }): ChatCitation => ({ kind: 'action', id: action })),
    ]
  }
  const evidence = [...new Set(focus.recent_changes.flatMap(({ evidence: facts }) => facts))]
  return [
    ...input.model.stages.slice(0, citedPerKind).map(({ id }): ChatCitation => ({ kind: 'stage', id })),
    ...focus.attention.slice(0, citedPerKind).map(({ id }): ChatCitation => ({ kind: 'question', id })),
    ...evidence.slice(0, citedPerKind).map((id): ChatCitation => ({ kind: 'fact', id })),
  ]
}

export const chatAnswerScript = (input: ChatInput): ChatOutput => {
  const citations = focusCitations(input)
  if (citations.length === 0) {
    return unanswerable('The map has no stages, questions or facts to answer from yet.')
  }
  const stages = input.model.stages.map(({ title, execution }) => `${title}: ${execution.state}`)
  return {
    needs: [],
    answer: `By map version ${String(input.model.version)}: ${stages.length === 0 ? 'no stages yet' : stages.join('; ')}.`,
    citations,
    insufficient_data: false,
    view_rule: null,
  }
}

const reviewing = (value: string | null): boolean => value !== null && /review/i.test(value)

const reviews = (agent: RunAgentBrief): boolean => [agent.agent_type, agent.name, agent.description].some(reviewing)

const reviewerSelector = (reviewers: readonly RunAgentBrief[]): ViewSelector | null => {
  const agentType = reviewers.find(({ agent_type }) => reviewing(agent_type))?.agent_type
  if (agentType !== undefined && agentType !== null) {
    return { kind: 'agent_type', agent_type: agentType }
  }
  const name = reviewers.find((agent) => agent.name !== null)?.name
  return name === undefined || name === null ? null : { kind: 'agent_name', name }
}

export const chatCollapseReviewersScript = (input: ChatInput): ChatOutput => {
  const reviewers = input.run.agents.filter(reviews)
  const selector = reviewerSelector(reviewers)
  if (selector === null) {
    return unanswerable('The run has no reviewer agents to collapse.')
  }
  return {
    needs: [],
    answer: `Collapsed ${String(reviewers.length)} reviewer agents; their questions stay in the attention zone.`,
    citations: [],
    insufficient_data: false,
    view_rule: { action: 'collapse', selector, params: null },
  }
}

const journalOf = (input: ChatInput, stage: StageId): JournalMaterial | undefined =>
  input.materials.find(
    (material: ChatMaterial): material is JournalMaterial =>
      material.kind === 'journal' && material.entity.kind === 'stage' && material.entity.id === stage,
  )

export const chatOldGroundScript = (input: ChatInput): ChatOutput => {
  const focused = input.focus.kind === 'stage' ? input.focus.stage : null
  const stage =
    input.model.stages.find(({ id }) => id === focused) ?? input.model.stages.find(({ parent }) => parent === null)
  if (stage === undefined) {
    return unanswerable('The map has no stage whose grounds could be traced.')
  }
  const journal = journalOf(input, stage.id)
  if (journal === undefined) {
    return {
      needs: [{ kind: 'journal', entity: { kind: 'stage', id: stage.id } }],
      answer: null,
      citations: [],
      insufficient_data: false,
      view_rule: null,
    }
  }
  const carried = JSON.stringify({ ...input, materials: [] })
  const ground = journal.entries.flatMap(({ evidence }) => evidence).find((fact) => !carried.includes(fact))
  return ground === undefined
    ? { ...unanswerable(`Every ground of ${stage.title} is already in the input.`), citations: [{ kind: 'stage', id: stage.id }] }
    : {
        needs: [],
        answer: `${stage.title} began from a ground the first input did not carry.`,
        citations: [
          { kind: 'stage', id: stage.id },
          { kind: 'fact', id: ground },
        ],
        insufficient_data: false,
        view_rule: null,
      }
}
