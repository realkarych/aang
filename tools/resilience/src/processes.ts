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
  let closed = false
  const running = (): boolean => child.exitCode === null && child.signalCode === null
  const terminate = (): void => {
    if (pid !== undefined && (windows ? running() : !closed)) killTree(pid)
  }
  const timer = setTimeout(() => {
    timedOut = true
    terminate()
  }, options.timeoutMs)
  const done = new Promise<Finished>((resolve, reject) => {
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code, signal) => {
      closed = true
      clearTimeout(timer)
      resolve({ code, signal, stdout, stderr, timedOut })
    })
  })
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

export interface ProcessEntry {
  readonly pid: number
  readonly parent: number
  readonly group: number
  readonly command: string
}

const listingLimit = 64 * 1024 * 1024

const listing = (command: string, args: readonly string[]): string[] => {
  try {
    return execFileSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: listingLimit }).split(
      /\r?\n/,
    )
  } catch {
    return []
  }
}

const listProcesses = (): ProcessEntry[] =>
  windows
    ? listing('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.CommandLine)" }',
      ]).flatMap((line) => {
        const match = /^\s*(\d+)\s+(\d+)\s*(.*)$/.exec(line)
        return match === null ? [] : [{ pid: Number(match[1]), parent: Number(match[2]), group: 0, command: match[3] ?? '' }]
      })
    : listing('ps', ['-A', '-o', 'pid=,ppid=,pgid=,stat=,args=']).flatMap((line) => {
        const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line)
        return match === null || match[4]?.startsWith('Z') === true
          ? []
          : [{ pid: Number(match[1]), parent: Number(match[2]), group: Number(match[3]), command: match[5] ?? '' }]
      })

const environments = (): ReadonlyMap<number, string> =>
  new Map(
    windows
      ? []
      : listing('ps', ['-A', process.platform === 'darwin' ? '-E' : 'e', '-o', 'pid=,args=']).flatMap((line) => {
          const match = /^\s*(\d+) (.*)$/.exec(line)
          return match === null ? [] : [[Number(match[1]), match[2] ?? ''] as const]
        }),
  )

const comparable = (text: string): string => (windows ? text.replaceAll('/', '\\').toLowerCase() : text)

export const processTree = (roots: readonly number[], groups: readonly number[], directory: string): ProcessEntry[] => {
  const listed = listProcesses().filter(({ pid }) => pid !== process.pid)
  const environment = environments()
  const present = new Set(listed.map(({ pid }) => pid))
  const leaders = new Set(groups.filter((group) => group > 0 && (roots.includes(group) || !present.has(group))))
  const names = (entry: ProcessEntry): boolean =>
    [entry.command, environment.get(entry.pid) ?? ''].some((text) => comparable(text).includes(comparable(directory)))
  const selected = new Set(
    listed.filter((entry) => roots.includes(entry.pid) || leaders.has(entry.group) || names(entry)).map(({ pid }) => pid),
  )
  let grown = true
  while (grown) {
    const children = listed.filter(({ pid, parent }) => !selected.has(pid) && selected.has(parent))
    for (const { pid } of children) selected.add(pid)
    grown = children.length > 0
  }
  return listed.filter(({ pid }) => selected.has(pid))
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
