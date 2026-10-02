import { join, resolve } from 'node:path'
import { aangHomePaths } from '@aang/contract/home'

export const hookBinaryName = process.platform === 'win32' ? 'aang-hook.exe' : 'aang-hook'

export interface HookInstallPaths {
  readonly binary: string
  readonly claudePlugin: string
  readonly spool: string
}

export const hookInstallPaths = (aangHome: string): HookInstallPaths => {
  const home = resolve(aangHome)
  return {
    binary: join(home, 'bin', hookBinaryName),
    claudePlugin: join(home, 'claude-plugin'),
    spool: aangHomePaths(home).spool,
  }
}
