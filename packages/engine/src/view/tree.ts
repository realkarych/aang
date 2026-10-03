import type { Action, ActionId, AgentId, Link, StageId, ViewElement } from '@aang/contract'
import { once, type ViewScene } from './scene.js'

export interface Subtree {
  readonly stages: ReadonlySet<StageId>
  readonly agents: ReadonlySet<AgentId>
  readonly actions: ReadonlySet<ActionId>
}

export interface ViewTree {
  readonly subtree: (element: ViewElement) => Subtree
  readonly action: (id: ActionId) => Action | null
}

type LinkOf<K extends Link['kind']> = Extract<Link, { readonly kind: K }>

const none: ReadonlySet<never> = new Set()

const addTo = <K, V>(groups: Map<K, V[]>, key: K, value: V): void => {
  const group = groups.get(key)
  if (group === undefined) {
    groups.set(key, [value])
  } else {
    group.push(value)
  }
}

const descendants = <T>(root: T, children: ReadonlyMap<T, readonly T[]>): Set<T> => {
  const reached = new Set<T>([root])
  const pending = [root]
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    for (const child of children.get(next) ?? []) {
      if (!reached.has(child)) {
        reached.add(child)
        pending.push(child)
      }
    }
  }
  return reached
}

const linksOf = <K extends Link['kind']>(links: readonly Link[], kind: K): LinkOf<K>[] =>
  links.filter((link): link is LinkOf<K> => link.kind === kind)

export const viewTree = (scene: ViewScene): ViewTree => {
  const { stages, links } = scene.parts
  const stageChildren = new Map<StageId, StageId[]>()
  for (const { id, parent } of stages) {
    if (parent !== null) {
      addTo(stageChildren, parent, id)
    }
  }
  const agentChildren = new Map<AgentId, AgentId[]>()
  for (const { id, parent } of scene.agents) {
    if (parent !== null) {
      addTo(agentChildren, parent, id)
    }
  }
  const assigned = new Map<StageId, ActionId[]>()
  for (const { stage, action } of linksOf(links, 'assignment')) {
    addTo(assigned, stage, action)
  }
  const members = new Set(scene.agents.map(({ id }) => id))
  const participants = new Map<StageId, AgentId[]>()
  for (const { stage, agent } of linksOf(links, 'participation')) {
    if (members.has(agent)) {
      addTo(participants, stage, agent)
    }
  }
  const actions = once(() => {
    const byId = new Map<ActionId, Action>()
    const byAgent = new Map<AgentId, ActionId[]>()
    const contained = new Map<ActionId, ActionId[]>()
    for (const action of scene.actions()) {
      byId.set(action.id, action)
      if (action.agent !== null) {
        addTo(byAgent, action.agent, action.id)
      }
      if (action.container !== null) {
        addTo(contained, action.container, action.id)
      }
    }
    return { byId, byAgent, contained }
  })

  const stageSubtree = (root: StageId): Subtree => {
    const reached = descendants(root, stageChildren)
    const { byId } = actions()
    const work = new Set([...reached].flatMap((stage) => assigned.get(stage) ?? []).filter((id) => byId.has(id)))
    const agents = new Set([...reached].flatMap((stage) => participants.get(stage) ?? []))
    for (const id of work) {
      const agent = byId.get(id)?.agent ?? null
      if (agent !== null) {
        agents.add(agent)
      }
    }
    return { stages: reached, agents, actions: work }
  }

  const agentSubtree = (root: AgentId): Subtree => {
    const reached = descendants(root, agentChildren)
    const { byAgent } = actions()
    return {
      stages: none,
      agents: reached,
      actions: new Set([...reached].flatMap((agent) => byAgent.get(agent) ?? [])),
    }
  }

  const actionSubtree = (root: ActionId): Subtree => ({
    stages: none,
    agents: none,
    actions: descendants(root, actions().contained),
  })

  return {
    subtree: (element) => {
      switch (element.kind) {
        case 'stage':
          return stageSubtree(element.id)
        case 'agent':
          return agentSubtree(element.id)
        case 'action':
          return actionSubtree(element.id)
      }
    },
    action: (id) => actions().byId.get(id) ?? null,
  }
}
