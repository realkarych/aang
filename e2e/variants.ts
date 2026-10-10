import type { OperatingSystem, Runtime, Surface } from '@aang/contract'
import { runnerOs } from './recordings.js'

export interface SurfaceVariant {
  readonly runtime: Runtime
  readonly surface: Surface
  readonly version: string
  readonly recordedOn: readonly [OperatingSystem, ...OperatingSystem[]]
  readonly scenarios: readonly string[]
  readonly skippedOn: Readonly<Partial<Record<OperatingSystem, string>>>
}

type Engine = Omit<SurfaceVariant, 'scenarios'>

const everyOs = ['macos', 'linux', 'windows'] as const

const desktopOnWindows = 'Desktop on Windows is not checked in the MVP (ADR-0013, decision 3)'

const cliRecordingsReadAsSdk =
  'the R.4 claude_cli recordings of Linux and Windows carry CLAUDE_AGENT_SDK_VERSION from the Scenarios workflow and read as Agent SDK sessions; they need re-recording (R.4)'

const claudeCli: Engine = {
  runtime: 'claude',
  surface: 'claude_cli',
  version: '2.1.289',
  recordedOn: ['macos'],
  skippedOn: { linux: cliRecordingsReadAsSdk, windows: cliRecordingsReadAsSdk },
}

const claudeSdk: Engine = { runtime: 'claude', surface: 'claude_sdk', version: '2.1.289', recordedOn: everyOs, skippedOn: {} }

const claudeDesktop: Engine = { runtime: 'claude', surface: 'claude_desktop', version: '2.1.286', recordedOn: ['macos'], skippedOn: {} }

const codexExec: Engine = { runtime: 'codex', surface: 'codex_exec', version: '0.160.0', recordedOn: everyOs, skippedOn: {} }

const codexSdk: Engine = { runtime: 'codex', surface: 'codex_sdk', version: '0.160.0', recordedOn: everyOs, skippedOn: {} }

const codexDesktop: Engine = { runtime: 'codex', surface: 'codex_desktop', version: '0.159.2', recordedOn: ['macos'], skippedOn: {} }

const notOnWindows = (engine: Engine): Engine => ({ ...engine, skippedOn: { ...engine.skippedOn, windows: desktopOnWindows } })

export const duringWorkScenario = 'subagents'

export const duringWorkVariants: readonly SurfaceVariant[] = [claudeCli, claudeSdk, claudeDesktop, codexExec, codexSdk, codexDesktop].map(
  (engine) => ({ ...engine, scenarios: [duringWorkScenario] }),
)

export const afterIterationVariants: readonly SurfaceVariant[] = [
  { ...claudeCli, scenarios: ['tools'] },
  { ...claudeSdk, scenarios: ['tools'] },
  { ...notOnWindows(claudeDesktop), scenarios: ['tools'] },
  { ...codexExec, scenarios: ['tools', 'question'] },
  { ...codexSdk, scenarios: ['tools', 'question'] },
  { ...notOnWindows(codexDesktop), scenarios: ['tools', 'question'] },
]

export const checkedOn = ({ skippedOn }: SurfaceVariant, os: OperatingSystem): boolean => skippedOn[os] === undefined

export const skippedHere = ({ skippedOn }: SurfaceVariant): string | undefined => (runnerOs === null ? undefined : skippedOn[runnerOs])
