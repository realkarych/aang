import type { Action, Agent, Stage, ViewElement, ViewSelector } from '@aang/contract'
import type { ViewScene } from './scene.js'

const folded = (text: string): string => text.trim().toLowerCase()

const equal = (value: string | null, wanted: string): boolean => value !== null && folded(value) === folded(wanted)

const agentsWhere = (scene: ViewScene, matches: (agent: Agent) => boolean): ViewElement[] =>
  scene.agents.filter(matches).map(({ id }) => ({ kind: 'agent', id }))

const stagesWhere = (scene: ViewScene, matches: (stage: Stage) => boolean): ViewElement[] =>
  scene.parts.stages.filter(matches).map(({ id }) => ({ kind: 'stage', id }))

const actionsWhere = (scene: ViewScene, matches: (action: Action) => boolean): ViewElement[] =>
  scene
    .actions()
    .filter(matches)
    .map(({ id }) => ({ kind: 'action', id }))

const isServiceAgent = (agent: Agent): boolean => agent.role === 'service' || agent.service !== null

export const selectedElements = (selector: ViewSelector, scene: ViewScene): ViewElement[] => {
  switch (selector.kind) {
    case 'agent_type':
      return agentsWhere(scene, (agent) => equal(agent.agent_type, selector.agent_type))
    case 'agent_name':
      return agentsWhere(scene, (agent) => equal(agent.name, selector.name))
    case 'agent_role':
      return agentsWhere(scene, (agent) => equal(agent.agent_role, selector.role) || equal(agent.role, selector.role))
    case 'service_agents':
      return agentsWhere(scene, isServiceAgent)
    case 'stage_ids': {
      const wanted = new Set<string>(selector.stages)
      return stagesWhere(scene, ({ id }) => wanted.has(id))
    }
    case 'stage_title':
      return stagesWhere(scene, ({ title }) => folded(title).includes(folded(selector.contains)))
    case 'action_tool':
      return actionsWhere(scene, ({ tool }) => equal(tool, selector.tool))
    case 'action_kind':
      return actionsWhere(scene, ({ action_kind: kind }) => kind === selector.action_kind)
  }
}
