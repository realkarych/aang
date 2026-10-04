import { execFile } from 'node:child_process'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { OperatingSystem, Runtime, Surface } from '@aang/contract'
import { RecordingManifest, recordSession } from '@aang/record'
import type { SampleScenario } from '@aang/testkit'

export const hookBinary = resolve('packages/hook/bin', process.platform === 'win32' ? 'aang-hook.exe' : 'aang-hook')

const main = fileURLToPath(new URL('../dist/main.js', import.meta.url))
const spikeRuntime = fileURLToPath(new URL('./spike-runtime.ts', import.meta.url))

export const hostOs: OperatingSystem = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux'

export const otherOs: OperatingSystem = hostOs === 'linux' ? 'windows' : 'linux'

export const thirdOs: OperatingSystem = (['macos', 'linux', 'windows'] as const).find((os) => os !== hostOs && os !== otherOs) ?? 'macos'

export interface SpikeRecording {
  readonly runtime: Runtime
  readonly engineVersion: string
  readonly surface: Surface
  readonly scenario: string
  readonly sample: SampleScenario
  readonly actions: readonly string[]
  readonly expectedFacts: readonly [string, ...string[]]
}

export const claudeSubagents: SpikeRecording = {
  runtime: 'claude',
  engineVersion: '2.1.286',
  surface: 'claude_cli',
  scenario: 'subagents',
  sample: 'claude-subagent',
  actions: ['SessionStart', 'PermissionRequest', 'PreToolUse', 'until:subagent', 'PostToolUse', 'play', 'Stop'],
  expectedFacts: ['The root session runs Bash, then the pinger subagent through the Agent tool'],
}

export const codexResumeCompaction: SpikeRecording = {
  runtime: 'codex',
  engineVersion: '0.159.2',
  surface: 'codex_exec',
  scenario: 'resume-compaction',
  sample: 'codex-resume-compaction',
  actions: ['play'],
  expectedFacts: ['The resumed exec turn carries an automatic compaction'],
}

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
      await session.run(process.execPath, [spikeRuntime, recording.sample, ...recording.actions])
    },
  )

export interface Placement {
  readonly os?: OperatingSystem
  readonly scenario?: string
  readonly surface?: Surface
  readonly appVersion?: string
}

export const placeRecording = async (source: string, sessions: string, placement: Placement = {}): Promise<string> => {
  const manifest = RecordingManifest.parse(JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8')))
  const placed: RecordingManifest = {
    ...manifest,
    os: placement.os ?? manifest.os,
    scenario: placement.scenario ?? manifest.scenario,
    surface: placement.surface ?? manifest.surface,
    app_version: placement.appVersion ?? manifest.app_version,
  }
  const target = join(sessions, placed.runtime, placed.engine_version, placed.surface, placed.os, placed.scenario)
  await cp(source, target, { recursive: true })
  await writeFile(join(target, 'manifest.json'), `${JSON.stringify(placed, null, 2)}\n`)
  return target
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
