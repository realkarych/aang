import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { OperatingSystem, Runtime, Surface, SupportKey } from '@aang/contract'
import { type ControlTarget, RecordingManifest, recordSession } from '@aang/record'
import type { SampleScenario } from '@aang/testkit'
import {
  type OwnerChecklist,
  type OwnerChecklistName,
  type PlacementCheck,
  serializeVerification,
  verificationFormat,
  verificationPath,
} from '../dist/index.js'

export const hookBinary = resolve('packages/hook/bin', process.platform === 'win32' ? 'aang-hook.exe' : 'aang-hook')

const main = fileURLToPath(new URL('../dist/main.js', import.meta.url))
const spikeRuntime = fileURLToPath(new URL('./spike-runtime.ts', import.meta.url))

export const hostOs: OperatingSystem = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux'

export const otherOs: OperatingSystem = hostOs === 'linux' ? 'windows' : 'linux'

export const thirdOs: OperatingSystem = (['macos', 'linux', 'windows'] as const).find((os) => os !== hostOs && os !== otherOs) ?? 'macos'

export interface Checkpoint {
  readonly label: string
  readonly target: ControlTarget
  readonly expectedMapChange: string
}

export interface SpikeRecording {
  readonly runtime: Runtime
  readonly engineVersion: string
  readonly surface: Surface
  readonly scenario: string
  readonly sample: SampleScenario
  readonly commands: readonly (readonly string[])[]
  readonly checkpoints?: readonly Checkpoint[]
  readonly otlp?: boolean
  readonly expectedFacts: readonly [string, ...string[]]
}

export const claudeSubagents: SpikeRecording = {
  runtime: 'claude',
  engineVersion: '2.1.286',
  surface: 'claude_cli',
  scenario: 'subagents',
  sample: 'claude-subagent',
  commands: [['SessionStart', 'PermissionRequest', 'PreToolUse', 'until:subagent', 'PostToolUse', 'tool-result', 'play', 'Stop']],
  expectedFacts: ['The root session runs Bash, then the pinger subagent through the Agent tool'],
}

export const claudeReconnect: SpikeRecording = {
  runtime: 'claude',
  engineVersion: '2.1.286',
  surface: 'claude_cli',
  scenario: 'reconnect',
  sample: 'claude-subagent',
  commands: [['SessionStart', 'PermissionRequest', 'PreToolUse', 'until:subagent', 'PostToolUse', 'Stop', 'pause', 'play', 'Stop']],
  checkpoints: [
    {
      label: 'daemon-restart',
      target: { root: 'claude', path: 'projects/-tmp-aang-spike-cc-transcripts-run/86f93ed5-1acd-4c6e-8c60-f1c98335c2ef.jsonl', occurrence: 'first' },
      expectedMapChange: 'The transcript holds the Bash turn; the daemon restarts here and continues the transcript from its saved cursor',
    },
  ],
  expectedFacts: ['The root session runs Bash, the daemon restarts, then the same transcript goes on with the pinger subagent'],
}

export const claudeSourceLoss: SpikeRecording = {
  runtime: 'claude',
  engineVersion: '2.1.286',
  surface: 'claude_cli',
  scenario: 'source-loss',
  sample: 'claude-subagent',
  commands: [['registry:null'], ['SessionStart', 'registry:busy', 'play'], ['registry:idle', 'Stop'], ['relocate'], ['delete', 'unregister']],
  expectedFacts: ['The session registry entry goes busy, idle and away; the transcript moves, then disappears'],
}

export const codexResumeCompaction: SpikeRecording = {
  runtime: 'codex',
  engineVersion: '0.159.2',
  surface: 'codex_exec',
  scenario: 'resume-compaction',
  sample: 'codex-resume-compaction',
  commands: [['play']],
  expectedFacts: ['The resumed exec turn carries an automatic compaction'],
}

export const codexToolDecisions: SpikeRecording = {
  runtime: 'codex',
  engineVersion: '0.159.2',
  surface: 'codex_exec',
  scenario: 'tools',
  sample: 'codex-otel',
  commands: [['play']],
  otlp: true,
  expectedFacts: ['Every codex.tool_decision log record reaches the OTLP receiver'],
}

export const spikeRecordings: readonly SpikeRecording[] = [claudeSubagents, claudeReconnect, claudeSourceLoss, codexResumeCompaction, codexToolDecisions]

export type Register = (cleanup: () => Promise<void>) => void

export const temporaryDirectory = async (register: Register, prefix: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  register(() => rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))
  return directory
}

export const recordSpike = async (fixturesRoot: string, recording: SpikeRecording): Promise<string> =>
  recordSession(
    {
      runtime: recording.runtime,
      engineVersion: recording.engineVersion,
      surface: recording.surface,
      scenario: recording.scenario,
      expectedFacts: [...recording.expectedFacts],
      fixturesRoot,
      hookBinary,
    },
    async (session) => {
      for (const command of recording.commands) {
        await session.run(process.execPath, [spikeRuntime, recording.sample, ...command, ...(recording.otlp === true ? ['--otlp', session.otlp] : [])])
      }
      for (const { label, target, expectedMapChange } of recording.checkpoints ?? []) {
        await session.checkpoint(label, target, expectedMapChange)
      }
    },
  )

export interface Placement {
  readonly os?: OperatingSystem
  readonly scenario?: string
  readonly surface?: Surface
  readonly engineVersion?: string
  readonly appVersion?: string
}

export const placeRecording = async (source: string, sessions: string, placement: Placement = {}): Promise<string> => {
  const manifest = RecordingManifest.parse(JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8')))
  const placed: RecordingManifest = {
    ...manifest,
    os: placement.os ?? manifest.os,
    scenario: placement.scenario ?? manifest.scenario,
    surface: placement.surface ?? manifest.surface,
    engine_version: placement.engineVersion ?? manifest.engine_version,
    app_version: placement.appVersion ?? manifest.app_version,
  }
  const target = join(sessions, placed.runtime, placed.engine_version, placed.surface, placed.os, placed.scenario)
  await cp(source, target, { recursive: true })
  await writeFile(join(target, 'manifest.json'), `${JSON.stringify(placed, null, 2)}\n`)
  return target
}

export const withoutCheckpoints = async (directory: string): Promise<void> => {
  const manifestPath = join(directory, 'manifest.json')
  const manifest = RecordingManifest.parse(JSON.parse(await readFile(manifestPath, 'utf8')))
  await writeFile(manifestPath, `${JSON.stringify({ ...manifest, control_events: [] }, null, 2)}\n`)
  const playbackPath = join(directory, 'playback.json')
  const playback = JSON.parse(await readFile(playbackPath, 'utf8')) as { readonly steps: readonly Readonly<Record<string, unknown>>[] }
  const steps = playback.steps.map((step) => Object.fromEntries(Object.entries(step).filter(([key]) => key !== 'label')))
  await writeFile(playbackPath, JSON.stringify({ ...playback, steps }))
}

export interface CliResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

export const supportCli = (args: readonly string[]): Promise<CliResult> =>
  new Promise((resolveResult) => {
    execFile(process.execPath, [main, ...args], { maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolveResult({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : 1, stdout, stderr })
    })
  })

export const cliOptions = (sessions: string, support: string): string[] => [
  '--fixtures',
  sessions,
  '--support',
  support,
  '--hook',
  hookBinary,
]

export const placementCheck = (key: SupportKey, result: PlacementCheck['result'], checkedOn = '2026-10-07'): PlacementCheck => ({
  ...key,
  result,
  checked_on: checkedOn,
})

export const ownerChecklist = (key: SupportKey, checklist: OwnerChecklistName, result: OwnerChecklist['result']): OwnerChecklist => ({
  ...key,
  checklist,
  result,
  checked_on: '2026-10-08',
  report: 'docs/research/q1-owner-checklist-results.md',
})

export interface VerificationEntries {
  readonly placements?: readonly PlacementCheck[]
  readonly ownerChecklists?: readonly OwnerChecklist[]
}

export const writeVerification = async (support: string, { placements = [], ownerChecklists = [] }: VerificationEntries): Promise<void> => {
  await mkdir(support, { recursive: true })
  await writeFile(
    verificationPath(support),
    serializeVerification({ format: verificationFormat, placements: [...placements], owner_checklists: [...ownerChecklists] }),
  )
}
