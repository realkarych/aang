import type { Agent, DetailLevel, StageId, ViewTotals } from '@aang/contract'
import { type Edge, type EdgeProps, Handle, type Node, type NodeProps, Position } from '@xyflow/react'
import type { ElkPoint } from 'elkjs/lib/elk.bundled.js'
import type { ReactElement } from 'react'
import { BasisBadge, DecisionBadge, ExecutionBadge, executionTone } from './badges.js'
import { plural } from './format.js'
import { DisclosureGlyph } from './glyphs.js'
import {
  actionForms,
  agentRoleLabel,
  serviceAgentLabel,
  stageForms,
  stageOriginLabel,
  substageForms,
} from './labels.js'
import type { EdgeKind, MapStage } from './map-graph.js'
import { shortIds } from './short-ids.js'
import { detailLevelLabel, totalsText } from './view-labels.js'

export type Selection = 'self' | 'inside' | 'none'

export interface StageView {
  readonly folded: ViewTotals | null
  readonly group: string | null
  readonly detail: DetailLevel | null
  readonly level: DetailLevel
}

type StageNodeData = {
  readonly node: MapStage
  readonly view: StageView
  readonly open: boolean
  readonly card?: ElkPoint
  readonly selection: Selection
  readonly onToggle: (stage: StageId, open: boolean) => void
  readonly onSelect: (stage: StageId | null) => void
}

export type StageFlowNode = Node<StageNodeData, 'stage'>

type GroupNodeData = {
  readonly name: string
  readonly members: number
}

export type GroupFlowNode = Node<GroupNodeData, 'frame'>

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

const StageCard = ({ node, view, open, card, selection, onToggle, onSelect }: StageNodeData): ReactElement => {
  const { stage, children, actions, agents } = node
  const team = agents.map(agentLabel).join(', ')
  const selected = selection === 'self'
  const title = shortIds(stage.title)
  return (
    <article
      className="stage-card"
      data-tone={executionTone(stage.execution.value)}
      data-stacked={!open && children.length > 0}
      data-folded={view.folded !== null}
      data-selection={selection}
      style={card === undefined ? undefined : { left: card.x, top: card.y }}
      onClick={() => {
        onSelect(selected ? null : stage.id)
      }}
    >
      <header className="stage-head">
        {children.length === 0 || view.folded !== null ? null : (
          <button
            type="button"
            className="stage-toggle nodrag nopan"
            aria-expanded={open}
            aria-label={`${open ? 'Свернуть' : 'Развернуть'} «${title}»`}
            onClick={(event) => {
              event.stopPropagation()
              onToggle(stage.id, !open)
            }}
          >
            <DisclosureGlyph open={open} />
          </button>
        )}
        <h3 className="stage-title" title={stage.title}>
          <button type="button" className="stage-pick" aria-pressed={selected}>
            {title}
          </button>
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
        {view.detail === null ? null : <span>{`детализация: ${detailLevelLabel[view.detail]}`}</span>}
        {view.folded === null ? (
          <>
            <span>{stageOriginLabel[stage.origin]}</span>
            {children.length === 0 ? null : <span>{plural(children.length, substageForms)}</span>}
            {actions === 0 || view.level !== 'all_actions' ? null : <span>{plural(actions, actionForms)}</span>}
            {agents.length === 0 || view.level === 'stages' ? null : (
              <span className="stage-team" title={team}>
                {`${agents.length === 1 ? 'агент' : 'агенты'}: ${team}`}
              </span>
            )}
          </>
        ) : (
          <span className="stage-folded" title={totalsText(view.folded)}>
            {`свёрнут правилом вида: ${totalsText(view.folded)}`}
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

export const GroupNode = ({ data }: NodeProps<GroupFlowNode>): ReactElement => (
  <div className="map-group">
    <p className="map-group-name" title={data.name}>
      {`Группа «${data.name}» · ${plural(data.members, stageForms)}`}
    </p>
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
