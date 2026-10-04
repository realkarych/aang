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
