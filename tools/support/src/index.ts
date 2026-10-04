export { invariantViolations } from './invariants.js'
export { generateMatrix, type MatrixOptions, type RecordingOutcome, serializeMatrix, supportGaps } from './matrix.js'
export { playRecording, type Played, type PlaybackRoots, type PlayOptions, removeRoots, restartLabel } from './play.js'
export { findRecordings, type Recording, recordingName } from './recordings.js'
export {
  checkRecording,
  contractRun,
  type ContractRun,
  type ContractRunOptions,
  inContractRun,
  matrixOf,
  matrixPath,
  notRestarted,
  passed,
  pendingScenarios,
  readMatrix,
  type RecordingCheck,
  runProblems,
  runRecordings,
  snapshotFile,
  staleSnapshots,
  updateSupport,
} from './run.js'
export { type ContractSnapshot, takeSnapshot } from './snapshot.js'
