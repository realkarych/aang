import type { OperatingSystem, Runtime, Surface } from '@aang/contract'
import type { CreatedEntries } from './capture.js'
import { recordSession, type RecordContext } from './record.js'
import { type ModelMode, type ProfileHome, recordingOs } from './schema.js'

export interface EngineSelection {
  readonly claude?: string | undefined
  readonly codex?: string | undefined
  readonly claudeSdk?: string | undefined
  readonly codexSdk?: string | undefined
  readonly claudeDesktop?: string | undefined
  readonly codexDesktop?: string | undefined
}

export interface Engine {
  readonly executable: string
  readonly version: string
  readonly appVersion?: string | undefined
  readonly module?: string | undefined
}

export class EngineUnavailableError extends Error {
  override readonly name = 'EngineUnavailableError'
}

export interface ScenarioSession extends RecordContext {
  readonly model: ModelMode
  readonly engine: Engine
}

export interface Scenario {
  readonly name: string
  readonly surface: Surface
  readonly models: readonly ModelMode[]
  readonly os?: readonly OperatingSystem[] | undefined
  readonly codexHome?: ProfileHome | undefined
  readonly expectedFacts: readonly string[]
  readonly run: (session: ScenarioSession) => Promise<void>
  readonly checkRecording?: ((recording: string) => Promise<void>) | undefined
}

export interface SurfaceDriver {
  readonly surface: Surface
  readonly runtime: Runtime
  readonly os?: readonly OperatingSystem[] | undefined
  readonly resolve: (selection: EngineSelection) => Promise<Engine>
}

export interface ScenarioOptions {
  readonly fixturesRoot: string
  readonly hookBinary: string
  readonly model?: ModelMode | undefined
  readonly claudeHome?: ProfileHome | undefined
  readonly created?: ((entries: CreatedEntries) => void) | undefined
  readonly selection: EngineSelection
}

export const scenarioModel = (scenario: Scenario, requested: ModelMode | undefined): ModelMode | undefined =>
  requested === undefined ? scenario.models[0] : scenario.models.includes(requested) ? requested : undefined

const recordedName = (scenario: Scenario, model: ModelMode): string =>
  model === scenario.models[0] ? scenario.name : `${scenario.name}-${model}`

export const supportsOs = (scenario: Scenario, driver: SurfaceDriver, os: OperatingSystem): boolean =>
  (scenario.os ?? driver.os ?? [os]).includes(os) && (driver.os ?? [os]).includes(os)

export const recordScenario = async (scenario: Scenario, driver: SurfaceDriver, options: ScenarioOptions): Promise<string> => {
  if (driver.surface !== scenario.surface) throw new Error(`Scenario ${scenario.name} does not belong to ${driver.surface}`)
  const model = scenarioModel(scenario, options.model)
  if (model === undefined) throw new Error(`Scenario ${scenario.surface}/${scenario.name} supports only ${scenario.models.join(', ')} models`)
  const os = recordingOs()
  if (!supportsOs(scenario, driver, os)) throw new Error(`Scenario ${scenario.surface}/${scenario.name} is not recorded on ${os}`)
  const engine = await driver.resolve(options.selection)
  return recordSession({
    runtime: driver.runtime,
    engineVersion: engine.version,
    appVersion: engine.appVersion,
    surface: scenario.surface,
    scenario: recordedName(scenario, model),
    model,
    expectedFacts: scenario.expectedFacts,
    fixturesRoot: options.fixturesRoot,
    hookBinary: options.hookBinary,
    codexHome: scenario.codexHome,
    claudeHome: options.claudeHome,
    created: options.created,
    check: scenario.checkRecording,
  }, (context) => scenario.run({ ...context, model, engine }))
}
