export { installFakeClaude, installFakeCodex, type FakeCli, type FakeCliHold } from './fake-cli/install.js'
export {
  fakeCliExitCodes,
  type ClaudeReply,
  type ClaudeScenario,
  type ClaudeUsage,
  type CodexReply,
  type CodexScenario,
  type CodexUsage,
  type FakeCall,
  type FakeCommand,
  type FakePurpose,
} from './fake-cli/scenario.js'
export {
  checksBlockerText,
  checksStageTitle,
  releaseStageTitle,
  reviewRequestText,
} from './observer-scenarios/attention.js'
export {
  agentStageTitle,
  branchStageTitles,
  checkedCriterionText,
  continuationQuestionText,
  continuedStageTitle,
  goalCriterionText,
  mainStageTitle,
  mergedStageTitle,
  nestedStageTitles,
  outlineStageTitles,
  preparationStageTitle,
  renamedStageTitle,
  reportQuestionText,
  reportStageTitle,
  reshapedStageTitles,
  splitStageTitles,
} from './observer-scenarios/observer.js'
export {
  type ObserverScenarioName,
  type ObserverScenarioPhase,
  type ObserverScenarioReply,
  observerScenarios,
} from './observer-scenarios/presets.js'
export { chatAnswerReport } from './observer-scenarios/chat.js'
export { runScenarioScript, ScenarioScript } from './observer-scenarios/scripts.js'
export {
  DaemonLaunchError,
  launchDaemon,
  type DaemonExit,
  type DaemonLaunch,
  type RunningDaemon,
} from './profile/daemon.js'
export { profileEnvironment, type Environment, type InheritedEnvironment } from './profile/environment.js'
export {
  createProfile,
  type ConfigInput,
  type Profile,
  type ProfileOptions,
  type ProfileRoot,
} from './profile/profile.js'
export type { PlayerRoots } from './player/files.js'
export {
  HookContractError,
  invokeHook,
  leaseSpool,
  readSpool,
  type HookEvent,
  type HookTarget,
  type SpoolEvent,
} from './player/hook.js'
export {
  loadManifest,
  ManifestError,
  PlayerManifest,
  PlayerRoot,
  PlayerStep,
  type LoadedManifest,
  type Target,
} from './player/manifest.js'
export { OtlpDeliveryError } from './player/otlp.js'
export { playbackShift, shifted, unshifted, type RecordShift, type RecordTime } from './player/record-time.js'
export { type SampleScenario, sampleScenarioManifest, sampleScenarios } from './player/sample-scenarios.js'
export {
  createPlayer,
  PlaybackError,
  type PlayedStep,
  type Player,
  type PlayerOptions,
  type PlayOptions,
} from './player/player.js'
export { applyFeed, type FeedEvent, type FeedSegment } from './stream/run-view.js'
