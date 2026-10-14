import { mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { RegistrationTag, Runtime } from '@catacomb/contract'
import { deployHookBinary } from './binary.js'
import { type ClaudeCli, type ClaudeCompleted, listPlugins, type PluginListing, pluginListingOf, runPluginCommand } from './claude-cli.js'
import { jsonText, readIfReadable, replaceFile } from './files.js'
import { hookInstallPaths } from './layout.js'

const claudeHookEvents = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PostToolBatch',
  'Notification',
  'UserPromptSubmit',
  'UserPromptExpansion',
  'SessionStart',
  'SessionEnd',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'PostModelSwitch',
  'PermissionRequest',
  'PermissionDenied',
  'Setup',
  'TeammateIdle',
  'TaskCreated',
  'TaskCompleted',
  'Elicitation',
  'ElicitationResult',
  'ConfigChange',
  'InstructionsLoaded',
  'CwdChanged',
  'FileChanged',
  'DirectoryAdded',
] as const

const runtime: Runtime = 'claude'
const registration: RegistrationTag = 'plugin'
const hookTimeoutSeconds = 2
const scope = 'user'
export const claudePluginName = 'catacomb'
const marketplaceName = 'catacomb'
const author = { name: 'catacomb' }
const description = 'Records Claude Code hook events into the catacomb spool'

export const claudePluginId = `${claudePluginName}@${marketplaceName}`

export interface ClaudePluginFiles {
  readonly directory: string
  readonly hookBinary: string
  readonly spool: string
}

export interface ClaudePluginInstallOptions {
  readonly catacombHome: string
  readonly hookBinarySource: string
  readonly claude: ClaudeCli
}

export interface ClaudePluginUninstallOptions {
  readonly catacombHome: string
  readonly claude: ClaudeCli
}

export interface ClaudePluginInstallation {
  readonly binary: string
  readonly plugin: string
}

export type ClaudePluginState = 'not_installed' | 'disabled' | 'enabled'

const hooksDocument = (hookBinary: string, spool: string): unknown => ({
  hooks: Object.fromEntries(
    claudeHookEvents.map((event) => [
      event,
      [
        {
          matcher: '',
          hooks: [
            { type: 'command', command: hookBinary, args: [runtime, registration, spool], timeout: hookTimeoutSeconds },
          ],
        },
      ],
    ]),
  ),
})

const pluginFiles = ({ directory, hookBinary, spool }: ClaudePluginFiles): readonly (readonly [string, unknown])[] => [
  [join(directory, '.claude-plugin', 'plugin.json'), { name: claudePluginName, version: '1.0.0', description, author }],
  [
    join(directory, '.claude-plugin', 'marketplace.json'),
    {
      name: marketplaceName,
      owner: author,
      description,
      plugins: [{ name: claudePluginName, source: './', description }],
    },
  ],
  [join(directory, 'hooks', 'hooks.json'), hooksDocument(hookBinary, spool)],
]

const writeIfChanged = async (path: string, content: string): Promise<void> => {
  if ((await readIfReadable(path))?.toString('utf8') === content) {
    return
  }
  await mkdir(dirname(path), { recursive: true })
  await replaceFile(path, content, 0o644)
}

export const writeClaudePlugin = async (files: ClaudePluginFiles): Promise<void> => {
  for (const [path, document] of pluginFiles(files)) {
    await writeIfChanged(path, jsonText(document))
  }
}

export const installClaudePlugin = async ({
  catacombHome,
  hookBinarySource,
  claude,
}: ClaudePluginInstallOptions): Promise<ClaudePluginInstallation> => {
  const paths = hookInstallPaths(catacombHome)
  const binary = await deployHookBinary({ catacombHome, hookBinarySource })
  await writeClaudePlugin({ directory: paths.claudePlugin, hookBinary: binary, spool: paths.spool })
  await runPluginCommand(claude, ['marketplace', 'add', paths.claudePlugin, '--scope', scope])
  await runPluginCommand(claude, ['install', claudePluginId, '--scope', scope])
  return { binary, plugin: paths.claudePlugin }
}

export const uninstallClaudePlugin = async ({ catacombHome, claude }: ClaudePluginUninstallOptions): Promise<void> => {
  await runPluginCommand(claude, ['uninstall', claudePluginId, '--scope', scope], ['not_installed'])
  await runPluginCommand(claude, ['marketplace', 'remove', marketplaceName, '--scope', scope], ['not_configured'])
  await rm(hookInstallPaths(catacombHome).claudePlugin, { recursive: true, force: true })
}

const pluginStateIn = (listing: PluginListing): ClaudePluginState => {
  const installed = listing.filter((plugin) => plugin.id === claudePluginId)
  if (installed.length === 0) {
    return 'not_installed'
  }
  return installed.some((plugin) => plugin.enabled) ? 'enabled' : 'disabled'
}

export const claudePluginState = async (claude: ClaudeCli): Promise<ClaudePluginState> =>
  pluginStateIn(await listPlugins(claude))

export const claudePluginStateOf = (completed: ClaudeCompleted): ClaudePluginState =>
  pluginStateIn(pluginListingOf(completed))
