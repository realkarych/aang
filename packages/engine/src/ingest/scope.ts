import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { CheckContract, ScopeDecision } from '@aang/contract'
import { readGit } from './git.js'

export interface WatchedRoot {
  readonly path: string
  readonly contracts?: readonly CheckContract[]
}

export interface WatchedRoots {
  readonly all: boolean
  readonly roots: readonly WatchedRoot[]
}

export type ScopeJudge = (cwd: string) => Promise<ScopeDecision>

const canonicalPath = async (path: string): Promise<string> => {
  const absolute = resolve(path)
  return realpath(absolute).catch(() => absolute)
}

export const contains = (root: string, path: string): boolean => {
  const relation = relative(root, path)
  return relation === '' || (!isAbsolute(relation) && relation !== '..' && !relation.startsWith(`..${sep}`))
}

const commonGitDirectory = async (directory: string): Promise<string | null> => {
  try {
    const stdout = await readGit(directory, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
    return await canonicalPath(stdout.trim())
  } catch {
    return null
  }
}

const once = <T>(compute: () => Promise<T>): (() => Promise<T>) => {
  let value: Promise<T> | undefined
  return () => (value ??= compute())
}

export const createScopeJudge = (watch: WatchedRoots): ScopeJudge => {
  const roots = once(() => Promise.all(watch.roots.map(({ path }) => canonicalPath(path))))
  const rootRepositories = once(async () => Promise.all((await roots()).map(commonGitDirectory)))
  const judgeDirectory = async (cwd: string): Promise<ScopeDecision> => {
    const directory = await canonicalPath(cwd)
    if ((await roots()).some((root) => contains(root, directory))) {
      return 'watched'
    }
    const repository = await commonGitDirectory(directory)
    return repository !== null && (await rootRepositories()).includes(repository) ? 'watched' : 'external'
  }
  return async (cwd) => (watch.all ? 'watched' : judgeDirectory(cwd))
}
