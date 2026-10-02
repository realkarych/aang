import { randomUUID } from 'node:crypto'
import { lstat, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { Listener } from './api.js'
import { EpochNs } from './primitives.js'
import { spoolLayout } from './spool.js'

export const aangHomeLayout = {
  spool: 'spool',
  daemonState: 'daemon.json',
  daemonLog: 'daemon.log',
  uiToken: 'token',
  authCodes: 'auth',
} as const

export interface AangHomePaths {
  readonly home: string
  readonly spool: string
  readonly spoolReady: string
  readonly spoolTemporary: string
  readonly stoppedMarker: string
  readonly daemonState: string
  readonly daemonLog: string
  readonly uiToken: string
  readonly authCodes: string
}

export const aangHomePaths = (aangHome: string): AangHomePaths => {
  const spool = join(aangHome, aangHomeLayout.spool)
  return {
    home: aangHome,
    spool,
    spoolReady: join(spool, spoolLayout.readyDirectory),
    spoolTemporary: join(spool, spoolLayout.temporaryDirectory),
    stoppedMarker: join(spool, spoolLayout.stoppedMarker),
    daemonState: join(aangHome, aangHomeLayout.daemonState),
    daemonLog: join(aangHome, aangHomeLayout.daemonLog),
    uiToken: join(aangHome, aangHomeLayout.uiToken),
    authCodes: join(aangHome, aangHomeLayout.authCodes),
  }
}

const secret = z.string().regex(/^[A-Za-z0-9_-]{43}$/)

export const UiToken = secret.brand<'UiToken'>()
export type UiToken = z.infer<typeof UiToken>

export const AuthCode = secret.brand<'AuthCode'>()
export type AuthCode = z.infer<typeof AuthCode>

export const DaemonState = z.strictObject({
  pid: z.int().positive(),
  started_at: EpochNs,
  api: Listener,
  spool_over_threshold: z
    .strictObject({
      detected_at: EpochNs,
      bytes: z.int().nonnegative(),
    })
    .nullable(),
})
export type DaemonState = z.infer<typeof DaemonState>

const leaseName = new RegExp(`^${spoolLayout.leasePrefix}(0|[1-9][0-9]*)$`)

export const leaseFileName = (expiresAtSeconds: number): string =>
  `${spoolLayout.leasePrefix}${String(Math.trunc(expiresAtSeconds))}`

export const leaseExpirySeconds = (fileName: string): number | undefined => {
  const match = leaseName.exec(fileName)
  return match?.[1] === undefined ? undefined : Number(match[1])
}

const isMissing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT'

const namesIn = async (directory: string): Promise<string[]> => {
  try {
    return await readdir(directory)
  } catch (error) {
    if (isMissing(error)) {
      return []
    }
    throw error
  }
}

const fileSize = async (path: string): Promise<number | undefined> => {
  try {
    const stats = await lstat(path)
    return stats.isFile() ? stats.size : undefined
  } catch (error) {
    if (isMissing(error)) {
      return undefined
    }
    throw error
  }
}

export interface SpoolState {
  readonly files: number
  readonly bytes: number
  readonly leaseExpiresAt: EpochNs | null
  readonly stopped: boolean
}

const queuedSizes = async (directory: string): Promise<number[]> => {
  const sizes = await Promise.all((await namesIn(directory)).map((name) => fileSize(join(directory, name))))
  return sizes.filter((size) => size !== undefined)
}

export const readSpoolState = async (spool: string): Promise<SpoolState> => {
  const names = await namesIn(spool)
  const expiries = names.flatMap((name) => leaseExpirySeconds(name) ?? [])
  const sizes = [
    ...(await queuedSizes(join(spool, spoolLayout.readyDirectory))),
    ...(await queuedSizes(join(spool, spoolLayout.temporaryDirectory))),
  ]
  return {
    files: sizes.length,
    bytes: sizes.reduce((total, size) => total + size, 0),
    leaseExpiresAt: expiries.length === 0 ? null : EpochNs.parse(BigInt(Math.max(...expiries)) * 1_000_000_000n),
    stopped: names.includes(spoolLayout.stoppedMarker),
  }
}

export const revokeLeases = async (spool: string): Promise<void> => {
  const leases = (await namesIn(spool)).filter((name) => leaseExpirySeconds(name) !== undefined)
  await Promise.all(leases.map((name) => rm(join(spool, name), { force: true })))
}

export const readUiToken = async (path: string): Promise<UiToken | null> => {
  try {
    return UiToken.parse((await readFile(path, 'utf8')).trim())
  } catch (error) {
    if (isMissing(error)) {
      return null
    }
    throw error
  }
}

export const readDaemonState = async (path: string): Promise<DaemonState | null> => {
  try {
    return DaemonState.parse(JSON.parse(await readFile(path, 'utf8')))
  } catch (error) {
    if (isMissing(error)) {
      return null
    }
    throw error
  }
}

const replaceFile = async (path: string, content: string): Promise<void> => {
  const staging = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(staging, content, { mode: 0o600, flag: 'wx' })
    await rename(staging, path)
  } catch (error) {
    await rm(staging, { force: true })
    throw error
  }
}

const daemonStateWrites = new Map<string, Promise<void>>()

export const writeDaemonState = async (path: string, state: DaemonState): Promise<void> => {
  const content = `${JSON.stringify(DaemonState.encode(state))}\n`
  const target = resolve(path)
  const replace = (): Promise<void> => replaceFile(target, content)
  const write = (daemonStateWrites.get(target) ?? Promise.resolve()).then(replace, replace)
  daemonStateWrites.set(target, write)
  try {
    await write
  } finally {
    if (daemonStateWrites.get(target) === write) {
      daemonStateWrites.delete(target)
    }
  }
}
