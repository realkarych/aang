import { isDeepStrictEqual } from 'node:util'
import {
  type ActionId,
  type AttentionItem,
  AttentionItemId,
  type Basis,
  type EpochNs,
  type ModelEntity,
  ModelVersion,
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

const citedActions = (transaction: Transaction, run: RunId, item: AttentionItem): ActionId[] => {
  const facts = new Set(
    transaction.model
      .entityChanges(run, { kind: 'attention_item', id: item.id }, ModelVersion.parse(0))
      .flatMap(({ after }) => (after?.kind === 'attention_item' ? after.value.evidence : [])),
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
  const claim = (entry: ContractStreak, candidates: readonly AttentionItem[]): AttentionItem | null => {
    const item = preferred(run, entry, candidates)
    if (item !== null) {
      free.delete(item.id)
    }
    return item
  }
  const byId = streaks.map((entry) =>
    claim(
      entry,
      entry.streak.failures.flatMap(({ action }) => free.get(itemId(run, entry.contract, action.id)) ?? []),
    ),
  )
  const sharing = ({ contract, streak }: ContractStreak): AttentionItem[] => {
    const cited = new Set(streak.failures.flatMap(({ evidence }) => evidence))
    return [...free.values()].filter(
      (candidate) => candidate.evidence.some((id) => cited.has(id)) && openedFor(transaction, run, contract, candidate),
    )
  }
  return streaks.map((entry, index) => ({ ...entry, existing: byId[index] ?? claim(entry, sharing(entry)) }))
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

const rootCwd = (transaction: Transaction, run: RunId, session: Session | null): string | null => {
  const entity = transaction.model.entity(run, { kind: 'run', id: run })
  if (entity?.kind === 'run') {
    return transaction.observations.getSession(entity.value.root_session)?.cwd ?? null
  }
  return session !== null && runId(session.key) === run ? session.cwd : null
}

const runOf = (transaction: Transaction, key: SessionKey): RunId =>
  transaction.model.entityRuns({ kind: 'session_membership', id: objectId(key) }).toSorted(compareText)[0] ??
  runId(key)

const runActions = (
  transaction: Transaction,
  run: RunId,
  session: Session | null,
  entities: readonly ModelEntity[],
): ActionFacts[] => {
  const members = new Set<SessionId>(session === null ? [] : [session.id])
  for (const entity of entities) {
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

const leaving = ({ id }: AttentionItem): ModelChangeDraft => ({
  op: 'session.move',
  remove: { kind: 'attention_item', id },
  basis: observed,
  evidence: [],
})

const latestOf = (times: readonly EpochNs[]): EpochNs | null =>
  times.reduce<EpochNs | null>((latest, time) => (latest === null || time > latest ? time : latest), null)

const refreshRun = (
  transaction: Transaction,
  run: RunId,
  session: Session | null,
  catalog: ContractCatalog,
  at: EpochNs,
): void => {
  const cwd = rootCwd(transaction, run, session)
  const contracts = cwd === null ? [] : catalog.contractsFor(cwd)
  if (contracts.length === 0) {
    return
  }
  const entities = transaction.model.entities(run)
  const actions = runActions(transaction, run, session, entities)
  const checks = contracts.map((contract) => ({
    contract,
    results: actions.flatMap((entry) => checkResult(entry, contract) ?? []).sort(byResultTime),
  }))
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
  const left = items.filter(({ id, evidence }) => !claimed.has(id) && !evidence.some((fact) => present.has(fact)))
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

export const refreshChecks = (
  transaction: Transaction,
  sessions: Iterable<SessionKey>,
  catalog: ContractCatalog,
  at: EpochNs,
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
    refreshRun(transaction, run, session, catalog, at)
  }
}

export const refreshRunChecks = (
  transaction: Transaction,
  runs: Iterable<RunId>,
  catalog: ContractCatalog,
  at: EpochNs,
): void => {
  if (catalog.empty) {
    return
  }
  for (const run of new Set(runs)) {
    refreshRun(transaction, run, null, catalog, at)
  }
}
