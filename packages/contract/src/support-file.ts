import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { SupportMatrix } from './support.js'

export class SupportMatrixError extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
  ) {
    super(`${path}: ${reason}`)
    this.name = 'SupportMatrixError'
  }
}

const parseDocument = (path: string, source: string): unknown => {
  try {
    return JSON.parse(source.replace(/^\uFEFF/, ''))
  } catch (error) {
    throw new SupportMatrixError(path, `invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export const readSupportMatrix = async (path: string): Promise<SupportMatrix> => {
  const result = SupportMatrix.safeParse(parseDocument(path, await readFile(path, 'utf8')))
  if (!result.success) {
    throw new SupportMatrixError(path, z.prettifyError(result.error))
  }
  return result.data
}
