import '@xyflow/react/dist/base.css'
import type { RunSnapshot, StageId } from '@catacomb/contract'
import {
  Background,
  BackgroundVariant,
  ControlButton,
  Controls,
  type NodeHandle,
  Position,
  ReactFlow,
  useReactFlow,
  useStore,
} from '@xyflow/react'
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { basisLabel } from './labels.js'
import {
  type MapEdge,
  type MapStage,
  type StageGraph,
  openOnMap,
  stageGraph,
  type VisibleGroup,
  type VisibleMap,
  visibleMap,
} from './map-graph.js'
import { FitGlyph } from './glyphs.js'
import {
  fittedViewport,
  keptViewport,
  layoutMap,
  type MapDirection,
  type MapLayout,
  readableZoom,
  revealedViewport,
} from './map-layout.js'
import {
  type GroupFlowNode,
  GroupNode,
  RouteEdge,
  type RouteFlowEdge,
  type Selection,
  StageNode,
  type StageFlowNode,
  type StageView,
} from './map-node.js'
import { type AgentIds, shortIds, useKnownAgents } from './short-ids.js'
import type { StageSelection } from './stage-lineage.js'
import { type PlacementOf, placementsOf } from './view-placement.js'

const nodeTypes = { stage: StageNode, frame: GroupNode }

const edgeTypes = { route: RouteEdge }

const ariaLabelConfig = {
  'controls.ariaLabel': 'Map zoom',
  'controls.zoomIn.ariaLabel': 'Zoom in',
  'controls.zoomOut.ariaLabel': 'Zoom out',
}

const proOptions = { hideAttribution: true }

type Layout = MapLayout | Error | null

const narrowScreen = '(max-width: 760px)'

const subscribeToWidth = (notify: () => void): (() => void) => {
  const query = window.matchMedia(narrowScreen)
  query.addEventListener('change', notify)
  return () => {
    query.removeEventListener('change', notify)
  }
}

const directionNow = (): MapDirection => (window.matchMedia(narrowScreen).matches ? 'DOWN' : 'RIGHT')

interface LaidOut {
  readonly map: VisibleMap
  readonly direction: MapDirection
  readonly layout: MapLayout | Error
}

interface LayoutState {
  readonly layout: Layout
  readonly upToDate: boolean
}

const useLayout = (map: VisibleMap): LayoutState => {
  const [laid, setLaid] = useState<LaidOut | null>(null)
  const direction = useSyncExternalStore(subscribeToWidth, directionNow)
  useEffect(() => {
    let current = true
    const settle = (layout: MapLayout | Error): void => {
      if (current) {
        setLaid({ map, direction, layout })
      }
    }
    layoutMap(map, direction).then(settle, (error: unknown) => {
      settle(error instanceof Error ? error : new Error(String(error)))
    })
    return () => {
      current = false
    }
  }, [map, direction])
  return { layout: laid?.layout ?? null, upToDate: laid?.map === map && laid.direction === direction }
}

const minZoom = 0.2

interface FollowLayoutProps {
  readonly layout: MapLayout
  readonly following: boolean
  readonly request: number
  readonly onPlaced: (layout: MapLayout) => void
}

const FollowLayout = ({ layout, following, request, onPlaced }: FollowLayoutProps): null => {
  const { setViewport } = useReactFlow()
  const fitted = useRef(request)
  const canvas = useStore((state) => state.domNode)
  const width = useStore((state) => state.width)
  const height = useStore((state) => state.height)
  useEffect(() => {
    const area = { width: canvas?.offsetWidth ?? width, height: canvas?.offsetHeight ?? height }
    if (following && area.width > 0 && area.height > 0) {
      void setViewport(fittedViewport(layout, area, request === fitted.current ? readableZoom : minZoom))
      fitted.current = request
      onPlaced(layout)
    }
  }, [layout, following, request, setViewport, onPlaced, canvas, width, height])
  return null
}

interface KeepPlaceProps {
  readonly layout: MapLayout
  readonly following: boolean
  readonly selection: StageSelection | null
  readonly onPlaced: (layout: MapLayout) => void
}

const KeepPlace = ({ layout, following, selection, onPlaced }: KeepPlaceProps): null => {
  const { getViewport, setViewport } = useReactFlow()
  const canvas = useStore((state) => state.domNode)
  const width = useStore((state) => state.width)
  const height = useStore((state) => state.height)
  const shown = useRef(layout)
  const seen = useRef({ width, height })
  useEffect(() => {
    const before = shown.current
    const area = seen.current
    shown.current = layout
    seen.current = { width, height }
    if (following) {
      return
    }
    const lineage = selection?.lineage ?? []
    const viewport = getViewport()
    const kept = before === layout ? null : keptViewport(before, layout, lineage, { ...viewport, ...area })
    const place = kept ?? viewport
    const resized = area.width !== width || area.height !== height
    const revealed = resized ? revealedViewport(layout, lineage, { ...viewport, ...place, width, height }, area) : null
    const next = revealed ?? place
    if (next.x !== viewport.x || next.y !== viewport.y) {
      void setViewport({ x: next.x, y: next.y, zoom: viewport.zoom })
    }
    if (canvas?.offsetWidth === width && canvas.offsetHeight === height) {
      onPlaced(layout)
    }
  }, [layout, following, selection, width, height, canvas, onPlaced, getViewport, setViewport])
  return null
}

const plainView: StageView = { folded: null, group: null }

const stageViews = (graph: StageGraph, placement: PlacementOf): ReadonlyMap<StageId, StageView> => {
  const views = new Map<StageId, StageView>()
  const visit = (node: MapStage): void => {
    const placed = placement({ kind: 'stage', id: node.stage.id })
    const visibility = placed?.visibility ?? null
    views.set(node.stage.id, {
      folded: visibility?.state === 'collapsed' ? visibility.totals : null,
      group: placed?.group?.name ?? null,
    })
    for (const child of node.children) {
      visit(child)
    }
  }
  for (const root of graph.roots) {
    visit(root)
  }
  return views
}

const edgeLabel = ({ kind, from, to, bases }: MapEdge, titles: ReadonlyMap<string, string>): string => {
  const source = `"${titles.get(from) ?? from}"`
  const target = `"${titles.get(to) ?? to}"`
  return kind === 'dependency'
    ? `${target} uses the output of ${source}, basis: ${bases.map((basis) => basisLabel[basis]).join(', ')}`
    : `${target} started after ${source} finished`
}

interface NodeActions {
  readonly onToggle: (stage: StageId, open: boolean) => void
  readonly onSelect: (stage: StageId | null) => void
}

const selectionOf = ({ source }: MapLayout, node: StageId, selected: StageId | null): Selection =>
  selected === null ? 'none' : selected === node ? 'self' : source.holders.get(selected) === node ? 'inside' : 'none'

const unplaced = { x: 0, y: 0, width: 0, height: 0 } as const

const sideHandles = (width: number, height: number): NodeHandle[] => [
  { type: 'target', position: Position.Left, x: 0, y: height / 2, width: 1, height: 1 },
  { type: 'source', position: Position.Right, x: width - 1, y: height / 2, width: 1, height: 1 },
]

const groupNode = (layout: MapLayout, { id, name, parent, members }: VisibleGroup): GroupFlowNode => {
  const { x, y, width, height } = layout.nodes.get(id) ?? unplaced
  return {
    id,
    type: 'frame',
    position: { x, y },
    width,
    height,
    measured: { width, height },
    handles: [],
    ...(parent === null ? {} : { parentId: parent }),
    data: { name, members: members.length },
    draggable: false,
    selectable: false,
    connectable: false,
    ariaRole: 'group',
    ariaLabel: `Stage group "${name}"`,
  }
}

const flowNodes = (
  layout: MapLayout,
  selected: StageId | null,
  views: ReadonlyMap<StageId, StageView>,
  agents: AgentIds,
  { onToggle, onSelect }: NodeActions,
): Array<StageFlowNode | GroupFlowNode> => {
  const groups = new Map(layout.source.groups.map((group) => [group.id, group]))
  const framed = new Set<string>()
  return layout.source.stages.flatMap(({ node, parent, frame, open }) => {
    const group = frame === null || framed.has(frame) ? undefined : groups.get(frame)
    if (group !== undefined) {
      framed.add(group.id)
    }
    const { x, y, width, height } = layout.nodes.get(node.stage.id) ?? unplaced
    const card = layout.cards.get(node.stage.id)
    const holder = frame ?? parent
    const stage: StageFlowNode = {
      id: node.stage.id,
      type: 'stage',
      position: { x, y },
      width,
      height,
      measured: { width, height },
      handles: sideHandles(width, height),
      ...(holder === null ? {} : { parentId: holder }),
      data: {
        node,
        view: views.get(node.stage.id) ?? plainView,
        open,
        selection: selectionOf(layout, node.stage.id, selected),
        onToggle,
        onSelect,
        ...(card === undefined ? {} : { card }),
      },
      draggable: false,
      selectable: false,
      connectable: false,
      ariaRole: 'group',
      ariaLabel: `Stage "${shortIds(node.stage.title, agents)}"`,
    }
    return group === undefined ? [stage] : [groupNode(layout, group), stage]
  })
}

const flowEdges = ({ source, routes }: MapLayout, agents: AgentIds): RouteFlowEdge[] => {
  const titles = new Map(source.stages.map(({ node }) => [node.stage.id, shortIds(node.stage.title, agents)]))
  return source.edges.map((edge) => {
    const label = edgeLabel(edge, titles)
    return {
      id: edge.id,
      type: 'route',
      source: edge.from,
      target: edge.to,
      data: { kind: edge.kind, points: routes.get(edge.id) ?? [], label },
      selectable: false,
      focusable: false,
      ariaLabel: label,
    }
  })
}

const Markers = (): ReactElement => (
  <svg className="map-markers" aria-hidden="true" focusable="false">
    <defs>
      <marker
        id="map-arrow-dependency"
        viewBox="0 0 10 10"
        refX="9"
        refY="5"
        markerWidth="9"
        markerHeight="9"
        markerUnits="userSpaceOnUse"
        orient="auto"
      >
        <path d="M0 1 10 5 0 9Z" />
      </marker>
      <marker
        id="map-arrow-order"
        viewBox="0 0 10 10"
        refX="8"
        refY="5"
        markerWidth="8"
        markerHeight="8"
        markerUnits="userSpaceOnUse"
        orient="auto"
      >
        <path d="M1 1.5 8 5 1 8.5" />
      </marker>
    </defs>
  </svg>
)

const Legend = (): ReactElement => (
  <ul className="map-legend" aria-label="Map lines">
    <li>
      <svg viewBox="0 0 34 10" width="34" height="10" aria-hidden="true" focusable="false">
        <path className="map-route" data-kind="dependency" d="M1 5H24" markerEnd="url(#map-arrow-dependency)" />
      </svg>
      uses the output
    </li>
    <li>
      <svg viewBox="0 0 34 10" width="34" height="10" aria-hidden="true" focusable="false">
        <path className="map-route" data-kind="order" d="M1 5H25" markerEnd="url(#map-arrow-order)" />
      </svg>
      later in time, no link
    </li>
  </ul>
)

interface StageMapProps {
  readonly snapshot: RunSnapshot
  readonly selection: StageSelection | null
  readonly onSelect: (stage: StageId | null) => void
  readonly toggled: ReadonlyMap<StageId, boolean>
  readonly onToggle: (stage: StageId, open: boolean) => void
}

export const StageMap = ({ snapshot, selection, onSelect, toggled, onToggle }: StageMapProps): ReactElement => {
  const selected = selection?.stage.id ?? null
  const graph = useMemo(() => stageGraph(snapshot), [snapshot])
  const placement = useMemo(() => placementsOf(snapshot.view), [snapshot.view])
  const views = useMemo(() => stageViews(graph, placement), [graph, placement])
  const visible = useMemo(() => {
    const folded = (stage: MapStage): boolean => (views.get(stage.stage.id)?.folded ?? null) !== null
    return visibleMap(
      graph,
      (stage) => openOnMap(stage, toggled, folded(stage)),
      (stage) => views.get(stage.stage.id)?.group ?? null,
    )
  }, [graph, toggled, views])
  const { layout, upToDate } = useLayout(visible)
  const [following, setFollowing] = useState(true)
  const [fitRequest, setFitRequest] = useState(0)
  const [placed, setPlaced] = useState<MapLayout | null>(null)
  const onPlaced = useCallback((shown: MapLayout) => {
    setPlaced(shown)
  }, [])
  const agents = useKnownAgents()
  const nodes = useMemo(
    () =>
      layout instanceof Error || layout === null
        ? []
        : flowNodes(layout, selected, views, agents, { onToggle, onSelect }),
    [layout, selected, views, agents, onToggle, onSelect],
  )
  const edges = useMemo(
    () => (layout instanceof Error || layout === null ? [] : flowEdges(layout, agents)),
    [layout, agents],
  )
  if (layout === null) {
    return <p className="map-note">Laying out the map…</p>
  }
  if (layout instanceof Error) {
    return <p className="map-note">{`Could not lay out the map: ${layout.message}`}</p>
  }
  return (
    <>
      <Markers />
      <Legend />
      <div className="map-canvas" data-placed={placed !== null}>
        <ReactFlow
          aria-busy={!upToDate || placed !== layout}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          ariaLabelConfig={ariaLabelConfig}
          proOptions={proOptions}
          minZoom={minZoom}
          maxZoom={1.5}
          nodesDraggable={false}
          nodesConnectable={false}
          nodesFocusable={false}
          edgesFocusable={false}
          elementsSelectable={false}
          zoomOnScroll={false}
          preventScrolling={false}
          onMove={(event) => {
            if (event !== null) {
              setFollowing(false)
            }
          }}
        >
          <FollowLayout layout={layout} following={following} request={fitRequest} onPlaced={onPlaced} />
          <KeepPlace layout={layout} following={following} selection={selection} onPlaced={onPlaced} />
          <Background variant={BackgroundVariant.Cross} gap={32} size={7} color="var(--map-grid)" />
          <Controls
            showInteractive={false}
            showFitView={false}
            position="bottom-left"
            onZoomIn={() => {
              setFollowing(false)
            }}
            onZoomOut={() => {
              setFollowing(false)
            }}
          >
            <ControlButton
              className="react-flow__controls-fitview"
              aria-label="Fit the map"
              title="Fit the map"
              onClick={() => {
                setFollowing(true)
                setFitRequest((count) => count + 1)
              }}
            >
              <FitGlyph />
            </ControlButton>
          </Controls>
        </ReactFlow>
      </div>
    </>
  )
}
