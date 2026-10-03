import { claudeDrivers, claudeScenarios } from './claude/index.js'
import { codexDrivers, codexScenarios } from './codex/index.js'
import type { Scenario, SurfaceDriver } from './scenario.js'

export const drivers: readonly SurfaceDriver[] = [...claudeDrivers, ...codexDrivers]

export const scenarios: readonly Scenario[] = [...claudeScenarios, ...codexScenarios]

export const driverOf = (scenario: Scenario): SurfaceDriver => {
  const driver = drivers.find(({ surface }) => surface === scenario.surface)
  if (driver === undefined) throw new Error(`No driver for ${scenario.surface}`)
  return driver
}
