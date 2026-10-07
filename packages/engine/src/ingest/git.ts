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

const gitOptions = (cwd: string) => ({
  cwd,
  env: gitEnvironment(),
  timeout: gitTimeoutMs,
  maxBuffer: maxOutputBytes,
  windowsHide: true,
})

export const readGit = async (cwd: string, args: readonly string[]): Promise<string> => {
  const { stdout } = await run('git', [...readOnlySettings, ...args], gitOptions(cwd))
  return stdout
}

export const readGitBytes = async (cwd: string, args: readonly string[]): Promise<Buffer> => {
  const { stdout } = await run('git', [...readOnlySettings, ...args], { ...gitOptions(cwd), encoding: 'buffer' })
  return stdout
}
