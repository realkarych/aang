import type { Action, EpochNs, Evidence, Fact, FactOf, JsonValue } from '@aang/contract'
import type { Contract } from './catalog.js'

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

const fieldOf = (input: JsonValue, name: string): JsonValue | undefined =>
  input !== null && typeof input === 'object' && !Array.isArray(input) ? input[name] : undefined

const isText = (value: JsonValue): value is string => typeof value === 'string'

const shellFlag = /^-[a-z]*c$/

const powerShells: ReadonlySet<string> = new Set(['pwsh', 'powershell'])

const powerShellFlag = /^-(c|command)$/i

const cmdFlag = /^\/c$/i

const programName = (path: string): string =>
  (path.split(/[\\/]/).at(-1) ?? '').toLowerCase().replace(/\.exe$/, '')

const scriptAfter = (args: readonly string[], flag: RegExp): string[] => {
  const index = args.findIndex((arg) => flag.test(arg))
  const script = args.slice(index + 1).join(' ')
  return index < 0 || script === '' ? [] : [script]
}

const shellScript = (argv: readonly string[]): string[] => {
  const [program = '', ...args] = argv
  const name = programName(program)
  if (powerShells.has(name)) {
    return scriptAfter(args, powerShellFlag)
  }
  if (name === 'cmd') {
    return scriptAfter(args, cmdFlag)
  }
  const flag = argv.at(-2)
  const script = argv.at(-1)
  return argv.length >= 3 && flag !== undefined && shellFlag.test(flag) && script !== undefined ? [script] : []
}

const commandLines = (input: JsonValue): string[] => {
  const command = fieldOf(input, 'command') ?? fieldOf(input, 'cmd')
  if (command === undefined) {
    return []
  }
  if (isText(command)) {
    return [command]
  }
  return Array.isArray(command) && command.length > 0 && command.every(isText)
    ? [command.join(' '), ...shellScript(command)]
    : []
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

export const checkResult = ({ action, facts }: ActionFacts, contract: Contract): CheckResult | null => {
  const starts = facts.filter(
    (fact): fact is Start => fact.kind === 'action_start' && fact.payload.action_kind === 'command',
  )
  const matched = starts.filter(({ payload }) =>
    commandLines(payload.input).some((line) => contract.command.test(line)),
  )
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
