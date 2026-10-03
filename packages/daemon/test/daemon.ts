import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { type AangHomePaths, aangHomePaths } from '@aang/contract/home'
import { type DaemonReady, type DaemonStopReason, runDaemon } from '@aang/daemon'
import type { TestContext } from 'vitest'

export interface Home {
  readonly root: string
  readonly paths: AangHomePaths
  readonly token: string
}

export interface RunningDaemon {
  readonly ready: DaemonReady
  readonly base: string
  readonly stopped: Promise<DaemonStopReason>
  readonly abort: () => void
}

export interface DaemonSettings {
  readonly config?: Record<string, unknown>
  readonly bind?: string | null
  readonly staticRoot?: string | null
  readonly env?: Readonly<Record<string, string>>
}

export const createHome = async (
  onTestFinished: TestContext['onTestFinished'],
  config: Record<string, unknown> = {},
): Promise<Home> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aang-daemon-')))
  onTestFinished(() => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))
  const paths = aangHomePaths(join(root, '.aang'))
  const token = randomBytes(32).toString('base64url')
  await mkdir(paths.home, { recursive: true })
  await writeFile(join(paths.home, 'config.json'), JSON.stringify({ otel: { port: 0 }, ...config, api: { port: 0 } }))
  await writeFile(paths.uiToken, `${token}\n`)
  return { root, paths, token }
}

export const startDaemon = async (
  home: Home,
  onTestFinished: TestContext['onTestFinished'],
  { bind = null, staticRoot = null, env = {} }: DaemonSettings = {},
): Promise<RunningDaemon> => {
  const controller = new AbortController()
  const ready = Promise.withResolvers<DaemonReady>()
  const stopped = runDaemon({
    environment: { env: { ...env, AANG_HOME: home.paths.home }, homedir: home.root },
    bind,
    staticRoot,
    signal: controller.signal,
    onReady: ready.resolve,
  })
  onTestFinished(async () => {
    controller.abort()
    await stopped.catch(() => undefined)
  })
  const started = await Promise.race([ready.promise, stopped.then(() => undefined)])
  if (started === undefined) {
    throw new Error('the daemon stopped before it was ready')
  }
  return {
    ready: started,
    base: `http://127.0.0.1:${String(started.api.port)}`,
    stopped,
    abort: () => {
      controller.abort()
    },
  }
}

export const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` })

export interface DaemonProcess {
  readonly ready: DaemonReady
  readonly base: string
  readonly kill: () => Promise<void>
  readonly shutdown: () => Promise<number | null>
  readonly exited: () => Promise<number | null>
  readonly errors: () => string
}

const host = fileURLToPath(new URL('host.ts', import.meta.url))

export const spawnDaemon = async (home: Home, onTestFinished: TestContext['onTestFinished']): Promise<DaemonProcess> => {
  const child = spawn(process.execPath, [host, home.paths.home, home.root], { stdio: ['ignore', 'pipe', 'pipe'] })
  let errors = ''
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    errors += chunk
  })
  const exited = once(child, 'close') as Promise<[number | null, NodeJS.Signals | null]>
  onTestFinished(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await exited
    }
  })
  const firstLine = once(createInterface({ input: child.stdout }), 'line') as Promise<[string]>
  const started = await Promise.race([firstLine, exited.then(() => undefined)])
  if (started === undefined) {
    throw new Error(`the daemon process exited before it was ready\n${errors}`)
  }
  const ready = JSON.parse(started[0]) as DaemonReady
  const base = `http://127.0.0.1:${String(ready.api.port)}`
  return {
    ready,
    base,
    kill: async () => {
      child.kill('SIGKILL')
      await exited
    },
    shutdown: async () => {
      const response = await fetch(`${base}/api/admin/shutdown`, {
        method: 'POST',
        headers: { ...bearer(home.token), 'content-type': 'application/json' },
        body: '{}',
      })
      if (!response.ok) {
        throw new Error(`shutdown was refused with ${String(response.status)}`)
      }
      const [code] = await exited
      return code
    },
    exited: async () => {
      const [code] = await exited
      return code
    },
    errors: () => errors,
  }
}
