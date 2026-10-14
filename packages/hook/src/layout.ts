import { join, resolve } from 'node:path'
import { catacombHomePaths } from '@catacomb/contract/home'

export const hookBinaryName = process.platform === 'win32' ? 'catacomb-hook.exe' : 'catacomb-hook'

export interface HookInstallPaths {
  readonly binary: string
  readonly claudePlugin: string
  readonly codexHooksRecord: string
  readonly spool: string
}

export const hookInstallPaths = (catacombHome: string): HookInstallPaths => {
  const home = resolve(catacombHome)
  return {
    binary: join(home, 'bin', hookBinaryName),
    claudePlugin: join(home, 'claude-plugin'),
    codexHooksRecord: join(home, 'codex-hooks.json'),
    spool: catacombHomePaths(home).spool,
  }
}
