import { readFile } from 'node:fs/promises'
import { z } from 'zod'

export const isMissing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT'

export const readOptional = async (path: string): Promise<string | null> => {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (isMissing(error)) {
      return null
    }
    throw error
  }
}

const parseDocument = (path: string, source: string): unknown => {
  try {
    return JSON.parse(source.replace(/^\uFEFF/, ''))
  } catch (error) {
    throw new Error(`${path}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
}

export const parseFile = <Schema extends z.ZodType>(schema: Schema, path: string, source: string): z.output<Schema> => {
  const result = schema.safeParse(parseDocument(path, source))
  if (!result.success) {
    throw new Error(`${path}: ${z.prettifyError(result.error)}`)
  }
  return result.data
}
