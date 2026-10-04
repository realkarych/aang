import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readdir, readFile, realpath, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { revokeLeases } from '@aang/contract/home'
import {
  type ClaudeCli,
  claudePluginState,
  codexHooksState,
  installClaudePlugin,
  installCodexHooks,
  uninstallClaudePlugin,
  writeClaudePlugin,
} from '@aang/hook'
import { type AgentSdk, runAgentSdk, sdkOutcome } from './agent-sdk.js'
import { claudeOutcome, runClaude } from './claude.js'
import { codexOutcome, type CommandForm, newPatch, runCodex, writeCodexHome } from './codex.js'
import { type ChainLink, type CheckContext, clearProbeLog, probeArgs, type ProbeEntry, readProbeLog } from './context.js'
import { type Launcher, type LatencySummary, measure, strictSeries } from './latency.js'
import { createSpool, filesUnder, runtimeEnv } from './profile.js'
import { excerpt, outcome, run } from './process.js'
import { clearDelivered, countByEvent, type DeliveredEvent, readDelivered } from './spool.js'

const posixQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`

export const aangInstallForm: CommandForm = {
  id: 'aang install (POSIX single quotes)',
  render: (parts) => parts.map(posixQuote).join(' '),
}

const installedCommand = ([binary = '', runtime = '', tag = '', spool = '']: readonly string[]): string =>
  [posixQuote(binary), runtime, tag, posixQuote(spool)].join(' ')

const withProcessEnv = async <T>(env: NodeJS.ProcessEnv, body: () => Promise<T>): Promise<T> => {
  const saved = { ...process.env }
  const replace = (next: NodeJS.ProcessEnv): void => {
    for (const name of Object.keys(process.env)) {
      Reflect.deleteProperty(process.env, name)
    }
    Object.assign(process.env, next)
  }
  replace(env)
  try {
    return await body()
  } finally {
    replace(saved)
  }
}

const isolated = <T>(context: CheckContext, body: () => Promise<T>): Promise<T> =>
  withProcessEnv(runtimeEnv(context.profile, null), body)

const attempt = async <T>(body: () => Promise<T>): Promise<{ readonly value: T | null; readonly error: string | null }> => {
  try {
    return { value: await body(), error: null }
  } catch (error) {
    return { value: null, error: error instanceof Error ? error.message : String(error) }
  }
}

const distinct = (values: readonly (string | undefined)[]): (string | null)[] => [
  ...new Set(values.map((value) => value ?? null)),
]

const deliverySummary = (events: readonly DeliveredEvent[]): Record<string, unknown> => ({
  delivered: events.length,
  byEvent: countByEvent(events),
  registrations: distinct(events.map(({ registration }) => registration)),
  pluginRoots: distinct(events.map(({ env }) => env.CLAUDE_PLUGIN_ROOT)),
  entrypoints: distinct(events.map(({ env }) => env.CLAUDE_CODE_ENTRYPOINT)),
  agentSdkVersions: distinct(events.map(({ env }) => env.CLAUDE_AGENT_SDK_VERSION)),
})

const delivered = async <T>(
  context: CheckContext,
  body: () => Promise<T>,
): Promise<{ readonly value: T; readonly summary: Record<string, unknown> }> => {
  await clearDelivered(context.profile.spool)
  const value = await body()
  const summary = deliverySummary(await readDelivered(context.profile.spool))
  await clearDelivered(context.profile.spool)
  return { value, summary }
}

const initPlugins = (stdout: string): unknown => {
  for (const line of stdout.split(/\r?\n/)) {
    try {
      const value: unknown = JSON.parse(line)
      if (typeof value === 'object' && value !== null && 'subtype' in value && value.subtype === 'init') {
        return 'plugins' in value ? value.plugins : null
      }
    } catch {
      continue
    }
  }
  return null
}

const claudeCliSession = async (context: CheckContext, configDir: string): Promise<Record<string, unknown>> => {
  const { value, summary } = await delivered(context, () => runClaude(context, { steps: 2, configDir }))
  return { session: claudeOutcome(value), initPlugins: initPlugins(value.result.stdout), ...summary }
}

const sdkSession = async (
  context: CheckContext,
  sdk: AgentSdk | null,
  configDir: string,
): Promise<Record<string, unknown>> => {
  if (sdk === null) {
    return { unavailable: 'the Agent SDK was not installed' }
  }
  const { value, summary } = await delivered(context, () => runAgentSdk(context, sdk, configDir, 2))
  return { sdkVersion: sdk.version, session: sdkOutcome(value), ...summary }
}

const claudeCli = (context: CheckContext, configDir: string): ClaudeCli => ({
  command: context.clis.claude.command,
  configDir,
})

const pluginListing = async (context: CheckContext, configDir: string): Promise<unknown> => {
  const listed = await run(context.clis.claude.command, ['plugin', 'list', '--json'], {
    env: { ...runtimeEnv(context.profile, null), CLAUDE_CONFIG_DIR: configDir },
    cwd: context.profile.home,
    timeoutMs: 60_000,
  })
  try {
    const value: unknown = JSON.parse(listed.stdout)
    return Array.isArray(value) ? value : excerpt(listed.stdout)
  } catch {
    return { ...outcome(listed), stdout: excerpt(listed.stdout) }
  }
}

const hookEntry = async (plugin: string): Promise<unknown> => {
  const document = JSON.parse(await readFile(join(plugin, 'hooks', 'hooks.json'), 'utf8')) as {
    readonly hooks: Readonly<Record<string, readonly { readonly hooks: readonly unknown[] }[]>>
  }
  return { events: Object.keys(document.hooks).length, PreToolUse: document.hooks.PreToolUse?.[0]?.hooks[0] ?? null }
}

export const claudeMarketplace = async (
  context: CheckContext,
  hookSource: string,
  sdk: AgentSdk | null,
): Promise<Record<string, unknown>> => {
  const { profile } = context
  const claude = claudeCli(context, profile.claudeConfigDir)
  const options = { aangHome: profile.aangHome, hookBinarySource: hookSource, claude }
  const installation = await isolated(context, () => installClaudePlugin(options))
  const repeated = await attempt(() => isolated(context, () => installClaudePlugin(options)))
  return {
    installation,
    repeatedInstall: { error: repeated.error },
    state: await isolated(context, () => claudePluginState(claude)),
    hookEntry: await hookEntry(installation.plugin),
    pluginList: await pluginListing(context, profile.claudeConfigDir),
    cli: await claudeCliSession(context, profile.claudeConfigDir),
    sdk: await sdkSession(context, sdk, profile.claudeConfigDir),
  }
}

export const claudeSkillsDirectory = async (
  context: CheckContext,
  sdk: AgentSdk | null,
): Promise<Record<string, unknown>> => {
  const { profile } = context
  const configDir = join(profile.home, '.claude-skills-fallback')
  const directory = join(configDir, 'skills', 'aang')
  await writeClaudePlugin({ directory, hookBinary: profile.hook, spool: profile.spool })
  try {
    return {
      configDir,
      plugin: directory,
      hookEntry: await hookEntry(directory),
      pluginList: await pluginListing(context, configDir),
      cli: await claudeCliSession(context, configDir),
      sdk: await sdkSession(context, sdk, configDir),
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

export const claudeRemoval = async (context: CheckContext): Promise<Record<string, unknown>> => {
  const { profile } = context
  const claude = claudeCli(context, profile.claudeConfigDir)
  const removed = await attempt(() => isolated(context, () => uninstallClaudePlugin({ aangHome: profile.aangHome, claude })))
  const repeated = await attempt(() => isolated(context, () => uninstallClaudePlugin({ aangHome: profile.aangHome, claude })))
  return {
    uninstall: { error: removed.error },
    repeatedUninstall: { error: repeated.error },
    state: await isolated(context, () => claudePluginState(claude)),
    pluginDirectoryRemoved: !existsSync(join(profile.aangHome, 'claude-plugin')),
    cli: await claudeCliSession(context, profile.claudeConfigDir),
  }
}

const fileHash = async (path: string): Promise<string | null> => {
  try {
    return createHash('sha256').update(await readFile(path)).digest('hex')
  } catch {
    return null
  }
}

const shellLauncher = (link: ChainLink, probeCommand: string, command: string): Launcher | null => {
  const id = 'codex account shell'
  const index = link.argv?.indexOf(probeCommand) ?? -1
  if (link.argv !== null && index > 0) {
    const [shell = '', ...flags] = link.argv.slice(0, index)
    return { id, command: shell, args: [...flags, command], verbatim: false }
  }
  if (link.commandLine?.endsWith(` ${probeCommand}`) === true) {
    const [shell = '', ...flags] = link.commandLine.slice(0, -probeCommand.length).trim().split(' ')
    return { id, command: shell, args: [...flags, command], verbatim: false }
  }
  return null
}

const trimChain = (chain: ProbeEntry['chain'], runtime: string): unknown => {
  if (!Array.isArray(chain)) {
    return chain ?? null
  }
  const links = chain as readonly ChainLink[]
  const index = links.findIndex(({ name }) => basename(name ?? '').toLowerCase().includes(runtime) || (name ?? '').includes(`/${runtime}/`))
  return (index < 0 ? links : links.slice(0, index + 1)).map(({ name, commandLine, argv }) => ({ name, commandLine, argv }))
}

export const trimProbes = (report: Readonly<Record<string, unknown>>, runtime: string): Record<string, unknown> => ({
  ...report,
  probes: Array.isArray(report.probes)
    ? (report.probes as ProbeEntry[]).map((probe) => ({ ...probe, chain: trimChain(probe.chain, runtime) }))
    : report.probes,
})

export interface CodexInstallation {
  readonly report: Record<string, unknown>
  readonly launcher: Launcher | null
}

const codexShellProbe = async (context: CheckContext): Promise<{ readonly entry: ProbeEntry | null; readonly probeCommand: string }> => {
  const { probe } = context
  const label = 'codex-account-shell'
  await clearProbeLog(probe)
  const probeCommand = `${aangInstallForm.render([probe.node, ...probeArgs(probe, label, ['chain'])])}; true`
  const home = join(context.work, 'codex-account-shell')
  await writeCodexHome(context, home, { SessionStart: [{ command: probeCommand, timeout: 60 }] })
  await runCodex(context, { home, steps: [] })
  const entry = (await readProbeLog(probe)).find((candidate) => candidate.label === label && Array.isArray(candidate.chain))
  return { entry: entry ?? null, probeCommand }
}

export const codexInstallation = async (context: CheckContext, hookSource: string): Promise<CodexInstallation> => {
  const { profile } = context
  const home = join(context.work, 'codex-installed')
  await writeCodexHome(context, home, null)
  const options = { aangHome: profile.aangHome, hookBinarySource: hookSource, codexHome: home, codex: { command: context.clis.codex.command } }
  const installation = await isolated(context, () => installCodexHooks(options))
  const hooksFile = join(home, 'hooks.json')
  const hashBefore = await fileHash(hooksFile)
  const repeated = await attempt(() => isolated(context, () => installCodexHooks(options)))
  const hashAfter = await fileHash(hooksFile)
  const state = await attempt(() => isolated(context, () => codexHooksState({ aangHome: profile.aangHome, codexHome: home, codex: options.codex })))
  const patch = newPatch(context, 'installed')
  const session = await delivered(context, () => runCodex(context, { home, steps: [patch.step] }))
  const { entry, probeCommand } = await codexShellProbe(context)
  const shell = entry !== null && Array.isArray(entry.chain) ? (entry.chain as readonly ChainLink[])[0] ?? null : null
  const launcher =
    shell === null ? null : shellLauncher(shell, probeCommand, installedCommand([profile.hook, 'codex', 'user', '<spool>']))
  return {
    report: {
      installation,
      commandMatchesMeasuredForm:
        installation.command === installedCommand([profile.hook, 'codex', 'user', profile.spool]),
      repeatedInstall: {
        error: repeated.error,
        commandUnchanged: repeated.value?.command === installation.command,
        hooksFileUnchanged: hashBefore !== null && hashBefore === hashAfter,
      },
      state: state.error === null
        ? { status: state.value?.status, trust: state.value?.hooks.map(({ eventName, trustStatus, enabled }) => ({ eventName, trustStatus, enabled })), warnings: state.value?.warnings }
        : { error: state.error },
      session: { ...codexOutcome(session.value), patchApplied: existsSync(patch.file), ...session.summary },
      accountShell: {
        probeCommand,
        chain: entry === null ? null : trimChain(entry.chain, 'codex'),
        launcher: launcher === null ? null : [launcher.command, ...launcher.args],
      },
    },
    launcher,
  }
}

interface LatencyInputs {
  readonly claudeProbes: readonly ProbeEntry[]
  readonly codexLauncher: Launcher | null
}

const withSpool = (launcher: Launcher, spool: string): Launcher => ({
  ...launcher,
  args: launcher.args.map((argument) => argument.replace(posixQuote('<spool>'), posixQuote(spool))),
})

export const installedLatency = async (context: CheckContext, inputs: LatencyInputs): Promise<Record<string, unknown>> => {
  const execForm = inputs.claudeProbes.find(({ label, chain }) => label === 'claude-exec-form' && Array.isArray(chain))
  if (execForm === undefined || inputs.codexLauncher === null) {
    return { unavailable: 'runtime launchers were not observed; the installed configuration cannot be measured' }
  }
  const { profile } = context
  const spool = join(profile.aangHome, 'spool-installed-latency')
  await createSpool(spool)
  const unleased = join(profile.aangHome, 'spool-installed-latency-unleased')
  await createSpool(unleased)
  await revokeLeases(unleased)
  const direct = (args: readonly string[], target: string): Promise<LatencySummary> =>
    measure({ id: 'direct spawn', command: profile.hook, args, verbatim: false }, target, strictSeries)
  return {
    series: strictSeries,
    claudeExecFormParent: trimChain(execForm.chain, 'claude'),
    'claude: aang-hook started directly (exec form)': await direct(['claude', 'plugin', spool], spool),
    'claude: aang-hook without a lease (no spool write)': await direct(['claude', 'plugin', unleased], unleased),
    'codex: installed command through the account shell': await measure(
      withSpool(inputs.codexLauncher, spool),
      spool,
      strictSeries,
    ),
    'codex: aang-hook alone': await direct(['codex', 'user', spool], spool),
  }
}

interface ProfileFile {
  readonly path: string
  readonly sha256: string | null
}

export interface UserProfileSnapshot {
  readonly startedAt: number
  readonly claudeRoot: string
  readonly codexRoot: string
  readonly files: readonly ProfileFile[]
  readonly skills: readonly string[]
}

const userRoots = (): { readonly claudeRoot: string; readonly codexRoot: string } => ({
  claudeRoot: process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
  codexRoot: process.env.CODEX_HOME ?? join(homedir(), '.codex'),
})

const watchedFiles = (claudeRoot: string, codexRoot: string): string[] => [
  join(claudeRoot, 'settings.json'),
  join(claudeRoot, 'settings.local.json'),
  join(claudeRoot, 'plugins', 'known_marketplaces.json'),
  join(claudeRoot, 'plugins', 'installed_plugins.json'),
  join(codexRoot, 'hooks.json'),
  join(codexRoot, 'config.toml'),
  join(codexRoot, 'auth.json'),
]

const names = async (directory: string): Promise<string[]> => {
  try {
    return (await readdir(directory)).sort()
  } catch {
    return []
  }
}

export const snapshotUserProfile = async (): Promise<UserProfileSnapshot> => {
  const { claudeRoot, codexRoot } = userRoots()
  return {
    startedAt: Date.now(),
    claudeRoot,
    codexRoot,
    files: await Promise.all(
      watchedFiles(claudeRoot, codexRoot).map(async (path) => ({ path, sha256: await fileHash(path) })),
    ),
    skills: await names(join(claudeRoot, 'skills')),
  }
}

const mentions = async (path: string, needles: readonly string[]): Promise<boolean> => {
  try {
    const text = await readFile(path, 'utf8')
    return needles.some((needle) => text.includes(needle))
  } catch {
    return false
  }
}

const recentRollouts = async (codexRoot: string, since: number): Promise<string[]> => {
  const rollouts = (await filesUnder(join(codexRoot, 'sessions'))).filter((file) => file.endsWith('.jsonl'))
  const recent: string[] = []
  for (const file of rollouts) {
    if ((await stat(file)).mtimeMs >= since) {
      recent.push(file)
    }
  }
  return recent
}

export const compareUserProfile = async (
  before: UserProfileSnapshot,
  work: string,
): Promise<Record<string, unknown>> => {
  const after = await snapshotUserProfile()
  const needles = [work, await realpath(work)]
  const marker = basename(work).replace(/[^a-zA-Z0-9]/g, '-')
  const touchedRollouts: string[] = []
  for (const file of await recentRollouts(before.codexRoot, before.startedAt)) {
    if (await mentions(file, needles)) {
      touchedRollouts.push(file)
    }
  }
  return {
    claudeRoot: before.claudeRoot,
    codexRoot: before.codexRoot,
    checkedFiles: before.files.map(({ path, sha256 }) => ({ path, present: sha256 !== null })),
    changedFiles: before.files
      .filter(({ path, sha256 }) => after.files.find((file) => file.path === path)?.sha256 !== sha256)
      .map(({ path }) => path),
    skillsAdded: after.skills.filter((name) => !before.skills.includes(name)),
    projectDirectoriesForWork: (await names(join(before.claudeRoot, 'projects'))).filter((name) => name.includes(marker)),
    claudeJsonMentionsWork: await mentions(join(homedir(), '.claude.json'), needles),
    rolloutsForWork: touchedRollouts,
  }
}
