import { open, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

export interface FileText {
  readonly path: string
  readonly text: string
  readonly length: number
}

const readLimitBytes = 1024 ** 2

const unsafeName = /[/\\:\0]/

const reservedNames: ReadonlySet<string> = new Set(['', '.', '..'])

export const safeName = (name: string): boolean => !reservedNames.has(name) && !unsafeName.test(name)

const chain = (directory: string): string[] => {
  const parent = dirname(directory)
  return parent === directory ? [directory] : [directory, ...chain(parent)]
}

export const ancestors = (directory: string): string[] => chain(resolve(directory))

export const readText = async (path: string): Promise<FileText | null> => {
  try {
    const stats = await stat(path)
    if (!stats.isFile()) {
      return null
    }
    const handle = await open(path, 'r')
    try {
      const buffer = Buffer.alloc(Math.min(stats.size, readLimitBytes))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      const text = buffer.subarray(0, bytesRead).toString('utf8')
      return { path, text, length: stats.size > bytesRead ? stats.size : text.length }
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}

export const firstText = async (paths: readonly string[]): Promise<FileText | null> => {
  for (const path of paths) {
    const found = await readText(path)
    if (found !== null) {
      return found
    }
  }
  return null
}

export const definitionPaths = (
  cwd: string | null,
  home: string | null,
  relativePath: readonly string[],
): string[] => [
  ...(cwd === null ? [] : ancestors(cwd).map((directory) => join(directory, '.claude', ...relativePath))),
  ...(home === null ? [] : [join(home, ...relativePath)]),
]

const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/

const field = /^description\s*:(.*)$/

const blockIndicator = /^([|>])[+-]?\d*$/

const indented = (line: string): boolean => line.trim() === '' || /^\s/.test(line)

const quoted = /^(["'])(.*)\1$/

const unquoted = (value: string): string => quoted.exec(value)?.[2] ?? value

export const frontmatterDescription = (text: string): string | null => {
  const lines = frontmatter.exec(text)?.[1]?.split(/\r?\n/) ?? []
  const index = lines.findIndex((line) => field.test(line))
  const value = field.exec(lines[index] ?? '')?.[1]?.trim()
  if (value === undefined) {
    return null
  }
  const following = lines.slice(index + 1)
  const end = following.findIndex((line) => !indented(line))
  const continuation = (end < 0 ? following : following.slice(0, end)).map((line) => line.trim())
  const style = blockIndicator.exec(value)?.[1]
  if (style !== undefined) {
    return continuation.join(style === '|' ? '\n' : ' ').trim()
  }
  return unquoted([value, ...continuation.filter((line) => line !== '')].join(' '))
}
