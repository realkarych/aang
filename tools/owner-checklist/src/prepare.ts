import { execFile } from 'node:child_process'
import { mkdir, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { leaseFileName } from '@catacomb/contract/home'
import {
  type ClaudeCli,
  claudePluginId,
  claudePluginState,
  deployHookBinary,
  installClaudePlugin,
  writeClaudePlugin,
} from '@catacomb/hook'
import { applyCodexHooks, codexHookCommand, planCodexHooks } from './codex-hooks.js'
import { type ChecklistLayout, checklistLayout, outsideProbeDir } from './layout.js'
import { consoleCommand } from './shell.js'
import { type ChecklistState, type ClaudeRegistration, writeState } from './state.js'

export interface PrepareOptions {
  readonly dir: string
  readonly hookSource: string
  readonly hours: number
  readonly claude: ClaudeRegistration
  readonly claudeCommand: string
  readonly codexHooks: boolean
  readonly codexHome: string
}

const execFileAsync = promisify(execFile)
const probeScript = fileURLToPath(new URL('./probe.js', import.meta.url))
const mainScript = fileURLToPath(new URL('./main.js', import.meta.url))
const envProbeTimeoutSeconds = 10
const failingHookTimeoutSeconds = 10
const hangingHookTimeoutSeconds = 2
const hangingHookSeconds = 30

const isMissing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT'

const requireSupport = (options: PrepareOptions): void => {
  if (process.platform !== 'win32') {
    return
  }
  if (options.claude === 'marketplace') {
    throw new Error('on Windows the checklist loads the plugin only with the --plugin-dir flag, without changing user settings (ADR-0013); use --claude plugin-dir')
  }
  if (options.codexHooks) {
    throw new Error('--codex-hooks is needed only for Codex Desktop on macOS; Desktop on Windows is not checked in the MVP (ADR-0013, decision 3)')
  }
}

const requireHookSource = async (path: string): Promise<void> => {
  const isFile = await stat(path).then(
    (stats) => stats.isFile(),
    () => false,
  )
  if (!isFile) {
    throw new Error(`catacomb-hook not found: ${path}; build the repository with pnpm build or pass --hook`)
  }
}

const createEmptyDir = async (dir: string): Promise<string> => {
  try {
    if ((await readdir(dir)).length > 0) {
      throw new Error(`${dir} is not empty: choose another --dir or roll back the previous prepare with cleanup`)
    }
  } catch (error) {
    if (!isMissing(error)) {
      throw error
    }
  }
  await mkdir(dir, { recursive: true })
  return realpath(dir)
}

const claimOutsideDir = async (dir: string): Promise<void> => {
  try {
    if ((await readdir(dir)).length > 0) {
      throw new Error(`${dir} already exists and is not empty: step 8a needs an empty directory`)
    }
    return
  } catch (error) {
    if (!isMissing(error)) {
      throw error
    }
  }
  await mkdir(dir, { mode: 0o700 })
}

const createSpool = async (layout: ChecklistLayout, expiresAtSeconds: number): Promise<void> => {
  await mkdir(layout.spoolReady, { recursive: true, mode: 0o700 })
  await mkdir(layout.spoolTemporary, { recursive: true, mode: 0o700 })
  await writeFile(join(layout.spool, leaseFileName(expiresAtSeconds)), '')
}

interface ProbeHandler {
  readonly type: 'command'
  readonly command: string
  readonly args: readonly string[]
  readonly timeout: number
  readonly statusMessage?: string
}

const probeHandler = (args: readonly string[], timeout: number, statusMessage?: string): ProbeHandler => ({
  type: 'command',
  command: process.execPath,
  args: [probeScript, ...args],
  timeout,
  ...(statusMessage === undefined ? {} : { statusMessage }),
})

const settingsDocument = (hooks: Readonly<Record<string, readonly ProbeHandler[]>>): string =>
  `${JSON.stringify(
    { hooks: Object.fromEntries(Object.entries(hooks).map(([event, handlers]) => [event, [{ matcher: '', hooks: handlers }]])) },
    null,
    2,
  )}\n`

const writeProbes = async (layout: ChecklistLayout): Promise<void> => {
  await mkdir(layout.probes, { recursive: true })
  await mkdir(layout.results, { recursive: true })
  await writeFile(
    layout.envSettings,
    settingsDocument({ SessionStart: [probeHandler(['env', layout.envProbeLog], envProbeTimeoutSeconds)] }),
  )
  await writeFile(
    layout.failureSettings,
    settingsDocument({
      PreToolUse: [probeHandler(['fail'], failingHookTimeoutSeconds)],
      UserPromptSubmit: [
        probeHandler(
          ['hang', String(hangingHookSeconds)],
          hangingHookTimeoutSeconds,
          'catacomb D.7: hook hangs longer than its 2 s timeout',
        ),
      ],
    }),
  )
}

const gitEnvironment = (): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('GIT_')))

const createProbeRepo = async (repo: string): Promise<void> => {
  await mkdir(repo, { recursive: true })
  await writeFile(join(repo, 'README.md'), '# catacomb D.7 probe repository\n')
  const git = (args: readonly string[]): Promise<unknown> =>
    execFileAsync('git', args, { cwd: repo, env: gitEnvironment(), windowsHide: true })
  await git(['init', '--quiet', '--initial-branch=main'])
  await git(['add', 'README.md'])
  await git([
    '-c',
    'user.name=catacomb D.7',
    '-c',
    'user.email=catacomb-d7@localhost',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--quiet',
    '--no-verify',
    '-m',
    'Initial commit',
  ])
}

const claudeCli = (command: string): ClaudeCli => ({
  command,
  configDir: process.env.CLAUDE_CONFIG_DIR === undefined || process.env.CLAUDE_CONFIG_DIR === '' ? null : process.env.CLAUDE_CONFIG_DIR,
})

const registerClaude = async (
  layout: ChecklistLayout,
  state: ChecklistState,
  options: PrepareOptions,
): Promise<ChecklistState> => {
  const cli = claudeCli(options.claudeCommand)
  const current = await claudePluginState(cli)
  if (current !== 'not_installed') {
    throw new Error(
      `plugin ${claudePluginId} is already in the Claude user settings (${current}); remove it or use --claude plugin-dir`,
    )
  }
  const registered: ChecklistState = { ...state, claude: { ...state.claude, configDir: cli.configDir, registered: true } }
  await writeState(layout, registered)
  await installClaudePlugin({ catacombHome: layout.catacombHome, hookBinarySource: options.hookSource, claude: cli })
  return registered
}

const registerCodex = async (
  layout: ChecklistLayout,
  state: ChecklistState,
  options: PrepareOptions,
): Promise<ChecklistState> => {
  const outsideDir = outsideProbeDir()
  await claimOutsideDir(outsideDir)
  const withOutside: ChecklistState = { ...state, outsideDir }
  await writeState(layout, withOutside)
  const plan = await planCodexHooks(options.codexHome, codexHookCommand(layout.hookBinary, layout.spool))
  const registered: ChecklistState = { ...withOutside, codex: plan.registration }
  await writeState(layout, registered)
  await applyCodexHooks(plan)
  return registered
}

const claudeLaunch = (
  layout: ChecklistLayout,
  state: ChecklistState,
  settings: string,
  extra: readonly string[] = [],
): string =>
  consoleCommand([
    'claude',
    ...extra,
    ...(state.claude.mode === 'plugin-dir' ? ['--plugin-dir', layout.pluginDir] : []),
    '--settings',
    settings,
  ])

const memo = (layout: ChecklistLayout, state: ChecklistState): string[] => {
  const tool = (command: string): string => consoleCommand(['node', mainScript, command, '--dir', layout.dir])
  const codex = state.codex
  const steps = [
    `Claude TUI, items (a)–(c), (e)–(g), in the probe repository:\n   ${consoleCommand(['cd', layout.probeRepo])}\n   ${claudeLaunch(layout, state, layout.envSettings)}`,
    `Item (d), a separate session in the same place:\n   ${claudeLaunch(layout, state, layout.failureSettings)}`,
    `Item (h), a session in plan mode:\n   ${claudeLaunch(layout, state, layout.envSettings, ['--permission-mode', 'plan'])}`,
    ...(state.claude.mode === 'marketplace'
      ? ['Claude Desktop: restart the app and open a new Code session in the probe repository.']
      : []),
    ...(codex === null ? [] : ['Codex Desktop: restart the app and confirm trust for the catacomb hooks in its UI.']),
    `Collect results: ${tool('collect')}`,
    `Roll back: ${tool('cleanup')} (with --keep-results the results/ directory stays)`,
  ]
  return [
    `Checklist working directory prepared: ${layout.dir}`,
    `- catacomb-hook: ${layout.hookBinary}`,
    `- spool: ${layout.spool}, lease until ${state.leaseExpiresAt}`,
    `- Claude plugin: ${layout.pluginDir}`,
    `- probe repository: ${layout.probeRepo}`,
    `- probes: ${layout.envSettings}, ${layout.failureSettings}`,
    state.claude.mode === 'marketplace'
      ? `- Claude: plugin ${claudePluginId} installed in the user scope through a local marketplace; cleanup will remove it`
      : '- Claude: user settings unchanged, the plugin is loaded with the --plugin-dir flag',
    ...(codex === null
      ? []
      : [
          `- Codex: catacomb entries appended to the arrays of ${codex.hooksFile}; ${codex.backup === null ? 'file created from scratch' : `backup ${codex.backup}`}`,
          `- directory for step 8a: ${state.outsideDir ?? ''}`,
        ]),
    '',
    'Next:',
    ...steps.map((step, index) => `${String(index + 1)}. ${step}`),
  ]
}

export const prepare = async (options: PrepareOptions): Promise<string[]> => {
  requireSupport(options)
  await requireHookSource(options.hookSource)
  const dir = await createEmptyDir(options.dir)
  const layout = checklistLayout(dir)
  const expiresAtSeconds = Math.floor(Date.now() / 1000) + Math.round(options.hours * 3600)
  let state: ChecklistState = {
    version: 1,
    createdAt: new Date().toISOString(),
    platform: process.platform,
    dir,
    leaseExpiresAt: new Date(expiresAtSeconds * 1000).toISOString(),
    claude: { mode: options.claude, command: options.claudeCommand, configDir: null, registered: false },
    codex: null,
    outsideDir: null,
  }
  await writeState(layout, state)
  try {
    await createSpool(layout, expiresAtSeconds)
    const hookBinary = await deployHookBinary({ catacombHome: layout.catacombHome, hookBinarySource: options.hookSource })
    await writeClaudePlugin({ directory: layout.pluginDir, hookBinary, spool: layout.spool })
    await writeProbes(layout)
    await createProbeRepo(layout.probeRepo)
    if (options.claude === 'marketplace') {
      state = await registerClaude(layout, state, options)
    }
    if (options.codexHooks) {
      state = await registerCodex(layout, state, options)
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(
      `prepare aborted: ${reason}\nto roll back what was done, run ${consoleCommand(['node', mainScript, 'cleanup', '--dir', dir])}`,
      { cause: error },
    )
  }
  return memo(layout, state)
}
