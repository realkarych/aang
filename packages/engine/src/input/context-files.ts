import { open, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'

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

const byteOrderMark = '\uFEFF'

const frontmatterBlock = /^---\s*\n([\s\S]*?)---\s*\n?/

const plainEntry = /^([a-zA-Z_-]+):\s+(\S.*)$/

const flowIndicators = /[{}[\]*&#!|>%@`]|: /

const leadingTabs = /^\t+/gm

type Fields = Readonly<Record<string, unknown>>

export interface Frontmatter {
  readonly fields: Fields
  readonly body: string
}

const isFields = (value: unknown): value is Fields =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const parsedYaml = (source: string): unknown => parseYaml(source, { logLevel: 'error' })

const quotedValue = (value: string): string => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`

const isFlowList = (value: string): boolean => {
  try {
    return Array.isArray(parsedYaml(value))
  } catch {
    return false
  }
}

const requotedLine = (line: string): string => {
  const [, key, value] = plainEntry.exec(line) ?? []
  if (key === undefined || value === undefined) {
    return line
  }
  const quoted = (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))
  const listed = value.startsWith('[') && value.endsWith(']') && isFlowList(value)
  return quoted || listed || !flowIndicators.test(value) ? line : `${key}: ${quotedValue(value)}`
}

const requoted = (source: string): string =>
  source
    .split('\n')
    .map(requotedLine)
    .join('\n')
    .replace(leadingTabs, (tabs) => '  '.repeat(tabs.length))

const yamlFields = (source: string): Fields => {
  for (const attempt of [source, requoted(source)]) {
    try {
      const value = parsedYaml(attempt)
      return isFields(value) ? value : {}
    } catch {
      continue
    }
  }
  return {}
}

export const frontmatterOf = (text: string): Frontmatter => {
  const content = text.startsWith(byteOrderMark) ? text.slice(byteOrderMark.length) : text
  const block = content.indexOf('---', 3) < 0 ? null : frontmatterBlock.exec(content)
  return block === null
    ? { fields: {}, body: text }
    : { fields: yamlFields(block[1] ?? ''), body: content.slice(block[0].length) }
}

const textField = (fields: Fields, key: string): string | null => {
  const value = fields[key]
  return typeof value === 'string' ? value : null
}

export const frontmatterDescription = (text: string): string | null =>
  textField(frontmatterOf(text).fields, 'description')?.trim() ?? null

const allTools = '*'

const toolNames = (values: readonly string[]): string[] => {
  const names: string[] = []
  for (const value of values) {
    let name = ''
    let grouped = false
    for (const char of value) {
      if (char === '(' || char === ')') {
        grouped = char === '('
        name += char
      } else if ((char === ',' || char === ' ') && !grouped) {
        if (name.trim() !== '') {
          names.push(name.trim())
          name = ''
        } else if (char === ',') {
          name = ''
        }
      } else if (name !== '' || char.trim() !== '') {
        name += char
      }
    }
    if (name.trim() !== '') {
      names.push(name.trim())
    }
  }
  return names
}

const toolsOf = (value: unknown): readonly string[] => {
  const values =
    typeof value === 'string'
      ? [value]
      : Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string')
        : []
  const names = toolNames(values)
  return names.includes(allTools) ? [] : names
}

const listedTools = (fields: Fields): string => {
  const allowed = toolsOf(fields['tools'])
  const disallowed = toolsOf(fields['disallowedTools'])
  if (allowed.length === 0) {
    return disallowed.length === 0 ? 'All tools' : `All tools except ${disallowed.join(', ')}`
  }
  const kept = allowed.filter((tool) => !disallowed.includes(tool))
  return kept.length === 0 ? 'None' : kept.join(', ')
}

export interface AgentFile {
  readonly type: string | null
  readonly listedLine: string | null
  readonly prompt: string
}

export const agentFileOf = (text: string): AgentFile => {
  const { fields, body } = frontmatterOf(text)
  const description = textField(fields, 'description')?.replaceAll('\\n', '\n') ?? ''
  return {
    type: textField(fields, 'name'),
    listedLine: description === '' ? null : `${description} (Tools: ${listedTools(fields)})`,
    prompt: body.trim(),
  }
}
