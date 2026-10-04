import { type Stats, unwatchFile, watchFile } from 'node:fs'
import { join } from 'node:path'
import { type Config, type HookInstallation, type Runtime, runtimes } from '@aang/contract'
import { claudePluginState, type ClaudePluginState, codexHooksState, type CodexHooksState } from '@aang/hook'

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
  readonly read: () => Promise<HookInstallation>
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

const probes = ({ aangHome, config, runtimeRoots }: HookChecksOptions): Readonly<Record<Runtime, Probe>> => ({
  claude: {
    files: [join(runtimeRoots.claude, 'settings.json'), join(runtimeRoots.claude, 'plugins', 'installed_plugins.json')],
    read: async () =>
      claudeInstallations[
        await claudePluginState({ command: config.cli.claude ?? 'claude', configDir: config.runtimes.claude.configDir })
      ],
  },
  codex: {
    files: [join(runtimeRoots.codex, 'hooks.json'), join(runtimeRoots.codex, 'config.toml')],
    read: async () => {
      const codex = { command: config.cli.codex ?? 'codex' }
      return codexInstallations[(await codexHooksState({ aangHome, codexHome: runtimeRoots.codex, codex })).status]
    },
  },
})

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
  const state = { closed: false }
  const watched: (readonly [string, (current: Stats, previous: Stats) => void])[] = []
  const probed = probes(options)
  const checkerOf = (runtime: Runtime): Checker => {
    const { files, read } = probed[runtime]
    const checker = createChecker(async () => {
      if (!state.closed) {
        installations[runtime] = await read().catch((): HookInstallation => 'unknown')
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
      state.closed = true
      for (const [file, listener] of watched) {
        unwatchFile(file, listener)
      }
      await Promise.all(runtimes.map((runtime) => checkers[runtime].settled()))
    },
  }
}
