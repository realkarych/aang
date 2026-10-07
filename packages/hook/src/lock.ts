import { randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { HookInstallError } from './errors.js'
import { createFileExclusively, isErrorCode } from './files.js'

const lockMode = 0o600
const lockPollMs = 20
const lockWaitMs = 30_000
const recoverySuffix = '.recovery'

export type Unlock = () => Promise<void>

const isRunning = (pid: number): boolean => {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !isErrorCode(error, 'ESRCH')
  }
}

const lockOwner = (content: string): number => Number(content.split(' ', 1)[0])

const readLock = async (lock: string, deadline: number): Promise<string | undefined> => {
  for (;;) {
    try {
      return await readFile(lock, 'utf8')
    } catch (error) {
      if (isErrorCode(error, 'ENOENT')) {
        return undefined
      }
      const retryable = isErrorCode(error, 'EPERM', 'EBUSY') || (process.platform === 'win32' && isErrorCode(error, 'EACCES'))
      if (!retryable || Date.now() >= deadline) {
        throw error
      }
      await delay(lockPollMs)
    }
  }
}

const removeAbandoned = async (lock: string, abandoned: string, deadline: number): Promise<boolean> => {
  const recovery = `${lock}${recoverySuffix}`
  if (!(await createFileExclusively(recovery, String(process.pid), lockMode))) {
    const recovering = await readLock(recovery, deadline)
    if (recovering !== undefined && !isRunning(lockOwner(recovering))) {
      throw new HookInstallError(
        'install_locked',
        `${recovery}: process ${recovering} stopped while taking over ${lock}; remove both files once no aang installation is running`,
      )
    }
    return false
  }
  try {
    if ((await readLock(lock, deadline)) === abandoned) {
      await rm(lock, { force: true })
    }
    return true
  } finally {
    await rm(recovery, { force: true })
  }
}

export const acquireLock = async (lock: string, operation: string, signal?: AbortSignal): Promise<Unlock> => {
  const content = `${String(process.pid)} ${randomUUID()}`
  const deadline = Date.now() + lockWaitMs
  while (!(await createFileExclusively(lock, content, lockMode))) {
    signal?.throwIfAborted()
    const held = await readLock(lock, deadline)
    if (held === undefined || (!isRunning(lockOwner(held)) && (await removeAbandoned(lock, held, deadline)))) {
      continue
    }
    if (Date.now() > deadline) {
      throw new HookInstallError(
        'install_locked',
        `${lock}: ${operation} by process ${String(lockOwner(held))} has not finished`,
      )
    }
    await delay(lockPollMs, undefined, { signal })
  }
  return () => rm(lock, { force: true })
}
