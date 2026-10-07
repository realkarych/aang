import { existsSync } from 'node:fs'
import type { OperatingSystem, Placement, Runtime, Surface } from '@aang/contract'
import {
  drivers,
  type Engine,
  type EngineSelection,
  EngineUnavailableError,
  type Scenario,
  scenarioModel,
  scenarios,
  type SurfaceDriver,
  supportsOs,
} from '@aang/record'
import { type AccessReport, accessNotRun, checkAccess } from './access.js'
import { type AangCommand, settled, signInLink } from './aang.js'
import { type LiveRun, startLive } from './live.js'
import { compare, compareRecords, type DaemonView, type Observation, observeDaemon, readReference, type Reference, referencePath, versionKeyText } from './observe.js'
import { daemonRecords } from './records.js'

export const surfaceCheckFormat = 'aang-surface-check/1'

export type Outcome = 'passed' | 'failed'

export interface ScenarioReport {
  readonly name: string
  readonly result: Outcome
  readonly error: string | null
  readonly failures: readonly string[]
  readonly notes: readonly string[]
  readonly installed: readonly string[]
  readonly restarts: number
  readonly daemon: DaemonView | null
  readonly reference: Observation | null
}

export interface SurfaceKey {
  readonly runtime: Runtime
  readonly surface: Surface
  readonly os: OperatingSystem
  readonly placement: Placement
  readonly engine_version: string
}

export interface SurfaceReport {
  readonly key: SurfaceKey | null
  readonly surface: Surface
  readonly app_version: string | null
  readonly emulated: boolean
  readonly result: Outcome
  readonly error: string | null
  readonly scenarios: readonly ScenarioReport[]
}

export interface KeptDaemon {
  readonly aang_home: string
  readonly home: string
}

export interface CheckReport {
  readonly format: typeof surfaceCheckFormat
  readonly started_at: string
  readonly finished_at: string
  readonly os: OperatingSystem
  readonly placement: Placement
  readonly access: AccessReport
  readonly kept: KeptDaemon | null
  readonly results: readonly SurfaceReport[]
}

export interface CheckOptions {
  readonly os: OperatingSystem
  readonly placement: Placement
  readonly surfaces: readonly Surface[]
  readonly required: ReadonlySet<Surface>
  readonly scenarioNames: readonly string[] | 'all'
  readonly emulateDesktop: boolean
  readonly selection: EngineSelection
  readonly aang: AangCommand
  readonly hookBinary: string
  readonly support: string
  readonly bind: string | null
  readonly port: number | null
  readonly keepDaemon: boolean
  readonly work: string
  readonly progress: (line: string) => void
}

export const coreScenarios: readonly string[] = ['tools', 'subagents', 'resume', 'compaction', 'reconnect', 'approval', 'question']

const desktopSurfaces: ReadonlySet<Surface> = new Set(['claude_desktop', 'codex_desktop'])

const settleTimeoutMs = 90_000

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const driverFor = (surface: Surface): SurfaceDriver => {
  const driver = drivers.find((candidate) => candidate.surface === surface)
  if (driver === undefined) {
    throw new Error(`no driver for ${surface}`)
  }
  return driver
}

const emulated = (options: CheckOptions, surface: Surface): boolean => options.emulateDesktop && desktopSurfaces.has(surface)

const scenariosOf = (options: CheckOptions, surface: Surface): Scenario[] =>
  scenarios
    .filter((scenario) => scenario.surface === surface && scenarioModel(scenario, 'stub') === 'stub')
    .filter((scenario) => emulated(options, surface) || supportsOs(scenario, driverFor(surface), options.os))
    .filter((scenario) => (options.scenarioNames === 'all' ? true : options.scenarioNames.includes(scenario.name)))

const cliOf = async (surface: Surface, selection: EngineSelection): Promise<string | null> =>
  driverFor(surface)
    .resolve(selection)
    .then(({ executable }) => executable)
    .catch(() => null)

const daemonFailures = (options: CheckOptions, scenario: Scenario, engine: Engine, live: LiveRun, view: DaemonView): string[] => {
  const runtime = driverFor(scenario.surface).runtime
  const key = versionKeyText({ runtime, surface: scenario.surface, os: options.os, placement: options.placement, engine_version: engine.version })
  return [
    ...(view.runs === 0 ? ['the daemon shows no run of the scenario'] : []),
    ...Object.keys(view.surfaces)
      .filter((surface) => surface !== scenario.surface)
      .map((surface) => `a session reads as ${surface}, expected ${scenario.surface}`),
    ...(view.versions.some((version) => version.key === key) ? [] : [`the daemon lists no version ${key}`]),
    ...(runtime === 'claude' && view.hooks.claude !== 'active' ? [`Claude hooks are ${String(view.hooks.claude)}, expected active`] : []),
    ...(scenario.name === 'reconnect' && live.restarts !== 1 ? [`the daemon restarted ${String(live.restarts)} times, expected once`] : []),
  ]
}

interface Observed {
  readonly failures: readonly string[]
  readonly notes: readonly string[]
  readonly daemon: DaemonView | null
  readonly reference: Reference | null
}

const prefixed = (lines: readonly string[]): string[] => lines.map((line) => `differs from the reference recording: ${line}`)

const observeScenario = async (options: CheckOptions, scenario: Scenario, engine: Engine, live: LiveRun): Promise<Observed> => {
  const runtime = driverFor(scenario.surface).runtime
  const failures: string[] = live.error === null ? [] : [`the scenario failed: ${live.error}`]
  const notes: string[] = []
  let daemon: DaemonView | null = null
  const reference = emulated(options, scenario.surface)
    ? null
    : await readReference(
        referencePath(options.support, {
          runtime,
          engineVersion: engine.version,
          surface: scenario.surface,
          os: options.os,
          scenario: scenario.name,
        }),
      )
  if (live.api === null) {
    failures.push('the daemon did not start')
  } else {
    try {
      daemon = await observeDaemon(live.api, await settled(live.api, settleTimeoutMs))
      failures.push(...daemonFailures(options, scenario, engine, live, daemon))
      if (reference !== null) {
        const comparison = compare(daemon, reference.observation)
        failures.push(...prefixed(comparison.failures))
        notes.push(...prefixed(comparison.notes))
      }
    } catch (error) {
      failures.push(`the daemon could not be read: ${describe(error)}`)
    }
  }
  return { failures, notes, daemon, reference }
}

const finishScenario = async (live: LiveRun, observed: Observed): Promise<Observed> => {
  await live.stop()
  if (observed.reference === null || live.api === null) {
    return observed
  }
  try {
    const comparison = compareRecords(daemonRecords(live.profile.aangHome, live.profile.root), observed.reference.records)
    return {
      ...observed,
      failures: [...observed.failures, ...prefixed(comparison.failures)],
      notes: [...observed.notes, ...prefixed(comparison.notes)],
    }
  } catch (error) {
    return { ...observed, failures: [...observed.failures, `the store of the daemon could not be read: ${describe(error)}`] }
  }
}

const scenarioReport = (name: string, live: LiveRun, { failures, notes, daemon, reference }: Observed): ScenarioReport => ({
  name,
  result: failures.length === 0 ? 'passed' : 'failed',
  error: live.error,
  failures,
  notes,
  installed: live.installed,
  restarts: live.restarts,
  daemon,
  reference: reference?.observation ?? null,
})

const freshAccess = async (live: LiveRun): Promise<AccessReport> => {
  const link = signInLink(await live.aang.ok(['open']))
  return checkAccess(link, link.origin)
}

const unavailable = (surface: Surface, emulatedEngine: boolean, error: string, required: boolean): SurfaceReport => ({
  key: null,
  surface,
  app_version: null,
  emulated: emulatedEngine,
  result: required ? 'failed' : 'passed',
  error,
  scenarios: [],
})

export const runCheck = async (options: CheckOptions): Promise<CheckReport> => {
  const started = new Date()
  const cli: Record<Runtime, string | null> = {
    claude: await cliOf('claude_cli', options.selection),
    codex: await cliOf('codex_exec', options.selection),
  }
  const selection: EngineSelection = options.emulateDesktop
    ? {
        ...options.selection,
        claudeDesktop: options.selection.claudeDesktop ?? cli.claude ?? undefined,
        codexDesktop: options.selection.codexDesktop ?? cli.codex ?? undefined,
      }
    : options.selection
  const results: SurfaceReport[] = []
  const plan = options.surfaces.map((surface) => ({ surface, scenarios: scenariosOf(options, surface) }))
  const lastSurface = plan.findLast(({ scenarios: listed }) => listed.length > 0)?.surface
  let kept: LiveRun | null = null
  let access: AccessReport = accessNotRun()
  for (const { surface, scenarios: listed } of plan) {
    const isEmulated = emulated(options, surface)
    const engine = await driverFor(surface)
      .resolve(selection)
      .catch((error: unknown) => {
        if (error instanceof EngineUnavailableError) {
          return describe(error)
        }
        throw error
      })
    if (typeof engine === 'string') {
      options.progress(`↷ ${surface}: ${engine}`)
      results.push(unavailable(surface, isEmulated, engine, options.required.has(surface)))
      continue
    }
    const key: SurfaceKey = {
      runtime: driverFor(surface).runtime,
      surface,
      os: options.os,
      placement: options.placement,
      engine_version: engine.version,
    }
    const reports: ScenarioReport[] = []
    for (const [index, scenario] of listed.entries()) {
      const last = surface === lastSurface && index === listed.length - 1
      options.progress(`▶ ${surface} ${scenario.name} (${engine.version})`)
      const live = await startLive({
        scenario,
        engine,
        runtime: key.runtime,
        os: options.os,
        placement: options.placement,
        aang: options.aang,
        hookBinary: options.hookBinary,
        cli,
        bind: options.bind,
        port: options.port,
        base: options.work,
      })
      let observed = await observeScenario(options, scenario, engine, live)
      if (last) {
        access = live.api === null ? accessNotRun() : await freshAccess(live)
        kept = live
      }
      if (!(last && options.keepDaemon)) {
        observed = await finishScenario(live, observed)
        await live.remove()
      }
      const report = scenarioReport(scenario.name, live, observed)
      reports.push(report)
      options.progress(`${report.result === 'passed' ? '✔' : '✘'} ${surface} ${scenario.name}${report.failures.length === 0 ? '' : `\n  ${report.failures.join('\n  ')}`}`)
    }
    results.push({
      key,
      surface,
      app_version: engine.appVersion ?? null,
      emulated: isEmulated,
      result: reports.length > 0 && reports.every(({ result }) => result === 'passed') ? 'passed' : 'failed',
      error: reports.length === 0 ? `no scenarios of ${surface} run on ${options.os}` : null,
      scenarios: reports,
    })
  }
  const keptRun: LiveRun | null = kept
  return {
    format: surfaceCheckFormat,
    started_at: started.toISOString(),
    finished_at: new Date().toISOString(),
    os: options.os,
    placement: options.placement,
    access,
    kept:
      options.keepDaemon && keptRun !== null ? { aang_home: keptRun.profile.aangHome, home: keptRun.profile.home } : null,
    results,
  }
}

export const dockerDetected = (): boolean => existsSync('/.dockerenv')
