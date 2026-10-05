import { spawn } from 'node:child_process'

export interface Completed {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}

export interface RunOptions {
  readonly input?: string
}

export const docker = (args: readonly string[], { input }: RunOptions = {}): Promise<Completed> =>
  new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', reject).on('close', (code) => {
      resolve({ code, stdout, stderr })
    })
    child.stdin.end(input)
  })

export const dockerOk = async (args: readonly string[], options: RunOptions = {}): Promise<string> => {
  const result = await docker(args, options)
  if (result.code !== 0) {
    throw new Error(`docker ${args.join(' ')} exited with ${String(result.code)}\n${result.stdout}${result.stderr}`)
  }
  return result.stdout
}
