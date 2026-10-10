import { appendFile, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { codexArchiveDirectory, type PlayerRoot, type Target } from './manifest.js'

export type PlayerRoots = Readonly<Record<PlayerRoot, string>>

const busyCodes: readonly string[] = ['EBUSY', 'EPERM', 'EACCES']
const busyAttempts = 50
const busyRetryMs = 20

const isBusy = (error: unknown): boolean =>
  process.platform === 'win32' && error instanceof Error && 'code' in error && busyCodes.includes(String(error.code))

const retryWhileBusy = async (operation: () => Promise<void>): Promise<void> => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await operation()
      return
    } catch (error) {
      if (!isBusy(error) || attempt === busyAttempts) {
        throw error
      }
      await sleep(busyRetryMs)
    }
  }
}

export const resolveTarget = (roots: PlayerRoots, target: Target): string =>
  join(roots[target.root], ...target.path.split('/'))

const ensureParent = async (path: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
}

const sizeOf = async (path: string): Promise<number> => {
  try {
    return (await stat(path)).size
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return 0
    }
    throw error
  }
}

export const appendTo = async (path: string, chunk: Uint8Array): Promise<number> => {
  await ensureParent(path)
  const offset = await sizeOf(path)
  await retryWhileBusy(() => appendFile(path, chunk))
  return offset
}

export const writeWhole = async (path: string, content: Uint8Array): Promise<void> => {
  await ensureParent(path)
  await retryWhileBusy(() => writeFile(path, content))
}

export const remove = (path: string): Promise<void> => retryWhileBusy(() => rm(path))

export const move = async (from: string, to: string): Promise<void> => {
  await ensureParent(to)
  await retryWhileBusy(() => rename(from, to))
}

export const archivedPath = (roots: PlayerRoots, rollout: string): string =>
  join(roots.codex, codexArchiveDirectory, basename(rollout))
