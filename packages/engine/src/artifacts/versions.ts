import type {
  Action,
  ActionKey,
  ArtifactRef,
  ArtifactVersionKey,
  Fact,
  FactOf,
  RunId,
  VersionIdentity,
} from '@aang/contract'
import { contentHash, objectId } from '@aang/contract/ids'
import type { ArtifactVersionDraft, Transaction } from '@aang/store'
import { runOf } from '../observations/runs.js'
import { actionCandidates, type VersionCandidate, type WriteKind } from './references.js'

type End = FactOf<'action_end'>

const byTime = (left: Fact, right: Fact): number =>
  left.at < right.at ? -1 : left.at > right.at ? 1 : left.id < right.id ? -1 : left.id > right.id ? 1 : 0

const wrote: Record<WriteKind, (end: End) => boolean> = {
  file_tool: ({ payload }) => payload.outcome === 'ok',
  command: ({ payload }) => payload.outcome !== 'denied',
}

const identitiesOf = (candidates: readonly VersionCandidate[]): VersionIdentity[] => {
  const contents = [...new Set(candidates.flatMap(({ content }) => (content === null ? [] : [contentHash(content)])))]
  const [first] = candidates
  if (contents.length > 0) {
    return contents.sort().map((hash) => ({ kind: 'content', hash }))
  }
  return first === undefined ? [] : [{ kind: 'reference', fact: first.fact.id }]
}

const versionDrafts = (run: RunId, action: Action, facts: readonly Fact[]): ArtifactVersionDraft[] => {
  const ends = facts.filter((fact): fact is End => fact.kind === 'action_end').sort(byTime)
  const byPath = new Map<string, VersionCandidate[]>()
  for (const candidate of actionCandidates(facts)) {
    byPath.set(candidate.path, [...(byPath.get(candidate.path) ?? []), candidate])
  }
  return [...byPath].flatMap(([path, candidates]) => {
    const [first] = candidates
    const end = first === undefined ? undefined : ends.find(wrote[first.written])
    if (end === undefined) {
      return []
    }
    const ref: ArtifactRef = { kind: 'file', path }
    return identitiesOf(candidates).map((identity): ArtifactVersionDraft => {
      const key: ArtifactVersionKey = { kind: 'artifact_version', run, artifact: ref, identity }
      return {
        id: objectId(key),
        key,
        run,
        artifact: objectId({ kind: 'artifact', run, artifact: ref }),
        ref,
        retention: { kind: 'reference' },
        produced_by: action.id,
        observed_at: end.at,
      }
    })
  })
}

export const projectVersions = (transaction: Transaction, actions: Iterable<ActionKey>): void => {
  for (const key of actions) {
    const action = transaction.observations.getAction(objectId(key))
    const session = action === null ? null : transaction.observations.getSession(action.session)
    if (action === null || action.inherited || session === null) {
      continue
    }
    const run = runOf(transaction, session.key)
    for (const draft of versionDrafts(run, action, transaction.facts.ofEntity(key))) {
      const previous = transaction.artifacts.getVersion(draft.id)
      transaction.artifacts.saveVersion({ ...draft, retention: previous?.retention ?? draft.retention })
    }
  }
}
