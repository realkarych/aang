import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FakeCli } from '@aang/testkit'

type Awaitable<T> = T | Promise<T>

export interface Workspace {
  readonly root: string
  readonly home: string
  readonly cwd: string
}

export const createWorkspace = async (register: (cleanup: () => Awaitable<void>) => void): Promise<Workspace> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aang-fake-cli-')))
  register(() => rm(root, { recursive: true, force: true, maxRetries: 5 }))
  const home = join(root, 'home')
  const cwd = join(root, 'observer', 'empty')
  mkdirSync(home, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  return { root, home, cwd }
}

const windowsVariables = ['SystemRoot', 'TEMP', 'TMP', 'PATH'] as const

export const cleanEnvironment = (home: string, markers: Readonly<Record<string, string>>): Record<string, string> => {
  const base: Record<string, string> =
    process.platform === 'win32'
      ? {
          ...Object.fromEntries(windowsVariables.flatMap((name) => [[name, process.env[name] ?? '']])),
          USERPROFILE: home,
        }
      : { HOME: home, PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' }
  return { ...base, ...markers }
}

export type Event = Record<string, unknown>

export interface Exit {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
  readonly events: Event[]
}

export interface RunOptions {
  readonly env: Readonly<Record<string, string>>
  readonly cwd: string
  readonly stdin?: string
}

export interface Running {
  readonly events: () => Event[]
  readonly alive: () => boolean
  readonly exit: Promise<Exit>
  readonly kill: () => Promise<Exit>
}

const parseEvents = (stdout: string): Event[] =>
  stdout
    .split(/\r?\n/)
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Event)

export const startFake = <S>(fake: FakeCli<S>, args: readonly string[], options: RunOptions): Running => {
  const child = spawn(fake.command, [...fake.args, ...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk
  })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk
  })
  const exit = new Promise<Exit>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code) => {
      resolve({
        code,
        stdout,
        stderr,
        get events() {
          return parseEvents(stdout)
        },
      })
    })
  })
  child.stdin.end(options.stdin ?? '')
  return {
    events: () => parseEvents(stdout.slice(0, stdout.lastIndexOf('\n') + 1)),
    alive: () => child.exitCode === null && child.signalCode === null,
    exit,
    kill: () => {
      child.kill('SIGKILL')
      return exit
    },
  }
}

export const runFake = <S>(fake: FakeCli<S>, args: readonly string[], options: RunOptions): Promise<Exit> =>
  startFake(fake, args, options).exit

export const waitFor = async (condition: () => boolean, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('condition was not met in time')
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

export const lines = (text: string): string[] => text.split(/\r?\n/).filter((line) => line !== '')
