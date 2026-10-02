import { randomUUID } from 'node:crypto'
import { chmod, copyFile, mkdir, readdir, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { hasContent, isErrorCode } from './files.js'
import { hookBinaryName, hookInstallPaths } from './layout.js'
import { acquireLock } from './lock.js'

const leftoverPrefix = `.${hookBinaryName}.`
const stagedSuffix = '.staged'
const retiredSuffix = '.retired'
const lockName = `${leftoverPrefix}lock`

const isLeftover = (name: string): boolean =>
  name.startsWith(leftoverPrefix) && (name.endsWith(stagedSuffix) || name.endsWith(retiredSuffix))

const removeUnlessBusy = async (path: string): Promise<void> => {
  try {
    await rm(path, { force: true })
  } catch (error) {
    if (!isErrorCode(error, 'EPERM', 'EBUSY', 'EACCES')) {
      throw error
    }
  }
}

const removeLeftovers = async (directory: string): Promise<void> => {
  const leftovers = (await readdir(directory)).filter(isLeftover)
  await Promise.all(leftovers.map((name) => removeUnlessBusy(join(directory, name))))
}

const retire = async (target: string, retired: string): Promise<boolean> => {
  try {
    await rename(target, retired)
    return true
  } catch (error) {
    if (!isErrorCode(error, 'ENOENT')) {
      throw error
    }
    return false
  }
}

const swapIn = async (staged: string, target: string, retired: string): Promise<void> => {
  const retiredTarget = process.platform === 'win32' && (await retire(target, retired))
  try {
    await rename(staged, target)
  } catch (error) {
    if (retiredTarget) {
      await rename(retired, target)
    }
    throw error
  }
}

const replaceBinary = async (directory: string, target: string, hookBinarySource: string): Promise<void> => {
  const name = `${leftoverPrefix}${randomUUID()}`
  const staged = join(directory, `${name}${stagedSuffix}`)
  try {
    await copyFile(hookBinarySource, staged)
    await chmod(staged, 0o755)
    await swapIn(staged, target, join(directory, `${name}${retiredSuffix}`))
  } finally {
    await rm(staged, { force: true })
  }
}

export interface HookBinaryDeployment {
  readonly aangHome: string
  readonly hookBinarySource: string
}

export const deployHookBinary = async ({ aangHome, hookBinarySource }: HookBinaryDeployment): Promise<string> => {
  const target = hookInstallPaths(aangHome).binary
  const directory = dirname(target)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const unlock = await acquireLock(join(directory, lockName), `another deployment of ${hookBinaryName}`)
  try {
    await removeLeftovers(directory)
    if (!(await hasContent(target, await readFile(hookBinarySource)))) {
      await replaceBinary(directory, target, hookBinarySource)
      await removeLeftovers(directory)
    }
  } finally {
    await unlock()
  }
  return target
}
