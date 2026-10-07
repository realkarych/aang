import { type ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import { Socket } from 'node:net'
import type { Target } from './manifest.js'

type Env = Readonly<Record<string, string>>

export interface SessionProcesses {
  readonly started: (target: Target) => Promise<Target>
  readonly hookEnv: (env: Env) => Promise<Env>
  readonly mapped: (target: Target) => Target
  readonly content: (target: Target, content: Buffer) => Buffer
  readonly removed: (target: Target) => Promise<void>
  readonly recorded: () => ReadonlyMap<number, number>
  readonly kill: () => Promise<void>
  readonly close: () => Promise<void>
}

const registryEntry = /^sessions\/(\d+)\.json$/

const decimal = /^\d+$/

const pidVariable = 'CLAUDE_PID'

const standInScript = "process.stdin.on('end', () => process.exit(0)).resume()"

const recordedPid = (target: Target): number | null => {
  const match = target.root === 'claude' ? registryEntry.exec(target.path) : null
  return match?.[1] === undefined ? null : Number(match[1])
}

interface StandIn {
  readonly child: ChildProcess
  readonly pid: number
}

const startStandIn = async (): Promise<StandIn> => {
  const child = spawn(process.execPath, ['-e', standInScript], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
  await once(child, 'spawn')
  child.unref()
  if (child.stdin instanceof Socket) {
    child.stdin.unref()
  }
  const { pid } = child
  if (pid === undefined) {
    throw new Error('the stand-in of a recorded session process has no pid')
  }
  return { child, pid }
}

const stopStandIn = async (child: ChildProcess, signal: NodeJS.Signals): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return
  }
  const exited = once(child, 'exit')
  child.kill(signal)
  await exited
}

const entryOf = (target: Target, pid: number): Target => ({ ...target, path: `sessions/${String(pid)}.json` })

export const createSessionProcesses = (): SessionProcesses => {
  const starting = new Map<number, Promise<number>>()
  const live = new Map<number, number>()
  const children = new Map<number, ChildProcess>()
  const assigned = new Map<number, number>()

  const standInPid = (recorded: number): Promise<number> => {
    const known = starting.get(recorded)
    if (known !== undefined) {
      return known
    }
    const started = startStandIn().then(({ child, pid }) => {
      children.set(recorded, child)
      live.set(recorded, pid)
      assigned.set(pid, recorded)
      return pid
    })
    starting.set(recorded, started)
    return started
  }

  const started = async (target: Target): Promise<Target> => {
    const recorded = recordedPid(target)
    return recorded === null ? target : entryOf(target, await standInPid(recorded))
  }

  const hookEnv = async (env: Env): Promise<Env> => {
    const recorded = env[pidVariable]
    return recorded === undefined || !decimal.test(recorded)
      ? env
      : { ...env, [pidVariable]: String(await standInPid(Number(recorded))) }
  }

  const livePid = (target: Target): number | undefined => {
    const recorded = recordedPid(target)
    return recorded === null ? undefined : live.get(recorded)
  }

  const mapped = (target: Target): Target => {
    const pid = livePid(target)
    return pid === undefined ? target : entryOf(target, pid)
  }

  const content = (target: Target, bytes: Buffer): Buffer => {
    const pid = livePid(target)
    if (pid === undefined) {
      return bytes
    }
    let entry: unknown
    try {
      entry = JSON.parse(bytes.toString('utf8'))
    } catch {
      return bytes
    }
    return typeof entry === 'object' && entry !== null && !Array.isArray(entry) && 'pid' in entry && entry.pid === recordedPid(target)
      ? Buffer.from(JSON.stringify({ ...entry, pid }))
      : bytes
  }

  const removed = async (target: Target): Promise<void> => {
    const recorded = recordedPid(target)
    const child = recorded === null ? undefined : children.get(recorded)
    if (recorded !== null && child !== undefined) {
      children.delete(recorded)
      await stopStandIn(child, 'SIGTERM')
    }
  }

  const stopAll = async (signal: NodeJS.Signals): Promise<void> => {
    const stopping = [...children.values()]
    children.clear()
    await Promise.all(stopping.map((child) => stopStandIn(child, signal)))
  }

  return {
    started,
    hookEnv,
    mapped,
    content,
    removed,
    recorded: () => new Map(assigned),
    kill: () => stopAll('SIGKILL'),
    close: () => stopAll('SIGTERM'),
  }
}
