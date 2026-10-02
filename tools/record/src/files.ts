import { lstat, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const isMissing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT'

export const filesIn = async (directory: string): Promise<string[]> => {
  const info = await lstat(directory).catch((error: unknown) => {
    if (isMissing(error)) return undefined
    throw error
  })
  if (info === undefined) return []
  if (info.isSymbolicLink()) throw new Error('Recording sources cannot contain symbolic links')
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
    if (isMissing(error)) return []
    throw error
  })
  const paths: string[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error('Recording sources cannot contain symbolic links')
    if (entry.isDirectory()) paths.push(...await filesIn(path))
    else if (entry.isFile()) paths.push(path)
  }
  return paths
}

export const readUtf8 = async (file: string): Promise<string> => new TextDecoder('utf-8', { fatal: true }).decode(await readFile(file))
