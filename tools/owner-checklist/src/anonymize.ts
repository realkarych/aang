import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'

export type Anonymize = (value: string) => string

interface Replacement {
  readonly from: string
  readonly to: string
}

const realOrSame = (path: string): string => {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

export const pathForms = (path: string): string[] => {
  const real = realOrSame(path)
  const forms = [path, real]
  for (const form of [path, real]) {
    if (form.startsWith('/private/')) {
      forms.push(form.slice('/private'.length))
    }
  }
  return [...new Set(forms)]
}

export const encodeProjectPath = (path: string): string => path.replace(/[^A-Za-z0-9]/g, '-')

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const replacementsFor = (dir: string, home: string): Replacement[] => {
  const labels = new Map<string, string>()
  for (const [root, label] of [
    [dir, '<dir>'],
    [home, '~'],
  ] as const) {
    for (const form of pathForms(root)) {
      for (const from of [form, encodeProjectPath(form)]) {
        if (from.length > 1 && !labels.has(from)) {
          labels.set(from, label)
        }
      }
    }
  }
  return [...labels]
    .map(([from, to]) => ({ from, to }))
    .sort((left, right) => right.from.length - left.from.length)
}

export const createAnonymizer = (dir: string, home: string = homedir()): Anonymize => {
  const replacements = replacementsFor(dir, home)
  const flags = process.platform === 'win32' ? 'gi' : 'g'
  const pattern = new RegExp(replacements.map(({ from }) => escapeRegExp(from)).join('|'), flags)
  const lookup = new Map(replacements.map(({ from, to }) => [flags.includes('i') ? from.toLowerCase() : from, to]))
  return (value) =>
    replacements.length === 0
      ? value
      : value.replace(pattern, (match) => lookup.get(flags.includes('i') ? match.toLowerCase() : match) ?? match)
}

export const anonymizeDeep = (value: unknown, anonymize: Anonymize): unknown => {
  if (typeof value === 'string') {
    return anonymize(value)
  }
  if (Array.isArray(value)) {
    return value.map((item) => anonymizeDeep(item, anonymize))
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, anonymizeDeep(item, anonymize)]))
  }
  return value
}
