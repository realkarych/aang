import { spawn } from 'node:child_process'

export interface Completed {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}

export interface RunOptions {
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
  readonly input?: string | Uint8Array
}

const windows = process.platform === 'win32'

const quoteForCmd = (value: string): string => (/^[A-Za-z0-9_\-.:\\/=@]+$/.test(value) ? value : `"${value}"`)

export const run = (command: string, args: readonly string[], { input, ...options }: RunOptions = {}): Promise<Completed> =>
  new Promise((resolve, reject) => {
    const throughShell = windows && /\.cmd$/i.test(command)
    const child = throughShell
      ? spawn([command, ...args].map(quoteForCmd).join(' '), { ...options, shell: true, windowsHide: true })
      : spawn(command, args, { ...options, windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => {
      resolve({ code, stdout, stderr })
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(input ?? '')
  })

const npmCommand = windows ? 'npm.cmd' : 'npm'

export const npm = async (args: readonly string[], options: RunOptions = {}): Promise<string> => {
  const completed = await run(npmCommand, args, options)
  if (completed.code !== 0) {
    throw new Error(`npm ${args.join(' ')} exited with ${String(completed.code)}: ${completed.stderr.trim()}`)
  }
  return completed.stdout
}
