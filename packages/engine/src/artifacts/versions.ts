import type {
  Action,
  ActionKey,
  ArtifactRef,
  ArtifactVersion,
  ArtifactVersionKey,
  EpochNs,
  Fact,
  FactOf,
  RunId,
  VersionIdentity,
} from '@aang/contract'
import { contentHash, objectId } from '@aang/contract/ids'
import type { ArtifactVersionDraft, Transaction } from '@aang/store'
import { sessionRun } from '../observations/runs.js'
import { actionCandidates, type VersionCandidate, type WriteKind } from './references.js'

type End = FactOf<'action_end'>

export interface PathWrite {
  readonly action: Action
  readonly path: string
  readonly candidates: readonly VersionCandidate[]
  readonly started: EpochNs
  readonly ended: EpochNs
}

const byTime = (left: Fact, right: Fact): number =>
  left.at < right.at ? -1 : left.at > right.at ? 1 : left.id < right.id ? -1 : left.id > right.id ? 1 : 0

const wrote: Record<WriteKind, (end: End) => boolean> = {
  file_tool: ({ payload }) => payload.outcome === 'ok',
  command: ({ payload }) => payload.outcome !== 'denied',
}

export const actionWrites = (action: Action, facts: readonly Fact[], session: string | null): PathWrite[] => {
  const [start] = facts.filter(({ kind }) => kind === 'action_start').sort(byTime)
  const ends = facts.filter((fact): fact is End => fact.kind === 'action_end').sort(byTime)
  const byPath = new Map<string, VersionCandidate[]>()
  for (const candidate of actionCandidates(facts, session)) {
    const group = byPath.get(candidate.path)
    if (group === undefined) {
      byPath.set(candidate.path, [candidate])
    } else {
      group.push(candidate)
    }
  }
  return [...byPath].flatMap(([path, candidates]) => {
    const [first] = candidates
    const end = first === undefined ? undefined : ends.find(wrote[first.written])
    return start === undefined || end === undefined ? [] : [{ action, path, candidates, started: start.at, ended: end.at }]
  })
}

const identitiesOf = (candidates: readonly VersionCandidate[]): VersionIdentity[] => {
  const contents = [...new Set(candidates.flatMap(({ content }) => (content === null ? [] : [contentHash(content)])))]
  const [first] = candidates
  if (contents.length > 0) {
    return contents.sort().map((hash) => ({ kind: 'content', hash }))
  }
  return first === undefined ? [] : [{ kind: 'reference', fact: first.fact.id }]
}

const versionDrafts = (run: RunId, { action, path, candidates, ended }: PathWrite): ArtifactVersionDraft[] => {
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
      observed_at: ended,
    }
  })
}

const precedes = (left: ArtifactVersionDraft, right: ArtifactVersionDraft): boolean =>
  left.observed_at < right.observed_at ||
  (left.observed_at === right.observed_at && (left.produced_by ?? '') <= (right.produced_by ?? ''))

const merged = (previous: ArtifactVersion | null, draft: ArtifactVersionDraft): ArtifactVersionDraft => {
  if (previous === null) {
    return draft
  }
  const { produced_by, observed_at } = precedes(previous, draft) ? previous : draft
  const retention =
    previous.retention.kind === 'action_payload' && produced_by !== null
      ? { ...previous.retention, action: produced_by }
      : previous.retention
  return { ...draft, produced_by, observed_at, retention }
}

export const projectVersions = (transaction: Transaction, actions: Iterable<ActionKey>): void => {
  for (const key of actions) {
    const action = transaction.observations.getAction(objectId(key))
    const session = action === null ? null : transaction.observations.getSession(action.session)
    if (action === null || action.inherited || session === null) {
      continue
    }
    const run = sessionRun(transaction, session.key)
    for (const write of actionWrites(action, transaction.facts.ofEntity(key), session.cwd)) {
      for (const draft of versionDrafts(run, write)) {
        transaction.artifacts.saveVersion(merged(transaction.artifacts.getVersion(draft.id), draft))
      }
    }
  }
}
