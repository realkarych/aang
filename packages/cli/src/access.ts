import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { processEnvironment, resolveCatacombHome } from '@catacomb/contract/config-file'
import { catacombHomePaths, readDaemonState } from '@catacomb/contract/home'
import { daemonUrl, isAlive } from './daemon-process.js'
import { newSecret, preparePrivateHome, writeUiToken } from './home.js'
import type { Output } from './output.js'

export const openLink = async (output: Output): Promise<number> => {
  const paths = catacombHomePaths(resolveCatacombHome(processEnvironment()))
  const state = await readDaemonState(paths.daemonState)
  if (state === null || !isAlive(state.pid)) {
    output.error('catacomb open: catacomb is not running; start it with `catacomb start`')
    return 1
  }
  const code = newSecret()
  await mkdir(paths.authCodes, { recursive: true, mode: 0o700 })
  await writeFile(join(paths.authCodes, code), '', { flag: 'wx', mode: 0o600 })
  output.out(`${daemonUrl(state.api)}/auth/${code}`)
  return 0
}

export const rotateToken = async (output: Output): Promise<number> => {
  const paths = catacombHomePaths(resolveCatacombHome(processEnvironment()))
  await preparePrivateHome(paths)
  await rm(paths.authCodes, { recursive: true, force: true })
  const token = newSecret()
  await writeUiToken(paths, token)
  output.out(token)
  output.error('catacomb token rotate: the UI token is replaced; sign in again with `catacomb open`')
  return 0
}
