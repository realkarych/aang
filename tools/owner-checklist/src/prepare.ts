import { execFile } from 'node:child_process'
import { mkdir, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { leaseFileName } from '@aang/contract/home'
import {
  type ClaudeCli,
  claudePluginId,
  claudePluginState,
  deployHookBinary,
  installClaudePlugin,
  writeClaudePlugin,
} from '@aang/hook'
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
    throw new Error('на Windows продуктовая установка плагина закрыта (ADR-0013); используйте --claude plugin-dir')
  }
  if (options.codexHooks) {
    throw new Error('--codex-hooks нужен только для Codex Desktop на macOS; Desktop на Windows в MVP не проверяется (ADR-0013, решение 3)')
  }
}

const requireHookSource = async (path: string): Promise<void> => {
  const isFile = await stat(path).then(
    (stats) => stats.isFile(),
    () => false,
  )
  if (!isFile) {
    throw new Error(`aang-hook не найден: ${path}; соберите репозиторий командой pnpm build или укажите --hook`)
  }
}

const createEmptyDir = async (dir: string): Promise<string> => {
  try {
    if ((await readdir(dir)).length > 0) {
      throw new Error(`${dir} не пуст: выберите другой --dir или откатите прошлую подготовку командой cleanup`)
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
      throw new Error(`${dir} уже существует и не пуст: для шага 8a нужен пустой каталог`)
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
          'aang D.7: hook hangs longer than its 2 s timeout',
        ),
      ],
    }),
  )
}

const gitEnvironment = (): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('GIT_')))

const createProbeRepo = async (repo: string): Promise<void> => {
  await mkdir(repo, { recursive: true })
  await writeFile(join(repo, 'README.md'), '# aang D.7 probe repository\n')
  const git = (args: readonly string[]): Promise<unknown> =>
    execFileAsync('git', args, { cwd: repo, env: gitEnvironment(), windowsHide: true })
  await git(['init', '--quiet', '--initial-branch=main'])
  await git(['add', 'README.md'])
  await git([
    '-c',
    'user.name=aang D.7',
    '-c',
    'user.email=aang-d7@localhost',
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
      `плагин ${claudePluginId} уже есть в пользовательских настройках Claude (${current}); удалите его или используйте --claude plugin-dir`,
    )
  }
  const registered: ChecklistState = { ...state, claude: { ...state.claude, configDir: cli.configDir, registered: true } }
  await writeState(layout, registered)
  await installClaudePlugin({ aangHome: layout.aangHome, hookBinarySource: options.hookSource, claude: cli })
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
    `TUI Claude, пункты (a)–(c), (e)–(g), в пробном репозитории:\n   ${consoleCommand(['cd', layout.probeRepo])}\n   ${claudeLaunch(layout, state, layout.envSettings)}`,
    `Пункт (d), отдельная сессия там же:\n   ${claudeLaunch(layout, state, layout.failureSettings)}`,
    `Пункт (h), сессия в режиме плана:\n   ${claudeLaunch(layout, state, layout.envSettings, ['--permission-mode', 'plan'])}`,
    ...(state.claude.mode === 'marketplace'
      ? ['Claude Desktop: перезапустите приложение и откройте новую сессию Code в пробном репозитории.']
      : []),
    ...(codex === null ? [] : ['Codex Desktop: перезапустите приложение и подтвердите доверие hooks aang в его интерфейсе.']),
    `Сбор результатов: ${tool('collect')}`,
    `Откат: ${tool('cleanup')} (с --keep-results каталог results/ останется)`,
  ]
  return [
    `Рабочий каталог чек-листа подготовлен: ${layout.dir}`,
    `- aang-hook: ${layout.hookBinary}`,
    `- spool: ${layout.spool}, аренда до ${state.leaseExpiresAt}`,
    `- плагин Claude: ${layout.pluginDir}`,
    `- пробный репозиторий: ${layout.probeRepo}`,
    `- зонды: ${layout.envSettings}, ${layout.failureSettings}`,
    state.claude.mode === 'marketplace'
      ? `- Claude: плагин ${claudePluginId} установлен в пользовательский scope через локальный маркетплейс; cleanup его удалит`
      : '- Claude: пользовательские настройки не менялись, плагин подключается флагом --plugin-dir',
    ...(codex === null
      ? []
      : [
          `- Codex: записи aang дописаны в конец массивов ${codex.hooksFile}; ${codex.backup === null ? 'файл создан заново' : `резервная копия ${codex.backup}`}`,
          `- каталог для шага 8a: ${state.outsideDir ?? ''}`,
        ]),
    '',
    'Дальше:',
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
    const hookBinary = await deployHookBinary({ aangHome: layout.aangHome, hookBinarySource: options.hookSource })
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
      `подготовка прервана: ${reason}\nсделанное откатывает ${consoleCommand(['node', mainScript, 'cleanup', '--dir', dir])}`,
      { cause: error },
    )
  }
  return memo(layout, state)
}
