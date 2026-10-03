import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FactOf, JsonValue } from '@aang/contract'
import { fieldOf } from '../checks/commands.js'

type Start = FactOf<'action_start'>

const present = (path: string | null): string | null => (path === '' ? null : path)

const pathOf = (value: JsonValue | undefined): string | null => {
  if (typeof value !== 'string' || value === '') {
    return null
  }
  if (!value.startsWith('file:')) {
    return value
  }
  try {
    return fileURLToPath(value)
  } catch {
    return null
  }
}

const explicitOf = ({ payload }: Start): string | null =>
  pathOf(fieldOf(payload.input, 'workdir')) ?? pathOf(fieldOf(payload.input, 'cwd'))

export const resolvedPath = (path: string, base: string | null): string | null =>
  isAbsolute(path) ? resolve(path) : base === null ? null : resolve(base, path)

export const actionDirectory = (starts: readonly Start[], session: string | null): string | null => {
  const ambient = starts.map(({ runtime_env }) => present(runtime_env.cwd)).find((cwd) => cwd !== null) ?? present(session)
  const explicit = starts.map(explicitOf).find((directory) => directory !== null)
  return explicit === undefined ? ambient : resolvedPath(explicit, ambient)
}
