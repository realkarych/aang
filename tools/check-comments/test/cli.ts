import { execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { TestContext } from 'vitest'

export interface CliResult {
  readonly status: number | null
  readonly stdout: readonly string[]
  readonly stderr: readonly string[]
}

const cliPath = fileURLToPath(new URL('../dist/main.js', import.meta.url))

const outputLines = (text: string): string[] => text.split('\n').filter((line) => line !== '')

const isolatedEnvironment = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('GIT_'))),
  ...overrides,
})

export const runCli = (cwd: string, args: readonly string[] = [], env: NodeJS.ProcessEnv = {}): Promise<CliResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], { cwd, env: isolatedEnvironment(env) })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (status) => {
      resolve({ status, stdout: outputLines(stdout), stderr: outputLines(stderr) })
    })
  })

export const createWorkspace = async (
  onTestFinished: TestContext['onTestFinished'],
  files: Readonly<Record<string, string>>,
): Promise<string> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'check-comments-')))
  onTestFinished(() => rm(root, { recursive: true, force: true, maxRetries: 3 }))
  for (const [path, text] of Object.entries(files)) {
    const target = join(root, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, text)
  }
  return root
}

const execFileAsync = promisify(execFile)

export const git = async (cwd: string, args: readonly string[]): Promise<void> => {
  await execFileAsync('git', args, { cwd, env: isolatedEnvironment() })
}
