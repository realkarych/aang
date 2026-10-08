import {
  type ActionKind,
  ActionOutcome,
  type DetailLevel,
  type Stage,
  type StageId,
  type UsageTotals,
  type ViewRule,
  type ViewRuleSource,
  type ViewSelector,
  type ViewTotals,
} from '@aang/contract'
import { plural, whole } from './format.js'
import { actionForms, agentForms, outcomeLabel } from './labels.js'

export const detailLevelLabel: Readonly<Record<DetailLevel, string>> = {
  stages: 'только этапы',
  stages_and_agents: 'этапы и агенты',
  all_actions: 'все действия',
}

export const ruleSourceLabel: Readonly<Record<ViewRuleSource, string>> = {
  chat: 'из чата',
  ui: 'из интерфейса',
}

const actionKindLabel: Readonly<Record<ActionKind, string>> = {
  command: 'команда',
  file_read: 'чтение файла',
  file_write: 'запись файла',
  search: 'поиск',
  web: 'веб',
  mcp: 'MCP',
  agent: 'запуск агента',
  question: 'вопрос',
  plan: 'план',
  code_cell: 'ячейка кода',
  other: 'другое',
}

export const elementForms = { one: 'элемент', few: 'элемента', many: 'элементов' } as const
export const attentionForms = { one: 'пункт внимания', few: 'пункта внимания', many: 'пунктов внимания' } as const
const outputForms = { one: 'результат', few: 'результата', many: 'результатов' } as const

const titled = (stages: readonly Stage[], id: StageId): string =>
  `«${stages.find((stage) => stage.id === id)?.title ?? id}»`

const selected = (selector: ViewSelector, stages: readonly Stage[]): string => {
  switch (selector.kind) {
    case 'agent_type':
      return `агентов типа «${selector.agent_type}»`
    case 'agent_name':
      return `агентов с именем «${selector.name}»`
    case 'agent_role':
      return `агентов с ролью «${selector.role}»`
    case 'service_agents':
      return 'служебных агентов'
    case 'stage_ids': {
      const titles = selector.stages.map((id) => titled(stages, id)).join(', ')
      return `${selector.stages.length === 1 ? 'этап' : 'этапы'} ${titles}`
    }
    case 'stage_title':
      return `этапы, в названии которых есть «${selector.contains}»`
    case 'action_tool':
      return `действия инструмента «${selector.tool}»`
    case 'action_kind':
      return `действия вида «${actionKindLabel[selector.action_kind]}»`
  }
}

export const ruleText = (rule: ViewRule, stages: readonly Stage[]): string => {
  const target = selected(rule.selector, stages)
  switch (rule.action) {
    case 'collapse':
      return `свернуть ${target}`
    case 'hide':
      return `скрыть ${target}`
    case 'group':
      return `сгруппировать ${target} под «${rule.params.name}»`
    case 'detail':
      return `показать ${target} с детализацией «${detailLevelLabel[rule.params.level]}»`
  }
}

const usageText = ({ tokens, output_lower_bound: lowerBound }: UsageTotals): string => {
  const input = tokens.uncached_input_tokens + tokens.cache_read_input_tokens + tokens.cache_write_input_tokens
  return `токенов: ввод ${whole(input)}, вывод ${lowerBound ? 'не меньше ' : ''}${whole(tokens.output_tokens)}`
}

export const totalsText = ({ agents, actions, running_actions: running, outcomes, usage, outputs }: ViewTotals): string =>
  [
    ...(agents === 0 ? [] : [plural(agents, agentForms)]),
    plural(actions, actionForms),
    ...(running === 0 ? [] : [`идёт ${String(running)}`]),
    ...ActionOutcome.options.flatMap((outcome) =>
      outcomes[outcome] === 0 ? [] : [`${outcomeLabel[outcome]}: ${String(outcomes[outcome])}`],
    ),
    ...(usage === null ? [] : [usageText(usage)]),
    ...(outputs.length === 0 ? [] : [plural(outputs.length, outputForms)]),
  ].join(' · ')
