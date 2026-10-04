import ELK, { type ElkExtendedEdge, type ElkNode, type ElkPoint } from 'elkjs/lib/elk.bundled.js'
import type { VisibleMap } from './map-graph.js'

export const card = { width: 248, height: 156, inset: 12 } as const

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
  readonly cards: ReadonlyMap<string, Placement>
  readonly routes: ReadonlyMap<string, readonly ElkPoint[]>
}

export type LayoutEngine = Pick<InstanceType<typeof ELK>, 'layout'>

const elk = new ELK()

const px = (value: number): string => String(value)

const spacing: Record<string, string> = {
  'elk.spacing.nodeNode': '28',
  'elk.spacing.edgeNode': '16',
  'elk.spacing.edgeEdge': '10',
  'elk.layered.spacing.nodeNodeBetweenLayers': '56',
  'elk.layered.spacing.edgeNodeBetweenLayers': '20',
}

const graphOptions = (direction: MapDirection): Record<string, string> => ({
  'elk.algorithm': 'layered',
  'elk.direction': direction,
  'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.padding': '[top=24,left=24,bottom=24,right=24]',
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  ...spacing,
})

const enclosureOptions: Record<string, string> = {
  'elk.padding': `[top=${px(card.inset)},left=${px(card.inset)},bottom=${px(card.inset + 8)},right=${px(card.inset + 8)}]`,
  ...spacing,
}

const cardOptions: Record<string, string> = { 'elk.layered.layering.layerConstraint': 'FIRST' }

const cardOf = (stage: string): string => `${stage}:card`

const loops = (start: string, next: ReadonlyMap<string, readonly string[]>): boolean => {
  const seen = new Set<string>()
  const queue = [...(next.get(start) ?? [])]
  for (const stage of queue) {
    if (stage === start) {
      return true
    }
    if (!seen.has(stage)) {
      seen.add(stage)
      queue.push(...(next.get(stage) ?? []))
    }
  }
  return false
}

const elkGraph = (map: VisibleMap, direction: MapDirection, cardsFirst: boolean): ElkNode => {
  const roots: ElkNode[] = []
  const enclosures = new Map<string, ElkNode[]>()
  const parents = new Map<string, string | null>()
  for (const { node, parent, open } of map.stages) {
    const id = node.stage.id
    parents.set(id, parent)
    const children: ElkNode[] = []
    if (open) {
      children.push({
        id: cardOf(id),
        width: card.width,
        height: card.height,
        ...(cardsFirst ? { layoutOptions: cardOptions } : {}),
      })
      enclosures.set(id, children)
    }
    const elkNode: ElkNode = open
      ? { id, layoutOptions: enclosureOptions, children }
      : { id, width: card.width, height: card.height }
    const siblings = parent === null ? roots : (enclosures.get(parent) ?? roots)
    siblings.push(elkNode)
  }
  const holder = (enclosure: string, stage: string): string | null => {
    const parent = parents.get(stage) ?? null
    return parent === null ? null : parent === enclosure ? stage : holder(enclosure, parent)
  }
  const end = (stage: string, other: string): string =>
    enclosures.has(stage) && holder(stage, other) !== null ? cardOf(stage) : stage
  const edges: ElkExtendedEdge[] = map.edges.map(({ id, from, to }) => ({
    id,
    sources: [end(from, to)],
    targets: [end(to, from)],
  }))
  const anchors = [...enclosures.keys()].flatMap((enclosure): ElkExtendedEdge[] => {
    const led = new Set<string>()
    const next = new Map<string, string[]>()
    for (const { from, to } of map.edges) {
      const source = from === enclosure ? cardOf(enclosure) : holder(enclosure, from)
      const target = holder(enclosure, to)
      if (source !== null && target !== null && source !== target) {
        led.add(target)
        next.set(source, [...(next.get(source) ?? []), target])
      }
    }
    return map.stages
      .filter(({ parent }) => parent === enclosure)
      .map(({ node }) => node.stage.id)
      .filter((stage) => !led.has(stage) || loops(stage, next))
      .map((stage) => ({ id: `${cardOf(enclosure)}>${stage}`, sources: [cardOf(enclosure)], targets: [stage] }))
  })
  return {
    id: 'map',
    layoutOptions: graphOptions(direction),
    children: roots,
    edges: cardsFirst ? [...edges, ...anchors] : edges,
  }
}

export const layoutMap = async (
  map: VisibleMap,
  direction: MapDirection,
  engine: LayoutEngine = elk,
): Promise<MapLayout> => {
  const result = await engine
    .layout(elkGraph(map, direction, true))
    .catch(async () => engine.layout(elkGraph(map, direction, false)))
  const nodes = new Map<string, Placement>()
  const cards = new Map<string, Placement>()
  const origins = new Map<string, ElkPoint>([[result.id, { x: 0, y: 0 }]])
  const visit = (node: ElkNode, origin: ElkPoint): void => {
    for (const child of node.children ?? []) {
      const placement = { x: child.x ?? 0, y: child.y ?? 0, width: child.width ?? 0, height: child.height ?? 0 }
      if (child.id === cardOf(node.id)) {
        cards.set(node.id, placement)
        continue
      }
      const absolute = { x: origin.x + placement.x, y: origin.y + placement.y }
      nodes.set(child.id, placement)
      origins.set(child.id, absolute)
      visit(child, absolute)
    }
  }
  visit(result, { x: 0, y: 0 })
  const drawn = new Set(map.edges.map(({ id }) => id))
  const routes = new Map<string, readonly ElkPoint[]>()
  for (const edge of (result.edges ?? []).filter(({ id }) => drawn.has(id))) {
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
  return { source: map, height: result.height ?? 0, nodes, cards, routes }
}
