import type { Stage, StageId, StageLifecycle } from '@aang/contract'
import { stageRevisionLabel } from './labels.js'

export type StageRevision = Exclude<StageLifecycle['state'], 'active'>

export const successorsOf = (lifecycle: StageLifecycle): readonly StageId[] => {
  switch (lifecycle.state) {
    case 'active':
      return []
    case 'replaced':
      return lifecycle.by
    case 'merged':
    case 'split':
      return [lifecycle.into].flat()
  }
}

export const predecessorsOf = (stages: readonly Stage[]): ReadonlyMap<StageId, readonly StageId[]> => {
  const found = new Map<StageId, StageId[]>()
  for (const stage of stages) {
    for (const next of successorsOf(stage.lifecycle)) {
      found.set(next, [...(found.get(next) ?? []), stage.id])
    }
  }
  return found
}

export interface Handover {
  readonly from: Stage
  readonly to: Stage
  readonly revisions: readonly StageRevision[]
  readonly others: readonly Stage[]
}

export interface StageSelection {
  readonly stage: Stage
  readonly lineage: readonly StageId[]
  readonly handover: Handover | null
}

interface Reached {
  readonly stage: Stage
  readonly revisions: readonly StageRevision[]
  readonly lineage: readonly StageId[]
}

const handoverOf = (from: Stage, { stage, revisions }: Reached, rest: readonly Reached[]): Handover | null => {
  const others = [...new Set(rest.map((reached) => reached.stage))].filter((other) => other !== stage)
  return stage === from ? null : { from, to: stage, revisions, others }
}

export const selectionOf = (stages: readonly Stage[], chosen: StageId): StageSelection | null => {
  const byId = new Map(stages.map((stage) => [stage.id, stage]))
  const start = byId.get(chosen)
  if (start === undefined) {
    return null
  }
  const reach = (stage: Stage, revisions: readonly StageRevision[], passed: readonly StageId[]): Reached[] => {
    const { lifecycle } = stage
    const lineage = [...passed, stage.id]
    return lifecycle.state === 'active'
      ? [{ stage, revisions, lineage }]
      : successorsOf(lifecycle).flatMap((id) => {
          const next = byId.get(id)
          return next === undefined ? [] : reach(next, [...revisions, lifecycle.state], lineage)
        })
  }
  const [first, ...rest] = reach(start, [], [])
  return first === undefined
    ? null
    : { stage: first.stage, lineage: first.lineage, handover: handoverOf(start, first, rest) }
}

const quoted = ({ title }: Stage): string => `«${title}»`

export const handoverText = ({ from, to, revisions, others }: Handover): string => {
  const steps = revisions
    .filter((revision, index) => revision !== revisions[index - 1])
    .map((revision) => stageRevisionLabel[revision])
  const rest = others.length === 0 ? '' : `, другие преемники: ${others.map(quoted).join(', ')}`
  return `Этап ${quoted(from)} ${steps.join(', затем ')}. Выбор перешёл к преемнику ${quoted(to)}${rest}.`
}
