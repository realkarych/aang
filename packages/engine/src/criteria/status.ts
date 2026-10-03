import { isDeepStrictEqual } from 'node:util'
import {
  type Basis,
  type Criterion,
  CriterionId,
  type CriterionStatus,
  type EpochNs,
  type Fact,
  type FactId,
  type FactOf,
  type RunId,
  type SessionId,
} from '@aang/contract'
import { canonicalJson, contentHash } from '@aang/contract/ids'
import type { Transaction } from '@aang/store'
import type { RunChecks } from '../checks/history.js'
import { applyChangeSet, type ModelChangeDraft } from '../model/journal.js'
import type { CheckGit, ResolvedCheck } from './git.js'
import type { CriterionCheck } from './plan.js'

interface Verdict {
  readonly status: CriterionStatus
  readonly evidence: readonly FactId[]
  readonly checkedCommit: string | null
  readonly cleanTreeCommit: string | null
  readonly at: EpochNs
}

interface VerifiedCommit {
  readonly name: string
  readonly evidence: readonly FactId[]
}

interface Update {
  readonly change: ModelChangeDraft
  readonly at: EpochNs
}

export type Origins = ReadonlyMap<SessionId, RunId>

type Seen = FactOf<'git_snapshot'>

type Foreign = (considered: readonly (Seen | undefined)[]) => FactId[]

const observed: Basis = { kind: 'observed' }

const criterionIdLength = 32

export const criterionId = (run: RunId, contract: string): CriterionId =>
  CriterionId.parse(contentHash(canonicalJson(['contract_criterion', run, contract])).slice(0, criterionIdLength))

const criterionIn = (transaction: Transaction, run: RunId, { contract }: CriterionCheck): Criterion | null => {
  const entity = transaction.model.entity(run, { kind: 'criterion', id: criterionId(run, contract.name) })
  return entity?.kind === 'criterion' ? entity.value : null
}

const storedCriterion = (transaction: Transaction, check: CriterionCheck): Criterion | null =>
  criterionIn(transaction, check.run, check)

export const isVersioned = (transaction: Transaction, check: CriterionCheck): boolean =>
  (storedCriterion(transaction, check)?.checked_commit ?? null) !== null

const later = (left: EpochNs, right: EpochNs): EpochNs => (right > left ? right : left)

const sameMasks = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((mask, index) => mask === right[index])

const priorRuns = (check: CriterionCheck, origins: Origins): RunId[] => {
  const origin = origins.get(check.result.action.session)
  return origin === undefined || origin === check.run ? [check.run] : [check.run, origin]
}

const isSnapshot = (fact: Fact | null): fact is Seen => fact?.kind === 'git_snapshot'

const knownSnapshots = (transaction: Transaction, run: RunId, check: CriterionCheck): FactId[] => [
  ...transaction.artifacts.snapshots(run).map(({ fact }) => fact),
  ...(criterionIn(transaction, run, check)?.status.evidence ?? []),
]

const snapshotsOf = (transaction: Transaction, check: CriterionCheck, { worktree }: CheckGit, runs: readonly RunId[]): Seen[] =>
  [...new Set(runs.flatMap((run) => knownSnapshots(transaction, run, check)))]
    .map((id) => transaction.facts.get(id))
    .filter(isSnapshot)
    .filter(
      ({ payload }) =>
        (payload.worktree === worktree || payload.worktree === check.directory) &&
        sameMasks(payload.masks, check.contract.inputMasks),
    )
    .sort((left, right) => left.seq - right.seq)

const foreignTo = (transaction: Transaction, run: RunId): Foreign => {
  const native = new Set(transaction.artifacts.snapshots(run).map(({ fact }) => fact))
  return (considered) => considered.flatMap((seen) => (seen === undefined || native.has(seen.id) ? [] : [seen.id]))
}

const showsCommit = ({ payload }: Seen, commit: string): boolean => payload.clean && payload.head === commit

const firstDeparture = (after: readonly Seen[], commit: string): Seen | null => {
  let departure: Seen | null = null
  for (const seen of after) {
    departure = showsCommit(seen, commit) ? null : (departure ?? seen)
  }
  return departure
}

const versionedVerdict = ({ result }: CriterionCheck, commit: VerifiedCommit, after: readonly Seen[], foreign: Foreign): Verdict => {
  const evidence = [...result.evidence, ...commit.evidence, ...foreign(after)]
  const departure = firstDeparture(after, commit.name)
  if (departure === null) {
    const latest = after.at(-1)
    return {
      status: 'confirmed',
      evidence,
      checkedCommit: commit.name,
      cleanTreeCommit: null,
      at: latest === undefined ? result.at : later(result.at, latest.at),
    }
  }
  return {
    status: 'stale',
    evidence: [...evidence, departure.id],
    checkedCommit: commit.name,
    cleanTreeCommit: null,
    at: later(result.at, departure.at),
  }
}

const unversionedVerdict = ({ result }: CriterionCheck, seen: readonly Seen[], foreign: Foreign): Verdict => {
  const { started, ended } = result
  const before = seen.filter(({ seq }) => seq > started && seq < ended).at(-1)
  const after = seen.find(({ seq }) => seq > ended)
  const plain: Verdict = {
    status: 'passed_unversioned',
    evidence: [...result.evidence, ...foreign([before, after])],
    checkedCommit: null,
    cleanTreeCommit: null,
    at: result.at,
  }
  const head = before?.payload.head ?? null
  if (before === undefined || after === undefined || head === null || !showsCommit(before, head) || !showsCommit(after, head)) {
    return plain
  }
  return {
    ...plain,
    evidence: [...result.evidence, before.id, after.id],
    cleanTreeCommit: head,
    at: later(result.at, after.at),
  }
}

const establishedCommit = (stored: Criterion | null, { result, commit }: CriterionCheck): string | null => {
  const checked = stored?.checked_commit ?? null
  if (stored === null || checked === null || commit === null || !checked.startsWith(commit.name)) {
    return null
  }
  const cited = new Set(stored.status.evidence)
  return [...result.evidence, ...commit.evidence].every((fact) => cited.has(fact)) ? checked : null
}

const verifiedCommit = (transaction: Transaction, { check, git }: ResolvedCheck, runs: readonly RunId[]): VerifiedCommit | null => {
  const established = runs.map((run) => establishedCommit(criterionIn(transaction, run, check), check)).find((name) => name !== null)
  const name = established ?? git.commit
  return name === null || check.commit === null ? null : { name, evidence: check.commit.evidence }
}

const verdictOf = (transaction: Transaction, resolved: ResolvedCheck, origins: Origins): Verdict => {
  const { check, git } = resolved
  const { result } = check
  if (!result.passed) {
    return { status: 'failed', evidence: result.evidence, checkedCommit: null, cleanTreeCommit: null, at: result.at }
  }
  const runs = priorRuns(check, origins)
  const seen = snapshotsOf(transaction, check, git, runs)
  const commit = verifiedCommit(transaction, resolved, runs)
  const foreign = foreignTo(transaction, check.run)
  return commit === null
    ? unversionedVerdict(check, seen, foreign)
    : versionedVerdict(check, commit, seen.filter(({ seq }) => seq > result.ended), foreign)
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

export const releaseCriteria = (transaction: Transaction, runs: readonly RunChecks[], at: EpochNs): void => {
  for (const { run, contracts } of runs) {
    const changes = contracts.flatMap(({ contract, checks }): ModelChangeDraft[] => {
      const id = criterionId(run, contract.name)
      return checks.length === 0 && transaction.model.entity(run, { kind: 'criterion', id }) !== null
        ? [{ op: 'session.move', remove: { kind: 'criterion', id }, basis: observed, evidence: [] }]
        : []
    })
    if (changes.length > 0) {
      applyChangeSet(transaction, { run, author: 'rule', at, changes })
    }
  }
}

export const reconcileCriteria = (
  transaction: Transaction,
  resolved: readonly ResolvedCheck[],
  origins: Origins,
): ReadonlyMap<RunId, readonly ResolvedCheck[]> => {
  const updates = new Map<RunId, Update[]>()
  const versioned = new Map<RunId, ResolvedCheck[]>()
  for (const entry of resolved) {
    const { run } = entry.check
    const verdict = verdictOf(transaction, entry, origins)
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
