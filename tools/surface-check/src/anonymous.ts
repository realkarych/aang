import { readdir, readFile } from 'node:fs/promises'
import { homedir, hostname, userInfo } from 'node:os'
import { dirname, join } from 'node:path'

export interface Identity {
  readonly home: string
  readonly user: string
  readonly host: string
}

const userName = (): string => {
  try {
    return userInfo().username
  } catch {
    return ''
  }
}

export const identity = (): Identity => ({ home: homedir(), user: userName(), host: hostname() })

const literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const spellings = (path: string): string[] => [...new Set([path, path.replaceAll('\\', '/'), path.replaceAll('\\', '\\\\')])]

const namedHost = (host: string): boolean => host !== '' && host.toLowerCase() !== 'localhost'

const pathFlags = process.platform === 'win32' ? 'gi' : 'g'

export type Anonymizer = (text: string) => string

export const anonymizer = (paths: readonly (readonly [string, string])[], host: string): Anonymizer => {
  const rules: (readonly [RegExp, string])[] = [
    ...paths
      .filter(([path]) => dirname(path) !== path)
      .flatMap(([path, label]) => spellings(path).map((spelling) => [spelling, label] as const))
      .toSorted(([left], [right]) => right.length - left.length)
      .map(([spelling, label]) => [new RegExp(literal(spelling), pathFlags), label] as const),
    ...(namedHost(host) ? [[new RegExp(`\\b${literal(host)}\\b`, 'gi'), '<host>'] as const] : []),
  ]
  return (text) => rules.reduce((current, [expression, label]) => current.replace(expression, label), text)
}

export const anonymized = <T>(value: T, anonymize: Anonymizer): T =>
  JSON.parse(JSON.stringify(value), (_key, item: unknown) => (typeof item === 'string' ? anonymize(item) : item)) as T

export interface Leak {
  readonly file: string
  readonly kind: string
}

const needles = ({ home, user, host }: Identity): (readonly [string, string])[] => [
  ...(dirname(home) === home ? [] : spellings(home).map((spelling) => [spelling, 'the home directory'] as const)),
  ...(user === ''
    ? []
    : [...['/', '\\', '\\\\'].map((separator) => `${separator}${user}${separator}`), `${user}@`].map((needle) => [needle, 'the user name'] as const)),
  ...(namedHost(host) ? [[host, 'the host name'] as const] : []),
]

const filesUnder = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true }).catch((error: unknown) => {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return []
    }
    throw error
  })
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name))
}

export const leaks = async (directory: string, who: Identity): Promise<Leak[]> => {
  const found: Leak[] = []
  for (const file of await filesUnder(directory)) {
    const text = (await readFile(file, 'utf8')).toLowerCase()
    const kinds = new Set(needles(who).filter(([needle]) => text.includes(needle.toLowerCase())).map(([, kind]) => kind))
    found.push(...[...kinds].map((kind) => ({ file, kind })))
  }
  return found
}
