import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type ClaudeScenario, installFakeClaude } from '@aang/testkit'

export interface Outcome {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}

export type Markup = Readonly<Record<string, unknown>>

const repository = (relative: string): string => fileURLToPath(new URL(`../../../${relative}`, import.meta.url))

const main = fileURLToPath(new URL('../dist/main.js', import.meta.url))

const hostOs = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux'

export const repositoryFixtures = repository('fixtures/sessions')

export const claudeRecording = (scenario: string): string => `claude/2.1.289/claude_cli/${hostOs}/${scenario}`

export const codexRecording = (scenario: string): string => `codex/0.160.0/codex_exec/${hostOs}/${scenario}`

export interface Workspace {
  readonly root: string
  readonly fixtures: string
  readonly measurement: string
  readonly profile: string
  readonly env: NodeJS.ProcessEnv
  readonly mark: (recording: string, markup: Markup) => Promise<void>
  readonly fakeClaude: (scenario: ClaudeScenario) => string
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
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    },
    fakeClaude: (scenario) => installFakeClaude(join(root, 'fake-cli'), scenario).path,
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
