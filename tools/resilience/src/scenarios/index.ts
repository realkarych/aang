import type { Scenario } from '../scenario.js'
import { divergenceScenarios } from './divergence.js'
import { hookScenarios } from './hooks.js'
import { lineageScenarios } from './lineage.js'
import { restartScenarios } from './restart.js'
import { sourceScenarios } from './source-loss.js'

export const scenarios: readonly Scenario[] = [
  ...restartScenarios,
  ...sourceScenarios,
  ...hookScenarios,
  ...divergenceScenarios,
  ...lineageScenarios,
]
