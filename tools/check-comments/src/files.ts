import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

export interface Problem {
  readonly path: string | undefined
  readonly message: string
}

export interface Discovery {
  readonly base: string
  readonly files: readonly string[]
  readonly problems: readonly Problem[]
}

const skippedDirectories: ReadonlySet<string> = new Set(['.git', 'node_modules'])
const skippedPrefixes: readonly string[] = ['docs/research/samples/']

const compareNames = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)

export const describeError = (error: unknown): string => {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    return error.code
  }
  return error instanceof Error ? error.message : String(error)
}

const git = (cwd: string, args: readonly string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })

const repositoryRoot = (cwd: string): string | undefined => {
  try {
    return resolve(cwd, git(cwd, ['rev-parse', '--show-cdup']).trim())
  } catch {
    return undefined
  }
}

const gitFiles = (root: string): string[] =>
  git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    .split('\0')
    .filter((path) => path !== '')
    .sort(compareNames)
    .map((path) => resolve(root, path))
    .filter((path) => existsSync(path))

const walk = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => compareNames(left.name, right.name))
    .flatMap((entry) => {
      const path = join(directory, entry.name)
      if (!entry.isDirectory()) {
        return [path]
      }
      return skippedDirectories.has(entry.name) ? [] : walk(path)
    })

const pathFiles = (args: readonly string[], cwd: string): { files: string[]; problems: Problem[] } => {
  const files: string[] = []
  const problems: Problem[] = []
  for (const arg of args) {
    const path = resolve(cwd, arg)
    try {
      files.push(...(statSync(path).isDirectory() ? walk(path) : [path]))
    } catch (error) {
      problems.push({ path, message: `cannot read: ${describeError(error)}` })
    }
  }
  return { files, problems }
}

export const isSkipped = (base: string, path: string): boolean => {
  const fromBase = relative(base, path).split(sep).join('/')
  return skippedPrefixes.some((prefix) => fromBase.startsWith(prefix))
}

export const discover = (args: readonly string[], cwd: string): Discovery => {
  const root = repositoryRoot(cwd)
  if (args.length > 0) {
    const { files, problems } = pathFiles(args, cwd)
    return { base: root ?? cwd, files: [...new Set(files)], problems }
  }
  if (root === undefined) {
    return {
      base: cwd,
      files: [],
      problems: [{ path: undefined, message: 'not inside a git repository; pass files or directories to check' }],
    }
  }
  return { base: root, files: [...new Set(gitFiles(root))], problems: [] }
}
