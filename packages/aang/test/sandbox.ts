import { type ChildProcessByStdio, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { invokeHook } from '@aang/testkit'
import type { TestContext } from 'vitest'
import { isAlive, kill } from './processes.js'

const entry = fileURLToPath(new URL('../dist/main.js', import.meta.url))
const hookBinary = fileURLToPath(
  new URL(`../../hook/bin/aang-hook${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url),
)

export interface CommandResult {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}

export interface DaemonStateFile {
  readonly pid: number
  readonly started_at: string
  readonly api: { readonly host: string; readonly port: number }
  readonly spool_over_threshold: { readonly detected_at: string; readonly bytes: number } | null
}

export interface SpoolView {
  readonly leaseExpiries: readonly number[]
  readonly stopped: boolean
}

export type AangProcess = ChildProcessByStdio<null, Readable, Readable>

export interface Sandbox {
  readonly aangHome: string
  readonly spool: string
  readonly env: NodeJS.ProcessEnv
  readonly aang: (...args: string[]) => Promise<CommandResult>
  readonly spawnAang: (...args: string[]) => AangProcess
  readonly daemonState: () => Promise<DaemonStateFile | null>
  readonly spoolView: () => Promise<SpoolView>
  readonly hookWrites: () => Promise<boolean>
  readonly track: (pid: number) => void
}

const leaseName = /^lease-(0|[1-9][0-9]*)$/

const isMissing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT'

const namesIn = (directory: string): Promise<string[]> =>
  readdir(directory).catch((error: unknown): string[] => {
    if (isMissing(error)) {
      return []
    }
    throw error
  })

const collect = async (child: AangProcess): Promise<CommandResult> => {
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk
  })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk
  })
  const [code] = (await once(child, 'close')) as [number | null]
  return { code, stdout, stderr }
}

export interface SandboxLayout {
  readonly relativeHome?: boolean
}

const homeName = 'aang home'

export const createSandbox = async (
  onTestFinished: TestContext['onTestFinished'],
  config: Record<string, unknown> = {},
  { relativeHome = false }: SandboxLayout = {},
): Promise<Sandbox> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aang-lifecycle-')))
  const aangHome = join(root, homeName)
  const spool = join(aangHome, 'spool')
  const daemonStateFile = join(aangHome, 'daemon.json')
  await mkdir(aangHome, { recursive: true })
  await writeFile(join(aangHome, 'config.json'), JSON.stringify({ ...config, api: { port: 0 }, otel: { port: 0 } }))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    AANG_HOME: relativeHome ? homeName : aangHome,
    CLAUDE_CONFIG_DIR: join(root, '.claude'),
    CODEX_HOME: join(root, '.codex'),
  }
  const tracked = new Set<number>()
  const children = new Set<AangProcess>()

  const daemonState = async (): Promise<DaemonStateFile | null> => {
    try {
      const state = JSON.parse(await readFile(daemonStateFile, 'utf8')) as DaemonStateFile
      tracked.add(state.pid)
      return state
    } catch (error) {
      if (isMissing(error)) {
        return null
      }
      throw error
    }
  }

  const spawnAang = (...args: string[]): AangProcess => {
    const child = spawn(process.execPath, [entry, ...args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    children.add(child)
    return child
  }

  onTestFinished(async () => {
    await daemonState().catch(() => null)
    for (const child of children) {
      child.kill('SIGKILL')
    }
    for (const pid of tracked) {
      kill(pid)
    }
    const deadline = Date.now() + 10_000
    while ([...tracked].some(isAlive) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  })

  return {
    aangHome,
    spool,
    env,
    aang: (...args) => collect(spawnAang(...args)),
    spawnAang,
    daemonState,
    spoolView: async () => {
      const names = await namesIn(spool)
      return {
        leaseExpiries: names.flatMap((name) => {
          const match = leaseName.exec(name)
          return match?.[1] === undefined ? [] : [Number(match[1])]
        }),
        stopped: names.includes('stopped'),
      }
    },
    hookWrites: async () => {
      const ready = join(spool, 'new')
      const before = new Set(await namesIn(ready))
      const payload = JSON.stringify({ hook_event_name: 'Notification', session_id: randomUUID() })
      await invokeHook({ binary: hookBinary, spool, env }, { runtime: 'claude', registration: 'plugin', payload })
      const written = (await namesIn(ready)).filter((name) => !before.has(name))
      const contents = await Promise.all(written.map((name) => readFile(join(ready, name), 'utf8')))
      return contents.some((content) => content.startsWith('aang-spool/1 claude plugin\n') && content.endsWith(payload))
    },
    track: (pid) => {
      tracked.add(pid)
    },
  }
}

export const startedPid = (result: CommandResult): number => {
  const match = /aang started: pid ([0-9]+), /.exec(result.stdout)
  if (match?.[1] === undefined) {
    throw new Error(`aang start did not report a pid: ${result.stdout}${result.stderr}`)
  }
  return Number(match[1])
}
