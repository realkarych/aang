import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { aangHomePaths, leaseFileName } from '@aang/contract/home'
import { type ClaudeCli, hookInstallPaths, type HookInstallPaths } from '@aang/hook'
import { type ClaudeScenario, type FakeCli, installFakeClaude } from '@aang/testkit'
import type { TestContext } from 'vitest'
import { nowSeconds } from './hook.js'

export interface InstallHome {
  readonly root: string
  readonly aangHome: string
  readonly codexHome: string
  readonly hooksFile: string
  readonly paths: HookInstallPaths
  readonly pluginHooksFile: string
  readonly fakeClaude: (scenario?: ClaudeScenario) => FakeClaude
}

export interface FakeClaude extends FakeCli<ClaudeScenario> {
  readonly cli: ClaudeCli
  readonly argv: () => string[][]
  readonly run: (args: readonly string[]) => Promise<void>
}

const execFileAsync = promisify(execFile)

const unusualHome = join('Имя Фамилия', process.platform === 'win32' ? 'aang home' : "it's $HOME")

export const sampleText = (path: string): Promise<string> =>
  readFile(new URL(`../../../docs/research/samples/${path}`, import.meta.url), 'utf8')

const heldFinishedProcessId = async (onTestFinished: TestContext['onTestFinished']): Promise<number> => {
  const script = `
$heldProcess = New-Object System.Diagnostics.Process
$heldProcess.StartInfo.FileName = $env:AANG_TEST_NODE
$heldProcess.StartInfo.Arguments = '-e "process.exit(0)"'
$heldProcess.StartInfo.UseShellExecute = $false
$heldProcess.StartInfo.CreateNoWindow = $true
$null = $heldProcess.Start()
$heldHandle = $heldProcess.Handle
$heldProcess.WaitForExit()
[Console]::Out.WriteLine($heldProcess.Id)
[Console]::Out.Flush()
$null = [Console]::In.ReadLine()
$heldProcess.Dispose()
`
  const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, AANG_TEST_NODE: process.execPath },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  onTestFinished(async () => {
    if (holder.exitCode === null && holder.signalCode === null) {
      const exited = once(holder, 'exit')
      holder.kill()
      await exited
    }
  })
  const [chunk] = await once(holder.stdout, 'data') as [Buffer]
  const pid = Number(chunk.toString('utf8').trim())
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`invalid finished process id: ${String(pid)}`)
  }
  return pid
}

export const finishedProcessId = async (onTestFinished: TestContext['onTestFinished']): Promise<number> => {
  if (process.platform === 'win32') {
    return heldFinishedProcessId(onTestFinished)
  }
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  await once(child, 'exit')
  if (child.pid === undefined) {
    throw new Error('the finished process has no pid')
  }
  return child.pid
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
  return {
    root,
    aangHome,
    codexHome,
    hooksFile: join(codexHome, 'hooks.json'),
    paths,
    pluginHooksFile: join(paths.claudePlugin, 'hooks', 'hooks.json'),
    fakeClaude: (scenario = {}) => {
      const fake = installFakeClaude(join(root, 'fakes'), scenario)
      return {
        ...fake,
        cli: { command: fake.command, configDir: null },
        argv: () => fake.calls().map((call) => call.argv),
        run: async (args) => {
          await execFileAsync(fake.command, [...fake.args, ...args])
        },
      }
    },
  }
}
