import type { RunView, ViewElement, ViewPlacement } from '@aang/contract'

export type PlacementOf = (element: ViewElement) => ViewPlacement | null

const keyOf = ({ kind, id }: ViewElement): string => `${kind}:${id}`

export const placementsOf = (view: RunView): PlacementOf => {
  const placements = new Map(view.placements.map((placement) => [keyOf(placement.element), placement]))
  return (element) => placements.get(keyOf(element)) ?? null
}

export const isHidden = (placement: ViewPlacement | null): boolean => placement?.visibility?.state === 'hidden'
