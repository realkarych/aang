import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Config } from '@aang/contract'
import { configFileName } from '@aang/contract/config-file'
import { aangHomePaths } from '@aang/contract/home'
import type { z } from 'zod'
import { type DaemonLaunch, launchDaemon, type RunningDaemon } from './daemon.js'
import { type Environment, profileEnvironment } from './environment.js'

export type ConfigInput = z.input<typeof Config>

export type ProfileRoot = 'home' | 'claude' | 'codex' | 'aang'

export interface ProfileOptions {
  readonly homeName?: string
  readonly config?: ConfigInput
}

export interface Profile {
  readonly root: string
  readonly home: string
  readonly claude: string
  readonly codex: string
  readonly aangHome: string
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

export const createProfile = async ({ homeName = 'home', config = {} }: ProfileOptions = {}): Promise<Profile> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aang-profile-')))
  const home = join(root, homeName)
  const claude = join(home, '.claude')
  const codex = join(home, '.codex')
  const aangHome = join(home, '.aang')
  const paths = aangHomePaths(aangHome)
  const roots: Readonly<Record<ProfileRoot, string>> = { home, claude, codex, aang: aangHome }
  const env = profileEnvironment(process.env, {
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: claude,
    CODEX_HOME: codex,
    AANG_HOME: aangHome,
  })
  const daemons = new Set<RunningDaemon>()

  const write = async (rootName: ProfileRoot, path: string, content: string | Uint8Array): Promise<string> => {
    const target = join(roots[rootName], ...path.split('/'))
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
    return target
  }

  const configure = async (next: ConfigInput): Promise<void> => {
    const merged = merge(testDefaults, next)
    Config.parse(merged)
    await write('aang', configFileName, `${JSON.stringify(merged, null, 2)}\n`)
  }

  const stopOrKill = async (daemon: RunningDaemon): Promise<void> => {
    await daemon.stop().catch(() => daemon.kill())
  }

  for (const directory of [claude, codex]) {
    await mkdir(directory, { recursive: true })
  }
  await mkdir(aangHome, { recursive: true, mode: 0o700 })
  await configure(config)

  return {
    root,
    home,
    claude,
    codex,
    aangHome,
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
}
