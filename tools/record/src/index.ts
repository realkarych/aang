export { recordSession, type RecordContext, type RecordOptions } from './record.js'
export { RecordingManifest } from './schema.js'
export { verifyRecording } from './verify.js'
export type { ControlTarget, CreatedEntries } from './capture.js'
export { drivers, driverOf, scenarios } from './catalog.js'
export { EngineUnavailableError, recordScenario, scenarioModel, supportsOs, type Engine, type EngineSelection, type Scenario, type ScenarioOptions, type ScenarioSession, type SurfaceDriver } from './scenario.js'
export { ModelMode } from './schema.js'
export type { RunOptions, RunOutput } from './record.js'
export { startModelStub, type ModelStub, type StubBlock as ClaudeStubBlock, type StubScript as ClaudeStubScript } from './claude/stub.js'
export {
  startResponsesStub,
  type ResponsesStub,
  type StubCall as CodexStubCall,
  type StubScript as CodexStubScript,
} from './codex/stub.js'
