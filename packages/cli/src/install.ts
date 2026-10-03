import { readlink, realpath } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { defaultConfig, type Runtime } from '@aang/contract'
import { loadConfig, processEnvironment, resolveRuntimeRoots } from '@aang/contract/config-file'
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
  readonly defaultCodexHome: string
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
  const environment = processEnvironment()
  const { aangHome, config, runtimeRoots } = await loadConfig(environment)
  return {
    aangHome,
    claude: { command: config.cli.claude ?? 'claude', configDir: config.runtimes.claude.configDir },
    codex: { command: config.cli.codex ?? 'codex' },
    codexHome: runtimeRoots.codex,
    defaultCodexHome: resolveRuntimeRoots(defaultConfig(), { env: {}, homedir: environment.homedir }).codex,
  }
}

const isMissing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT'

interface ResolvedPath {
  readonly existing: string
  readonly missing: readonly string[]
}

const resolveExisting = async (path: string): Promise<ResolvedPath> => {
  try {
    return { existing: await realpath(path), missing: [] }
  } catch (error) {
    if (!isMissing(error)) {
      throw error
    }
  }
  const link = await readlink(path).catch(() => null)
  if (link !== null) {
    return resolveExisting(resolve(dirname(path), link))
  }
  const parent = dirname(path)
  if (parent === path) {
    return { existing: path, missing: [] }
  }
  const { existing, missing } = await resolveExisting(parent)
  return { existing, missing: [...missing, basename(path)] }
}

const foldCase = (name: string): string => name.normalize('NFC').toLowerCase()

const mayNameSameEntries = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((name, index) => foldCase(name) === foldCase(right[index] ?? ''))

const mayBeSameDirectory = async (left: string, right: string): Promise<boolean> => {
  const [one, other] = await Promise.all([resolveExisting(resolve(left)), resolveExisting(resolve(right))])
  return one.existing === other.existing && mayNameSameEntries(one.missing, other.missing)
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
  async ({ aangHome, codex, codexHome, defaultCodexHome }, output) => {
    if (await mayBeSameDirectory(codexHome, defaultCodexHome)) {
      throw new Error(
        `installing hooks into the default Codex profile ${codexHome} is not enabled yet: the effects of codex app-server on it are not verified`,
      )
    }
    const { hooksFile, backup } = await installCodexHooks({ aangHome, hookBinarySource, codexHome, codex })
    output.out(`codex: aang hooks registered in ${hooksFile}${backup === null ? '' : `; the previous file is kept in ${backup}`}`)
    const { status } = await codexHooksState({ codexHome, codex })
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
