import { fileURLToPath } from 'node:url'

export const sampleScenarios = [
  'claude-subagent',
  'claude-fork',
  'claude-compaction',
  'codex-resume-compaction',
  'codex-otel',
] as const

export type SampleScenario = (typeof sampleScenarios)[number]

const directory = new URL('../../sample-scenarios/', import.meta.url)

export const sampleScenarioManifest = (scenario: SampleScenario): string =>
  fileURLToPath(new URL(`${scenario}/manifest.json`, directory))
