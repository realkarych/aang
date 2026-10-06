import { ChangeSeq, type ModelChange, type ModelEntity, ModelVersion, type ModelVersionRecord, type RunId } from '@aang/contract'
import type { Store } from '@aang/store'
import type { ModelState } from './predicate.js'

export interface VersionState {
  readonly record: ModelVersionRecord
  readonly changes: readonly ModelChange[]
  readonly model: ModelState
}

const entityKey = ({ target }: ModelChange): string => `${target.kind}:${target.id}`

const stateOf = (entities: ReadonlyMap<string, ModelEntity>): ModelState => {
  const values = [...entities.values()]
  return {
    run: values.flatMap((entity) => (entity.kind === 'run' ? [entity.value] : []))[0] ?? null,
    stages: values.flatMap((entity) => (entity.kind === 'stage' ? [entity.value] : [])),
    criteria: values.flatMap((entity) => (entity.kind === 'criterion' ? [entity.value] : [])),
    attention: values.flatMap((entity) => (entity.kind === 'attention_item' ? [entity.value] : [])),
    cards: values.flatMap((entity) => (entity.kind === 'card' ? [entity.value] : [])),
    links: values.flatMap((entity) => (entity.kind === 'link' ? [entity.value] : [])),
  }
}

export const emptyModel: ModelState = stateOf(new Map())

export const versionStates = (store: Store, run: RunId): VersionState[] => {
  const byVersion = Map.groupBy(store.model.changes(run, ModelVersion.parse(0)), ({ version }) => version)
  const entities = new Map<string, ModelEntity>()
  return store.model.versions(run, ChangeSeq.parse(0)).map((record) => {
    const changes = byVersion.get(record.version) ?? []
    for (const change of changes) {
      if (change.after === null) {
        entities.delete(entityKey(change))
      } else {
        entities.set(entityKey(change), change.after)
      }
    }
    return { record, changes, model: stateOf(entities) }
  })
}

const quoted = (text: string): string => JSON.stringify(text)

const entityLabel = (entity: ModelEntity): string => {
  switch (entity.kind) {
    case 'run':
      return `run brief ${quoted(entity.value.brief?.text ?? '')}`
    case 'stage':
      return `stage ${quoted(entity.value.title)} ${entity.value.lifecycle.state} ${entity.value.execution.value.state}`
    case 'criterion':
      return `criterion ${quoted(entity.value.text)} ${entity.value.status.value}`
    case 'card':
      return `card ${quoted(entity.value.text)}`
    case 'attention_item':
      return `attention ${entity.value.kind} ${quoted(entity.value.text)} ${entity.value.resolution}`
    case 'link':
      return `link ${entity.value.kind}`
    case 'binding':
      return `binding ${entity.value.kind}`
    case 'session_membership':
      return `session ${entity.value.session}`
  }
}

export const describeChange = ({ op, target, after }: ModelChange): string =>
  `${op}: ${after === null ? `${target.kind} ${target.id} removed` : entityLabel(after)}`
