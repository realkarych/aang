import {
  type ActionKind,
  ActionOutcome,
  type DetailLevel,
  type Stage,
  type StageId,
  type UsageTotals,
  type ViewRule,
  type ViewSelector,
  type ViewTotals,
} from '@catacomb/contract'
import { plural, whole } from './format.js'
import { actionForms, agentForms, outcomeLabel } from './labels.js'

const detailLevelLabel: Readonly<Record<DetailLevel, string>> = {
  stages: 'stages only',
  stages_and_agents: 'stages and agents',
  all_actions: 'all actions',
}

const actionKindLabel: Readonly<Record<ActionKind, string>> = {
  command: 'command',
  file_read: 'file read',
  file_write: 'file write',
  search: 'search',
  web: 'web',
  mcp: 'MCP',
  agent: 'agent start',
  question: 'question',
  plan: 'plan',
  code_cell: 'code cell',
  other: 'other',
}

const outputForms = { one: 'output', other: 'outputs' } as const

const titled = (stages: readonly Stage[], id: StageId): string =>
  `"${stages.find((stage) => stage.id === id)?.title ?? id}"`

const selected = (selector: ViewSelector, stages: readonly Stage[]): string => {
  switch (selector.kind) {
    case 'agent_type':
      return `agents of type "${selector.agent_type}"`
    case 'agent_name':
      return `agents named "${selector.name}"`
    case 'agent_role':
      return `agents with role "${selector.role}"`
    case 'service_agents':
      return 'service agents'
    case 'stage_ids': {
      const titles = selector.stages.map((id) => titled(stages, id)).join(', ')
      return `${selector.stages.length === 1 ? 'stage' : 'stages'} ${titles}`
    }
    case 'stage_title':
      return `stages whose title contains "${selector.contains}"`
    case 'action_tool':
      return `actions of tool "${selector.tool}"`
    case 'action_kind':
      return `actions of kind "${actionKindLabel[selector.action_kind]}"`
  }
}

export const ruleText = (rule: ViewRule, stages: readonly Stage[]): string => {
  const target = selected(rule.selector, stages)
  switch (rule.action) {
    case 'collapse':
      return `collapse ${target}`
    case 'hide':
      return `hide ${target}`
    case 'group':
      return `group ${target} under "${rule.params.name}"`
    case 'detail':
      return `show ${target} with detail level "${detailLevelLabel[rule.params.level]}"`
  }
}

export const changesStageMap = ({ selector, action }: ViewRule): boolean =>
  (selector.kind === 'stage_ids' || selector.kind === 'stage_title') && action !== 'detail'

export const noStageMapEffect = 'does not change the stage map'

const usageText = ({ tokens, output_lower_bound: lowerBound }: UsageTotals): string => {
  const input = tokens.uncached_input_tokens + tokens.cache_read_input_tokens + tokens.cache_write_input_tokens
  return `tokens: input ${whole(input)}, output ${lowerBound ? 'at least ' : ''}${whole(tokens.output_tokens)}`
}

export const totalsText = ({ agents, actions, running_actions: running, outcomes, usage, outputs }: ViewTotals): string =>
  [
    ...(agents === 0 ? [] : [plural(agents, agentForms)]),
    plural(actions, actionForms),
    ...(running === 0 ? [] : [`running ${String(running)}`]),
    ...ActionOutcome.options.flatMap((outcome) =>
      outcomes[outcome] === 0 ? [] : [`${outcomeLabel[outcome]}: ${String(outcomes[outcome])}`],
    ),
    ...(usage === null ? [] : [usageText(usage)]),
    ...(outputs.length === 0 ? [] : [plural(outputs.length, outputForms)]),
  ].join(' · ')
