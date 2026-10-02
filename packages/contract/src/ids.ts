import { hash } from 'node:crypto'
import type { FactDraft, FactKind } from './facts.js'
import type { FactEntityKey, ObjectIdByKind, ObjectKey, SessionKey } from './keys.js'
import type { ContentHash, DedupeKey, FactId, JsonValue, RunId } from './primitives.js'

const derivedIdLength = 32

const byCodeUnits = ([left]: readonly [string, unknown], [right]: readonly [string, unknown]): number =>
  left < right ? -1 : left > right ? 1 : 0

export const canonicalJson = (value: JsonValue): string => {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  if (value !== null && typeof value === 'object') {
    const members = Object.entries(value)
      .sort(byCodeUnits)
      .map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`)
    return `{${members.join(',')}}`
  }
  return JSON.stringify(value)
}

const derive = (domain: string, value: JsonValue): string =>
  hash('sha256', `${domain}\0${canonicalJson(value)}`, 'hex').slice(0, derivedIdLength)

export const contentHash = (content: string | Uint8Array): ContentHash => hash('sha256', content, 'hex') as ContentHash

export const objectId = <K extends ObjectKey>(key: K): ObjectIdByKind[K['kind']] =>
  derive('object', key) as ObjectIdByKind[K['kind']]

export const runId = (root: SessionKey): RunId =>
  objectId({ kind: 'run', runtime: root.runtime, session: root.session })

export interface FactIdentity {
  readonly dedupe_key: DedupeKey
  readonly kind: FactKind
  readonly entity_key: FactEntityKey
  readonly ordinal: number
}

export const factId = (identity: FactIdentity): FactId =>
  derive('fact', [identity.dedupe_key, identity.kind, identity.entity_key, identity.ordinal]) as FactId

export const factIds = (dedupeKey: DedupeKey, drafts: readonly Pick<FactDraft, 'kind' | 'entity_key'>[]): FactId[] => {
  const seen = new Map<string, number>()
  return drafts.map(({ kind, entity_key }) => {
    const group = canonicalJson([kind, entity_key])
    const ordinal = seen.get(group) ?? 0
    seen.set(group, ordinal + 1)
    return factId({ dedupe_key: dedupeKey, kind, entity_key, ordinal })
  })
}
