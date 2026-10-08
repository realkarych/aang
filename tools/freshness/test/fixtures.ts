import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type ClaudeScenario, type CodexScenario, type FakeCli, installFakeClaude, installFakeCodex } from '@aang/testkit'

export interface Outcome {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}

export type Markup = Readonly<Record<string, unknown>>

export interface RecordedStep {
  readonly at: number
  readonly kind: string
  readonly label?: string | undefined
  readonly [field: string]: unknown
}

export interface RecordedEvent {
  readonly label: string
  readonly step: number
  readonly observed_at: string
  readonly expected_map_change: Record<string, unknown>
}

export interface Recorded {
  readonly manifest: { readonly recorded_at: string; readonly control_events: readonly RecordedEvent[] }
  readonly steps: readonly RecordedStep[]
}

const repository = (relative: string): string => fileURLToPath(new URL(`../../../${relative}`, import.meta.url))

const main = fileURLToPath(new URL('../dist/main.js', import.meta.url))

const hostOs = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux'

export const repositoryFixtures = repository('fixtures/sessions')

export const claudeRecording = (scenario: string): string => `claude/2.1.289/claude_cli/${hostOs}/${scenario}`

export const codexRecording = (scenario: string): string => `codex/0.160.0/codex_exec/${hostOs}/${scenario}`

export const readRecorded = async (fixtures: string, recording: string): Promise<Recorded> => {
  const directory = join(fixtures, ...recording.split('/'))
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as Recorded['manifest']
  const playback = JSON.parse(await readFile(join(directory, 'playback.json'), 'utf8')) as { steps: RecordedStep[] }
  return { manifest, steps: playback.steps }
}

export const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM'
  }
}

export interface Workspace {
  readonly root: string
  readonly fixtures: string
  readonly measurement: string
  readonly profile: string
  readonly env: NodeJS.ProcessEnv
  readonly mark: (recording: string, markup: Markup) => Promise<void>
  readonly edit: (recording: string, change: (recorded: Recorded) => Recorded) => Promise<void>
  readonly fakeClaude: (scenario: ClaudeScenario) => FakeCli<ClaudeScenario>
  readonly fakeCodex: (scenario: CodexScenario) => FakeCli<CodexScenario>
  readonly writeProfile: (profile: unknown) => Promise<void>
  readonly freshness: (...args: readonly string[]) => Promise<Outcome>
  readonly read: (file: string) => Promise<unknown>
  readonly dispose: () => Promise<void>
}

export const createWorkspace = async (): Promise<Workspace> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aang-freshness-')))
  const home = join(root, 'user')
  await mkdir(home)
  const fixtures = join(root, 'fixtures')
  const measurement = join(root, 'measurement')
  const profile = join(root, 'profile.json')
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home }
  const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`
  return {
    root,
    fixtures,
    measurement,
    profile,
    env,
    mark: async (recording, markup) => {
      const directory = join(fixtures, ...recording.split('/'))
      await mkdir(directory, { recursive: true })
      await cp(join(repositoryFixtures, ...recording.split('/')), directory, { recursive: true })
      const manifestPath = join(directory, 'manifest.json')
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
        control_events: { label: string; expected_map_change: Record<string, unknown> }[]
      }
      for (const event of manifest.control_events) {
        const predicate = markup[event.label]
        if (predicate !== undefined) {
          event.expected_map_change.predicate = predicate
        }
      }
      await writeFile(manifestPath, json(manifest))
    },
    edit: async (recording, change) => {
      const directory = join(fixtures, ...recording.split('/'))
      const manifestPath = join(directory, 'manifest.json')
      const playbackPath = join(directory, 'playback.json')
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
      const playback = JSON.parse(await readFile(playbackPath, 'utf8')) as Record<string, unknown>
      const changed = change(await readRecorded(fixtures, recording))
      await writeFile(manifestPath, json({ ...manifest, ...changed.manifest }))
      await writeFile(playbackPath, json({ ...playback, steps: changed.steps }))
    },
    fakeClaude: (scenario) => installFakeClaude(join(root, 'fake-cli'), scenario),
    fakeCodex: (scenario) => installFakeCodex(join(root, 'fake-cli'), scenario),
    writeProfile: async (value) => {
      await writeFile(profile, JSON.stringify(value))
    },
    freshness: async (...args) => {
      const child = spawn(process.execPath, [main, ...args], { env, windowsHide: true })
      const output = { stdout: '', stderr: '' }
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        output.stdout += chunk
      })
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        output.stderr += chunk
      })
      const [code] = (await once(child, 'close')) as [number | null]
      return { code, ...output }
    },
    read: async (file) => JSON.parse(await readFile(join(measurement, file), 'utf8')) as unknown,
    dispose: () => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }),
  }
}
