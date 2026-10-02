import type {
  Action,
  Fact,
  MaterialUnavailableReason,
  RawRecord,
  RunId,
  Runtime,
  SessionId,
} from '@aang/contract'
import { objectId } from '@aang/contract/ids'
import type { FactReader, ModelReader, ObservationReader, RawRecordReader } from '@aang/store'

export interface ScopeReader {
  readonly facts: FactReader
  readonly rawRecords: RawRecordReader
  readonly observations: ObservationReader
  readonly model: ModelReader
}

export interface InputScopeOptions {
  readonly run: RunId
  readonly backend: Runtime
  readonly crossVendor: boolean
}

export type ScopeExclusion = Extract<MaterialUnavailableReason, 'out_of_scope' | 'cross_vendor'>

export interface InputScope extends InputScopeOptions {
  readonly fact: (fact: Fact) => ScopeExclusion | null
  readonly record: (record: RawRecord) => ScopeExclusion | null
  readonly action: (action: Action) => ScopeExclusion | null
}

export const sessionInRun = (
  model: Pick<ModelReader, 'objectRun' | 'entity'>,
  run: RunId,
  session: SessionId,
): boolean => {
  const owner = model.objectRun('session', session)
  return owner === undefined
    ? model.entity(run, { kind: 'session_membership', id: session }) !== null
    : owner === run
}

export const factSession = (fact: Fact): SessionId => {
  const { runtime, session } = fact.entity_key
  return objectId({ kind: 'session', runtime, session })
}

export const inputScope = (reader: ScopeReader, options: InputScopeOptions): InputScope => {
  const { run, backend, crossVendor } = options
  const admit = (session: SessionId, vendor: Runtime): ScopeExclusion | null => {
    if (!sessionInRun(reader.model, run, session)) {
      return 'out_of_scope'
    }
    return vendor === backend || crossVendor ? null : 'cross_vendor'
  }
  const fact = (value: Fact): ScopeExclusion | null => admit(factSession(value), value.entity_key.runtime)
  return {
    run,
    backend,
    crossVendor,
    fact,
    action: (action) => admit(action.session, action.key.runtime),
    record: (record) => {
      const exclusions = reader.facts.ofRecord(record.seq).map(fact)
      if (exclusions.length === 0 || exclusions.includes('out_of_scope')) {
        return 'out_of_scope'
      }
      return exclusions.includes('cross_vendor') ? 'cross_vendor' : null
    },
  }
}
