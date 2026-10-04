import type { Action, Agent, Basis, BasisKind, RunSnapshot, Stage, StageId } from '@aang/contract'

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
  readonly actions: number
  readonly span: Span | null
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
  readonly open: boolean
}

export interface VisibleMap {
  readonly stages: readonly VisibleStage[]
  readonly edges: readonly MapEdge[]
}

const byModelOrder = (left: Stage, right: Stage): number =>
  left.created_version - right.created_version || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)

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

export const stageGraph = (snapshot: RunSnapshot): StageGraph => {
  const all = new Map(snapshot.model.stages.map((stage) => [stage.id, stage]))
  const active = snapshot.model.stages.filter(({ lifecycle }) => lifecycle.state === 'active').sort(byModelOrder)
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
    const node: MapStage = {
      stage,
      parent,
      children,
      depth,
      agents: team,
      actions: own.length,
      span: joined([
        ...own.flatMap(spanOf),
        ...team.filter(({ role }) => role !== 'main').flatMap(spanOf),
        ...children.flatMap(({ span }) => (span === null ? [] : [span])),
      ]),
    }
    stages.set(stage.id, node)
    return node
  }
  const roots = (childrenOf.get(null) ?? []).map((root) => build(root, null, 0))
  return { stages, roots, dependencies }
}

const precedes = (earlier: Span | null, later: Span | null): boolean =>
  earlier !== null && later !== null && earlier.end !== null && earlier.end <= later.start

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

export const visibleMap = (graph: StageGraph, isOpen: (stage: MapStage) => boolean): VisibleMap => {
  const stages: VisibleStage[] = []
  const shownAs = new Map<StageId, StageId>()
  const place = (node: MapStage, holder: StageId | null): void => {
    const open = holder === null && node.children.length > 0 && isOpen(node)
    if (holder === null) {
      stages.push({ node, parent: node.parent, open })
    }
    shownAs.set(node.stage.id, holder ?? node.stage.id)
    for (const child of node.children) {
      place(child, holder ?? (open ? null : node.stage.id))
    }
  }
  for (const root of graph.roots) {
    place(root, null)
  }
  const within = (inner: StageId, outer: StageId): boolean => {
    const parent = graph.stages.get(inner)?.parent ?? null
    return parent !== null && (parent === outer || within(parent, outer))
  }
  const edges = new Map<string, MapEdge>()
  for (const { from, to, basis } of graph.dependencies) {
    const source = shownAs.get(from)
    const target = shownAs.get(to)
    if (
      source === undefined ||
      target === undefined ||
      source === target ||
      within(source, target) ||
      within(target, source)
    ) {
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
  return { stages, edges: [...edges.values()] }
}
