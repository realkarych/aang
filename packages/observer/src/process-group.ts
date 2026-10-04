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

export interface ProcessGroupWatch {
  readonly finish: () => Promise<readonly string[]>
}

const execute = promisify(execFile)

const procEntry = async (pid: string): Promise<ProcessEntry[]> => {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
    const close = stat.lastIndexOf(')')
    const fields = stat.slice(close + 2).split(' ')
    return [{ pid: Number(pid), ppid: Number(fields[1]), pgid: Number(fields[2]), start: fields[19] ?? '', name: stat.slice(stat.indexOf('(') + 1, close) }]
  } catch { return [] }
}

const linuxTable = async (): Promise<ProcessEntry[]> =>
  (await Promise.all((await readdir('/proc')).filter((name) => /^\d+$/.test(name)).map(procEntry))).flat()

const psTable = async (): Promise<ProcessEntry[]> => {
  const { stdout } = await execute('/bin/ps', ['-A', '-o', 'pid=,ppid=,pgid=,lstart=,comm='], { env: { LC_ALL: 'C', PATH: '/usr/bin:/bin' }, maxBuffer: 64 * 1024 * 1024 })
  return stdout.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.*)$/.exec(line)
    return match === null ? [] : [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), start: match[4] ?? '', name: basename((match[5] ?? '').trim().replace(/^\((.*)\)$/, '$1')) }]
  })
}

const processTable = (): Promise<ProcessEntry[]> => process.platform === 'linux' ? linuxTable() : psTable()

const identity = (entry: ProcessEntry): string => `${String(entry.pid)}:${entry.start}`

export const watchProcessGroup = (pgid: number): ProcessGroupWatch => {
  const known = new Set<string>()
  const departed = new Map<string, string>()
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
      if (entry.pgid !== pgid) departed.set(identity(entry), entry.name)
    }
  }
  const watching = new AbortController()
  const loop = (async () => {
    while (!watching.signal.aborted) {
      await sample().catch(() => undefined)
      await setTimeout(25)
    }
  })()
  return {
    finish: async () => {
      watching.abort()
      await loop
      await sample()
      return [...new Set(departed.values())].sort()
    },
  }
}
