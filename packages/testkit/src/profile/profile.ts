import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Config } from '@catacomb/contract'
import { configFileName } from '@catacomb/contract/config-file'
import { catacombHomePaths } from '@catacomb/contract/home'
import type { z } from 'zod'
import { type DaemonLaunch, launchDaemon, type RunningDaemon } from './daemon.js'
import { type Environment, profileEnvironment } from './environment.js'

export type ConfigInput = z.input<typeof Config>

export type ProfileRoot = 'home' | 'claude' | 'codex' | 'catacomb'

export interface ProfileOptions {
  readonly homeName?: string
  readonly config?: ConfigInput
}

export interface Profile {
  readonly root: string
  readonly home: string
  readonly claude: string
  readonly codex: string
  readonly catacombHome: string
  readonly spool: string
  readonly env: Environment
  readonly configure: (config: ConfigInput) => Promise<void>
  readonly write: (root: ProfileRoot, path: string, content: string | Uint8Array) => Promise<string>
  readonly startDaemon: (launch: DaemonLaunch) => Promise<RunningDaemon>
  readonly dispose: () => Promise<void>
}

const testDefaults: ConfigInput = { api: { port: 0 }, otel: { port: 0 } }

type Plain = Record<string, unknown>

const isPlain = (value: unknown): value is Plain => typeof value === 'object' && value !== null && !Array.isArray(value)

const merge = (base: Plain, override: Plain): Plain =>
  Object.fromEntries(
    [...new Set([...Object.keys(base), ...Object.keys(override)])].map((key) => {
      const [left, right] = [base[key], override[key]]
      return [key, isPlain(left) && isPlain(right) ? merge(left, right) : right === undefined ? left : right]
    }),
  )

const removeTree = (path: string): Promise<void> =>
  rm(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })

const absentClis = (root: string): ConfigInput => ({
  cli: { claude: join(root, 'absent', 'claude'), codex: join(root, 'absent', 'codex') },
})

const serializeConfig = (config: ConfigInput, defaults: ConfigInput = {}): string => {
  const merged = merge(merge(testDefaults, defaults), config)
  Config.parse(merged)
  return `${JSON.stringify(merged, null, 2)}\n`
}

export const createProfile = async ({ homeName = 'home', config = {} }: ProfileOptions = {}): Promise<Profile> => {
  serializeConfig(config)
  const temporary = await mkdtemp(join(tmpdir(), 'catacomb-profile-'))
  try {
    const root = await realpath(temporary)
    const home = join(root, homeName)
    const claude = join(home, '.claude')
    const codex = join(home, '.codex')
    const catacombHome = join(home, '.catacomb')
    const paths = catacombHomePaths(catacombHome)
    const roots: Readonly<Record<ProfileRoot, string>> = { home, claude, codex, catacomb: catacombHome }
    const env = profileEnvironment(process.env, {
      HOME: home,
      USERPROFILE: home,
      CLAUDE_CONFIG_DIR: claude,
      CODEX_HOME: codex,
      CATACOMB_HOME: catacombHome,
    })
    const daemons = new Set<RunningDaemon>()

    const write = async (rootName: ProfileRoot, path: string, content: string | Uint8Array): Promise<string> => {
      const target = join(roots[rootName], ...path.split('/'))
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, content)
      return target
    }

    const configure = async (next: ConfigInput): Promise<void> => {
      await write('catacomb', configFileName, serializeConfig(next, absentClis(root)))
    }

    const stopOrKill = async (daemon: RunningDaemon): Promise<void> => {
      await daemon.stop().catch(() => daemon.kill())
    }

    for (const directory of [claude, codex]) {
      await mkdir(directory, { recursive: true })
    }
    await mkdir(catacombHome, { recursive: true, mode: 0o700 })
    await configure(config)

    return {
      root,
      home,
      claude,
      codex,
      catacombHome,
      spool: paths.spool,
      env,
      configure,
      write,
      startDaemon: async (launch) => {
        const daemon = await launchDaemon(paths, env, launch)
        daemons.add(daemon)
        return daemon
      },
      dispose: async () => {
        await Promise.all([...daemons].map(stopOrKill))
        await removeTree(root)
      },
    }
  } catch (error) {
    await removeTree(temporary)
    throw error
  }
}
