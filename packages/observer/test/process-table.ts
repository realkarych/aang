import childProcess from 'node:child_process'
import { promises } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { promisify } from 'node:util'

export const failNextProcessTableRead = (): (() => void) => {
  const { readdir } = promises
  const { execFile } = childProcess
  const ps = promisify(execFile)
  let pending = true
  const fails = (path: unknown, table: string): boolean => {
    if (!pending || path !== table) return false
    pending = false
    return true
  }
  const unavailable = (): Promise<never> => Promise.reject(Object.assign(new Error('process table is unavailable'), { code: 'EAGAIN' }))
  Reflect.set(promises, 'readdir', (path: unknown, ...rest: unknown[]): unknown => {
    if (fails(path, '/proc')) return unavailable()
    const entries: unknown = Reflect.apply(readdir, promises, [path, ...rest])
    return entries
  })
  Reflect.set(childProcess, 'execFile', Object.assign((...args: unknown[]): unknown => Reflect.apply(execFile, childProcess, args), {
    [promisify.custom]: (file: unknown, ...rest: unknown[]): unknown => {
      if (fails(file, '/bin/ps')) return unavailable()
      return Reflect.apply(ps, undefined, [file, ...rest])
    },
  }))
  syncBuiltinESMExports()
  return () => {
    Reflect.set(promises, 'readdir', readdir)
    Reflect.set(childProcess, 'execFile', execFile)
    syncBuiltinESMExports()
  }
}

const releasedStat = (stat: string): string => {
  const close = stat.lastIndexOf(')')
  const fields = stat.slice(close + 2).split(' ')
  return `${stat.slice(0, close + 2)}${['X', '0', '-1', '-1', '0', '-1', ...fields.slice(6)].join(' ')}`
}

export interface ProcessRelease {
  readonly released: () => readonly number[]
  readonly restore: () => void
}

export const showExitedProcessesWhileReleased = (): ProcessRelease => {
  const { readdir, readFile } = promises
  const seen = new Map<string, string>()
  const releasing = new Set<string>()
  const released = new Set<string>()
  Reflect.set(promises, 'readdir', async (path: unknown, ...rest: unknown[]): Promise<unknown> => {
    const entries: unknown = await Reflect.apply(readdir, promises, [path, ...rest])
    if (path !== '/proc' || !Array.isArray(entries)) return entries
    const listed = entries.map(String)
    const present = new Set(listed)
    for (const pid of seen.keys()) if (!present.has(pid) && !released.has(pid)) releasing.add(pid)
    return [...listed, ...releasing]
  })
  Reflect.set(promises, 'readFile', async (path: unknown, ...rest: unknown[]): Promise<unknown> => {
    const pid = /^\/proc\/(\d+)\/stat$/.exec(String(path))?.[1]
    const stat = pid === undefined ? undefined : seen.get(pid)
    if (pid !== undefined && stat !== undefined && releasing.delete(pid)) {
      released.add(pid)
      return releasedStat(stat)
    }
    const content: unknown = await Reflect.apply(readFile, promises, [path, ...rest])
    if (pid !== undefined && typeof content === 'string') seen.set(pid, content)
    return content
  })
  syncBuiltinESMExports()
  return {
    released: () => [...released].map(Number),
    restore: () => {
      Reflect.set(promises, 'readdir', readdir)
      Reflect.set(promises, 'readFile', readFile)
      syncBuiltinESMExports()
    },
  }
}
