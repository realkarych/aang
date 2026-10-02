import { listCodexHooks, type CodexAppServerOptions, type CodexHookListing } from './codex-app-server.js'
import { isAangCommand } from './codex-command.js'
import { HookInstallError } from './errors.js'

export interface CodexHooksState extends CodexHookListing {
  readonly status: 'not_installed' | 'untrusted' | 'inactive' | 'active'
}

export const codexHooksState = async (options: CodexAppServerOptions): Promise<CodexHooksState> => {
  const listing = await listCodexHooks(options)
  const hooks = listing.hooks.filter((hook) => hook.handlerType === 'command' && isAangCommand(hook.command ?? ''))
  const status = hooks.length === 0
    ? 'not_installed'
    : hooks.some((hook) => hook.trustStatus !== 'trusted')
      ? 'untrusted'
      : hooks.some((hook) => !hook.enabled)
        ? 'inactive'
        : 'active'
  return { ...listing, hooks, status }
}

export const verifyForeignTrust = (before: CodexHookListing, after: CodexHookListing): void => {
  const updated = new Map(after.hooks.map((hook) => [hook.key, hook]))
  const changed = before.hooks.filter((hook) =>
    !(hook.handlerType === 'command' && isAangCommand(hook.command ?? '')) &&
    updated.get(hook.key)?.trustStatus !== hook.trustStatus,
  )
  if (changed.length > 0) {
    throw new HookInstallError('foreign_hook_trust_changed', `foreign hook trust changed: ${changed.map((hook) => hook.key).join(', ')}`)
  }
}
