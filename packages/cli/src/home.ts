import { randomBytes } from 'node:crypto'
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises'
import { type AangHomePaths, readUiToken } from '@aang/contract/home'

export const newSecret = (): string => randomBytes(32).toString('base64url')

export const preparePrivateHome = async (paths: AangHomePaths): Promise<void> => {
  await mkdir(paths.home, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') {
    await chmod(paths.home, 0o700)
  }
}

export const writeUiToken = async (paths: AangHomePaths, token: string): Promise<void> => {
  const staging = `${paths.uiToken}.${String(process.pid)}.tmp`
  await writeFile(staging, `${token}\n`, { mode: 0o600 })
  await rename(staging, paths.uiToken)
}

export const ensureUiToken = async (paths: AangHomePaths): Promise<void> => {
  if ((await readUiToken(paths.uiToken)) === null) {
    await writeUiToken(paths, newSecret())
  }
}
