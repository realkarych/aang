import type { Action, EpochNs, Evidence, Fact, FactOf } from '@aang/contract'
import type { Contract } from './catalog.js'
import { commandLines, fieldOf } from './commands.js'

export interface CheckResult {
  readonly action: Action
  readonly passed: boolean
  readonly exitCode: number | null
  readonly at: EpochNs
  readonly evidence: Evidence
}

type Start = FactOf<'action_start'>
type End = FactOf<'action_end'>

interface Verdict {
  readonly passed: boolean
  readonly exitCode: number | null
  readonly fact: End
}

const inBackground = (start: Start): boolean => fieldOf(start.payload.input, 'run_in_background') === true

const settles = ({ payload }: End): boolean => payload.exit_code !== null || payload.outcome !== 'unknown'

const byTime = (left: Fact, right: Fact): number =>
  left.at < right.at ? -1 : left.at > right.at ? 1 : left.id < right.id ? -1 : left.id > right.id ? 1 : 0

const verdictOf = (contract: Contract, ends: readonly End[], background: boolean): Verdict | null => {
  if (ends.some(({ payload }) => payload.outcome === 'interrupted' || payload.outcome === 'denied')) {
    return null
  }
  for (const fact of ends) {
    const exitCode = fact.payload.exit_code
    if (exitCode !== null) {
      return { passed: contract.successExitCodes.includes(exitCode), exitCode, fact }
    }
  }
  const error = ends.find(({ payload }) => payload.outcome === 'error')
  if (error !== undefined) {
    return { passed: false, exitCode: null, fact: error }
  }
  const completed = ends.find(({ payload }) => payload.outcome === 'ok')
  if (completed === undefined || background) {
    return null
  }
  return { passed: contract.successExitCodes.includes(0), exitCode: 0, fact: completed }
}

export interface ActionFacts {
  readonly action: Action
  readonly facts: readonly Fact[]
}

const commandStarts = (facts: readonly Fact[]): Start[] =>
  facts.filter((fact): fact is Start => fact.kind === 'action_start' && fact.payload.action_kind === 'command')

export const matchedStarts = (facts: readonly Fact[], contract: Contract): Start[] =>
  commandStarts(facts).filter(({ payload }) => commandLines(payload.input).some((line) => contract.command.test(line)))

export const checkResult = ({ action, facts }: ActionFacts, contract: Contract): CheckResult | null => {
  const starts = commandStarts(facts)
  const matched = matchedStarts(facts, contract)
  if (matched.length === 0) {
    return null
  }
  const ends = facts.filter((fact): fact is End => fact.kind === 'action_end').sort(byTime)
  const verdict = verdictOf(contract, ends, starts.some(inBackground))
  const settled = ends.find(settles)
  if (verdict === null || settled === undefined) {
    return null
  }
  return {
    action,
    passed: verdict.passed,
    exitCode: verdict.exitCode,
    at: settled.at,
    evidence: [...new Set([...matched.map(({ id }) => id), settled.id, verdict.fact.id])].sort(),
  }
}
