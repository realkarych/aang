export { recordSession, type RecordContext, type RecordOptions } from './record.js'
export {
  AttentionPredicate,
  CardPredicate,
  ControlEvent,
  CriterionPredicate,
  ExpectedMapChange,
  LinkPredicate,
  MapPredicate,
  RecordingManifest,
  StagePredicate,
} from './schema.js'
export { verifyRecording } from './verify.js'
export type { ControlTarget, CreatedEntries } from './capture.js'
export { drivers, driverOf, scenarios } from './catalog.js'
export { EngineUnavailableError, recordScenario, scenarioModel, supportsOs, type Engine, type EngineSelection, type Scenario, type ScenarioOptions, type ScenarioSession, type SurfaceDriver } from './scenario.js'
export { ModelMode } from './schema.js'
export type { RunOptions, RunOutput } from './record.js'
