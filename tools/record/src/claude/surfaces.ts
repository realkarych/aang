import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { OperatingSystem } from '@aang/contract'
import type { ScenarioSession } from '../scenario.js'
import { desktopSdkVersion } from './drivers.js'
import { type HostPlanInput, type HostSummary, readSummary } from './plan.js'
import { startModelStub, type StubScript } from './stub.js'
import { driveTui, type TuiRun } from './tui.js'

export type ClaudeSurfaceName = 'claude_cli' | 'claude_sdk' | 'claude_desktop'

interface Launch {
  readonly host: string
  readonly engine: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly initialize: boolean
}

export interface ClaudeSurface {
  readonly surface: ClaudeSurfaceName
  readonly os?: readonly OperatingSystem[]
  readonly launch: (session: ScenarioSession) => Promise<Launch>
}

const streamHost = fileURLToPath(new URL('./stream-host.js', import.meta.url))
const sdkHost = fileURLToPath(new URL('./sdk-host.js', import.meta.url))
const filesHost = fileURLToPath(new URL('./files-host.js', import.meta.url))

export const claudeSurfaces: readonly ClaudeSurface[] = [
  {
    surface: 'claude_cli',
    launch: (session) => Promise.resolve({ host: streamHost, engine: session.engine.executable, args: ['-p'], env: {}, initialize: false }),
  },
  {
    surface: 'claude_sdk',
    launch: (session) => {
      const { module } = session.engine
      if (module === undefined) throw new Error('The Claude Agent SDK driver did not resolve the SDK module')
      return Promise.resolve({ host: sdkHost, engine: module, args: [], env: {}, initialize: false })
    },
  },
  {
    surface: 'claude_desktop',
    os: ['macos'],
    launch: async (session) => {
      const sdkVersion = await desktopSdkVersion()
      return {
        host: streamHost,
        engine: session.engine.executable,
        args: ['--setting-sources', 'user,project,local', '--include-partial-messages', '--replay-user-messages'],
        env: {
          CLAUDE_CODE_ENTRYPOINT: 'claude-desktop',
          CLAUDE_CODE_EAGER_FLUSH: '1',
          CLAUDE_CODE_SDK_READS_SESSION_STATE: '1',
          ...sdkVersion === undefined ? {} : { CLAUDE_AGENT_SDK_VERSION: sdkVersion },
        },
        initialize: true,
      }
    },
  },
]

export type Stage = Omit<HostPlanInput, 'engine' | 'args' | 'initialize'>

export interface ClaudeRun {
  readonly session: ScenarioSession
  readonly stage: (name: string, stage: Stage) => Promise<HostSummary>
  readonly tui: (name: string, run: TuiRun) => Promise<void>
  readonly remove: (file: string) => Promise<void>
  readonly move: (file: string, destination: string) => Promise<void>
}

const quiet = { DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1' }
const stubKey = 'sk-ant-api03-aang-record-model-stub'

const liveCredentials = (): void => {
  if (process.env['ANTHROPIC_API_KEY'] || process.env['CLAUDE_CODE_OAUTH_TOKEN']) return
  throw new Error('Live Claude scenarios need ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN: the temporary CLAUDE_CONFIG_DIR has no login')
}

export const withClaude = (
  surface: ClaudeSurface,
  script: (session: ScenarioSession) => StubScript,
  body: (run: ClaudeRun) => Promise<void>,
) => async (session: ScenarioSession): Promise<void> => {
  const live = session.model === 'live'
  if (live) liveCredentials()
  const stub = live ? undefined : await startModelStub(script(session), join(session.work, 'model-stub.jsonl'))
  const env = stub === undefined
    ? quiet
    : {
        ...quiet,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        ANTHROPIC_BASE_URL: stub.url,
        ANTHROPIC_API_KEY: stubKey,
        ANTHROPIC_AUTH_TOKEN: '',
        CLAUDE_CODE_OAUTH_TOKEN: '',
      }
  const timeoutMs = live ? 900_000 : 300_000
  try {
    const launch = await surface.launch(session)
    await body({
      session,
      stage: async (name, stage) => {
        const plan = join(session.work, `${name}.plan.json`)
        const summary = join(session.work, `${name}.summary.json`)
        const content: HostPlanInput = { ...stage, engine: launch.engine, args: [...launch.args], env: { ...launch.env, ...stage.env }, initialize: launch.initialize }
        await writeFile(plan, `${JSON.stringify(content, null, 2)}\n`)
        try {
          await session.run(process.execPath, [launch.host, plan, summary], { env, timeoutMs })
        } catch (error) {
          const partial = await readSummary(summary).catch(() => undefined)
          throw new Error(`${surface.surface} stage ${name} failed: ${partial?.error ?? (error instanceof Error ? error.message : String(error))}`, { cause: error })
        }
        const result = await readSummary(summary)
        if (result === undefined) throw new Error(`${surface.surface} stage ${name} wrote no summary`)
        return result
      },
      tui: async (name, run) => {
        if (live) throw new Error('TUI scenarios run only with the model stub')
        await driveTui(session, name, stubKey, { ...run, env: { ...env, ...run.env } })
      },
      remove: async (file) => {
        await session.run(process.execPath, [filesHost, 'remove', file])
      },
      move: async (file, destination) => {
        await session.run(process.execPath, [filesHost, 'move', file, destination])
      },
    })
  } finally {
    await stub?.close()
  }
}
