import { mkdir, rm, writeFile } from 'node:fs/promises'
import { endpoints, ShutdownResponse } from '@aang/contract'
import { processEnvironment, resolveAangHome } from '@aang/contract/config-file'
import {
  type AangHomePaths,
  aangHomePaths,
  type DaemonState,
  readDaemonState,
  readUiToken,
  revokeLeases,
} from '@aang/contract/home'
import { daemonUrl, isAlive, waitForExit } from './daemon-process.js'
import { describeError, type Output } from './output.js'

const shutdownTimeoutMs = 5_000
const exitTimeoutMs = 15_000
const exitGraceMs = 2_000

const requestShutdown = async (paths: AangHomePaths, state: DaemonState, output: Output): Promise<boolean> => {
  try {
    const token = await readUiToken(paths.uiToken)
    if (token === null) {
      output.error(`aang stop: no UI token in ${paths.uiToken}, cannot ask the daemon to shut down`)
      return false
    }
    const response = await fetch(`${daemonUrl(state.api)}${endpoints.shutdown.path}`, {
      method: endpoints.shutdown.method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(shutdownTimeoutMs),
    })
    return response.ok && ShutdownResponse.safeParse(await response.json()).success
  } catch (error) {
    output.error(`aang stop: the daemon API did not answer: ${describeError(error)}`)
    return false
  }
}

const readState = async (paths: AangHomePaths, output: Output): Promise<DaemonState | null> => {
  try {
    return await readDaemonState(paths.daemonState)
  } catch (error) {
    output.error(`aang stop: ignoring unreadable ${paths.daemonState}: ${describeError(error)}`)
    return null
  }
}

export const stop = async (output: Output): Promise<number> => {
  const paths = aangHomePaths(resolveAangHome(processEnvironment()))
  await mkdir(paths.spool, { recursive: true, mode: 0o700 })
  await writeFile(paths.stoppedMarker, '')
  const state = await readState(paths, output)
  if (state !== null && (await requestShutdown(paths, state, output))) {
    const exited = await waitForExit(state.pid, exitTimeoutMs)
    await revokeLeases(paths.spool)
    if (exited) {
      output.out(`aang stopped: pid ${String(state.pid)}`)
      return 0
    }
    output.error(
      `aang stop: the daemon (pid ${String(state.pid)}) accepted the shutdown but is still running; the stop is not confirmed`,
    )
    return 1
  }
  await revokeLeases(paths.spool)
  if (state !== null && isAlive(state.pid)) {
    if (await waitForExit(state.pid, exitGraceMs)) {
      await rm(paths.daemonState, { force: true })
      output.out(`aang stopped: pid ${String(state.pid)} exited after the stop marker`)
      return 0
    }
    output.error(
      `aang stop: process ${String(state.pid)} is alive but its API did not shut it down; the spool lease is removed and the stop marker is set, but the stop is not confirmed`,
    )
    return 1
  }
  if (state !== null) {
    await rm(paths.daemonState, { force: true })
  }
  output.out('aang is not running; the spool lease is removed and the stop marker is set')
  return 0
}
