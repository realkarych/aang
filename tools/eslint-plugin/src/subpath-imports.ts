import { readFileSync } from 'node:fs'
import { join } from 'node:path'

type ImportsField = Readonly<Record<string, unknown>>

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const importsField = (packageDirectory: string): ImportsField => {
  try {
    const manifest: unknown = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8'))
    return isRecord(manifest) && isRecord(manifest.imports) ? manifest.imports : {}
  } catch {
    return {}
  }
}

const leaves = (target: unknown): string[] => {
  if (typeof target === 'string') {
    return [target]
  }
  if (Array.isArray(target)) {
    return target.flatMap(leaves)
  }
  return isRecord(target) ? Object.values(target).flatMap(leaves) : []
}

const keyHead = (key: string): string => key.split('*')[0] ?? key

const bySpecificity = (left: string, right: string): number =>
  keyHead(right).length - keyHead(left).length || right.length - left.length

const exactTargets = (imports: ImportsField, specifier: string): string[] => {
  if (Object.hasOwn(imports, specifier)) {
    return leaves(imports[specifier])
  }
  const [pattern] = Object.keys(imports)
    .filter((key) => {
      const star = key.indexOf('*')
      return (
        star >= 0 &&
        key.indexOf('*', star + 1) < 0 &&
        specifier.length >= key.length &&
        specifier.startsWith(key.slice(0, star)) &&
        specifier.endsWith(key.slice(star + 1))
      )
    })
    .sort(bySpecificity)
  if (pattern === undefined) {
    return []
  }
  const star = pattern.indexOf('*')
  const match = specifier.slice(star, specifier.length - (pattern.length - star - 1))
  return leaves(imports[pattern]).map((target) => target.replaceAll('*', match))
}

const mayMatch = (key: string, prefix: string): boolean =>
  key.startsWith(prefix) || (key.includes('*') && prefix.startsWith(keyHead(key)))

const prefixTargets = (imports: ImportsField, prefix: string): string[] =>
  Object.entries(imports)
    .filter(([key]) => mayMatch(key, prefix))
    .flatMap(([, target]) => leaves(target))

export const isSubpathImport = (specifier: string): boolean => specifier.startsWith('#')

export const subpathImportTargets = (packageDirectory: string, specifier: string, exact: boolean): string[] => {
  const imports = importsField(packageDirectory)
  const targets = exact ? exactTargets(imports, specifier) : prefixTargets(imports, specifier)
  return targets.filter((target) => !target.startsWith('./') && !isSubpathImport(target))
}
