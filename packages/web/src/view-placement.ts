import type { Action, ActionId, RunView, ViewElement, ViewPlacement } from '@aang/contract'

export type PlacementOf = (element: ViewElement) => ViewPlacement | null

const keyOf = ({ kind, id }: ViewElement): string => `${kind}:${id}`

export const placementsOf = (view: RunView): PlacementOf => {
  const placements = new Map(view.placements.map((placement) => [keyOf(placement.element), placement]))
  return (element) => placements.get(keyOf(element)) ?? null
}

export const isHidden = (placement: ViewPlacement | null): boolean => placement?.visibility?.state === 'hidden'

export type Grouped<T> =
  | { readonly kind: 'one'; readonly item: T }
  | { readonly kind: 'group'; readonly name: string; readonly items: T[] }

export const grouped = <T>(items: readonly T[], groupOf: (item: T) => string | null): Grouped<T>[] => {
  const entries: Grouped<T>[] = []
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const name = groupOf(item)
    const members = name === null ? undefined : groups.get(name)
    if (name === null) {
      entries.push({ kind: 'one', item })
    } else if (members === undefined) {
      const created = [item]
      groups.set(name, created)
      entries.push({ kind: 'group', name, items: created })
    } else {
      members.push(item)
    }
  }
  return entries
}

export const concealedActions = (actions: readonly Action[], placement: PlacementOf): ReadonlySet<ActionId> => {
  const containers = new Map(actions.map(({ id, container }) => [id, container]))
  const folded = (id: ActionId): boolean => (placement({ kind: 'action', id })?.visibility ?? null) !== null
  const concealed = new Set<ActionId>()
  for (const action of actions) {
    const passed = new Set<ActionId>()
    let inside = isHidden(placement({ kind: 'action', id: action.id }))
    let next = action.container
    while (!inside && next !== null && !passed.has(next)) {
      passed.add(next)
      inside = folded(next)
      next = containers.get(next) ?? null
    }
    if (inside) {
      concealed.add(action.id)
    }
  }
  return concealed
}
