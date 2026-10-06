import {
  type CheckResult,
  type ObserverIsolationResult,
  type OperatingSystem,
  type Surface,
  type SupportKey,
  type SupportMatrix,
  supportMatrixFormat,
  type SupportRow,
  type SupportScenarios,
  supportKeyText,
} from '@aang/contract'
import { driverOf, type RecordingManifest, scenarios as catalog, supportsOs } from '@aang/record'

export interface RecordingOutcome {
  readonly manifest: RecordingManifest
  readonly passed: boolean
}

export interface MatrixOptions {
  readonly outcomes: readonly RecordingOutcome[]
  readonly previous: SupportMatrix | null
  readonly contractScenarios: (manifest: Pick<RecordingManifest, 'runtime' | 'scenario'>) => boolean
}

type ContractField = Exclude<keyof SupportScenarios, 'during_work' | 'after_iteration'>

const contractFields: Readonly<Record<ContractField, readonly string[]>> = {
  resume: ['resume', 'resume-compaction'],
  compaction: ['compaction', 'resume-compaction'],
  child_sessions: ['subagents', 'fork'],
  reconnect: ['reconnect'],
}

const desktopSurfaces: readonly Surface[] = ['claude_desktop', 'codex_desktop']

export const supportGaps = {
  desktopOnWindows: 'Desktop on Windows is not verified in the MVP (ADR-0013, decision 3)',
  placement: 'the placement is not verified until the surface matrix check (Q.1)',
  noRecordings: 'no reference recordings on this OS',
  failed: (names: readonly string[]) => `the contract run fails on: ${names.join(', ')}`,
  missing: (names: readonly string[]) => `no reference recordings of: ${names.join(', ')}`,
  userScenarios: 'user scenarios are not verified (E2E 1 and 4)',
  userScenariosFail: (names: readonly string[]) => `user scenarios fail: ${names.join(', ')}`,
} as const

const userScenarios: readonly (readonly [Exclude<keyof SupportScenarios, ContractField>, string])[] = [
  ['during_work', 'E2E 1'],
  ['after_iteration', 'E2E 4'],
]

const notRun: SupportScenarios = {
  during_work: 'not_run',
  after_iteration: 'not_run',
  resume: 'not_run',
  compaction: 'not_run',
  child_sessions: 'not_run',
  reconnect: 'not_run',
}

const notVerifiedObserver: SupportRow['observer'] = {
  admission: 'not_run',
  cross_session_inbound: 'not_run',
  builtins: { mcp_servers: [], plugins: [], skills: [] },
}

const keyOf = (manifest: RecordingManifest): SupportKey => ({
  runtime: manifest.runtime,
  surface: manifest.surface,
  os: manifest.os,
  placement: 'local',
  engine_version: manifest.engine_version,
})

const byKeyText = (left: SupportKey, right: SupportKey): number => {
  const [a, b] = [supportKeyText(left), supportKeyText(right)]
  return a < b ? -1 : a > b ? 1 : 0
}

const sameEngine = (manifest: RecordingManifest, key: SupportKey): boolean =>
  manifest.runtime === key.runtime &&
  manifest.surface === key.surface &&
  manifest.os === key.os &&
  manifest.engine_version === key.engine_version

const requiredScenarios = (surface: Surface, os: OperatingSystem, inRun: MatrixOptions['contractScenarios']): string[] =>
  catalog
    .filter((scenario) => scenario.surface === surface && supportsOs(scenario, driverOf(scenario), os))
    .filter((scenario) => inRun({ runtime: driverOf(scenario).runtime, scenario: scenario.name }))
    .map(({ name }) => name)

const fieldResult = (outcomes: readonly RecordingOutcome[], names: readonly string[]): CheckResult => {
  const relevant = outcomes.filter(({ manifest }) => names.includes(manifest.scenario))
  return relevant.length === 0 ? 'not_run' : relevant.every(({ passed }) => passed) ? 'passed' : 'failed'
}

const latestAppVersion = (outcomes: readonly RecordingOutcome[]): string | null =>
  outcomes
    .map(({ manifest }) => manifest)
    .filter((manifest) => manifest.app_version !== null)
    .toSorted((left, right) => Date.parse(right.recorded_at) - Date.parse(left.recorded_at))[0]?.app_version ?? null

const rowFor = (key: SupportKey, previous: SupportRow | null, options: MatrixOptions): SupportRow => {
  const own = options.outcomes.filter(({ manifest }) => sameEngine(manifest, key))
  const scenarios: SupportScenarios = {
    during_work: previous?.scenarios.during_work ?? notRun.during_work,
    after_iteration: previous?.scenarios.after_iteration ?? notRun.after_iteration,
    resume: fieldResult(own, contractFields.resume),
    compaction: fieldResult(own, contractFields.compaction),
    child_sessions: fieldResult(own, contractFields.child_sessions),
    reconnect: fieldResult(own, contractFields.reconnect),
  }
  const failedUser = userScenarios.filter(([field]) => scenarios[field] === 'failed').map(([, name]) => name)
  const recorded = new Set(own.map(({ manifest }) => manifest.scenario))
  const failed = [...new Set(own.filter(({ passed }) => !passed).map(({ manifest }) => manifest.scenario))].sort()
  const missing = requiredScenarios(key.surface, key.os, options.contractScenarios).filter((name) => !recorded.has(name)).sort()
  const reasons = [
    ...(desktopSurfaces.includes(key.surface) && key.os === 'windows' ? [supportGaps.desktopOnWindows] : []),
    ...(key.placement === 'local' ? [] : [supportGaps.placement]),
    ...(own.length === 0 ? [supportGaps.noRecordings] : []),
    ...(failed.length === 0 ? [] : [supportGaps.failed(failed)]),
    ...(own.length === 0 || missing.length === 0 ? [] : [supportGaps.missing(missing)]),
    ...(failedUser.length === 0 ? [] : [supportGaps.userScenariosFail(failedUser)]),
    ...(userScenarios.some(([field]) => scenarios[field] === 'not_run') ? [supportGaps.userScenarios] : []),
  ]
  const claimed = previous !== null && previous.status !== 'unverified' && reasons.length === 0 ? previous : null
  return {
    ...key,
    app_version: latestAppVersion(own) ?? previous?.app_version ?? null,
    status: claimed?.status ?? 'unverified',
    gaps: claimed?.gaps ?? reasons,
    scenarios,
    observer: previous?.observer ?? notVerifiedObserver,
    verified_on: previous?.verified_on ?? null,
  }
}

export const generateMatrix = (options: MatrixOptions): SupportMatrix => {
  const keys = new Map<string, SupportKey>()
  const add = (key: SupportKey): void => {
    keys.set(supportKeyText(key), key)
  }
  for (const { manifest } of options.outcomes) {
    const key = keyOf(manifest)
    add(key)
    if (desktopSurfaces.includes(key.surface)) {
      add({ ...key, os: 'windows' })
    }
  }
  const previous = new Map((options.previous?.rows ?? []).map((row) => [supportKeyText(row), row]))
  for (const { runtime, surface, os, placement, engine_version } of previous.values()) {
    add({ runtime, surface, os, placement, engine_version })
  }
  return {
    format: supportMatrixFormat,
    rows: [...keys.values()].sort(byKeyText).map((key) => rowFor(key, previous.get(supportKeyText(key)) ?? null, options)),
  }
}

const keyOfRow = ({ runtime, surface, os, placement, engine_version }: SupportKey): SupportKey => ({
  runtime,
  surface,
  os,
  placement,
  engine_version,
})

export const withObserver = (matrix: SupportMatrix | null, key: SupportKey, observer: ObserverIsolationResult): SupportMatrix => {
  const text = supportKeyText(key)
  const rows = matrix?.rows ?? []
  const row =
    rows.find((candidate) => supportKeyText(candidate) === text) ??
    rowFor(keyOfRow(key), null, { outcomes: [], previous: null, contractScenarios: () => false })
  return {
    format: supportMatrixFormat,
    rows: [...rows.filter((candidate) => supportKeyText(candidate) !== text), { ...row, observer }].sort(byKeyText),
  }
}

export const importObservers = (matrix: SupportMatrix | null, sources: readonly SupportMatrix[]): SupportMatrix =>
  sources
    .flatMap(({ rows }) => rows)
    .filter(({ observer }) => observer.admission !== 'not_run' || observer.cross_session_inbound !== 'not_run')
    .reduce<SupportMatrix>((merged, row) => withObserver(merged, row, row.observer), matrix ?? { format: supportMatrixFormat, rows: [] })

export const serializeMatrix = (matrix: SupportMatrix): string => `${JSON.stringify(matrix, null, 2)}\n`
