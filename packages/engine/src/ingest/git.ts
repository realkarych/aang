import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

const gitTimeoutMs = 10_000

const maxOutputBytes = 64 * 1024 ** 2

const readOnlySettings = ['-c', 'core.fsmonitor=false']

const gitEnvironment = (): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
  GIT_OPTIONAL_LOCKS: '0',
})

export const readGit = async (cwd: string, args: readonly string[]): Promise<string> => {
  const { stdout } = await run('git', [...readOnlySettings, ...args], {
    cwd,
    env: gitEnvironment(),
    timeout: gitTimeoutMs,
    maxBuffer: maxOutputBytes,
    windowsHide: true,
  })
  return stdout
}
