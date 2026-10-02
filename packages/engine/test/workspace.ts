import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

type Awaitable<T> = T | Promise<T>

export type Register = (cleanup: () => Awaitable<void>) => void

export interface Workspace {
  readonly repository: string
  readonly nested: string
  readonly worktree: string
  readonly otherRepository: string
  readonly outside: string
  readonly missing: string
}

const run = promisify(execFile)

const gitEnvironment = (): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: join(tmpdir(), 'aang-engine-no-gitconfig'),
})

const git = async (cwd: string, ...args: readonly string[]): Promise<void> => {
  await run('git', ['-c', 'user.name=aang', '-c', 'user.email=aang@example.invalid', ...args], {
    cwd,
    env: gitEnvironment(),
  })
}

const createRepository = async (path: string): Promise<void> => {
  await mkdir(path, { recursive: true })
  await git(path, 'init', '--quiet', '--initial-branch=main')
  await git(path, 'commit', '--quiet', '--allow-empty', '--message=init')
}

export const createWorkspace = async (register: Register): Promise<Workspace> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aang-workspace-')))
  register(() => rm(root, { recursive: true, force: true, maxRetries: 5 }))
  const repository = join(root, 'projects', 'watched')
  const nested = join(repository, 'packages', 'app')
  const worktree = join(root, 'worktrees', 'watched-feature')
  const otherRepository = join(root, 'projects', 'other')
  const outside = join(root, 'scratch')
  await createRepository(repository)
  await mkdir(nested, { recursive: true })
  await git(repository, 'worktree', 'add', '--quiet', '-b', 'feature', worktree)
  await createRepository(otherRepository)
  await mkdir(outside, { recursive: true })
  return { repository, nested, worktree, otherRepository, outside, missing: join(root, 'removed', 'project') }
}
