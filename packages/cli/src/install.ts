import type { Runtime } from '@catacomb/contract'
import { loadConfig, processEnvironment } from '@catacomb/contract/config-file'
import {
  type ClaudeCli,
  claudePluginId,
  claudePluginState,
  type ClaudePluginState,
  type CodexCli,
  type CodexHooksStatus,
  installClaudePlugin,
  installCodexHooks,
  uninstallClaudePlugin,
  uninstallCodexHooks,
} from '@catacomb/hook'
import { describeError, type Output } from './output.js'
import { codexHookSlowdown, codexHooksOffByDefault, onWindows } from './windows.js'

export type HookBinaryLocator = () => string

interface Connection {
  readonly catacombHome: string
  readonly claude: ClaudeCli
  readonly codex: CodexCli
  readonly codexHome: string
}

type Step = (connection: Connection, output: Output) => Promise<boolean>

const claudePluginNotes: Readonly<Record<ClaudePluginState, string>> = {
  enabled: 'enabled',
  disabled: `disabled; enable it with \`claude plugin enable ${claudePluginId}\``,
  not_installed: 'missing from `claude plugin list` after the installation',
}

const codexHooksNotes: Readonly<Record<CodexHooksStatus, string>> = {
  active: 'trusted and active',
  untrusted: 'not trusted yet; trust them in Codex with /hooks, until then Codex skips them',
  inactive: 'trusted but disabled; enable them in Codex with /hooks',
  not_installed: 'not listed by codex app-server after the installation, so Codex does not load them',
}

const connect = async (): Promise<Connection> => {
  const { catacombHome, config, runtimeRoots } = await loadConfig(processEnvironment())
  return {
    catacombHome,
    claude: { command: config.cli.claude ?? 'claude', configDir: config.runtimes.claude.configDir },
    codex: { command: config.cli.codex ?? 'codex' },
    codexHome: runtimeRoots.codex,
  }
}

const runSteps = async (
  command: string,
  steps: readonly (readonly [Runtime, Step])[],
  output: Output,
): Promise<number> => {
  const connection = await connect()
  let failed = false
  for (const [runtime, step] of steps) {
    try {
      if (!(await step(connection, output))) {
        failed = true
      }
    } catch (error) {
      output.error(`catacomb ${command}: ${runtime}: ${describeError(error)}`)
      failed = true
    }
  }
  return failed ? 1 : 0
}

const installClaude =
  (hookBinarySource: string): Step =>
  async ({ catacombHome, claude }, output) => {
    const { plugin } = await installClaudePlugin({ catacombHome, hookBinarySource, claude })
    output.out(`claude: plugin ${claudePluginId} installed from ${plugin}`)
    const state = await claudePluginState(claude)
    output.out(`claude: plugin ${claudePluginId} is ${claudePluginNotes[state]}`)
    return state !== 'not_installed'
  }

const installCodex =
  (hookBinarySource: string): Step =>
  async ({ catacombHome, codex, codexHome }, output) => {
    const { hooksFile, backup, status } = await installCodexHooks({ catacombHome, hookBinarySource, codexHome, codex })
    output.out(`codex: catacomb hooks registered in ${hooksFile}${backup === null ? '' : `; the previous file is kept in ${backup}`}`)
    output.out(`codex: catacomb hooks are ${codexHooksNotes[status]}`)
    if (onWindows) {
      output.out(`codex: ${codexHookSlowdown}`)
    }
    return status !== 'not_installed'
  }

const skipCodexOnWindows: Step = (_connection, output) => {
  output.out(`codex: ${codexHooksOffByDefault}`)
  output.out(`codex: \`catacomb install --codex\` installs them anyway; ${codexHookSlowdown}`)
  return Promise.resolve(true)
}

const uninstallClaude: Step = async ({ catacombHome, claude }, output) => {
  await uninstallClaudePlugin({ catacombHome, claude })
  output.out(`claude: plugin ${claudePluginId} and its marketplace are removed`)
  return true
}

const uninstallCodex: Step = async ({ codexHome }, output) => {
  const { hooksFile, backup } = await uninstallCodexHooks({ codexHome })
  output.out(
    backup === null
      ? `codex: no catacomb hooks in ${hooksFile}`
      : `codex: catacomb hooks neutralized in ${hooksFile}; the previous file is kept in ${backup}`,
  )
  return true
}

export const install = (
  output: Output,
  locateHookBinary: HookBinaryLocator,
  targets: Readonly<Record<Runtime, boolean>>,
): Promise<number> => {
  const hookBinarySource = locateHookBinary()
  const everything = !targets.claude && !targets.codex
  const steps: readonly (readonly [Runtime, Step])[] = [
    ['claude', installClaude(hookBinarySource)],
    ['codex', everything && onWindows ? skipCodexOnWindows : installCodex(hookBinarySource)],
  ]
  return runSteps('install', steps.filter(([runtime]) => everything || targets[runtime]), output)
}

export const uninstall = (output: Output): Promise<number> =>
  runSteps(
    'uninstall',
    [
      ['claude', uninstallClaude],
      ['codex', uninstallCodex],
    ],
    output,
  )
