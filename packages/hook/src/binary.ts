import { randomUUID } from 'node:crypto'
import { chmod, copyFile, mkdir, readdir, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isErrorCode, readIfReadable } from './files.js'
import { hookBinaryName, hookInstallPaths } from './layout.js'

const leftoverPrefix = `.${hookBinaryName}.`
const stagedSuffix = '.staged'
const retiredSuffix = '.retired'

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

const hasContent = async (path: string, content: Buffer): Promise<boolean> =>
  (await readIfReadable(path))?.equals(content) ?? false

const retire = async (target: string, retired: string): Promise<void> => {
  try {
    await rename(target, retired)
  } catch (error) {
    if (!isErrorCode(error, 'ENOENT')) {
      throw error
    }
  }
}

const swapIn = async (staged: string, target: string, retired: string): Promise<void> => {
  if (process.platform === 'win32') {
    await retire(target, retired)
  }
  await rename(staged, target)
}

export interface HookBinaryDeployment {
  readonly aangHome: string
  readonly hookBinarySource: string
}

export const deployHookBinary = async ({ aangHome, hookBinarySource }: HookBinaryDeployment): Promise<string> => {
  const target = hookInstallPaths(aangHome).binary
  const directory = dirname(target)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await removeLeftovers(directory)
  if (await hasContent(target, await readFile(hookBinarySource))) {
    return target
  }
  const name = `${leftoverPrefix}${randomUUID()}`
  const staged = join(directory, `${name}${stagedSuffix}`)
  try {
    await copyFile(hookBinarySource, staged)
    await chmod(staged, 0o755)
    await swapIn(staged, target, join(directory, `${name}${retiredSuffix}`))
  } finally {
    await rm(staged, { force: true })
  }
  await removeLeftovers(directory)
  return target
}
