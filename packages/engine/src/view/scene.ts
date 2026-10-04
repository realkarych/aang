import {
  type Action,
  type Agent,
  type ArtifactVersion,
  ChangeSeq,
  type Question,
  type QuestionId,
  type RunId,
  type StageId,
  type UsageRecord,
  type ViewRule,
} from '@aang/contract'
import type { ArtifactReader, Observation, ViewReader } from '@aang/store'
import { byId, type ModelParts, partsOf } from '../read/context.js'
import { type UsageSource, usageByStage } from '../usage/solver.js'

export type ViewSource = UsageSource & {
  readonly artifacts: ArtifactReader
  readonly views: ViewReader
}

export interface ViewScene {
  readonly run: RunId
  readonly parts: ModelParts
  readonly agents: readonly Agent[]
  readonly rules: readonly ViewRule[]
  readonly actions: () => readonly Action[]
  readonly question: (id: QuestionId) => Question | null
  readonly usage: () => readonly UsageRecord[]
  readonly versions: () => readonly ArtifactVersion[]
  readonly stageUsage: () => ReadonlyMap<StageId | null, readonly UsageRecord[]>
}

export interface SceneObjects {
  readonly parts?: ModelParts
  readonly agents?: readonly Agent[]
  readonly objects?: readonly Observation[]
}

const everything = ChangeSeq.parse(0)

export const once = <T>(load: () => T): (() => T) => {
  let loaded: { readonly value: T } | null = null
  return () => {
    loaded ??= { value: load() }
    return loaded.value
  }
}

const isAgent = (object: Observation): object is Agent => object.key.kind === 'agent'
const isAction = (object: Observation): object is Action => object.key.kind === 'action'
const isQuestion = (object: Observation): object is Question => object.key.kind === 'question'
const isUsage = (object: Observation): object is UsageRecord => object.key.kind === 'usage'

export const activeRules = (views: ViewReader, run: RunId): ViewRule[] =>
  views.rules(run).filter(({ revoked_at: revokedAt }) => revokedAt === null)

export const viewScene = (source: ViewSource, run: RunId, known: SceneObjects = {}): ViewScene => {
  const { objects } = known
  const ofKind = <T extends Observation>(kind: T['key']['kind'], is: (object: Observation) => object is T): T[] =>
    (objects ?? source.observations.ofRun(run, everything, [kind])).filter(is).sort(byId)
  const questions = objects === undefined ? null : new Map(objects.filter(isQuestion).map((value) => [value.id, value]))
  return {
    run,
    parts: known.parts ?? partsOf(source.model.entities(run)),
    agents: [...(known.agents ?? ofKind('agent', isAgent))].sort(byId),
    rules: activeRules(source.views, run),
    actions: once(() => ofKind('action', isAction)),
    question: (id) => questions?.get(id) ?? source.observations.getQuestion(id),
    usage: once(() => ofKind('usage', isUsage)),
    versions: once(() => source.artifacts.versions(run)),
    stageUsage: once(() => usageByStage(source, run)),
  }
}
