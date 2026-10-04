import { Stage } from '@aang/contract'
import { runId } from '@aang/contract/ids'
import { type MapStage, type StageGraph, visibleMap } from '@aang/web/map-graph'
import { type LayoutEngine, layoutMap, type Placement } from '@aang/web/map-layout'
import ELK, { type ElkNode } from 'elkjs/lib/elk.bundled.js'
import { describe, expect, test } from 'vitest'

const run = runId({ kind: 'session', runtime: 'claude', session: 'nested-map' })

const observed = { value: { state: 'running' }, basis: { kind: 'observed' }, evidence: [] } as const

const stageNode = (id: string, parent: string | null, children: MapStage[]): MapStage => {
  const stage = Stage.parse({
    id,
    run,
    title: id,
    expected_result: null,
    summary: null,
    parent,
    origin: 'inferred',
    lifecycle: { state: 'active' },
    execution: observed,
    execution_claim: null,
    decision: { ...observed, value: 'none' },
    session_moved: false,
    basis: { kind: 'observed' },
    evidence: [],
    created_version: 1,
    updated_version: 1,
  })
  return { stage, parent: stage.parent, children, depth: 0, agents: [], actions: 0, span: null }
}

const sign = stageNode('sign', 'bundle', [])
const bundle = stageNode('bundle', 'release', [sign])
const release = stageNode('release', null, [bundle])

const nested: StageGraph = {
  stages: new Map([release, bundle, sign].map((node) => [node.stage.id, node])),
  roots: [release],
  dependencies: [bundle, sign].map(({ stage }) => ({ from: release.stage.id, to: stage.id, basis: { kind: 'observed' } })),
}

const elk = new ELK()

const constrained = ({ layoutOptions, children = [] }: ElkNode): boolean =>
  layoutOptions?.['elk.layered.layering.layerConstraint'] !== undefined || children.some(constrained)

const refusingConstraints: LayoutEngine = {
  layout: async (graph, args) =>
    constrained(graph) ? Promise.reject(new Error('java.lang.ClassCastException')) : elk.layout(graph, args),
}

const overlap = (left: Placement, right: Placement): boolean =>
  left.x < right.x + right.width &&
  right.x < left.x + left.width &&
  left.y < right.y + right.height &&
  right.y < left.y + left.height

describe('a map whose card constraint ELK cannot solve', () => {
  const map = visibleMap(nested, () => true)

  test.for(['RIGHT', 'DOWN'] as const)('is laid out whole without the constraint, %s', async (direction) => {
    const layout = await layoutMap(map, direction, refusingConstraints)

    expect([...layout.nodes.keys()].sort()).toEqual(['bundle', 'release', 'sign'])
    expect([...layout.cards.keys()].sort()).toEqual(['bundle', 'release'])
    expect([...layout.routes.keys()].sort()).toEqual(map.edges.map(({ id }) => id).sort())
    for (const points of layout.routes.values()) {
      expect(points.length).toBeGreaterThanOrEqual(2)
    }
    const [releaseCard, bundleCard, bundleFrame, signCard] = [
      layout.cards.get('release'),
      layout.cards.get('bundle'),
      layout.nodes.get('bundle'),
      layout.nodes.get('sign'),
    ]
    expect(releaseCard && bundleFrame && overlap(releaseCard, bundleFrame)).toBe(false)
    expect(bundleCard && signCard && overlap(bundleCard, signCard)).toBe(false)
  })

  test('still fails with the reason of ELK when the layout without it fails too', async () => {
    const broken: LayoutEngine = { layout: async () => Promise.reject(new Error('java.lang.OutOfMemoryError')) }
    await expect(layoutMap(map, 'RIGHT', broken)).rejects.toThrow('java.lang.OutOfMemoryError')
  })
})
