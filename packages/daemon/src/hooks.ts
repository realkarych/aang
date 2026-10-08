import { type Stats, unwatchFile, watchFile } from 'node:fs'
import { join } from 'node:path'
import { type Config, type HookInstallation, type Runtime, runtimes } from '@aang/contract'
import {
  claudePluginListArgs,
  type ClaudePluginState,
  claudePluginStateOf,
  codexHooksState,
  type CodexHooksState,
  hookInstallPaths,
} from '@aang/hook'
import { createProcessRunner, type ProcessRunner, resolveCli } from '@aang/observer'

export interface HookChecksOptions {
  readonly aangHome: string
  readonly config: Config
  readonly runtimeRoots: Readonly<Record<Runtime, string>>
}

export interface HookChecks {
  readonly installations: () => Readonly<Record<Runtime, HookInstallation>>
  readonly check: () => Promise<void>
  readonly close: () => Promise<void>
}

interface Probe {
  readonly files: readonly string[]
  readonly read: (signal: AbortSignal) => Promise<HookInstallation>
}

interface Checker {
  readonly request: () => Promise<void>
  readonly settled: () => Promise<void>
}

const claudeInstallations: Readonly<Record<ClaudePluginState, HookInstallation>> = {
  not_installed: 'not_installed',
  disabled: 'disabled',
  enabled: 'active',
}

const codexInstallations: Readonly<Record<CodexHooksState['status'], HookInstallation>> = {
  not_installed: 'not_installed',
  untrusted: 'untrusted',
  inactive: 'disabled',
  active: 'active',
}

const fileCheckIntervalMs = 1_000

const hookProbeTimeoutMs = 10_000

const inheritedEnvironment = (): Record<string, string> =>
  Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))

const claudePlugin = async (
  { aangHome, config }: HookChecksOptions,
  runner: ProcessRunner,
  signal: AbortSignal,
): Promise<ClaudePluginState> => {
  const environment = inheritedEnvironment()
  const { configDir } = config.runtimes.claude
  const cli = resolveCli('claude', config.cli.claude ?? 'claude', environment)
  const { failure, exitCode, stdout, stderr } = await runner.run({
    command: cli.command,
    args: [...(cli.args ?? []), ...claudePluginListArgs],
    cwd: aangHome,
    env: configDir === null ? environment : { ...environment, CLAUDE_CONFIG_DIR: configDir },
    input: '',
    timeoutMs: hookProbeTimeoutMs,
    signal,
  })
  if (failure !== null) {
    throw new Error(`claude ${claudePluginListArgs.join(' ')}: ${failure}`)
  }
  return claudePluginStateOf({ status: exitCode ?? -1, stdout, stderr })
}

const probes = (options: HookChecksOptions, runner: ProcessRunner): Readonly<Record<Runtime, Probe>> => {
  const { aangHome, config, runtimeRoots } = options
  return {
    claude: {
      files: [join(runtimeRoots.claude, 'settings.json'), join(runtimeRoots.claude, 'plugins', 'installed_plugins.json')],
      read: async (signal) => claudeInstallations[await claudePlugin(options, runner, signal)],
    },
    codex: {
      files: [join(runtimeRoots.codex, 'hooks.json'), join(runtimeRoots.codex, 'config.toml')],
      read: async (signal) => {
        const codex = resolveCli('codex', config.cli.codex ?? 'codex', inheritedEnvironment())
        const state = await codexHooksState({
          aangHome,
          codexHome: runtimeRoots.codex,
          codex,
          timeoutMs: hookProbeTimeoutMs,
          signal,
        })
        return codexInstallations[state.status]
      },
    },
  }
}

const createChecker = (check: () => Promise<void>): Checker => {
  let running: Promise<void> | null = null
  let queued: Promise<void> | null = null
  const start = (): Promise<void> => {
    const run = check().finally(() => {
      running = null
    })
    running = run
    return run
  }
  return {
    request: () => {
      if (queued !== null) {
        return queued
      }
      if (running === null) {
        return start()
      }
      const next = running.then(() => {
        queued = null
        return start()
      })
      queued = next
      return next
    },
    settled: async () => {
      await queued
      await running
    },
  }
}

const changed = (current: Stats, previous: Stats): boolean =>
  current.mtimeMs !== previous.mtimeMs ||
  current.ctimeMs !== previous.ctimeMs ||
  current.size !== previous.size ||
  current.ino !== previous.ino

export const startHookChecks = (options: HookChecksOptions): HookChecks => {
  const installations: Record<Runtime, HookInstallation> = { claude: 'unknown', codex: 'unknown' }
  const closing = new AbortController()
  const watched: (readonly [string, (current: Stats, previous: Stats) => void])[] = []
  const runner = createProcessRunner({ windowsLauncher: hookInstallPaths(options.aangHome).binary })
  const probed = probes(options, runner)
  const checkerOf = (runtime: Runtime): Checker => {
    const { files, read } = probed[runtime]
    const checker = createChecker(async () => {
      if (!closing.signal.aborted) {
        installations[runtime] = await read(closing.signal).catch((): HookInstallation => 'unknown')
      }
    })
    for (const file of files) {
      const listener = (current: Stats, previous: Stats): void => {
        if (changed(current, previous)) {
          void checker.request()
        }
      }
      watchFile(file, { interval: fileCheckIntervalMs, persistent: false }, listener)
      watched.push([file, listener])
    }
    return checker
  }
  const checkers: Readonly<Record<Runtime, Checker>> = { claude: checkerOf('claude'), codex: checkerOf('codex') }
  const check = async (): Promise<void> => {
    await Promise.all(runtimes.map((runtime) => checkers[runtime].request()))
  }
  void check()
  return {
    installations: () => ({ ...installations }),
    check,
    close: async () => {
      closing.abort()
      for (const [file, listener] of watched) {
        unwatchFile(file, listener)
      }
      await Promise.all(runtimes.map((runtime) => checkers[runtime].settled()))
    },
  }
}
