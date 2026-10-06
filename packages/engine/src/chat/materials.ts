import type {
  ChatMaterial,
  ChatNeed,
  FactId,
  FactMaterial,
  JournalEntityRef,
  JournalMaterial,
  ModelChange,
  ModelEntityRef,
  ModelVersion,
  StageId,
  StageMaterial,
} from '@aang/contract'
import { ModelVersion as Version } from '@aang/contract'
import { canonicalJson } from '@aang/contract/ids'
import { factInput, snapshotStage } from '../input/batch.js'
import { clipNote, clipOptional } from '../input/fit.js'
import {
  artifactVersionMaterial,
  isUnavailable,
  type MaterialLimits,
  rawRecordMaterial,
  requestedAction,
  type Resolved,
} from '../input/materials.js'
import type { InputScope, ScopeReader } from '../input/scope.js'
import { clipEntries, journalEntry } from './journal.js'

const changesAt = (reader: ScopeReader, scope: InputScope, ref: ModelEntityRef, version: ModelVersion): ModelChange[] =>
  reader.model.entityChanges(scope.run, ref, Version.parse(0)).filter((change) => change.version <= version)

const admitted = (reader: ScopeReader, scope: InputScope, ref: ModelEntityRef): Resolved<true> =>
  reader.model.entityRuns(ref).length === 0 ? 'not_found' : (scope.entity(ref) ?? true)

const visibleStage = (reader: ScopeReader, scope: InputScope, id: StageId | null): StageId | null =>
  id !== null && scope.entity({ kind: 'stage', id }) === null && reader.model.entity(scope.run, { kind: 'stage', id }) !== null
    ? id
    : null

const stageAt = (
  reader: ScopeReader,
  scope: InputScope,
  id: StageId,
  version: ModelVersion,
  limit: number,
): Resolved<StageMaterial> => {
  const ref = { kind: 'stage', id } as const
  const known = admitted(reader, scope, ref)
  if (isUnavailable(known)) {
    return known
  }
  const state = changesAt(reader, scope, ref, version).at(-1)?.after
  if (state?.kind !== 'stage') {
    return 'not_found'
  }
  const stage = snapshotStage(state.value, visibleStage(reader, scope, state.value.parent))
  return {
    kind: 'stage',
    stage: {
      ...stage,
      title: clipNote(stage.title, limit),
      expected_result: clipOptional(stage.expected_result, limit),
      summary: clipOptional(stage.summary, limit),
    },
    lifecycle: state.value.lifecycle,
  }
}

const journalAt = (
  reader: ScopeReader,
  scope: InputScope,
  entity: JournalEntityRef,
  version: ModelVersion,
  limit: number,
): Resolved<JournalMaterial> => {
  const known = admitted(reader, scope, entity)
  if (isUnavailable(known)) {
    return known
  }
  const entries = changesAt(reader, scope, entity, version).map(journalEntry)
  return entries.length === 0 ? 'not_found' : { kind: 'journal', entity, entries: clipEntries(entries, limit) }
}

const requestedFact = (reader: ScopeReader, scope: InputScope, id: FactId, limit: number): Resolved<FactMaterial> => {
  const fact = reader.facts.get(id)
  if (fact === null) {
    return 'not_found'
  }
  return scope.fact(fact) ?? { kind: 'fact', fact: factInput(reader, scope, fact, limit) }
}

const materialOf = <M extends ChatMaterial>(request: ChatNeed, resolved: Resolved<M>): ChatMaterial =>
  isUnavailable(resolved) ? { kind: 'unavailable', request, reason: resolved } : resolved

const resolveChatNeed = (
  reader: ScopeReader,
  scope: InputScope,
  need: ChatNeed,
  version: ModelVersion,
  limit: number,
): ChatMaterial => {
  switch (need.kind) {
    case 'stage':
      return materialOf(need, stageAt(reader, scope, need.stage, version, limit))
    case 'fact':
      return materialOf(need, requestedFact(reader, scope, need.fact, limit))
    case 'raw_record':
      return materialOf(need, rawRecordMaterial(reader, scope, need.seq, limit))
    case 'action':
      return materialOf(need, requestedAction(reader, scope, need.action, limit))
    case 'journal':
      return materialOf(need, journalAt(reader, scope, need.entity, version, limit))
    case 'artifact_version':
      return materialOf(need, artifactVersionMaterial(reader, scope, need.version, limit))
  }
}

export const resolveChatNeeds = (
  reader: ScopeReader,
  scope: InputScope,
  needs: readonly ChatNeed[],
  version: ModelVersion,
  limits: MaterialLimits,
): ChatMaterial[] => {
  const unique = new Map(needs.map((need) => [canonicalJson(need), need]))
  return [...unique.values()]
    .slice(0, limits.needs)
    .map((need) => resolveChatNeed(reader, scope, need, version, limits.textLength))
}
