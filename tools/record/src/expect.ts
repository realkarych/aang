import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { delimiter, resolve } from 'node:path'
import { EngineUnavailableError } from './scenario.js'

const isExecutable = async (path: string): Promise<boolean> =>
  (await stat(path).catch(() => undefined))?.isFile() === true && await access(path, constants.X_OK).then(() => true, () => false)

export const resolveExpect = async (): Promise<string> => {
  for (const directory of (process.env['PATH'] ?? '').split(delimiter).filter(Boolean)) {
    const candidate = resolve(directory, 'expect')
    if (await isExecutable(candidate)) return candidate
  }
  throw new EngineUnavailableError('expect is not on PATH; TUI scenarios are driven through expect')
}
