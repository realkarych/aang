import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import type { ContentHash } from '@aang/contract'
import { isMissing } from './errors.js'

export interface Prefix {
  readonly hash: ContentHash
  readonly lines: number
}

const lineFeed = 0x0a
const readChunkBytes = 1024 ** 2

const countLines = (bytes: Buffer): number => {
  let lines = 0
  for (let index = bytes.indexOf(lineFeed); index >= 0; index = bytes.indexOf(lineFeed, index + 1)) {
    lines += 1
  }
  return lines
}

export const readPrefix = async (path: string, offset: number): Promise<Prefix | null> => {
  const handle = await open(path, 'r')
  try {
    const digest = createHash('sha256')
    const buffer = Buffer.alloc(Math.min(offset, readChunkBytes))
    let lines = 0
    for (let position = 0; position < offset;) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, offset - position), position)
      if (bytesRead === 0) {
        return null
      }
      const bytes = buffer.subarray(0, bytesRead)
      digest.update(bytes)
      lines += countLines(bytes)
      position += bytesRead
    }
    return { hash: digest.digest('hex') as ContentHash, lines }
  } finally {
    await handle.close()
  }
}

export const prefixHash = async (path: string, offset: number): Promise<ContentHash | null> => {
  try {
    return (await readPrefix(path, offset))?.hash ?? null
  } catch (error) {
    if (isMissing(error)) {
      return null
    }
    throw error
  }
}
