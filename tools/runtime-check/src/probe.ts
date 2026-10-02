import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import type { ChainLink } from './context.js'

const [log = '', label = '', action = 'record', argument = ''] = process.argv.slice(2)

const readStdin = (): Buffer => {
  try {
    return readFileSync(0)
  } catch {
    return Buffer.alloc(0)
  }
}

const hookEvent = (stdin: Buffer): string | null => {
  try {
    const value: unknown = JSON.parse(stdin.toString('utf8'))
    return typeof value === 'object' &&
      value !== null &&
      'hook_event_name' in value &&
      typeof value.hook_event_name === 'string'
      ? value.hook_event_name
      : null
  } catch {
    return null
  }
}

const windowsChain = (pid: number): ChainLink[] => {
  const script = [
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
    `$id=${String(pid)}`,
    '$links=@()',
    'for($i=0;$i -lt 4 -and $id;$i++){',
    '$p=Get-CimInstance Win32_Process -Filter "ProcessId=$id"',
    'if(-not $p){break}',
    '$links+=[pscustomobject]@{pid=[int]$p.ProcessId;ppid=[int]$p.ParentProcessId;name=$p.Name;commandLine=$p.CommandLine;argv=$null}',
    '$id=$p.ParentProcessId}',
    'ConvertTo-Json -InputObject @($links) -Compress',
  ].join(';')
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
  })
  return JSON.parse(output) as ChainLink[]
}

const linuxLink = (pid: number): ChainLink | null => {
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8')
    const closing = stat.lastIndexOf(')')
    const argv = readFileSync(`/proc/${String(pid)}/cmdline`, 'utf8').split('\0')
    return {
      pid,
      ppid: Number(stat.slice(closing + 2).split(' ')[1]),
      name: stat.slice(stat.indexOf('(') + 1, closing),
      commandLine: null,
      argv: argv.at(-1) === '' ? argv.slice(0, -1) : argv,
    }
  } catch {
    return null
  }
}

const psLink = (pid: number): ChainLink | null => {
  try {
    const ps = (field: string): string =>
      execFileSync('ps', ['-o', `${field}=`, '-p', String(pid)], { encoding: 'utf8' }).trim()
    return { pid, ppid: Number(ps('ppid')), name: ps('comm'), commandLine: ps('args'), argv: null }
  } catch {
    return null
  }
}

const posixChain = (pid: number): ChainLink[] => {
  const links: ChainLink[] = []
  let current = pid
  while (links.length < 4 && current > 1) {
    const link = process.platform === 'linux' ? linuxLink(current) : psLink(current)
    if (link === null) {
      break
    }
    links.push(link)
    current = link.ppid ?? 0
  }
  return links
}

const chainOf = (pid: number): readonly ChainLink[] | string => {
  try {
    return process.platform === 'win32' ? windowsChain(pid) : posixChain(pid)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

const write = (entry: Record<string, unknown>): void => {
  appendFileSync(log, `${JSON.stringify({ label, pid: process.pid, at: Date.now(), ...entry })}\n`)
}

const stdin = readStdin()
write({
  action,
  ppid: process.ppid,
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  stdinBytes: stdin.length,
  event: hookEvent(stdin),
  chain: action === 'chain' ? chainOf(process.ppid) : null,
})

if (action === 'exit') {
  process.stderr.write('aang runtime check probe exit\n')
  process.exitCode = Number(argument)
} else if (action === 'sleep') {
  await sleep(Number(argument))
  write({ action: 'slept' })
} else if (action === 'marker') {
  writeFileSync(argument, label)
}
