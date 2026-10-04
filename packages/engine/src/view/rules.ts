import {
  type AppliedViewRule,
  type EpochNs,
  type RunId,
  type ViewRule,
  type ViewRuleId,
  type ViewRuleSource,
  ViewRuleSpec,
  type ViewSelector,
} from '@aang/contract'
import type { Transaction } from '@aang/store'
import { viewScene } from './scene.js'
import { selectedElements } from './selectors.js'

export type ViewRuleErrorCode = 'invalid_rule' | 'invalid_selector' | 'invalid_params'

export class ViewRuleError extends Error {
  override readonly name = 'ViewRuleError'

  constructor(
    readonly code: ViewRuleErrorCode,
    message: string,
  ) {
    super(message)
  }
}

export interface ViewRuleAddition {
  readonly run: RunId
  readonly rule: ViewRuleSpec
  readonly source: ViewRuleSource
  readonly at: EpochNs
}

export interface ViewRuleRevocation {
  readonly run: RunId
  readonly id: ViewRuleId
  readonly at: EpochNs
}

const filled = (text: string, field: string, code: ViewRuleErrorCode = 'invalid_selector'): string => {
  const trimmed = text.trim()
  if (trimmed === '') {
    throw new ViewRuleError(code, `the ${field} must not be empty`)
  }
  return trimmed
}

const checkedSelector = (transaction: Transaction, run: RunId, selector: ViewSelector): ViewSelector => {
  switch (selector.kind) {
    case 'agent_type':
      return { ...selector, agent_type: filled(selector.agent_type, 'agent type of the selector') }
    case 'agent_name':
      return { ...selector, name: filled(selector.name, 'agent name of the selector') }
    case 'agent_role':
      return { ...selector, role: filled(selector.role, 'agent role of the selector') }
    case 'stage_title':
      return { ...selector, contains: filled(selector.contains, 'stage title fragment of the selector') }
    case 'action_tool':
      return { ...selector, tool: filled(selector.tool, 'tool name of the selector') }
    case 'stage_ids': {
      const stages = [...new Set(selector.stages)]
      if (stages.length === 0) {
        throw new ViewRuleError('invalid_selector', 'the selector names no stages')
      }
      const unknown = stages.filter((id) => transaction.model.entity(run, { kind: 'stage', id })?.kind !== 'stage')
      if (unknown.length > 0) {
        throw new ViewRuleError('invalid_selector', `the run has no stages ${unknown.join(', ')}`)
      }
      return { ...selector, stages }
    }
    case 'service_agents':
    case 'action_kind':
      return selector
  }
}

const checkedRule = (transaction: Transaction, run: RunId, input: ViewRuleSpec): ViewRuleSpec => {
  const parsed = ViewRuleSpec.safeParse(input)
  if (!parsed.success) {
    throw new ViewRuleError('invalid_rule', `the view rule does not match the schema: ${parsed.error.message}`)
  }
  const rule = parsed.data
  const selector = checkedSelector(transaction, run, rule.selector)
  switch (rule.action) {
    case 'group':
      return { ...rule, selector, params: { name: filled(rule.params.name, 'group name', 'invalid_params') } }
    case 'collapse':
    case 'hide':
    case 'detail':
      return { ...rule, selector }
  }
}

const hasRun = (transaction: Transaction, run: RunId): boolean =>
  transaction.model.entity(run, { kind: 'run', id: run })?.kind === 'run'

export const addViewRule = (
  transaction: Transaction,
  { run, rule, source, at }: ViewRuleAddition,
): AppliedViewRule | null => {
  if (!hasRun(transaction, run)) {
    return null
  }
  const stored = transaction.views.saveRule({ ...checkedRule(transaction, run, rule), run, source, created_at: at })
  return { rule: stored, affected: selectedElements(stored.selector, viewScene(transaction, run)) }
}

export const revokeViewRule = (transaction: Transaction, { run, id, at }: ViewRuleRevocation): ViewRule | null =>
  transaction.views.revokeRule(run, id, at)
