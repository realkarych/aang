import { posix, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FactOf, JsonValue } from '@aang/contract'
import { fieldOf } from '../checks/commands.js'

type Start = FactOf<'action_start'>

const present = (path: string | null): string | null => (path === '' ? null : path)

const windowsAbsolute = /^(?:[A-Za-z]:[\\/]|\\\\)/

export const isWindowsPath = (path: string): boolean => windowsAbsolute.test(path)

const fileUrlPath = (value: string): string | null => {
  try {
    const url = new URL(value)
    const remote = url.hostname !== '' && url.hostname !== 'localhost'
    return fileURLToPath(url, { windows: remote || /^\/[A-Za-z]:/.test(url.pathname) })
  } catch {
    return null
  }
}

const pathOf = (value: JsonValue | undefined): string | null => {
  if (typeof value !== 'string' || value === '') {
    return null
  }
  return value.startsWith('file:') ? fileUrlPath(value) : value
}

const explicitOf = ({ payload }: Start): string | null =>
  pathOf(fieldOf(payload.input, 'workdir')) ?? pathOf(fieldOf(payload.input, 'cwd'))

export const resolvedPath = (path: string, base: string | null): string | null => {
  if (isWindowsPath(path)) {
    return win32.resolve(path)
  }
  if (base !== null && isWindowsPath(base)) {
    return win32.resolve(base, path)
  }
  if (posix.isAbsolute(path)) {
    return posix.resolve(path)
  }
  return base !== null && posix.isAbsolute(base) ? posix.resolve(base, path) : null
}

export const actionDirectory = (starts: readonly Start[], session: string | null): string | null => {
  const ambient = starts.map(({ runtime_env }) => present(runtime_env.cwd)).find((cwd) => cwd !== null) ?? present(session)
  const explicit = starts.map(explicitOf).find((directory) => directory !== null)
  return explicit === undefined ? ambient : resolvedPath(explicit, ambient)
}
