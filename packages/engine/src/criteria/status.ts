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
  type ModelChange,
  type ModelEntityRef,
  ModelVersion,
  type RunId,
} from '@aang/contract'
import { canonicalJson, contentHash } from '@aang/contract/ids'
import type { Transaction } from '@aang/store'
import { resolvedMasks } from '../checks/catalog.js'
import type { RunChecks } from '../checks/history.js'
import { applyChangeSet, type ModelChangeDraft } from '../model/journal.js'
import type { CheckGit, ResolvedCheck } from './git.js'
import type { CriterionCheck } from './plan.js'

interface Verdict {
  readonly op: 'criterion.status' | 'session.move'
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

type Seen = FactOf<'git_snapshot'>

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

const cites = (criterion: Criterion | null, { result }: CriterionCheck): boolean =>
  criterion !== null && result.evidence.some((fact) => criterion.status.evidence.includes(fact))

const changesOf = (transaction: Transaction, run: RunId, target: ModelEntityRef): ModelChange[] =>
  transaction.model.entityChanges(run, target, ModelVersion.parse(0))

const carriedBySession = (transaction: Transaction, { run, result }: CriterionCheck): boolean => {
  const last = changesOf(transaction, run, { kind: 'session_membership', id: result.action.session }).at(-1)
  return (
    last?.op === 'session.move' &&
    last.evidence.some((id) => {
      const anchor = transaction.facts.get(id)
      return anchor === null || result.ended <= anchor.seq
    })
  )
}

const broughtByMove = (transaction: Transaction, check: CriterionCheck): boolean =>
  changesOf(transaction, check.run, { kind: 'criterion', id: criterionId(check.run, check.contract.name) }).some(
    ({ op, author, after }) =>
      op === 'session.move' &&
      author === 'rule' &&
      after?.kind === 'criterion' &&
      after.value.status.value === 'passed_unversioned' &&
      cites(after.value, check),
  )

const unversionedByMove = (transaction: Transaction, check: CriterionCheck, moved: boolean): boolean =>
  carriedBySession(transaction, check) ||
  broughtByMove(transaction, check) ||
  (moved && !cites(storedCriterion(transaction, check), check))

const isSnapshot = (fact: Fact | null): fact is Seen => fact?.kind === 'git_snapshot'

const snapshotsOf = (transaction: Transaction, check: CriterionCheck, { worktree }: CheckGit): Seen[] => {
  const masks = resolvedMasks(check.contract)
  return transaction.artifacts
    .snapshots(check.run)
    .filter((snapshot) => (snapshot.worktree === worktree || snapshot.worktree === check.directory) && sameMasks(snapshot.masks, masks))
    .map(({ fact }) => transaction.facts.get(fact))
    .filter(isSnapshot)
    .sort((left, right) => left.seq - right.seq)
}

const showsCommit = ({ payload }: Seen, commit: string): boolean => payload.clean && payload.head === commit

const firstDeparture = (after: readonly Seen[], commit: string): Seen | null => {
  let departure: Seen | null = null
  for (const seen of after) {
    departure = showsCommit(seen, commit) ? null : (departure ?? seen)
  }
  return departure
}

const versionedVerdict = ({ result }: CriterionCheck, commit: VerifiedCommit, after: readonly Seen[]): Verdict => {
  const evidence = [...result.evidence, ...commit.evidence]
  const departure = firstDeparture(after, commit.name)
  if (departure === null) {
    const latest = after.at(-1)
    return {
      op: 'criterion.status',
      status: 'confirmed',
      evidence,
      checkedCommit: commit.name,
      cleanTreeCommit: null,
      at: latest === undefined ? result.at : later(result.at, latest.at),
    }
  }
  return {
    op: 'criterion.status',
    status: 'stale',
    evidence: [...evidence, departure.id],
    checkedCommit: commit.name,
    cleanTreeCommit: null,
    at: later(result.at, departure.at),
  }
}

const unversionedVerdict = ({ result }: CriterionCheck, seen: readonly Seen[]): Verdict => {
  const { started, ended } = result
  const before = seen.filter(({ seq }) => seq > started && seq < ended).at(-1)
  const after = seen.find(({ seq }) => seq > ended)
  const plain: Verdict = {
    op: 'criterion.status',
    status: 'passed_unversioned',
    evidence: result.evidence,
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

const verifiedCommit = (transaction: Transaction, check: CriterionCheck, git: CheckGit): VerifiedCommit | null => {
  const name = establishedCommit(storedCriterion(transaction, check), check) ?? git.commit
  return name === null || check.commit === null ? null : { name, evidence: check.commit.evidence }
}

const verdictOf = (transaction: Transaction, { check, git }: ResolvedCheck, moved: boolean): Verdict => {
  const { result } = check
  if (!result.passed) {
    return { op: 'criterion.status', status: 'failed', evidence: result.evidence, checkedCommit: null, cleanTreeCommit: null, at: result.at }
  }
  if (unversionedByMove(transaction, check, moved)) {
    return { op: 'session.move', status: 'passed_unversioned', evidence: result.evidence, checkedCommit: null, cleanTreeCommit: null, at: result.at }
  }
  const seen = snapshotsOf(transaction, check, git)
  const commit = verifiedCommit(transaction, check, git)
  return commit === null
    ? unversionedVerdict(check, seen)
    : versionedVerdict(check, commit, seen.filter(({ seq }) => seq > result.ended))
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
    change: { op: verdict.op, put: { kind: 'criterion', value: criterion }, basis: observed, evidence: criterion.status.evidence },
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
  moved: boolean,
): ReadonlyMap<RunId, readonly ResolvedCheck[]> => {
  const updates = new Map<RunId, Update[]>()
  const versioned = new Map<RunId, ResolvedCheck[]>()
  for (const entry of resolved) {
    const { run } = entry.check
    const verdict = verdictOf(transaction, entry, moved)
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
