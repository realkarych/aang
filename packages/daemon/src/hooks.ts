import { type Stats, unwatchFile, watchFile } from 'node:fs'
import { join } from 'node:path'
import { type Config, type HookInstallation, type Runtime, runtimes } from '@aang/contract'
import {
  checkCodexHooks,
  claudePluginListArgs,
  type ClaudePluginState,
  claudePluginStateOf,
  type CodexHooksCheck,
  type CodexHooksStatus,
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
  readonly read: (signal: AbortSignal, fresh: boolean) => Promise<HookInstallation>
}

interface Checker {
  readonly request: (fresh: boolean) => Promise<void>
  readonly noticeChange: () => void
  readonly settled: () => Promise<void>
  readonly stop: () => void
}

interface QueuedCheck {
  readonly done: Promise<void>
  fresh: boolean
}

const claudeInstallations: Readonly<Record<ClaudePluginState, HookInstallation>> = {
  not_installed: 'not_installed',
  disabled: 'disabled',
  enabled: 'active',
}

const codexInstallations: Readonly<Record<CodexHooksStatus, HookInstallation>> = {
  not_installed: 'not_installed',
  untrusted: 'untrusted',
  inactive: 'disabled',
  active: 'active',
}

const fileCheckIntervalMs = 1_000

const changeQuietMs = 2_000

const changeDelayLimitMs = 10_000

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

const codexProbe = ({ aangHome, config, runtimeRoots }: HookChecksOptions): Probe => {
  let known: CodexHooksCheck | null = null
  return {
    files: [
      join(runtimeRoots.codex, 'hooks.json'),
      join(runtimeRoots.codex, 'config.toml'),
      hookInstallPaths(aangHome).codexHooksRecord,
    ],
    read: async (signal, fresh) => {
      try {
        known = await checkCodexHooks({
          aangHome,
          codexHome: runtimeRoots.codex,
          codex: () => resolveCli('codex', config.cli.codex ?? 'codex', inheritedEnvironment()),
          timeoutMs: hookProbeTimeoutMs,
          signal,
          known,
          fresh,
        })
      } catch (error) {
        known = null
        throw error
      }
      return codexInstallations[known.status]
    },
  }
}

const probes = (options: HookChecksOptions, runner: ProcessRunner): Readonly<Record<Runtime, Probe>> => {
  const { runtimeRoots } = options
  return {
    claude: {
      files: [join(runtimeRoots.claude, 'settings.json'), join(runtimeRoots.claude, 'plugins', 'installed_plugins.json')],
      read: async (signal) => claudeInstallations[await claudePlugin(options, runner, signal)],
    },
    codex: codexProbe(options),
  }
}

const createChecker = (check: (fresh: boolean) => Promise<void>): Checker => {
  let running: Promise<void> | null = null
  let queued: QueuedCheck | null = null
  let delayed: NodeJS.Timeout | undefined
  let firstChange: number | null = null
  const start = (fresh: boolean): Promise<void> => {
    const run = check(fresh).finally(() => {
      running = null
    })
    running = run
    return run
  }
  const stop = (): void => {
    clearTimeout(delayed)
    delayed = undefined
    firstChange = null
  }
  const request = (fresh: boolean): Promise<void> => {
    if (fresh) {
      stop()
    }
    if (queued !== null) {
      queued.fresh ||= fresh
      return queued.done
    }
    if (running === null) {
      return start(fresh)
    }
    const next: QueuedCheck = {
      fresh,
      done: running.then(() => {
        queued = null
        return start(next.fresh)
      }),
    }
    queued = next
    return next.done
  }
  return {
    request,
    noticeChange: () => {
      const now = Date.now()
      firstChange ??= now
      clearTimeout(delayed)
      delayed = setTimeout(
        () => {
          stop()
          void request(false)
        },
        Math.max(0, Math.min(changeQuietMs, firstChange + changeDelayLimitMs - now)),
      )
      delayed.unref()
    },
    settled: async () => {
      await queued?.done
      await running
    },
    stop,
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
    const checker = createChecker(async (fresh) => {
      if (!closing.signal.aborted) {
        installations[runtime] = await read(closing.signal, fresh).catch((): HookInstallation => 'unknown')
      }
    })
    for (const file of files) {
      const listener = (current: Stats, previous: Stats): void => {
        if (changed(current, previous)) {
          checker.noticeChange()
        }
      }
      watchFile(file, { interval: fileCheckIntervalMs, persistent: false }, listener)
      watched.push([file, listener])
    }
    return checker
  }
  const checkers: Readonly<Record<Runtime, Checker>> = { claude: checkerOf('claude'), codex: checkerOf('codex') }
  const check = async (): Promise<void> => {
    await Promise.all(runtimes.map((runtime) => checkers[runtime].request(true)))
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
      for (const runtime of runtimes) {
        checkers[runtime].stop()
      }
      await Promise.all(runtimes.map((runtime) => checkers[runtime].settled()))
    },
  }
}
