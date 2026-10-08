import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { aangHomePaths, leaseFileName } from '@aang/contract/home'
import { type ClaudeCli, hookInstallPaths, type HookInstallPaths } from '@aang/hook'
import { type ClaudeScenario, type FakeCli, installFakeClaude } from '@aang/testkit'
import type { TestContext } from 'vitest'
import { nowSeconds } from './hook.js'
import { fakeAppServer } from './app-server.js'

export interface InstallHome {
  readonly root: string
  readonly aangHome: string
  readonly codexHome: string
  readonly hooksFile: string
  readonly paths: HookInstallPaths
  readonly pluginHooksFile: string
  readonly fakeClaude: (scenario?: ClaudeScenario) => FakeClaude
  readonly codex: Awaited<ReturnType<typeof fakeAppServer>>
}

export interface FakeClaude extends FakeCli<ClaudeScenario> {
  readonly cli: ClaudeCli
  readonly argv: () => string[][]
  readonly run: (args: readonly string[]) => Promise<void>
}

const execFileAsync = promisify(execFile)

const unusualHome = join('Имя Фамилия', "it's $HOME")

export const sampleText = (path: string): Promise<string> =>
  readFile(new URL(`../../../docs/research/samples/${path}`, import.meta.url), 'utf8')

export const absentProcessId = (): number => {
  const pid = 2_147_483_647
  try {
    process.kill(pid, 0)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
      return pid
    }
    throw error
  }
  throw new Error(`the absent lock owner ${String(pid)} is running`)
}

export const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, 'utf8')) as unknown

const leaseSpool = async (aangHome: string): Promise<void> => {
  const paths = aangHomePaths(aangHome)
  await mkdir(paths.spoolReady, { recursive: true })
  await mkdir(paths.spoolTemporary, { recursive: true })
  await writeFile(join(paths.spool, leaseFileName(nowSeconds() + 3600)), '')
}

export const createInstallHome = async (onTestFinished: TestContext['onTestFinished']): Promise<InstallHome> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aang-install-')))
  onTestFinished(() => rm(root, { recursive: true, force: true, maxRetries: 5 }))
  const aangHome = join(root, unusualHome)
  const codexHome = join(root, 'codex home')
  await mkdir(codexHome, { recursive: true })
  await leaseSpool(aangHome)
  const paths = hookInstallPaths(aangHome)
  const home = {
    root,
    aangHome,
    codexHome,
    hooksFile: join(codexHome, 'hooks.json'),
    paths,
    pluginHooksFile: join(paths.claudePlugin, 'hooks', 'hooks.json'),
    fakeClaude: (scenario: ClaudeScenario = {}) => {
      const fake = installFakeClaude(join(root, 'fakes'), scenario)
      return {
        ...fake,
        cli: { command: fake.executable, configDir: null },
        argv: () => fake.calls().map((call) => call.argv),
        run: async (args: readonly string[]) => {
          await execFileAsync(fake.command, [...fake.args, ...args])
        },
      }
    },
  }
  return { ...home, codex: await fakeAppServer(home) }
}
