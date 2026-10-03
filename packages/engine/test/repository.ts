import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

type Awaitable<T> = T | Promise<T>

export type Register = (cleanup: () => Awaitable<void>) => void

const run = promisify(execFile)

const gitEnvironment = (): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: join(tmpdir(), 'aang-engine-no-gitconfig'),
})

export const git = async (cwd: string, ...args: readonly string[]): Promise<string> => {
  const { stdout } = await run('git', ['-c', 'user.name=aang', '-c', 'user.email=aang@example.invalid', ...args], {
    cwd,
    env: gitEnvironment(),
  })
  return stdout.trim()
}

export const writeFiles = async (root: string, files: Readonly<Record<string, string>>): Promise<void> => {
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
  }
}

export interface Repository {
  readonly path: string
  readonly head: string | null
}

export const createRepository = async (
  register: Register,
  files: Readonly<Record<string, string>>,
  commit = true,
): Promise<Repository> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aang-repository-')))
  register(() => rm(root, { recursive: true, force: true, maxRetries: 5 }))
  return initRepository(join(root, 'project'), files, commit)
}

export const initRepository = async (
  path: string,
  files: Readonly<Record<string, string>>,
  commit = true,
): Promise<Repository> => {
  await mkdir(path, { recursive: true })
  await git(path, 'init', '--quiet', '--initial-branch=main')
  await writeFiles(path, files)
  if (!commit) {
    return { path, head: null }
  }
  await git(path, 'add', '--all')
  await git(path, 'commit', '--quiet', '--message=init')
  return { path, head: await git(path, 'rev-parse', 'HEAD') }
}
