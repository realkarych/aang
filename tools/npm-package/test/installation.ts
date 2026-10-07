import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Completed, npm, run } from '../dist/index.js'

export type Command = 'aang' | 'aang-hook'

export interface CommandOptions {
  readonly env?: NodeJS.ProcessEnv
  readonly input?: string
}

export interface Installation {
  readonly root: string
  readonly packageDirectory: string
  readonly run: (command: Command, args: readonly string[], options?: CommandOptions) => Promise<Completed>
  readonly remove: () => Promise<void>
}

const windows = process.platform === 'win32'

const npmEnvironment = (root: string): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^npm_(?:config|package)_/i.test(name))),
  npm_config_userconfig: join(root, 'npmrc'),
  npm_config_cache: join(root, 'npm-cache'),
  npm_config_update_notifier: 'false',
  npm_config_audit: 'false',
  npm_config_fund: 'false',
})

export type InstallScope = 'global' | 'project'

interface Layout {
  readonly packageDirectory: string
  readonly bin: (command: Command) => string
}

const globalLayout = (prefix: string): Layout => ({
  packageDirectory: windows ? join(prefix, 'node_modules', 'aang') : join(prefix, 'lib', 'node_modules', 'aang'),
  bin: (command) => (windows ? join(prefix, `${command}.cmd`) : join(prefix, 'bin', command)),
})

const projectLayout = (prefix: string): Layout => ({
  packageDirectory: join(prefix, 'node_modules', 'aang'),
  bin: (command) => join(prefix, 'node_modules', '.bin', windows ? `${command}.cmd` : command),
})

export const install = async (
  registry: string,
  scope: InstallScope,
  flags: readonly string[] = [],
): Promise<Installation> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aang-npm-install-')))
  const remove = (): Promise<void> => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  const prefix = join(root, 'prefix')
  try {
    await mkdir(prefix)
    const scopeFlags = scope === 'global' ? ['--global'] : []
    await npm(['install', ...scopeFlags, '--prefix', prefix, '--registry', registry, ...flags, 'aang'], {
      cwd: root,
      env: npmEnvironment(root),
    })
  } catch (error) {
    await remove()
    throw error
  }
  const { packageDirectory, bin } = scope === 'global' ? globalLayout(prefix) : projectLayout(prefix)
  return {
    root,
    packageDirectory,
    run: (command, args, { env = process.env, input } = {}) =>
      run(bin(command), args, { cwd: root, env, ...(input === undefined ? {} : { input }) }),
    remove,
  }
}
