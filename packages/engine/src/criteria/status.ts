import { isDeepStrictEqual } from 'node:util'
import {
  type Basis,
  type Criterion,
  CriterionId,
  type CriterionStatus,
  type EpochNs,
  type FactId,
  type GitSnapshot,
  type RawSeq,
  type RunId,
} from '@aang/contract'
import { canonicalJson, contentHash } from '@aang/contract/ids'
import type { Transaction } from '@aang/store'
import { applyChangeSet, type ModelChangeDraft } from '../model/journal.js'
import type { ResolvedCheck } from './git.js'
import type { CriterionCheck } from './plan.js'

interface Verdict {
  readonly status: CriterionStatus
  readonly evidence: readonly FactId[]
  readonly checkedCommit: string | null
  readonly cleanTreeCommit: string | null
  readonly at: EpochNs
}

interface Seen {
  readonly snapshot: GitSnapshot
  readonly seq: RawSeq
}

interface Update {
  readonly change: ModelChangeDraft
  readonly at: EpochNs
}

const observed: Basis = { kind: 'observed' }

const criterionIdLength = 32

export const criterionId = (run: RunId, contract: string): CriterionId =>
  CriterionId.parse(contentHash(canonicalJson(['contract_criterion', run, contract])).slice(0, criterionIdLength))

const storedCriterion = (transaction: Transaction, { run, contract }: CriterionCheck): Criterion | null => {
  const entity = transaction.model.entity(run, { kind: 'criterion', id: criterionId(run, contract.name) })
  return entity?.kind === 'criterion' ? entity.value : null
}

export const isVersioned = (transaction: Transaction, check: CriterionCheck): boolean =>
  (storedCriterion(transaction, check)?.checked_commit ?? null) !== null

const later = (left: EpochNs, right: EpochNs): EpochNs => (right > left ? right : left)

const sameMasks = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((mask, index) => mask === right[index])

const snapshotsOf = (transaction: Transaction, { run, contract }: CriterionCheck, worktree: string): Seen[] =>
  transaction.artifacts
    .snapshots(run)
    .flatMap((snapshot) => {
      const seq =
        snapshot.worktree === worktree && sameMasks(snapshot.masks, contract.inputMasks)
          ? transaction.facts.get(snapshot.fact)?.seq
          : undefined
      return seq === undefined ? [] : [{ snapshot, seq }]
    })
    .sort((left, right) => left.seq - right.seq)

const showsCommit = ({ snapshot }: Seen, commit: string): boolean => snapshot.clean && snapshot.head === commit

const firstDeparture = (after: readonly Seen[], commit: string): Seen | null => {
  let departure: Seen | null = null
  for (const seen of after) {
    departure = showsCommit(seen, commit) ? null : (departure ?? seen)
  }
  return departure
}

const versionedVerdict = (check: CriterionCheck, commit: string, after: readonly Seen[]): Verdict => {
  const { result } = check
  const departure = firstDeparture(after, commit)
  if (departure === null) {
    const latest = after.at(-1)
    return {
      status: 'confirmed',
      evidence: result.evidence,
      checkedCommit: commit,
      cleanTreeCommit: null,
      at: latest === undefined ? result.at : later(result.at, latest.snapshot.taken_at),
    }
  }
  return {
    status: 'stale',
    evidence: [...result.evidence, departure.snapshot.fact],
    checkedCommit: commit,
    cleanTreeCommit: null,
    at: later(result.at, departure.snapshot.taken_at),
  }
}

const unversionedVerdict = ({ result }: CriterionCheck, seen: readonly Seen[]): Verdict => {
  const { started, ended } = result
  const plain: Verdict = { status: 'passed_unversioned', evidence: result.evidence, checkedCommit: null, cleanTreeCommit: null, at: result.at }
  const before = seen.filter(({ seq }) => seq > started && seq < ended).at(-1)
  const after = seen.find(({ seq }) => seq > ended)
  const head = before?.snapshot.head ?? null
  if (before === undefined || after === undefined || head === null || !showsCommit(before, head) || !showsCommit(after, head)) {
    return plain
  }
  return {
    ...plain,
    evidence: [...result.evidence, before.snapshot.fact, after.snapshot.fact],
    cleanTreeCommit: head,
    at: later(result.at, after.snapshot.taken_at),
  }
}

const verdictOf = (transaction: Transaction, { check, git }: ResolvedCheck): Verdict => {
  const { result } = check
  if (!result.passed) {
    return { status: 'failed', evidence: result.evidence, checkedCommit: null, cleanTreeCommit: null, at: result.at }
  }
  const seen = git.worktree === null ? [] : snapshotsOf(transaction, check, git.worktree)
  return git.commit === null
    ? unversionedVerdict(check, seen)
    : versionedVerdict(check, git.commit, seen.filter(({ seq }) => seq > result.ended))
}

const criterionOf = (check: CriterionCheck, verdict: Verdict, stored: Criterion | null): Criterion => ({
  id: criterionId(check.run, check.contract.name),
  run: check.run,
  stage: stored?.stage ?? null,
  text: `Check "${check.contract.name}" passes`,
  source: 'contract',
  contract: check.contract.name,
  status: { value: verdict.status, basis: observed, evidence: [...new Set(verdict.evidence)].sort() },
  checked_commit: verdict.checkedCommit,
  clean_tree_commit: verdict.cleanTreeCommit,
})

const updateOf = (transaction: Transaction, resolved: ResolvedCheck, verdict: Verdict): Update | null => {
  const stored = storedCriterion(transaction, resolved.check)
  const criterion = criterionOf(resolved.check, verdict, stored)
  if (stored !== null && isDeepStrictEqual(stored, criterion)) {
    return null
  }
  return {
    change: { op: 'criterion.status', put: { kind: 'criterion', value: criterion }, basis: observed, evidence: criterion.status.evidence },
    at: verdict.at,
  }
}

export const reconcileCriteria = (
  transaction: Transaction,
  resolved: readonly ResolvedCheck[],
): ReadonlyMap<RunId, readonly ResolvedCheck[]> => {
  const updates = new Map<RunId, Update[]>()
  const versioned = new Map<RunId, ResolvedCheck[]>()
  for (const entry of resolved) {
    const { run } = entry.check
    const verdict = verdictOf(transaction, entry)
    const update = updateOf(transaction, entry, verdict)
    updates.set(run, [...(updates.get(run) ?? []), ...(update === null ? [] : [update])])
    versioned.set(run, [...(versioned.get(run) ?? []), ...(verdict.checkedCommit === null ? [] : [entry])])
  }
  for (const [run, changes] of updates) {
    const at = changes.map((update) => update.at).reduce<EpochNs | null>((latest, time) => (latest === null ? time : later(latest, time)), null)
    if (at !== null) {
      applyChangeSet(transaction, { run, author: 'rule', at, changes: changes.map(({ change }) => change) })
    }
  }
  return versioned
}
