import type { ActionId, Fact, FactId, FactOf, RunId, SessionId, SessionKey } from '@aang/contract'
import type { Transaction } from '@aang/store'
import type { Contract } from '../checks/catalog.js'
import { checkDirectory, type CheckEntry, type RunChecks } from '../checks/history.js'
import type { CheckResult } from '../checks/results.js'

export interface ReportedCommit {
  readonly name: string
  readonly evidence: readonly FactId[]
}

export interface CriterionCheck {
  readonly run: RunId
  readonly root: SessionKey
  readonly contract: Contract
  readonly result: CheckResult
  readonly directory: string | null
  readonly commit: ReportedCommit | null
  readonly carried: readonly ActionId[]
}

const objectName = /^[0-9a-f]{7,64}$/

const isEnd = (fact: Fact): fact is FactOf<'action_end'> => fact.kind === 'action_end'

const captured = (match: RegExpMatchArray): string => (match.groups?.['commit'] ?? match[1] ?? match[0]).trim().toLowerCase()

const longest = (names: ReadonlySet<string>): string[] =>
  [...names].filter((name) => ![...names].some((other) => other !== name && other.startsWith(name)))

const namesOf = (pattern: RegExp, { payload }: FactOf<'action_end'>): string[] =>
  payload.output === null ? [] : [...payload.output.matchAll(pattern)].map(captured).filter((name) => objectName.test(name))

const reportedCommit = (pattern: RegExp, ends: readonly FactOf<'action_end'>[]): ReportedCommit | null => {
  const reports = ends.map((end) => ({ end, names: namesOf(pattern, end) }))
  const [name, ...others] = longest(new Set(reports.flatMap(({ names }) => names)))
  return name === undefined || others.length > 0
    ? null
    : { name, evidence: reports.flatMap(({ end, names }) => (names.length === 0 ? [] : [end.id])) }
}

const criterionCheck = (
  transaction: Transaction,
  { run, root }: RunChecks,
  contract: Contract,
  entry: CheckEntry,
  carried: readonly ActionId[],
): CriterionCheck => {
  const ends = entry.facts.filter(isEnd)
  const { commitPattern } = contract
  return {
    run,
    root: root.key,
    contract,
    result: entry.result,
    directory: checkDirectory(transaction, entry, root),
    commit: entry.result.passed && commitPattern !== null ? reportedCommit(commitPattern, ends) : null,
    carried,
  }
}

export const latestChecks = (
  transaction: Transaction,
  runs: readonly RunChecks[],
  moved: ReadonlySet<SessionId>,
): CriterionCheck[] =>
  runs.flatMap((checks) =>
    checks.contracts.flatMap(({ contract, checks: entries }) => {
      const latest = entries.at(-1)
      const carried = entries.flatMap(({ action }) => (moved.has(action.session) ? [action.id] : []))
      return latest === undefined ? [] : [criterionCheck(transaction, checks, contract, latest, carried)]
    }),
  )
