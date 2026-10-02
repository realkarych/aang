import { randomUUID } from 'node:crypto'
import { chmod, link, readFile, rename, rm, writeFile } from 'node:fs/promises'

const creationMode = 0o600

export const isErrorCode = (error: unknown, ...codes: readonly string[]): boolean =>
  error instanceof Error && 'code' in error && typeof error.code === 'string' && codes.includes(error.code)

export const readIfReadable = (path: string): Promise<Buffer | undefined> => readFile(path).catch(() => undefined)

export const hasContent = async (path: string, content: Buffer): Promise<boolean> =>
  (await readIfReadable(path))?.equals(content) ?? false

export const writeNewFile = async (path: string, content: string | Buffer, mode: number): Promise<void> => {
  await writeFile(path, content, { flag: 'wx', mode: creationMode })
  await chmod(path, mode)
}

export const withStagedFile = async <T>(
  path: string,
  content: string,
  mode: number,
  commit: (staged: string) => Promise<T>,
): Promise<T> => {
  const staged = `${path}.${randomUUID()}.tmp`
  try {
    await writeNewFile(staged, content, mode)
    return await commit(staged)
  } finally {
    await rm(staged, { force: true })
  }
}

export const replaceFile = (path: string, content: string, mode: number): Promise<void> =>
  withStagedFile(path, content, mode, (staged) => rename(staged, path))

export const createFileExclusively = (path: string, content: string, mode: number): Promise<boolean> =>
  withStagedFile(path, content, mode, async (staged) => {
    try {
      await link(staged, path)
      return true
    } catch (error) {
      if (isErrorCode(error, 'EEXIST')) {
        return false
      }
      throw error
    }
  })

export const jsonText = (document: unknown): string => `${JSON.stringify(document, null, 2)}\n`
