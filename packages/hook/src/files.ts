import { randomUUID } from 'node:crypto'
import { chmod, readFile, rename, rm, writeFile } from 'node:fs/promises'

export const isErrorCode = (error: unknown, ...codes: readonly string[]): boolean =>
  error instanceof Error && 'code' in error && typeof error.code === 'string' && codes.includes(error.code)

export const readIfReadable = (path: string): Promise<Buffer | undefined> => readFile(path).catch(() => undefined)

export const replaceFile = async (path: string, content: string, mode: number): Promise<void> => {
  const staging = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(staging, content, { flag: 'wx' })
    await chmod(staging, mode)
    await rename(staging, path)
  } catch (error) {
    await rm(staging, { force: true })
    throw error
  }
}

export const jsonText = (document: unknown): string => `${JSON.stringify(document, null, 2)}\n`
