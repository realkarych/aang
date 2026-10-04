import type { FactOf, RunId, Session, SessionId, SessionKey } from '@aang/contract'
import { objectId } from '@aang/contract/ids'
import type { Transaction } from '@aang/store'
import { actionDirectory } from '../observations/directories.js'
import { compareText } from '../observations/evidence.js'
import { rootSessionOf, sessionRun } from '../observations/runs.js'
import type { Contract, ContractCatalog } from './catalog.js'
import { type ActionFacts, type CheckResult, checkResult } from './results.js'

export interface CheckEntry extends ActionFacts {
  readonly result: CheckResult
}

export interface ContractChecks {
  readonly contract: Contract
  readonly checks: readonly CheckEntry[]
}

export interface RunChecks {
  readonly run: RunId
  readonly root: Session
  readonly actions: readonly ActionFacts[]
  readonly contracts: readonly ContractChecks[]
}

const byResultTime = ({ result: left }: CheckEntry, { result: right }: CheckEntry): number =>
  left.at < right.at ? -1 : left.at > right.at ? 1 : compareText(left.action.id, right.action.id)

const present = (path: string | null): string | null => (path === '' ? null : path)

const isStart = (fact: ActionFacts['facts'][number]): fact is FactOf<'action_start'> => fact.kind === 'action_start'

export const checkDirectory = (transaction: Transaction, { action, facts }: ActionFacts, root: Session): string | null =>
  actionDirectory(facts.filter(isStart), transaction.observations.getSession(action.session)?.cwd ?? null) ??
  present(root.cwd)

const runActions = (transaction: Transaction, run: RunId, session: Session | null): ActionFacts[] => {
  const members = new Set<SessionId>(session === null ? [] : [session.id])
  for (const entity of transaction.model.entities(run)) {
    if (entity.kind !== 'session_membership') {
      continue
    }
    const member = transaction.observations.getSession(entity.value.session)
    if (member !== null && sessionRun(transaction, member.key) === run) {
      members.add(member.id)
    }
  }
  return [...members]
    .flatMap((member) => transaction.observations.actions(member))
    .filter((action) => action.action_kind === 'command' && !action.inherited)
    .map((action) => ({ action, facts: transaction.facts.ofEntity(action.key) }))
}

export const runChecks = (
  transaction: Transaction,
  run: RunId,
  session: Session | null,
  catalog: ContractCatalog,
): RunChecks | null => {
  const root = rootSessionOf(transaction, run, session)
  const contracts = root?.cwd === null || root?.cwd === undefined ? [] : catalog.contractsFor(root.cwd)
  if (root === null || contracts.length === 0) {
    return null
  }
  const actions = runActions(transaction, run, session)
  return {
    run,
    root,
    actions,
    contracts: contracts.map((contract) => ({
      contract,
      checks: actions
        .flatMap((entry) => {
          const result = checkResult(entry, contract)
          return result === null ? [] : [{ ...entry, result }]
        })
        .sort(byResultTime),
    })),
  }
}

export const changedRunChecks = (
  transaction: Transaction,
  sessions: Iterable<SessionKey>,
  catalog: ContractCatalog,
): RunChecks[] => {
  if (catalog.empty) {
    return []
  }
  const runs = new Set<RunId>()
  const checked: RunChecks[] = []
  for (const key of sessions) {
    const session = transaction.observations.getSession(objectId(key))
    const run = sessionRun(transaction, key)
    if (session === null || runs.has(run)) {
      continue
    }
    runs.add(run)
    const checks = runChecks(transaction, run, session, catalog)
    if (checks !== null) {
      checked.push(checks)
    }
  }
  return checked
}

export const storedRunChecks = (
  transaction: Transaction,
  runs: Iterable<RunId>,
  catalog: ContractCatalog,
): RunChecks[] =>
  catalog.empty ? [] : [...new Set(runs)].flatMap((run) => runChecks(transaction, run, null, catalog) ?? [])
