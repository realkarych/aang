import type { StageId } from '@aang/contract'
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
  readonly cardsOnMap: ReadonlyMap<string, ElkPoint>
  readonly routes: ReadonlyMap<string, readonly ElkPoint[]>
}

export type LayoutEngine = Pick<InstanceType<typeof ELK>, 'layout'>

const elk = new ELK()

const px = (value: number): string => String(value)

const levelOptions = (direction: MapDirection): Record<string, string> => ({
  'elk.algorithm': 'layered',
  'elk.direction': direction,
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.separateConnectedComponents': 'false',
  'elk.spacing.nodeNode': '28',
  'elk.spacing.edgeNode': '16',
  'elk.spacing.edgeEdge': '10',
  'elk.layered.spacing.nodeNodeBetweenLayers': '56',
  'elk.layered.spacing.edgeNodeBetweenLayers': '20',
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  'elk.layered.crossingMinimization.forceNodeModelOrder': 'true',
})

const enclosureOptions = (direction: MapDirection): Record<string, string> => ({
  ...levelOptions(direction),
  'elk.padding': `[top=${px(card.inset)},left=${px(card.inset)},bottom=${px(card.inset + 8)},right=${px(card.inset + 8)}]`,
})

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

interface ElkMap {
  readonly graph: ElkNode
  readonly pieces: ReadonlyMap<string, readonly string[]>
}

const elkMap = (map: VisibleMap, direction: MapDirection, cardsFirst: boolean): ElkMap => {
  const graph: ElkNode = {
    id: 'map',
    layoutOptions: { ...levelOptions(direction), 'elk.padding': '[top=24,left=24,bottom=24,right=24]' },
    children: [],
    edges: [],
  }
  const enclosures = new Map<string, ElkNode>()
  const containerOf = (stage: string | null): ElkNode => (stage === null ? graph : (enclosures.get(stage) ?? graph))
  const parents = new Map<string, StageId | null>()
  for (const { node, parent, open } of map.stages) {
    const id = node.stage.id
    const elkNode: ElkNode = open
      ? {
          id,
          layoutOptions: enclosureOptions(direction),
          ports: [],
          children: [
            {
              id: cardOf(id),
              width: card.width,
              height: card.height,
              ...(cardsFirst ? { layoutOptions: cardOptions } : {}),
            },
          ],
          edges: [],
        }
      : { id, width: card.width, height: card.height }
    if (open) {
      enclosures.set(id, elkNode)
    }
    parents.set(id, parent)
    containerOf(parent).children?.push(elkNode)
  }
  const ancestry = (stage: string): string[] => {
    const parent = parents.get(stage) ?? null
    return parent === null ? [stage] : [...ancestry(parent), stage]
  }
  const pieces = new Map<string, string[]>()
  for (const { id, from, to } of map.edges) {
    const sources = ancestry(from)
    const targets = ancestry(to)
    const shared = sources.filter((stage, index) => stage === targets[index]).length
    const portOf = (stage: string): string => {
      const port = `${id}@${stage}`
      enclosures.get(stage)?.ports?.push({ id: port, width: 0, height: 0 })
      return port
    }
    const route: Array<{ readonly within: string | null; readonly source: string; readonly target: string }> = []
    let start = shared === sources.length ? cardOf(from) : from
    for (const outer of sources.slice(shared, -1).toReversed()) {
      const port = portOf(outer)
      route.push({ within: outer, source: start, target: port })
      start = port
    }
    const inward = targets.slice(shared, -1).map((outer) => ({ outer, port: portOf(outer) }))
    const finish = shared === targets.length ? cardOf(to) : (inward[0]?.port ?? to)
    route.push({ within: shared === 0 ? null : (sources[shared - 1] ?? null), source: start, target: finish })
    inward.forEach(({ outer, port }, index) => {
      route.push({ within: outer, source: port, target: inward[index + 1]?.port ?? to })
    })
    pieces.set(
      id,
      route.map(({ within, source, target }, index) => {
        const piece = `${id}#${String(index)}`
        containerOf(within).edges?.push({ id: piece, sources: [source], targets: [target] })
        return piece
      }),
    )
  }
  if (cardsFirst) {
    const holder = (enclosure: string, stage: string): string | null => {
      const parent = parents.get(stage) ?? null
      return parent === null ? null : parent === enclosure ? stage : holder(enclosure, parent)
    }
    for (const [enclosure, frame] of enclosures) {
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
      const anchors = map.stages
        .filter(({ parent }) => parent === enclosure)
        .map(({ node }) => node.stage.id)
        .filter((stage) => !led.has(stage) || loops(stage, next))
        .map((stage): ElkExtendedEdge => ({ id: `${cardOf(enclosure)}>${stage}`, sources: [cardOf(enclosure)], targets: [stage] }))
      frame.edges?.push(...anchors)
    }
  }
  return { graph, pieces }
}

const joined = (points: readonly ElkPoint[]): ElkPoint[] =>
  points.filter((point, index) => {
    const previous = points[index - 1]
    return previous === undefined || previous.x !== point.x || previous.y !== point.y
  })

const placed = async (map: VisibleMap, direction: MapDirection, engine: LayoutEngine): Promise<ElkMap> => {
  const constrained = elkMap(map, direction, true)
  return engine.layout(constrained.graph).then(
    (graph) => ({ ...constrained, graph }),
    async () => {
      const free = elkMap(map, direction, false)
      return { ...free, graph: await engine.layout(free.graph) }
    },
  )
}

export const layoutMap = async (
  map: VisibleMap,
  direction: MapDirection,
  engine: LayoutEngine = elk,
): Promise<MapLayout> => {
  const { graph: result, pieces } = await placed(map, direction, engine)
  const nodes = new Map<string, Placement>()
  const cards = new Map<string, Placement>()
  const cardsOnMap = new Map<string, ElkPoint>()
  const segments = new Map<string, readonly ElkPoint[]>()
  const visit = (container: ElkNode, origin: ElkPoint): void => {
    for (const edge of container.edges ?? []) {
      const points = (edge.sections ?? []).flatMap(({ startPoint, bendPoints = [], endPoint }) => [
        startPoint,
        ...bendPoints,
        endPoint,
      ])
      segments.set(
        edge.id,
        points.map(({ x, y }) => ({ x: origin.x + x, y: origin.y + y })),
      )
    }
    for (const child of container.children ?? []) {
      const placement = { x: child.x ?? 0, y: child.y ?? 0, width: child.width ?? 0, height: child.height ?? 0 }
      const absolute = { x: origin.x + placement.x, y: origin.y + placement.y }
      if (child.id === cardOf(container.id)) {
        cards.set(container.id, placement)
        cardsOnMap.set(container.id, absolute)
        continue
      }
      nodes.set(child.id, placement)
      if (child.children === undefined) {
        cardsOnMap.set(child.id, absolute)
      }
      visit(child, absolute)
    }
  }
  visit(result, { x: 0, y: 0 })
  const routes = new Map(
    [...pieces].map(([id, route]) => [id, joined(route.flatMap((piece) => segments.get(piece) ?? []))] as const),
  )
  return { source: map, height: result.height ?? 0, nodes, cards, cardsOnMap, routes }
}

export interface Area {
  readonly width: number
  readonly height: number
}

export interface Viewport extends Area {
  readonly x: number
  readonly y: number
  readonly zoom: number
}

const shownCard = (layout: MapLayout, stage: StageId): ElkPoint | undefined => {
  const holder = layout.source.holders.get(stage)
  return holder === undefined ? undefined : layout.cardsOnMap.get(holder)
}

const firstShown = (layout: MapLayout, stages: readonly StageId[]): ElkPoint | undefined =>
  stages.map((stage) => shownCard(layout, stage)).find((at) => at !== undefined)

const shows = ({ x: shiftX, y: shiftY, zoom, width, height }: Viewport, { x, y }: ElkPoint): boolean =>
  x * zoom + shiftX < width &&
  (x + card.width) * zoom + shiftX > 0 &&
  y * zoom + shiftY < height &&
  (y + card.height) * zoom + shiftY > 0

const nearestToCenter = <T>(view: Viewport, candidates: readonly T[], at: (candidate: T) => ElkPoint): T | undefined => {
  const center = { x: (view.width / 2 - view.x) / view.zoom, y: (view.height / 2 - view.y) / view.zoom }
  const distance = (candidate: T): number => {
    const { x, y } = at(candidate)
    return Math.hypot(x + card.width / 2 - center.x, y + card.height / 2 - center.y)
  }
  return candidates.reduce<T | undefined>(
    (nearest, next) => (nearest === undefined || distance(next) < distance(nearest) ? next : nearest),
    undefined,
  )
}

interface Shift {
  readonly from: ElkPoint
  readonly to: ElkPoint
}

export const keptViewport = (
  before: MapLayout,
  after: MapLayout,
  lineage: readonly StageId[],
  view: Viewport,
): ElkPoint | null => {
  const from = firstShown(before, lineage)
  const to = firstShown(after, lineage.toReversed())
  const kept = [...after.cardsOnMap].flatMap(([stage, at]): Shift[] => {
    const was = before.cardsOnMap.get(stage)
    return was === undefined ? [] : [{ from: was, to: at }]
  })
  const anchor =
    from !== undefined && to !== undefined && shows(view, from)
      ? { from, to }
      : nearestToCenter(view, kept, (shift) => shift.from)
  return anchor === undefined
    ? null
    : { x: view.x - (anchor.to.x - anchor.from.x) * view.zoom, y: view.y - (anchor.to.y - anchor.from.y) * view.zoom }
}

const margin = 16

const reveal = (start: number, size: number, room: number): number =>
  start + size <= 0 ? margin - start : start >= room ? Math.max(room - margin - start - size, margin - start) : 0

export const revealedViewport = (
  layout: MapLayout,
  lineage: readonly StageId[],
  view: Viewport,
  seen: Area,
): ElkPoint | null => {
  const earlier = { ...view, ...seen }
  const chosen = firstShown(layout, lineage.toReversed())
  const anchor =
    chosen !== undefined && shows(earlier, chosen)
      ? chosen
      : nearestToCenter(earlier, [...layout.cardsOnMap.values()], (at) => at)
  if (anchor === undefined || !shows(earlier, anchor) || shows(view, anchor)) {
    return null
  }
  return {
    x: view.x + reveal(anchor.x * view.zoom + view.x, card.width * view.zoom, view.width),
    y: view.y + reveal(anchor.y * view.zoom + view.y, card.height * view.zoom, view.height),
  }
}
