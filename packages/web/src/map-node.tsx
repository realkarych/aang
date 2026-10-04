import type { Agent, StageId } from '@aang/contract'
import { type Edge, type EdgeProps, Handle, type Node, type NodeProps, Position } from '@xyflow/react'
import type { ElkPoint } from 'elkjs/lib/elk.bundled.js'
import type { ReactElement } from 'react'
import { BasisBadge, DecisionBadge, ExecutionBadge, executionTone } from './badges.js'
import { plural } from './format.js'
import { DisclosureGlyph } from './glyphs.js'
import { actionForms, agentRoleLabel, serviceAgentLabel, stageOriginLabel, substageForms } from './labels.js'
import type { EdgeKind, MapStage } from './map-graph.js'

type StageNodeData = {
  readonly node: MapStage
  readonly open: boolean
  readonly card?: ElkPoint
  readonly onToggle: (stage: StageId, open: boolean) => void
}

export type StageFlowNode = Node<StageNodeData, 'stage'>

type RouteEdgeData = {
  readonly kind: EdgeKind
  readonly points: readonly ElkPoint[]
  readonly label: string
}

export type RouteFlowEdge = Edge<RouteEdgeData, 'route'>

const agentLabel = (agent: Agent): string =>
  agent.agent_type ??
  agent.name ??
  (agent.service === null ? agentRoleLabel[agent.role] : serviceAgentLabel[agent.service])

const StageCard = ({ node, open, card, onToggle }: StageNodeData): ReactElement => {
  const { stage, children, actions, agents } = node
  const team = agents.map(agentLabel).join(', ')
  return (
    <article
      className="stage-card"
      data-tone={executionTone(stage.execution.value)}
      data-stacked={!open && children.length > 0}
      style={card === undefined ? undefined : { left: card.x, top: card.y }}
    >
      <header className="stage-head">
        {children.length === 0 ? null : (
          <button
            type="button"
            className="stage-toggle nodrag nopan"
            aria-expanded={open}
            aria-label={`${open ? 'Свернуть' : 'Развернуть'} «${stage.title}»`}
            onClick={() => {
              onToggle(stage.id, !open)
            }}
          >
            <DisclosureGlyph open={open} />
          </button>
        )}
        <h3 className="stage-title" title={stage.title}>
          {stage.title}
        </h3>
      </header>
      <ul className="stage-axes">
        <li>
          <span className="visually-hidden">Выполнение: </span>
          <ExecutionBadge execution={stage.execution.value} />
        </li>
        <li>
          <span className="visually-hidden">Основание: </span>
          <BasisBadge basis={stage.execution.basis} />
        </li>
        <li>
          <span className="visually-hidden">Решение человека: </span>
          <DecisionBadge decision={stage.decision.value} />
        </li>
      </ul>
      <p className="stage-meta">
        <span>{stageOriginLabel[stage.origin]}</span>
        {children.length === 0 ? null : <span>{plural(children.length, substageForms)}</span>}
        {actions === 0 ? null : <span>{plural(actions, actionForms)}</span>}
        {agents.length === 0 ? null : (
          <span className="stage-team" title={team}>
            {`${agents.length === 1 ? 'агент' : 'агенты'}: ${team}`}
          </span>
        )}
      </p>
    </article>
  )
}

export const StageNode = ({ data }: NodeProps<StageFlowNode>): ReactElement => (
  <div className="map-stage" data-open={data.open}>
    <Handle type="target" position={Position.Left} isConnectable={false} className="map-handle" />
    <StageCard {...data} />
    <Handle type="source" position={Position.Right} isConnectable={false} className="map-handle" />
  </div>
)

const routePath = (points: readonly ElkPoint[]): string =>
  points.map(({ x, y }, index) => `${index === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`).join(' ')

export const RouteEdge = ({ data }: EdgeProps<RouteFlowEdge>): ReactElement | null =>
  data === undefined ? null : (
    <path
      className="map-route"
      data-kind={data.kind}
      d={routePath(data.points)}
      markerEnd={`url(#map-arrow-${data.kind})`}
    >
      <title>{data.label}</title>
    </path>
  )
