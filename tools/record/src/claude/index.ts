import type { Scenario, SurfaceDriver } from '../scenario.js'
import { claudeSurfaceDrivers } from './drivers.js'
import { scenariosFor } from './scenarios.js'
import { claudeSurfaces } from './surfaces.js'

export const claudeDrivers: readonly SurfaceDriver[] = claudeSurfaceDrivers

export const claudeScenarios: readonly Scenario[] = claudeSurfaces.flatMap(scenariosFor)
