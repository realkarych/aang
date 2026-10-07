import { once } from 'node:events'
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import type { OperatingSystem, Placement, Runtime } from '@aang/contract'
import { configFileName } from '@aang/contract/config-file'
import { writeClaudePlugin } from '@aang/hook'
import { createProcessRunner } from '@aang/observer'
import type { Engine, RunOptions, RunOutput, Scenario, ScenarioSession } from '@aang/record'
import { leaseSpool } from '@aang/testkit'
import { type Aang, type AangCommand, type ApiClient, createAang, otelEndpoint, signIn, signInLink } from './aang.js'

export interface LiveOptions {
  readonly scenario: Scenario
  readonly engine: Engine
  readonly runtime: Runtime
  readonly os: OperatingSystem
  readonly placement: Placement
  readonly aang: AangCommand
  readonly hookBinary: string
  readonly cli: Readonly<Record<Runtime, string | null>>
  readonly bind: string | null
  readonly port: number | null
  readonly base: string
}

export interface LiveProfile {
  readonly root: string
  readonly home: string
  readonly project: string
  readonly claude: string
  readonly codex: string
  readonly aangHome: string
}

export interface LiveRun {
  readonly profile: LiveProfile
  readonly aang: Aang
  readonly api: ApiClient | null
  readonly installed: readonly string[]
  readonly restarts: number
  readonly error: string | null
  readonly stop: () => Promise<void>
  readonly remove: () => Promise<void>
}

const scenarioPluginName = 'aang-scenario'
const commandTimeoutMs = 300_000
const strippedPrefixes = ['ANTHROPIC_', 'OPENAI_', 'AANG_', 'CLAUDE_CODE_', 'CLAUDE_AGENT_SDK_', 'CLAUDE_PLUGIN_', 'CODEX_', 'GITHUB_TOKEN', 'ACTIONS_']
const strippedNames = new Set(['CLAUDE_CONFIG_DIR', 'AI_AGENT'])

const inheritedEnv = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        !strippedNames.has(entry[0].toUpperCase()) &&
        !strippedPrefixes.some((prefix) => entry[0].toUpperCase().startsWith(prefix)),
    ),
  )

const beforeOperands = (args: readonly string[], options: readonly string[]): string[] => {
  const operands = args.indexOf('--')
  return operands < 0 ? [...args, ...options] : [...args.slice(0, operands), ...options, ...args.slice(operands)]
}

const freePort = async (): Promise<number> => {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo
  server.close()
  await once(server, 'close')
  return port
}

const renamePlugin = async (directory: string): Promise<void> => {
  for (const file of ['plugin.json', 'marketplace.json']) {
    const path = join(directory, '.claude-plugin', file)
    const document = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    const plugins = Array.isArray(document['plugins'])
      ? (document['plugins'] as Record<string, unknown>[]).map((plugin) => ({ ...plugin, name: scenarioPluginName }))
      : undefined
    await writeFile(path, `${JSON.stringify({ ...document, name: scenarioPluginName, ...(plugins === undefined ? {} : { plugins }) }, null, 2)}\n`)
  }
}

const createProfile = async (base: string): Promise<LiveProfile> => {
  await mkdir(base, { recursive: true })
  const root = await realpath(await mkdtemp(join(base, 'aang-surface-')))
  const home = join(root, 'home')
  const profile: LiveProfile = {
    root,
    home,
    project: join(home, 'project'),
    claude: join(home, '.claude'),
    codex: join(home, '.codex'),
    aangHome: join(home, '.aang'),
  }
  const runtimeRoots = [
    join(profile.claude, 'projects'),
    join(profile.claude, 'sessions'),
    join(profile.claude, 'teams'),
    join(profile.codex, 'sessions'),
    join(profile.codex, 'archived_sessions'),
  ]
  for (const directory of [profile.project, ...runtimeRoots, profile.aangHome, join(root, 'work')]) {
    await mkdir(directory, { recursive: true, mode: 0o700 })
  }
  return profile
}

const writeConfig = async (profile: LiveProfile, options: LiveOptions, apiPort: number): Promise<void> => {
  const config = {
    ...(options.placement === 'vm' || options.placement === 'desktop_ssh' ? { placement: options.placement } : {}),
    cli: options.cli,
    runtimes: { claude: { configDir: profile.claude }, codex: { home: profile.codex } },
    api: { port: apiPort },
    otel: { port: await freePort() },
    watch: { all: false },
  }
  await writeFile(join(profile.aangHome, configFileName), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export const startLive = async (options: LiveOptions): Promise<LiveRun> => {
  const profile = await createProfile(options.base)
  const spool = join(profile.root, 'spool')
  const plugin = join(profile.root, 'plugin')
  const work = join(profile.root, 'work')
  const scenarioHook = join(profile.root, process.platform === 'win32' ? 'scenario-hook.exe' : 'scenario-hook')
  await copyFile(options.hookBinary, scenarioHook)
  await chmod(scenarioHook, 0o755)
  await leaseSpool(spool, 24 * 60 * 60 * 1_000)
  await writeClaudePlugin({ directory: plugin, hookBinary: scenarioHook, spool })
  await renamePlugin(plugin)
  await writeConfig(profile, options, options.port ?? (await freePort()))
  const env: Record<string, string> = {
    ...inheritedEnv(),
    HOME: profile.home,
    USERPROFILE: profile.home,
    CLAUDE_CONFIG_DIR: profile.claude,
    CODEX_HOME: profile.codex,
    AANG_HOME: profile.aangHome,
  }
  const aang = createAang(options.aang, env)
  const bind = options.bind === null ? [] : ['--bind', options.bind]
  const installed: string[] = []
  const state: { restarts: number; api: ApiClient | null; error: string | null } = { restarts: 0, api: null, error: null }
  const connect = async (): Promise<void> => {
    await aang.ok(['start', ...bind])
    state.api = await signIn(signInLink(await aang.ok(['open'])))
  }
  const runner = createProcessRunner({ windowsLauncher: options.hookBinary, temporaryDirectory: profile.root })
  const controller = new AbortController()
  const prepare = async (): Promise<void> => {
    if (installed.length === 0) {
      await aang.ok(['stop'])
      installed.push(await aang.ok(['install', `--${options.runtime}`], commandTimeoutMs))
      await connect()
    }
    await aang.run(['status'], commandTimeoutMs)
  }
  const run = async (command: string, args: readonly string[], runOptions: RunOptions = {}): Promise<RunOutput> => {
    await prepare()
    const result = await runner.run({
      command,
      args: options.runtime === 'claude' ? beforeOperands(args, ['--plugin-dir', plugin]) : [...args],
      cwd: profile.project,
      env: { ...env, AANG_RECORD_SPOOL: spool, AANG_RECORD_HOOK: scenarioHook, ...runOptions.env },
      input: '',
      timeoutMs: runOptions.timeoutMs ?? commandTimeoutMs,
      signal: controller.signal,
    })
    const detail = result.stderr.trim().slice(-2_000)
    if (result.failure !== null || result.exitCode !== 0) {
      throw new Error(`command failed: ${result.failure ?? String(result.exitCode)}${detail === '' ? '' : `\n${detail}`}`)
    }
    return { stdout: result.stdout, stderr: result.stderr }
  }
  const stop = async (): Promise<void> => {
    controller.abort()
    await aang.run(['stop'])
  }
  try {
    await connect()
    await aang.ok(['watch', profile.project])
    const otlp = otelEndpoint(await aang.ok(['otel-config']))
    const session: ScenarioSession = {
      os: options.os,
      claudeHome: 'isolated',
      project: profile.project,
      home: profile.home,
      claude: profile.claude,
      codex: profile.codex,
      spool,
      plugin,
      hook: scenarioHook,
      otlp,
      work,
      model: 'stub',
      engine: options.engine,
      run,
      checkpoint: async (label) => {
        if (label !== 'daemon-restart') {
          return
        }
        await aang.ok(['stop'])
        await connect()
        state.restarts += 1
      },
      keep: () => Promise.resolve(),
    }
    await options.scenario.run(session)
  } catch (error) {
    state.error = describe(error)
  }
  return {
    profile,
    aang,
    api: state.api,
    installed,
    restarts: state.restarts,
    error: state.error,
    stop,
    remove: () => rm(profile.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }),
  }
}
