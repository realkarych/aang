import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type { ScopeDecision } from '@aang/contract'
import type { Evidence } from './parse.js'

export interface WatchedRoots {
  readonly all: boolean
  readonly roots: readonly { readonly path: string }[]
}

export type ScopeJudge = (evidence: Evidence) => Promise<ScopeDecision | null>

const run = promisify(execFile)
const gitTimeoutMs = 10_000

const canonicalPath = async (path: string): Promise<string> => {
  const absolute = resolve(path)
  return realpath(absolute).catch(() => absolute)
}

const contains = (root: string, path: string): boolean => {
  const relation = relative(root, path)
  return relation === '' || (!isAbsolute(relation) && relation !== '..' && !relation.startsWith(`..${sep}`))
}

const gitEnvironment = (): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
  GIT_OPTIONAL_LOCKS: '0',
})

const commonGitDirectory = async (directory: string): Promise<string | null> => {
  try {
    const { stdout } = await run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: directory,
      env: gitEnvironment(),
      timeout: gitTimeoutMs,
      windowsHide: true,
    })
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
  return async ({ observer, cwd }) => {
    if (observer) {
      return 'observer'
    }
    if (cwd === null) {
      return null
    }
    return watch.all ? 'watched' : judgeDirectory(cwd.path)
  }
}
