import { lstat, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export type Unavailable = (path: string, error: unknown) => boolean

const busyCodes: readonly string[] = ['EBUSY', 'EPERM', 'EACCES']

export const isMissing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT'

export const isBusy = (error: unknown): boolean =>
  process.platform === 'win32' && error instanceof Error && 'code' in error && busyCodes.includes(String(error.code))

export const filesIn = async (directory: string, unavailable: Unavailable = () => false): Promise<string[]> => {
  const skipped = (error: unknown): boolean => isMissing(error) || unavailable(directory, error)
  const info = await lstat(directory).catch((error: unknown) => {
    if (skipped(error)) return undefined
    throw error
  })
  if (info === undefined) return []
  if (info.isSymbolicLink()) throw new Error('Recording sources cannot contain symbolic links')
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
    if (skipped(error)) return []
    throw error
  })
  const paths: string[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error('Recording sources cannot contain symbolic links')
    if (entry.isDirectory()) paths.push(...await filesIn(path, unavailable))
    else if (entry.isFile()) paths.push(path)
  }
  return paths
}

export const readUtf8 = async (file: string): Promise<string> => new TextDecoder('utf-8', { fatal: true }).decode(await readFile(file))
