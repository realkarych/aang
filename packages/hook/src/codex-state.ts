import { listCodexHooks, type CodexAppServerOptions, type CodexHookEntry, type CodexHookListing } from './codex-app-server.js'
import { codexHookCommand, isCatacombCommand } from './codex-command.js'
import type { CodexHooksStatus } from './codex-files.js'
import { HookInstallError } from './errors.js'
import { hookInstallPaths } from './layout.js'

export interface CodexHooksStateOptions extends CodexAppServerOptions {
  readonly catacombHome: string
}

export interface CodexHooksState extends CodexHookListing {
  readonly status: CodexHooksStatus
  readonly stale: readonly CodexHookEntry[]
}

const isCatacombHook = (hook: CodexHookEntry): boolean => hook.handlerType === 'command' && isCatacombCommand(hook.command ?? '')

export const codexHooksStateOf = (listing: CodexHookListing, catacombHome: string): CodexHooksState => {
  const command = codexHookCommand(catacombHome)
  const catacomb = listing.hooks.filter(isCatacombHook)
  const hooks = catacomb.filter((hook) => hook.command === command)
  const status = hooks.length === 0
    ? 'not_installed'
    : hooks.some((hook) => hook.trustStatus !== 'trusted')
      ? 'untrusted'
      : hooks.some((hook) => !hook.enabled)
        ? 'inactive'
        : 'active'
  return { ...listing, hooks, stale: catacomb.filter((hook) => hook.command !== command), status }
}

export const codexHooksState = async ({ catacombHome, ...options }: CodexHooksStateOptions): Promise<CodexHooksState> =>
  codexHooksStateOf(await listCodexHooks(options, hookInstallPaths(catacombHome).binary), catacombHome)

export const verifyForeignTrust = (before: CodexHookListing, after: CodexHookListing): void => {
  const updated = new Map(after.hooks.map((hook) => [hook.key, hook]))
  const changed = before.hooks.filter((hook) => !isCatacombHook(hook) && updated.get(hook.key)?.trustStatus !== hook.trustStatus)
  if (changed.length > 0) {
    throw new HookInstallError('foreign_hook_trust_changed', `foreign hook trust changed: ${changed.map((hook) => hook.key).join(', ')}`)
  }
}
