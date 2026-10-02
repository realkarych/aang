import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  await writeFile(join(paths.home, 'config.json'), JSON.stringify({ ...config, api: { port: 0 } }))
  await writeFile(paths.uiToken, `${token}\n`)
  return { root, paths, token }
}

export const startDaemon = async (
  home: Home,
  onTestFinished: TestContext['onTestFinished'],
  { bind = null, staticRoot = null }: DaemonSettings = {},
): Promise<RunningDaemon> => {
  const controller = new AbortController()
  const ready = Promise.withResolvers<DaemonReady>()
  const stopped = runDaemon({
    environment: { env: { AANG_HOME: home.paths.home }, homedir: home.root },
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
