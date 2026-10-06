import type { Runtime } from '@aang/contract'
import { loadConfig, processEnvironment } from '@aang/contract/config-file'
import {
  type ClaudeCli,
  claudePluginId,
  claudePluginState,
  type ClaudePluginState,
  type CodexCli,
  type CodexHooksState,
  codexHooksState,
  installClaudePlugin,
  installCodexHooks,
  uninstallClaudePlugin,
  uninstallCodexHooks,
} from '@aang/hook'
import { describeError, type Output } from './output.js'

export type HookBinaryLocator = () => string

interface Connection {
  readonly aangHome: string
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

const codexHooksNotes: Readonly<Record<CodexHooksState['status'], string>> = {
  active: 'trusted and active',
  untrusted: 'not trusted yet; trust them in Codex with /hooks, until then Codex skips them',
  inactive: 'trusted but disabled; enable them in Codex with /hooks',
  not_installed: 'not listed by codex app-server after the installation, so Codex does not load them',
}

const connect = async (): Promise<Connection> => {
  const { aangHome, config, runtimeRoots } = await loadConfig(processEnvironment())
  return {
    aangHome,
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
      output.error(`aang ${command}: ${runtime}: ${describeError(error)}`)
      failed = true
    }
  }
  return failed ? 1 : 0
}

const installClaude =
  (hookBinarySource: string): Step =>
  async ({ aangHome, claude }, output) => {
    const { plugin } = await installClaudePlugin({ aangHome, hookBinarySource, claude })
    output.out(`claude: plugin ${claudePluginId} installed from ${plugin}`)
    const state = await claudePluginState(claude)
    output.out(`claude: plugin ${claudePluginId} is ${claudePluginNotes[state]}`)
    return state !== 'not_installed'
  }

const installCodex =
  (hookBinarySource: string): Step =>
  async ({ aangHome, codex, codexHome }, output) => {
    const { hooksFile, backup } = await installCodexHooks({ aangHome, hookBinarySource, codexHome, codex })
    output.out(`codex: aang hooks registered in ${hooksFile}${backup === null ? '' : `; the previous file is kept in ${backup}`}`)
    const { status } = await codexHooksState({ aangHome, codexHome, codex })
    output.out(`codex: aang hooks are ${codexHooksNotes[status]}`)
    return status !== 'not_installed'
  }

const uninstallClaude: Step = async ({ aangHome, claude }, output) => {
  await uninstallClaudePlugin({ aangHome, claude })
  output.out(`claude: plugin ${claudePluginId} and its marketplace are removed`)
  return true
}

const uninstallCodex: Step = async ({ codexHome }, output) => {
  const { hooksFile, backup } = await uninstallCodexHooks({ codexHome })
  output.out(
    backup === null
      ? `codex: no aang hooks in ${hooksFile}`
      : `codex: aang hooks neutralized in ${hooksFile}; the previous file is kept in ${backup}`,
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
    ['codex', installCodex(hookBinarySource)],
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
