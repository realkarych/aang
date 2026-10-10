import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { promisify } from 'node:util'

interface ProcessEntry {
  readonly pid: number
  readonly ppid: number
  readonly pgid: number
  readonly start: string
  readonly name: string
}

export type DepartedProcess = Pick<ProcessEntry, 'pid' | 'pgid' | 'name'>

export interface ProcessGroupWatch {
  readonly finish: () => Promise<readonly DepartedProcess[]>
}

const vanished = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ESRCH')

const released = (pgid: number): boolean => pgid < 0

const procEntry = async (pid: string): Promise<ProcessEntry[]> => {
  let stat: string
  try { stat = await readFile(`/proc/${pid}/stat`, 'utf8') }
  catch (error) {
    if (vanished(error)) return []
    throw error
  }
  const close = stat.lastIndexOf(')')
  const fields = stat.slice(close + 2).split(' ')
  const pgid = Number(fields[2])
  if (released(pgid)) return []
  return [{ pid: Number(pid), ppid: Number(fields[1]), pgid, start: fields[19] ?? '', name: stat.slice(stat.indexOf('(') + 1, close) }]
}

const linuxTable = async (): Promise<ProcessEntry[]> => {
  const pids = (await readdir('/proc')).filter((name) => /^\d+$/.test(name))
  const table: ProcessEntry[] = []
  for (let start = 0; start < pids.length; start += 64) table.push(...(await Promise.all(pids.slice(start, start + 64).map(procEntry))).flat())
  return table
}

const psTable = async (): Promise<ProcessEntry[]> => {
  const { stdout } = await promisify(execFile)('/bin/ps', ['-A', '-o', 'pid=,ppid=,pgid=,lstart=,comm='], { env: { LC_ALL: 'C', PATH: '/usr/bin:/bin' }, maxBuffer: 64 * 1024 * 1024 })
  return stdout.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.*)$/.exec(line)
    return match === null ? [] : [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), start: match[4] ?? '', name: basename((match[5] ?? '').trim().replace(/^\((.*)\)$/, '$1')) }]
  })
}

const processTable = async (): Promise<ProcessEntry[]> => {
  const table = process.platform === 'linux' ? await linuxTable() : await psTable()
  if (!table.some((entry) => entry.pid === process.pid)) throw new Error('process table does not list the daemon')
  return table
}

const identity = (entry: ProcessEntry): string => `${String(entry.pid)}:${entry.start}`

export const watchProcessGroup = (pgid: number): ProcessGroupWatch => {
  const known = new Set<string>()
  const departed = new Map<string, ProcessEntry>()
  let root: string | undefined
  const sample = async (): Promise<void> => {
    const table = await processTable()
    const leader = table.find((entry) => entry.pid === pgid)
    if (root === undefined && leader !== undefined) root = identity(leader)
    const members = new Set(table.filter((entry) => identity(entry) === root || known.has(identity(entry)) || entry.pgid === pgid).map((entry) => entry.pid))
    for (let grew = true; grew;) {
      grew = false
      for (const entry of table) {
        if (members.has(entry.pid) || !members.has(entry.ppid)) continue
        members.add(entry.pid)
        grew = true
      }
    }
    for (const entry of table) {
      if (!members.has(entry.pid)) continue
      known.add(identity(entry))
      if (entry.pgid !== pgid) departed.set(`${identity(entry)}:${String(entry.pgid)}`, entry)
    }
  }
  const watching = new AbortController()
  let failure: { readonly error: unknown } | undefined
  const loop = (async () => {
    while (!watching.signal.aborted && failure === undefined) {
      await sample().catch((error: unknown) => { failure = { error } })
      await setTimeout(25)
    }
  })()
  return {
    finish: async () => {
      watching.abort()
      await loop
      if (failure !== undefined) throw failure.error
      await sample()
      return [...departed.values()]
    },
  }
}
