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

export const firstText = async (
  paths: readonly string[],
  accepted: (file: FileText) => boolean = () => true,
): Promise<FileText | null> => {
  for (const path of paths) {
    const found = await readText(path)
    if (found !== null && accepted(found)) {
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

const blockIndicator = /^([|>])[+-]?\d*$/

const indented = (line: string): boolean => line.trim() === '' || /^\s/.test(line)

const quoted = /^(["'])(.*)\1$/

const unquoted = (value: string): string => quoted.exec(value)?.[2] ?? value

interface Field {
  readonly value: string
  readonly following: readonly string[]
}

const frontmatterField = (text: string, key: string): Field | null => {
  const lines = frontmatter.exec(text)?.[1]?.split(/\r?\n/) ?? []
  const pattern = new RegExp(`^${key}\\s*:(.*)$`)
  const index = lines.findIndex((line) => pattern.test(line))
  const value = pattern.exec(lines[index] ?? '')?.[1]?.trim()
  return value === undefined ? null : { value, following: lines.slice(index + 1) }
}

const leading = (lines: readonly string[], kept: (line: string) => boolean): readonly string[] => {
  const end = lines.findIndex((line) => !kept(line))
  return end < 0 ? lines : lines.slice(0, end)
}

export const frontmatterDescription = (text: string): string | null => {
  const field = frontmatterField(text, 'description')
  if (field === null) {
    return null
  }
  const continuation = leading(field.following, indented).map((line) => line.trim())
  const style = blockIndicator.exec(field.value)?.[1]
  if (style !== undefined) {
    return continuation.join(style === '|' ? '\n' : ' ').trim()
  }
  return unquoted([field.value, ...continuation.filter((line) => line !== '')].join(' '))
}

const flowSequence = /^\[(.*)\]$/

const sequenceItem = /^\s*-\s+(.*)$/

const toolName = /(?:\([^)]*\)?|[^\s,(])+/g

const allTools = '*'

const fieldItems = ({ value, following }: Field): readonly string[] => {
  const flow = flowSequence.exec(value)?.[1]
  if (flow !== undefined) {
    return flow.split(',')
  }
  if (value !== '') {
    return [value]
  }
  return leading(following, (line) => sequenceItem.test(line)).map((line) => line.replace(sequenceItem, '$1'))
}

const frontmatterTools = (text: string, key: string): readonly string[] => {
  const field = frontmatterField(text, key)
  const names = (field === null ? [] : fieldItems(field)).flatMap(
    (item) => unquoted(item.trim()).match(toolName) ?? [],
  )
  return names.includes(allTools) ? [] : names
}

export const listedTools = (text: string): string => {
  const allowed = frontmatterTools(text, 'tools')
  const disallowed = frontmatterTools(text, 'disallowedTools')
  if (allowed.length === 0) {
    return disallowed.length === 0 ? 'All tools' : `All tools except ${disallowed.join(', ')}`
  }
  const kept = allowed.filter((tool) => !disallowed.includes(tool))
  return kept.length === 0 ? 'None' : kept.join(', ')
}
