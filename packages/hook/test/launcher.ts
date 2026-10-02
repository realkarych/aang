import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Writable } from 'node:stream'
import { setTimeout } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { inject, type TestContext } from 'vitest'
import { hookEnvironment } from './hook.js'

export type TreeMode = 'echo' | 'orphan' | 'hold'

export type TreeProcess = 'root' | 'descendant' | 'launcher'

export interface Launch {
  readonly stdin: Writable
  readonly closed: Promise<number | null>
  readonly stdout: () => Buffer
  readonly stderr: () => string
  readonly kill: () => Promise<void>
}

export interface LaunchSandbox {
  readonly directory: string
  readonly statusPath: string
  readonly command: (mode: TreeMode, ...args: readonly string[]) => string[]
  readonly launch: (args: readonly string[], env?: Readonly<Record<string, string>>) => Launch
  readonly launchFromParent: (args: readonly string[]) => Launch
  readonly pid: (name: TreeProcess) => Promise<number>
  readonly status: () => Promise<unknown>
  readonly report: () => Promise<unknown>
}

const processTree = fileURLToPath(new URL('process-tree.ts', import.meta.url))

const pidSuffix = '.pid'

export const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM'
  }
}

export const waitUntil = async (condition: () => boolean, timeoutMs = 20_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`condition not met within ${String(timeoutMs)} ms`)
    }
    await setTimeout(25)
  }
}

const isMissingProcess = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ESRCH'

const terminate = (pid: number): void => {
  try {
    process.kill(pid)
  } catch (error) {
    if (!isMissingProcess(error)) {
      throw error
    }
  }
}

const track = (child: ChildProcessWithoutNullStreams): Launch => {
  const output: Buffer[] = []
  let errors = ''
  child.stdin.on('error', () => undefined)
  child.stdout.on('data', (chunk: Buffer) => output.push(chunk))
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    errors += chunk
  })
  const closed = (once(child, 'close') as Promise<[number | null]>).then(([code]) => code)
  return {
    stdin: child.stdin,
    closed,
    stdout: () => Buffer.concat(output),
    stderr: () => errors,
    kill: async () => {
      child.kill()
      await closed
    },
  }
}

const recordedPids = async (directory: string): Promise<number[]> =>
  Promise.all(
    (await readdir(directory))
      .filter((name) => name.endsWith(pidSuffix))
      .map(async (name) => Number(await readFile(join(directory, name), 'utf8'))),
  )

export const createLaunchSandbox = async (onTestFinished: TestContext['onTestFinished']): Promise<LaunchSandbox> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aang-launch-')))
  const directory = join(root, 'Имя Фамилия')
  await mkdir(directory)
  const launches: Launch[] = []
  onTestFinished(async () => {
    await Promise.all(launches.map((launch) => launch.kill()))
    const leftovers = (await recordedPids(directory)).filter(isAlive)
    leftovers.forEach(terminate)
    await waitUntil(() => !leftovers.some(isAlive))
    await rm(root, { recursive: true, force: true, maxRetries: 10 })
  })
  const start = (command: string, args: readonly string[], env: Readonly<Record<string, string>>): Launch => {
    const launch = track(
      spawn(command, args, { cwd: directory, env: hookEnvironment(env), stdio: 'pipe', windowsHide: true }),
    )
    launches.push(launch)
    return launch
  }
  const binary = inject('hookBinaries').covered
  const statusPath = join(directory, 'status.json')
  return {
    directory,
    statusPath,
    command: (mode, ...args) => [process.execPath, processTree, mode, directory, ...args],
    launch: (args, env = {}) => start(binary, ['launch', ...args], env),
    launchFromParent: (args) => start(process.execPath, [processTree, 'parent', directory, binary, ...args], {}),
    pid: async (name) => {
      const path = join(directory, `${name}${pidSuffix}`)
      await waitUntil(() => existsSync(path))
      return Number(await readFile(path, 'utf8'))
    },
    status: async () => JSON.parse(await readFile(statusPath, 'utf8')) as unknown,
    report: async () => JSON.parse(await readFile(join(directory, 'report.json'), 'utf8')) as unknown,
  }
}
