import { listCodexHooks, type CodexAppServerOptions, type CodexHookEntry, type CodexHookListing } from './codex-app-server.js'
import { codexHookCommand, isAangCommand } from './codex-command.js'
import { HookInstallError } from './errors.js'
import { hookInstallPaths } from './layout.js'

export interface CodexHooksStateOptions extends CodexAppServerOptions {
  readonly aangHome: string
}

export interface CodexHooksState extends CodexHookListing {
  readonly status: 'not_installed' | 'untrusted' | 'inactive' | 'active'
  readonly stale: readonly CodexHookEntry[]
}

const isAangHook = (hook: CodexHookEntry): boolean => hook.handlerType === 'command' && isAangCommand(hook.command ?? '')

export const codexHooksState = async ({ aangHome, ...options }: CodexHooksStateOptions): Promise<CodexHooksState> => {
  const listing = await listCodexHooks(options, hookInstallPaths(aangHome).binary)
  const command = codexHookCommand(aangHome)
  const aang = listing.hooks.filter(isAangHook)
  const hooks = aang.filter((hook) => hook.command === command)
  const status = hooks.length === 0
    ? 'not_installed'
    : hooks.some((hook) => hook.trustStatus !== 'trusted')
      ? 'untrusted'
      : hooks.some((hook) => !hook.enabled)
        ? 'inactive'
        : 'active'
  return { ...listing, hooks, stale: aang.filter((hook) => hook.command !== command), status }
}

export const verifyForeignTrust = (before: CodexHookListing, after: CodexHookListing): void => {
  const updated = new Map(after.hooks.map((hook) => [hook.key, hook]))
  const changed = before.hooks.filter((hook) => !isAangHook(hook) && updated.get(hook.key)?.trustStatus !== hook.trustStatus)
  if (changed.length > 0) {
    throw new HookInstallError('foreign_hook_trust_changed', `foreign hook trust changed: ${changed.map((hook) => hook.key).join(', ')}`)
  }
}
