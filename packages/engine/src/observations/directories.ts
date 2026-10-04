import { posix, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FactOf, JsonValue } from '@aang/contract'
import { fieldOf } from '../checks/commands.js'

type Start = FactOf<'action_start'>

const present = (path: string | null): string | null => (path === '' ? null : path)

const windowsAbsolute = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/

const windowsDrive = /^\/[A-Za-z](?::|%3A)/i

const isAbsolute = (path: string): boolean => windowsAbsolute.test(path) || posix.isAbsolute(path)

const dialectOf = (path: string) => (windowsAbsolute.test(path) ? win32 : posix)

const pathOf = (value: JsonValue | undefined): string | null => {
  if (typeof value !== 'string' || value === '') {
    return null
  }
  if (!value.startsWith('file:')) {
    return value
  }
  try {
    const url = new URL(value)
    return fileURLToPath(url, { windows: url.hostname !== '' || windowsDrive.test(url.pathname) })
  } catch {
    return null
  }
}

const explicitOf = ({ payload }: Start): string | null =>
  pathOf(fieldOf(payload.input, 'workdir')) ?? pathOf(fieldOf(payload.input, 'cwd'))

export const resolvedPath = (path: string, base: string | null): string | null => {
  if (windowsAbsolute.test(path)) {
    return win32.resolve(path)
  }
  if (base !== null && isAbsolute(base)) {
    return dialectOf(base).resolve(base, path)
  }
  return posix.isAbsolute(path) ? posix.resolve(path) : null
}

export const actionDirectory = (starts: readonly Start[], session: string | null): string | null => {
  const ambient = starts.map(({ runtime_env }) => present(runtime_env.cwd)).find((cwd) => cwd !== null) ?? present(session)
  const explicit = starts.map(explicitOf).find((directory) => directory !== null)
  return explicit === undefined ? ambient : resolvedPath(explicit, ambient)
}
