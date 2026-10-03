import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

const gitTimeoutMs = 10_000

const gitEnvironment = (): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
  GIT_OPTIONAL_LOCKS: '0',
})

export const worktreeOf = async (directory: string): Promise<string | null> => {
  try {
    const { stdout } = await run('git', ['rev-parse', '--show-toplevel'], {
      cwd: directory,
      env: gitEnvironment(),
      timeout: gitTimeoutMs,
      windowsHide: true,
    })
    return resolve(stdout.trim())
  } catch {
    return null
  }
}
