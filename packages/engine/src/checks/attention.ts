import { isDeepStrictEqual } from 'node:util'
import {
  type ActionId,
  type AttentionItem,
  AttentionItemId,
  type Basis,
  type EpochNs,
  type FactId,
  type ModelChange,
  type ModelEntity,
  ModelVersion,
  type RunId,
} from '@aang/contract'
import { canonicalJson, contentHash, objectId } from '@aang/contract/ids'
import type { Transaction } from '@aang/store'
import { applyChangeSet, type AttentionItemDraft, type ModelChangeDraft } from '../model/journal.js'
import type { Contract } from './catalog.js'
import type { RunChecks } from './history.js'
import type { CheckResult } from './results.js'

interface Streak {
  readonly failures: readonly [CheckResult, ...CheckResult[]]
  readonly success: CheckResult | null
}

interface ContractStreak {
  readonly contract: Contract
  readonly streak: Streak
}

interface MatchedStreak extends ContractStreak {
  readonly existing: AttentionItem | null
}

interface ContractResults {
  readonly contract: Contract
  readonly results: readonly CheckResult[]
}

interface SucceededItem {
  readonly item: AttentionItem
  readonly success: CheckResult
}

interface StreakChanges {
  readonly changes: readonly ModelChangeDraft[]
  readonly at: EpochNs
}

const observed: Basis = { kind: 'observed' }

const itemIdLength = 32

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

const itemId = (run: RunId, contract: Contract, action: ActionId): AttentionItemId =>
  AttentionItemId.parse(contentHash(canonicalJson(['failed_check', run, contract.name, action])).slice(0, itemIdLength))

const failureText = (contract: Contract, { exitCode }: CheckResult): string =>
  exitCode === null
    ? `Check "${contract.name}" failed`
    : `Check "${contract.name}" failed with exit code ${String(exitCode)}`

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
    id: existing?.id ?? itemId(run, contract, first.action.id),
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

const failedCheckItems = (entities: readonly ModelEntity[]): AttentionItem[] =>
  entities.flatMap((entity) =>
    entity.kind === 'attention_item' && entity.value.kind === 'failed_check' ? [entity.value] : [],
  )

const itemChanges = (transaction: Transaction, run: RunId, { id }: AttentionItem): ModelChange[] =>
  transaction.model.entityChanges(run, { kind: 'attention_item', id }, ModelVersion.parse(0))

const citedActions = (transaction: Transaction, run: RunId, item: AttentionItem): ActionId[] => {
  const facts = new Set(
    itemChanges(transaction, run, item).flatMap(({ after }) =>
      after?.kind === 'attention_item' ? after.value.evidence : [],
    ),
  )
  return [...facts].flatMap((id) => {
    const key = transaction.facts.get(id)?.entity_key
    return key?.kind === 'action' ? [objectId(key)] : []
  })
}

const openedFor = (transaction: Transaction, run: RunId, contract: Contract, item: AttentionItem): boolean =>
  citedActions(transaction, run, item).some((action) => itemId(run, contract, action) === item.id)

const preferred = (
  run: RunId,
  { contract, streak }: ContractStreak,
  candidates: readonly AttentionItem[],
): AttentionItem | null =>
  candidates.find(({ resolution }) => resolution === 'open') ??
  candidates.find((candidate) => represents(candidate, streakItem(run, contract, streak, candidate))) ??
  candidates[0] ??
  null

const matchedItems = (
  transaction: Transaction,
  run: RunId,
  streaks: readonly ContractStreak[],
  items: readonly AttentionItem[],
): MatchedStreak[] => {
  const free = new Map(items.map((item) => [item.id, item]))
  const named = streaks.map(({ contract, streak }) =>
    streak.failures.flatMap(({ action }) => free.get(itemId(run, contract, action.id)) ?? []),
  )
  for (const { id } of named.flat()) {
    free.delete(id)
  }
  const sharing = ({ contract, streak }: ContractStreak): AttentionItem[] => {
    const cited = new Set(streak.failures.flatMap(({ evidence }) => evidence))
    return [...free.values()].filter(
      (candidate) => candidate.evidence.some((id) => cited.has(id)) && openedFor(transaction, run, contract, candidate),
    )
  }
  return streaks.map((entry, index) => {
    const existing = preferred(run, entry, [...(named[index] ?? []), ...sharing(entry)])
    if (existing !== null) {
      free.delete(existing.id)
    }
    return { ...entry, existing }
  })
}

const streakChanges = (
  run: RunId,
  contract: Contract,
  streak: Streak,
  existing: AttentionItem | null,
): StreakChanges | null => {
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

const succeededItems = (
  run: RunId,
  checks: readonly ContractResults[],
  items: readonly AttentionItem[],
): SucceededItem[] => {
  const byId = new Map(items.map((item) => [item.id, item]))
  return checks.flatMap(({ contract, results }) =>
    results.flatMap((success) => {
      const item = success.passed ? byId.get(itemId(run, contract, success.action.id)) : undefined
      return item === undefined ? [] : [{ item, success }]
    }),
  )
}

const successChanges = ({ item, success }: SucceededItem): StreakChanges[] =>
  item.resolution === 'open'
    ? [
        {
          changes: [
            {
              op: 'attention.close',
              put: { kind: 'attention_item', value: { ...item, resolution: 'answered', closed_at: success.at } },
              basis: observed,
              evidence: success.evidence,
            },
          ],
          at: success.at,
        },
      ]
    : []

const leaving = ({ id }: AttentionItem): ModelChangeDraft => ({
  op: 'session.move',
  remove: { kind: 'attention_item', id },
  basis: observed,
  evidence: [],
})

const closingFacts = (transaction: Transaction, run: RunId, item: AttentionItem): readonly FactId[] =>
  item.resolution === 'answered'
    ? (itemChanges(transaction, run, item).findLast(({ op }) => op === 'attention.close')?.evidence ?? [])
    : []

const latestOf = (times: readonly EpochNs[]): EpochNs | null =>
  times.reduce<EpochNs | null>((latest, time) => (latest === null || time > latest ? time : latest), null)

const refreshRun = (transaction: Transaction, { run, actions, contracts }: RunChecks, at: EpochNs): void => {
  const entities = transaction.model.entities(run)
  const checks = contracts.map(({ contract, checks: entries }) => ({ contract, results: entries.map(({ result }) => result) }))
  const streaks = checks.flatMap(({ contract, results }) => streaksOf(results).map((streak) => ({ contract, streak })))
  const items = failedCheckItems(entities)
  const succeeded = succeededItems(run, checks, items)
  const settled = new Set(succeeded.map(({ item }) => item.id))
  const matched = matchedItems(transaction, run, streaks, items.filter(({ id }) => !settled.has(id)))
  const updates = [
    ...matched.flatMap(({ contract, streak, existing }) => streakChanges(run, contract, streak, existing) ?? []),
    ...succeeded.flatMap(successChanges),
  ]
  const claimed = new Set([...settled, ...matched.flatMap(({ existing }) => (existing === null ? [] : [existing.id]))])
  const present = new Set(actions.flatMap(({ facts }) => facts.map(({ id }) => id)))
  const left = items.filter(
    (item) =>
      !claimed.has(item.id) &&
      (!item.evidence.some((fact) => present.has(fact)) ||
        closingFacts(transaction, run, item).some((fact) => !present.has(fact))),
  )
  const time = latestOf([...updates.map((update) => update.at), ...(left.length === 0 ? [] : [at])])
  if (time !== null) {
    applyChangeSet(transaction, {
      run,
      author: 'rule',
      at: time,
      changes: [...updates.flatMap((update) => update.changes), ...left.map(leaving)],
    })
  }
}

export const refreshChecks = (transaction: Transaction, runs: readonly RunChecks[], at: EpochNs): void => {
  for (const checks of runs) {
    refreshRun(transaction, checks, at)
  }
}
