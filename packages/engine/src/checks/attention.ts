import { isDeepStrictEqual } from 'node:util'
import {
  type Action,
  type AttentionItem,
  AttentionItemId,
  type Basis,
  type EpochNs,
  type RunId,
  type Session,
  type SessionId,
  type SessionKey,
} from '@aang/contract'
import { canonicalJson, contentHash, objectId, runId } from '@aang/contract/ids'
import type { Transaction } from '@aang/store'
import { applyChangeSet, type AttentionItemDraft, type ModelChangeDraft } from '../model/journal.js'
import type { Contract, ContractCatalog } from './catalog.js'
import { type ActionFacts, type CheckResult, checkResult } from './results.js'

interface Streak {
  readonly failures: readonly [CheckResult, ...CheckResult[]]
  readonly success: CheckResult | null
}

interface StreakChanges {
  readonly changes: readonly ModelChangeDraft[]
  readonly at: EpochNs
}

const observed: Basis = { kind: 'observed' }

const itemIdLength = 32

const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)

const byResultTime = (left: CheckResult, right: CheckResult): number =>
  left.at < right.at ? -1 : left.at > right.at ? 1 : compareText(left.action.id, right.action.id)

const streaksOf = (results: readonly CheckResult[]): Streak[] => {
  const streaks: Streak[] = []
  let failures: CheckResult[] = []
  for (const result of results) {
    if (!result.passed) {
      failures.push(result)
      continue
    }
    const [first, ...rest] = failures
    if (first !== undefined) {
      streaks.push({ failures: [first, ...rest], success: result })
      failures = []
    }
  }
  const [first, ...rest] = failures
  return first === undefined ? streaks : [...streaks, { failures: [first, ...rest], success: null }]
}

const itemId = (run: RunId, contract: Contract, action: Action): AttentionItemId =>
  AttentionItemId.parse(
    contentHash(canonicalJson(['failed_check', run, contract.name, action.id])).slice(0, itemIdLength),
  )

const failureText = (contract: Contract, { exitCode }: CheckResult): string =>
  exitCode === null
    ? `Check "${contract.name}" failed`
    : `Check "${contract.name}" failed with exit code ${String(exitCode)}`

const existingItems = (transaction: Transaction, run: RunId, ids: readonly AttentionItemId[]): AttentionItem[] =>
  ids.flatMap((id) => {
    const entity = transaction.model.entity(run, { kind: 'attention_item', id })
    return entity?.kind === 'attention_item' ? [entity.value] : []
  })

const latestFailure = ({ failures }: Streak): CheckResult => failures.at(-1) ?? failures[0]

const streakItem = (
  run: RunId,
  contract: Contract,
  streak: Streak,
  existing: AttentionItem | null,
): AttentionItemDraft => {
  const { failures, success } = streak
  const [first] = failures
  const latest = latestFailure(streak)
  return {
    id: existing?.id ?? itemId(run, contract, first.action),
    run,
    kind: 'failed_check',
    author: 'rule',
    text: failureText(contract, latest),
    stage: existing?.stage ?? null,
    question: null,
    action: latest.action.id,
    basis: observed,
    evidence: [...new Set(failures.flatMap((failure) => failure.evidence))].sort(),
    runtime_wait: 'none',
    resolution: success === null ? 'open' : 'answered',
    likely_resolved: existing?.likely_resolved ?? null,
    priority: existing?.priority ?? null,
    opened_at: first.at,
    closed_at: success?.at ?? null,
  }
}

const represents = (existing: AttentionItem, item: AttentionItemDraft): boolean =>
  isDeepStrictEqual(existing, { ...item, change_seq: existing.change_seq })

const streakChanges = (
  transaction: Transaction,
  run: RunId,
  contract: Contract,
  streak: Streak,
): StreakChanges | null => {
  const candidates = existingItems(
    transaction,
    run,
    streak.failures.map(({ action }) => itemId(run, contract, action)),
  )
  const existing =
    candidates.find(({ resolution }) => resolution === 'open') ??
    candidates.find((candidate) => represents(candidate, streakItem(run, contract, streak, candidate))) ??
    candidates[0] ??
    null
  const item = streakItem(run, contract, streak, existing)
  const { success } = streak
  const opening: ModelChangeDraft = {
    op: 'attention.open',
    put: { kind: 'attention_item', value: { ...item, resolution: 'open', closed_at: null } },
    basis: observed,
    evidence: item.evidence,
  }
  const closing: ModelChangeDraft | null =
    success === null
      ? null
      : {
          op: 'attention.close',
          put: { kind: 'attention_item', value: item },
          basis: observed,
          evidence: success.evidence,
        }
  const at = success?.at ?? latestFailure(streak).at
  if (existing === null) {
    return { changes: closing === null ? [opening] : [opening, closing], at }
  }
  if (represents(existing, item)) {
    return null
  }
  return { changes: [closing ?? opening], at }
}

const rootCwd = (transaction: Transaction, run: RunId, session: Session): string | null => {
  const entity = transaction.model.entity(run, { kind: 'run', id: run })
  if (entity?.kind === 'run') {
    return transaction.observations.getSession(entity.value.root_session)?.cwd ?? null
  }
  return runId(session.key) === run ? session.cwd : null
}

const runOf = (transaction: Transaction, key: SessionKey): RunId =>
  transaction.model.entityRuns({ kind: 'session_membership', id: objectId(key) }).toSorted(compareText)[0] ??
  runId(key)

const runActions = (transaction: Transaction, run: RunId, session: Session): ActionFacts[] => {
  const members = new Set<SessionId>([session.id])
  for (const entity of transaction.model.entities(run)) {
    if (entity.kind !== 'session_membership') {
      continue
    }
    const member = transaction.observations.getSession(entity.value.session)
    if (member !== null && runOf(transaction, member.key) === run) {
      members.add(member.id)
    }
  }
  return [...members]
    .flatMap((member) => transaction.observations.actions(member))
    .filter((action) => action.action_kind === 'command' && !action.inherited)
    .map((action) => ({ action, facts: transaction.facts.ofEntity(action.key) }))
}

const refreshRun = (transaction: Transaction, run: RunId, session: Session, catalog: ContractCatalog): void => {
  const cwd = rootCwd(transaction, run, session)
  const contracts = cwd === null ? [] : catalog.contractsFor(cwd)
  if (contracts.length === 0) {
    return
  }
  const actions = runActions(transaction, run, session)
  const updates = contracts.flatMap((contract) => {
    const results = actions
      .flatMap((entry) => checkResult(entry, contract) ?? [])
      .sort(byResultTime)
    return streaksOf(results).flatMap((streak) => streakChanges(transaction, run, contract, streak) ?? [])
  })
  const changes = updates.flatMap((update) => update.changes)
  const at = updates.map((update) => update.at).reduce<EpochNs | null>(
    (latest, time) => (latest === null || time > latest ? time : latest),
    null,
  )
  if (at !== null) {
    applyChangeSet(transaction, { run, author: 'rule', at, changes })
  }
}

export const refreshChecks = (
  transaction: Transaction,
  sessions: Iterable<SessionKey>,
  catalog: ContractCatalog,
): void => {
  if (catalog.empty) {
    return
  }
  const runs = new Set<RunId>()
  for (const key of sessions) {
    const session = transaction.observations.getSession(objectId(key))
    const run = runOf(transaction, key)
    if (session === null || runs.has(run)) {
      continue
    }
    runs.add(run)
    refreshRun(transaction, run, session, catalog)
  }
}
