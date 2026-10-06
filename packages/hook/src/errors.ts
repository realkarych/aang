export type HookInstallFailure =
  | 'claude_cli'
  | 'invalid_hooks_file'
  | 'hooks_file_changed'
  | 'install_locked'
  | 'codex_app_server'
  | 'foreign_hook_trust_changed'

export class HookInstallError extends Error {
  constructor(
    readonly reason: HookInstallFailure,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'HookInstallError'
  }
}
