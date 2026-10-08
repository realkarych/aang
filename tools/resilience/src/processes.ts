import { execFileSync, spawn, spawnSync } from 'node:child_process'

export const windows = process.platform === 'win32'

export interface Finished {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
}

export interface Launched {
  readonly pid: number
  readonly done: Promise<Finished>
  readonly running: () => boolean
  readonly terminate: () => void
  readonly kill: () => Promise<Finished>
}

export interface LaunchOptions {
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly timeoutMs: number
  readonly input?: string
}

const killTree = (pid: number): void => {
  if (windows) {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    return
  }
}

export const launch = (command: string, args: readonly string[], options: LaunchOptions): Launched => {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: !windows,
    windowsHide: true,
  })
  let stdout = ''
  let stderr = ''
  let timedOut = false
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk
  })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk
  })
  child.stdin.on('error', () => undefined)
  child.stdin.end(options.input ?? '')
  const pid = child.pid
  const timer = setTimeout(() => {
    timedOut = true
    if (pid !== undefined) killTree(pid)
  }, options.timeoutMs)
  const done = new Promise<Finished>((resolve, reject) => {
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, stdout, stderr, timedOut })
    })
  })
  const running = (): boolean => child.exitCode === null && child.signalCode === null
  const terminate = (): void => {
    if (pid !== undefined && running()) killTree(pid)
  }
  return {
    pid: pid ?? -1,
    done,
    running,
    terminate,
    kill: async () => {
      terminate()
      return done
    },
  }
}

export const runToEnd = async (command: string, args: readonly string[], options: LaunchOptions): Promise<Finished> =>
  launch(command, args, options).done

export interface ProcessEntry {
  readonly pid: number
  readonly parent: number
  readonly command: string
}

const listProcesses = (): ProcessEntry[] => {
  try {
    const output = windows
      ? execFileSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            '[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.CommandLine)" }',
          ],
          { encoding: 'utf8', windowsHide: true, timeout: 60_000 },
        )
      : execFileSync('ps', ['-A', '-o', 'pid=,ppid=,args='], { encoding: 'utf8', timeout: 60_000 })
    return output.split(/\r?\n/).flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s*(.*)$/.exec(line)
      return match === null ? [] : [{ pid: Number(match[1]), parent: Number(match[2]), command: match[3] ?? '' }]
    })
  } catch {
    return []
  }
}

const comparable = (text: string): string => (windows ? text.replaceAll('/', '\\').toLowerCase() : text)

export const processTree = (roots: readonly number[], directory: string): ProcessEntry[] => {
  const listed = listProcesses().filter(({ pid }) => pid !== process.pid)
  const selected = new Set(
    listed
      .filter(({ pid, command }) => roots.includes(pid) || comparable(command).includes(comparable(directory)))
      .map(({ pid }) => pid),
  )
  let grown = true
  while (grown) {
    const children = listed.filter(({ pid, parent }) => !selected.has(pid) && selected.has(parent))
    for (const { pid } of children) selected.add(pid)
    grown = children.length > 0
  }
  return listed.filter(({ pid }) => selected.has(pid))
}

export const exists = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export const killProcess = (pid: number): void => {
  if (windows) {
    killTree(pid)
    return
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    return
  }
}

export const shellPath = (path: string): string => `"${path.replaceAll('\\', '/')}"`

export const tail = (text: string, limit = 1200): string =>
  text.length <= limit ? text.trim() : `…${text.slice(-limit).trim()}`
