import {
  type ActionId,
  ActionOutcome,
  type AgentId,
  type AppliedViewRule,
  type ArtifactVersionId,
  type AttentionItem,
  type AttentionItemId,
  type DetailLevel,
  type StageId,
  type UsageRecord,
  type ViewElement,
  type ViewPlacement,
  type ViewRuleId,
  type ViewSelector,
  type ViewTotals,
  type ViewVisibility,
} from '@aang/contract'
import { compareText } from '../observations/evidence.js'
import { counted, usageTotals } from '../usage/solver.js'
import type { ViewScene } from './scene.js'
import { selectedElements } from './selectors.js'
import { type Subtree, type ViewTree, viewTree } from './tree.js'

export interface ProjectedView {
  readonly rules: AppliedViewRule[]
  readonly placements: ViewPlacement[]
}

interface Placing {
  readonly element: ViewElement
  visibility: { readonly state: ViewVisibility['state']; readonly rule: ViewRuleId | null } | null
  group: ViewPlacement['group']
  detail: ViewPlacement['detail']
}

interface Anchors {
  readonly item: AttentionItemId
  readonly stage: StageId | null
  readonly agent: AgentId | null
  readonly action: ActionId | null
}

const collapsedByDefault: ViewSelector = { kind: 'service_agents' }

const elementOrder: readonly ViewElement['kind'][] = ['stage', 'agent', 'action']

const keyOf = ({ kind, id }: ViewElement): string => `${kind}:${id}`

const byElement = (left: ViewElement, right: ViewElement): number =>
  elementOrder.indexOf(left.kind) - elementOrder.indexOf(right.kind) || compareText(left.id, right.id)

const none: ReadonlySet<never> = new Set()

const without = <T>(set: ReadonlySet<T>, value: string): ReadonlySet<T> =>
  new Set([...set].filter((member) => member !== value))

const belowLevel = (element: ViewElement, subtree: Subtree, level: DetailLevel): Subtree => {
  const actions = element.kind === 'action' ? without(subtree.actions, element.id) : subtree.actions
  switch (level) {
    case 'all_actions':
      return { stages: none, agents: none, actions: none }
    case 'stages_and_agents':
      return { stages: none, agents: none, actions }
    case 'stages':
      return {
        stages: none,
        agents: element.kind === 'agent' ? without(subtree.agents, element.id) : subtree.agents,
        actions,
      }
  }
}

const anchorsOf = (scene: ViewScene, tree: ViewTree, item: AttentionItem): Anchors => {
  const question = item.question === null ? null : scene.question(item.question)
  const action = item.action ?? question?.action?.action ?? null
  return {
    item: item.id,
    stage: item.stage,
    agent: question?.agent ?? (action === null ? null : (tree.action(action)?.agent ?? null)),
    action,
  }
}

const inside = (anchors: Anchors, part: Subtree): boolean =>
  (anchors.action !== null && part.actions.has(anchors.action)) ||
  (anchors.agent !== null && part.agents.has(anchors.agent)) ||
  (anchors.stage !== null && part.stages.has(anchors.stage))

const emptyOutcomes = (): ViewTotals['outcomes'] =>
  Object.fromEntries(ActionOutcome.options.map((outcome) => [outcome, 0])) as ViewTotals['outcomes']

const usageOf = (scene: ViewScene, element: ViewElement, subtree: Subtree): ViewTotals['usage'] => {
  switch (element.kind) {
    case 'agent':
      return usageTotals(
        scene.usage().filter((record) => counted(record) && record.agent !== null && subtree.agents.has(record.agent)),
      )
    case 'stage': {
      const attributed: UsageRecord[] = []
      for (const [stage, records] of scene.stageUsage()) {
        if (stage !== null && subtree.stages.has(stage)) {
          attributed.push(...records)
        }
      }
      return usageTotals(attributed)
    }
    case 'action':
      return null
  }
}

const outputsOf = (scene: ViewScene, subtree: Subtree): ArtifactVersionId[] => {
  const produced = scene
    .versions()
    .filter(({ produced_by: action }) => action !== null && subtree.actions.has(action))
    .map(({ id }) => id)
  const linked = scene.parts.links.flatMap((link) =>
    link.kind === 'artifact' && link.direction === 'output' && subtree.stages.has(link.stage) ? [link.version] : [],
  )
  return [...new Set([...produced, ...linked])].sort(compareText)
}

const totalsOf = (scene: ViewScene, tree: ViewTree, element: ViewElement, subtree: Subtree): ViewTotals => {
  const outcomes = emptyOutcomes()
  let running = 0
  for (const id of subtree.actions) {
    const action = tree.action(id)
    if (action?.execution.state === 'running') {
      running += 1
    }
    const outcome = action?.outcome ?? null
    if (outcome !== null) {
      outcomes[outcome.value] += 1
    }
  }
  return {
    agents: subtree.agents.size,
    actions: subtree.actions.size,
    running_actions: running,
    outcomes,
    usage: usageOf(scene, element, subtree),
    outputs: outputsOf(scene, subtree),
  }
}

const placingOf = (placings: Map<string, Placing>, element: ViewElement): Placing => {
  const key = keyOf(element)
  const known = placings.get(key)
  if (known !== undefined) {
    return known
  }
  const placing: Placing = { element, visibility: null, group: null, detail: null }
  placings.set(key, placing)
  return placing
}

export const projectView = (scene: ViewScene): ProjectedView => {
  const tree = viewTree(scene)
  const placings = new Map<string, Placing>()
  for (const element of selectedElements(collapsedByDefault, scene)) {
    placingOf(placings, element).visibility = { state: 'collapsed', rule: null }
  }
  const rules = scene.rules.map((rule): AppliedViewRule => {
    const affected = selectedElements(rule.selector, scene)
    for (const element of affected) {
      const placing = placingOf(placings, element)
      switch (rule.action) {
        case 'collapse':
          placing.visibility = { state: 'collapsed', rule: rule.id }
          break
        case 'hide':
          placing.visibility = { state: 'hidden', rule: rule.id }
          break
        case 'group':
          placing.group = { name: rule.params.name, rule: rule.id }
          break
        case 'detail':
          placing.detail = { level: rule.params.level, rule: rule.id }
          break
      }
    }
    return { rule, affected }
  })
  let anchors: readonly Anchors[] | null = null
  const attentionIn = (part: Subtree): AttentionItemId[] => {
    anchors ??= scene.parts.attention
      .filter(({ resolution }) => resolution === 'open')
      .map((item) => anchorsOf(scene, tree, item))
    return anchors.filter((anchored) => inside(anchored, part)).map(({ item }) => item)
  }
  const placements = [...placings.values()]
    .sort((left, right) => byElement(left.element, right.element))
    .map(({ element, visibility, group, detail }): ViewPlacement => {
      if (visibility !== null) {
        const subtree = tree.subtree(element)
        return {
          element,
          visibility:
            visibility.state === 'collapsed'
              ? { state: 'collapsed', rule: visibility.rule, totals: totalsOf(scene, tree, element, subtree) }
              : { state: 'hidden', rule: visibility.rule },
          group,
          detail,
          attention: attentionIn(subtree),
        }
      }
      return {
        element,
        visibility: null,
        group,
        detail,
        attention: detail === null ? [] : attentionIn(belowLevel(element, tree.subtree(element), detail.level)),
      }
    })
  return { rules, placements }
}
