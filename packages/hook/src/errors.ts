export type HookInstallFailure = 'unsupported_platform' | 'claude_cli' | 'invalid_hooks_file'

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

export const requireHookInstallSupport = (): void => {
  if (process.platform === 'win32') {
    throw new HookInstallError(
      'unsupported_platform',
      'installing hooks on Windows is not enabled yet: the hook command form for Windows runtimes is unverified',
    )
  }
}
