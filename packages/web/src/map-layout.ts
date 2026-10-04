import ELK, { type ElkExtendedEdge, type ElkNode, type ElkPoint } from 'elkjs/lib/elk.bundled.js'
import type { VisibleMap } from './map-graph.js'

export const card = { width: 248, height: 156, inset: 12 } as const

const cardGap = 40

export type MapDirection = 'RIGHT' | 'DOWN'

export interface Placement {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface MapLayout {
  readonly source: VisibleMap
  readonly height: number
  readonly nodes: ReadonlyMap<string, Placement>
  readonly routes: ReadonlyMap<string, readonly ElkPoint[]>
}

const elk = new ELK()

const px = (value: number): string => String(value)

const graphOptions = (direction: MapDirection): Record<string, string> => ({
  'elk.algorithm': 'layered',
  'elk.direction': direction,
  'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.padding': '[top=24,left=24,bottom=24,right=24]',
  'elk.spacing.nodeNode': '28',
  'elk.spacing.edgeNode': '16',
  'elk.spacing.edgeEdge': '10',
  'elk.layered.spacing.nodeNodeBetweenLayers': '56',
  'elk.layered.spacing.edgeNodeBetweenLayers': '20',
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
})

const leading = { top: card.inset, left: card.inset, bottom: card.inset + 8, right: card.inset + 8 }

const enclosureOptions = (direction: MapDirection): Record<string, string> => {
  const { top, left, bottom, right } =
    direction === 'RIGHT'
      ? { ...leading, left: leading.left + card.width + cardGap, bottom: card.inset }
      : { ...leading, top: leading.top + card.height + cardGap, right: card.inset }
  return {
    'elk.padding': `[top=${px(top)},left=${px(left)},bottom=${px(bottom)},right=${px(right)}]`,
    'elk.nodeSize.constraints': 'MINIMUM_SIZE',
    'elk.nodeSize.minimum': `(${px(card.width + 2 * card.inset)},${px(card.height + 2 * card.inset)})`,
  }
}

const elkGraph = (map: VisibleMap, direction: MapDirection): ElkNode => {
  const roots: ElkNode[] = []
  const enclosures = new Map<string, ElkNode[]>()
  for (const { node, parent, open } of map.stages) {
    const id = node.stage.id
    const children: ElkNode[] = []
    if (open) {
      enclosures.set(id, children)
    }
    const elkNode: ElkNode = open
      ? { id, layoutOptions: enclosureOptions(direction), children }
      : { id, width: card.width, height: card.height }
    const siblings = parent === null ? roots : (enclosures.get(parent) ?? roots)
    siblings.push(elkNode)
  }
  const edges: ElkExtendedEdge[] = map.edges.map(({ id, from, to }) => ({ id, sources: [from], targets: [to] }))
  return { id: 'map', layoutOptions: graphOptions(direction), children: roots, edges }
}

export const layoutMap = async (map: VisibleMap, direction: MapDirection): Promise<MapLayout> => {
  const result = await elk.layout(elkGraph(map, direction))
  const nodes = new Map<string, Placement>()
  const origins = new Map<string, ElkPoint>([[result.id, { x: 0, y: 0 }]])
  const visit = (node: ElkNode, origin: ElkPoint): void => {
    for (const child of node.children ?? []) {
      const placement = { x: child.x ?? 0, y: child.y ?? 0, width: child.width ?? 0, height: child.height ?? 0 }
      const absolute = { x: origin.x + placement.x, y: origin.y + placement.y }
      nodes.set(child.id, placement)
      origins.set(child.id, absolute)
      visit(child, absolute)
    }
  }
  visit(result, { x: 0, y: 0 })
  const routes = new Map<string, readonly ElkPoint[]>()
  for (const edge of result.edges ?? []) {
    const origin = origins.get(edge.container ?? result.id) ?? { x: 0, y: 0 }
    const points = (edge.sections ?? []).flatMap(({ startPoint, bendPoints = [], endPoint }) => [
      startPoint,
      ...bendPoints,
      endPoint,
    ])
    routes.set(
      edge.id,
      points.map(({ x, y }) => ({ x: origin.x + x, y: origin.y + y })),
    )
  }
  return { source: map, height: result.height ?? 0, nodes, routes }
}
