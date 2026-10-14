import type { Action, Agent, AttentionItem, Basis, BasisKind, RunSnapshot, Stage, StageId } from '@catacomb/contract'
import { predecessorsOf } from './stage-lineage.js'
import { isHidden, placementsOf } from './view-placement.js'

export interface Span {
  readonly start: bigint
  readonly end: bigint | null
}

export interface MapStage {
  readonly stage: Stage
  readonly parent: StageId | null
  readonly children: readonly MapStage[]
  readonly depth: number
  readonly agents: readonly Agent[]
  readonly span: Span | null
  readonly waiting: number
  readonly waitingWithin: number
}

interface Dependency {
  readonly from: StageId
  readonly to: StageId
  readonly basis: Basis
}

export interface StageGraph {
  readonly stages: ReadonlyMap<StageId, MapStage>
  readonly roots: readonly MapStage[]
  readonly dependencies: readonly Dependency[]
}

export type EdgeKind = 'dependency' | 'order'

export interface MapEdge {
  readonly id: string
  readonly kind: EdgeKind
  readonly from: StageId
  readonly to: StageId
  readonly bases: readonly BasisKind[]
}

export interface VisibleStage {
  readonly node: MapStage
  readonly parent: StageId | null
  readonly frame: string | null
  readonly open: boolean
}

export interface VisibleGroup {
  readonly id: string
  readonly name: string
  readonly parent: StageId | null
  readonly members: readonly StageId[]
}

export interface VisibleMap {
  readonly stages: readonly VisibleStage[]
  readonly groups: readonly VisibleGroup[]
  readonly edges: readonly MapEdge[]
  readonly holders: ReadonlyMap<StageId, StageId>
}

const byModelOrder = (left: Stage, right: Stage): number =>
  left.created_version - right.created_version || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)

const inheritedPlaces = (
  all: ReadonlyMap<StageId, Stage>,
  predecessors: ReadonlyMap<StageId, readonly StageId[]>,
): ((stage: Stage) => Stage) => {
  const places = new Map<StageId, Stage>()
  const placeOf = (stage: Stage): Stage => {
    const known = places.get(stage.id)
    if (known !== undefined) {
      return known
    }
    const place = (predecessors.get(stage.id) ?? [])
      .flatMap((id) => {
        const predecessor = all.get(id)
        return predecessor === undefined ? [] : [placeOf(predecessor)]
      })
      .reduce((earliest, inherited) => (byModelOrder(inherited, earliest) < 0 ? inherited : earliest), stage)
    places.set(stage.id, place)
    return place
  }
  return placeOf
}

const spanOf = ({ started_at: start, ended_at: end }: Pick<Action, 'started_at' | 'ended_at'>): Span[] =>
  start === null ? [] : [{ start, end }]

const joined = (spans: readonly Span[]): Span | null => {
  const [first, ...rest] = spans
  return first === undefined
    ? null
    : rest.reduce<Span>(
        (span, next) => ({
          start: next.start < span.start ? next.start : span.start,
          end: span.end === null || next.end === null ? null : next.end > span.end ? next.end : span.end,
        }),
        first,
      )
}

const listed = <K, V>(map: Map<K, V[]>, key: K, value: V): void => {
  map.set(key, [...(map.get(key) ?? []), value])
}

const waitingByStage = (items: readonly AttentionItem[]): ReadonlyMap<StageId, number> => {
  const counts = new Map<StageId, number>()
  for (const { stage, resolution } of items) {
    if (stage !== null && resolution === 'open') {
      counts.set(stage, (counts.get(stage) ?? 0) + 1)
    }
  }
  return counts
}

const shownStages = (snapshot: RunSnapshot): readonly Stage[] => {
  const all = new Map(snapshot.model.stages.map((stage) => [stage.id, stage]))
  const placement = placementsOf(snapshot.view)
  const concealed = (stage: Stage): boolean => {
    const passed = new Set<StageId>()
    let next: Stage | undefined = stage
    while (next !== undefined && !passed.has(next.id)) {
      if (isHidden(placement({ kind: 'stage', id: next.id }))) {
        return true
      }
      passed.add(next.id)
      next = next.parent === null ? undefined : all.get(next.parent)
    }
    return false
  }
  return snapshot.model.stages.filter((stage) => stage.lifecycle.state === 'active' && !concealed(stage))
}

export const waitingOffMap = (snapshot: RunSnapshot): AttentionItem[] => {
  const shown = new Set(shownStages(snapshot).map(({ id }) => id))
  return snapshot.attention.items.filter(
    ({ stage, resolution }) => resolution === 'open' && (stage === null || !shown.has(stage)),
  )
}

export const openOnMap = (node: MapStage, toggled: ReadonlyMap<StageId, boolean>, folded: boolean): boolean =>
  !folded && (toggled.get(node.stage.id) ?? node.depth === 0)

export interface HeldItem {
  readonly item: AttentionItem
  readonly within: Stage | null
}

export const heldItems = (
  snapshot: RunSnapshot,
  chosen: StageId,
  toggled: ReadonlyMap<StageId, boolean>,
): readonly HeldItem[] => {
  const openOf = (stage: StageId): AttentionItem[] =>
    snapshot.attention.items.filter((item) => item.stage === stage && item.resolution === 'open')
  const own = openOf(chosen).map((item) => ({ item, within: null }))
  const node = stageGraph(snapshot).stages.get(chosen)
  const folded = placementsOf(snapshot.view)({ kind: 'stage', id: chosen })?.visibility?.state === 'collapsed'
  if (node === undefined || openOnMap(node, toggled, folded)) {
    return own
  }
  const below = ({ children }: MapStage): HeldItem[] =>
    children.flatMap((child) => [...openOf(child.stage.id).map((item) => ({ item, within: child.stage })), ...below(child)])
  return [...own, ...below(node)]
}

export const stageGraph = (snapshot: RunSnapshot): StageGraph => {
  const waiting = waitingByStage(snapshot.attention.items)
  const all = new Map(snapshot.model.stages.map((stage) => [stage.id, stage]))
  const placeOf = inheritedPlaces(all, predecessorsOf(snapshot.model.stages))
  const active = shownStages(snapshot).toSorted(
    (left, right) => byModelOrder(placeOf(left), placeOf(right)) || byModelOrder(left, right),
  )
  const shown = new Set(active.map(({ id }) => id))
  const actions = new Map(snapshot.objects.actions.map((action) => [action.id, action]))
  const agents = new Map(snapshot.objects.agents.map((agent) => [agent.id, agent]))
  const assigned = new Map<StageId, Action[]>()
  const participants = new Map<StageId, Agent[]>()
  const dependencies: Dependency[] = []
  for (const link of snapshot.model.links) {
    if (link.kind === 'assignment') {
      const action = actions.get(link.action)
      const agent = action?.agent === null || action === undefined ? undefined : agents.get(action.agent)
      if (action !== undefined) {
        listed(assigned, link.stage, action)
      }
      if (agent !== undefined) {
        listed(participants, link.stage, agent)
      }
    } else if (link.kind === 'participation') {
      const agent = agents.get(link.agent)
      if (agent !== undefined) {
        listed(participants, link.stage, agent)
      }
    } else if (link.kind === 'dependency') {
      dependencies.push({ from: link.depends_on, to: link.stage, basis: link.basis })
    }
  }
  const parentOf = (stage: Stage): StageId | null => {
    const seen = new Set<StageId>([stage.id])
    let parent = stage.parent
    while (parent !== null && !shown.has(parent) && !seen.has(parent)) {
      seen.add(parent)
      parent = all.get(parent)?.parent ?? null
    }
    return parent !== null && shown.has(parent) ? parent : null
  }
  const childrenOf = new Map<StageId | null, Stage[]>()
  for (const stage of active) {
    listed(childrenOf, parentOf(stage), stage)
  }
  const stages = new Map<StageId, MapStage>()
  const build = (stage: Stage, parent: StageId | null, depth: number): MapStage => {
    const children = (childrenOf.get(stage.id) ?? []).map((child) => build(child, stage.id, depth + 1))
    const own = assigned.get(stage.id) ?? []
    const team = [...new Map((participants.get(stage.id) ?? []).map((agent) => [agent.id, agent])).values()]
    const ownWaiting = waiting.get(stage.id) ?? 0
    const node: MapStage = {
      stage,
      parent,
      children,
      depth,
      agents: team,
      span: joined([
        ...own.flatMap(spanOf),
        ...team.filter(({ role }) => role !== 'main').flatMap(spanOf),
        ...children.flatMap(({ span }) => (span === null ? [] : [span])),
      ]),
      waiting: ownWaiting,
      waitingWithin: children.reduce((sum, child) => sum + child.waitingWithin, ownWaiting),
    }
    stages.set(stage.id, node)
    return node
  }
  const roots = (childrenOf.get(null) ?? []).map((root) => build(root, null, 0))
  return { stages, roots, dependencies }
}

const precedes = (earlier: Span | null, later: Span | null): boolean =>
  earlier !== null &&
  later !== null &&
  earlier.end !== null &&
  earlier.end <= later.start &&
  (later.end === null || earlier.start < later.end)

const orderOf = (siblings: readonly MapStage[]): Array<readonly [StageId, StageId]> =>
  siblings.flatMap((later) =>
    siblings
      .filter(
        (earlier) =>
          precedes(earlier.span, later.span) &&
          !siblings.some((between) => precedes(earlier.span, between.span) && precedes(between.span, later.span)),
      )
      .map((earlier) => [earlier.stage.id, later.stage.id] as const),
  )

const groupId = (parent: StageId | null, name: string): string => `group:${parent ?? ''}:${name}`

export const visibleMap = (
  graph: StageGraph,
  isOpen: (stage: MapStage) => boolean,
  groupOf: (stage: MapStage) => string | null = () => null,
): VisibleMap => {
  const stages: VisibleStage[] = []
  const frames = new Map<string, { readonly name: string; readonly parent: StageId | null; readonly members: StageId[] }>()
  const shownAs = new Map<StageId, StageId>()
  const frameOf = (node: MapStage): string | null => {
    const name = groupOf(node)
    if (name === null) {
      return null
    }
    const id = groupId(node.parent, name)
    const frame = frames.get(id)
    if (frame === undefined) {
      frames.set(id, { name, parent: node.parent, members: [node.stage.id] })
    } else {
      frame.members.push(node.stage.id)
    }
    return id
  }
  const place = (node: MapStage, holder: StageId | null): void => {
    const open = holder === null && node.children.length > 0 && isOpen(node)
    if (holder === null) {
      stages.push({ node, parent: node.parent, frame: frameOf(node), open })
    }
    shownAs.set(node.stage.id, holder ?? node.stage.id)
    for (const child of node.children) {
      place(child, holder ?? (open ? null : node.stage.id))
    }
  }
  for (const root of graph.roots) {
    place(root, null)
  }
  const edges = new Map<string, MapEdge>()
  for (const { from, to, basis } of graph.dependencies) {
    const source = shownAs.get(from)
    const target = shownAs.get(to)
    if (source === undefined || target === undefined || source === target) {
      continue
    }
    const id = `dependency:${source}:${target}`
    const bases = edges.get(id)?.bases ?? []
    edges.set(id, { id, kind: 'dependency', from: source, to: target, bases: [...new Set([...bases, basis.kind])] })
  }
  const linked = (left: StageId, right: StageId): boolean =>
    edges.has(`dependency:${left}:${right}`) || edges.has(`dependency:${right}:${left}`)
  const groups = [graph.roots, ...stages.filter(({ open }) => open).map(({ node }) => node.children)]
  for (const group of groups) {
    for (const [from, to] of orderOf(group)) {
      if (!linked(from, to)) {
        const id = `order:${from}:${to}`
        edges.set(id, { id, kind: 'order', from, to, bases: [] })
      }
    }
  }
  return {
    stages,
    groups: [...frames].map(([id, { name, parent, members }]) => ({ id, name, parent, members })),
    edges: [...edges.values()],
    holders: shownAs,
  }
}
