import type { EpochNs } from '@aang/contract'
import { loadConfig, processEnvironment, resolveAangHome } from '@aang/contract/config-file'
import { aangHomePaths, type DaemonState, readDaemonState, readSpoolState, type SpoolState } from '@aang/contract/home'
import { daemonUrl, isAlive } from './daemon-process.js'
import { describeError, type Output } from './output.js'

const isoTime = (time: EpochNs): string => new Date(Number(time / 1_000_000n)).toISOString()

const leaseLine = ({ leaseExpiresAt }: SpoolState): string => {
  if (leaseExpiresAt === null) {
    return 'lease: none'
  }
  const now = BigInt(Date.now()) * 1_000_000n
  return leaseExpiresAt > now ? `lease: valid until ${isoTime(leaseExpiresAt)}` : `lease: expired at ${isoTime(leaseExpiresAt)}`
}

const daemonLine = (state: DaemonState | null, alive: boolean): string => {
  if (state === null) {
    return 'daemon: not running'
  }
  return alive
    ? `daemon: running, pid ${String(state.pid)}, ${daemonUrl(state.api)}`
    : `daemon: not running (stale state of pid ${String(state.pid)})`
}

const thresholdLines = async (output: Output, state: DaemonState | null, spool: SpoolState): Promise<string[]> => {
  const environment = processEnvironment()
  const threshold = await loadConfig(environment).then(
    ({ config }) => `threshold: ${String(config.spool.thresholdBytes)} bytes`,
    (error: unknown) => {
      output.error(`aang status: ${describeError(error)}`)
      return 'threshold: unknown, the config is invalid'
    },
  )
  const over = state?.spool_over_threshold ?? null
  return over === null
    ? [threshold]
    : [
        threshold,
        `over threshold since ${isoTime(over.detected_at)}: ${String(over.bytes)} bytes at detection, ${String(Math.max(0, spool.bytes - over.bytes))} bytes of growth since`,
      ]
}

export const status = async (output: Output): Promise<number> => {
  const paths = aangHomePaths(resolveAangHome(processEnvironment()))
  const state = await readDaemonState(paths.daemonState)
  const alive = state !== null && isAlive(state.pid)
  const spool = await readSpoolState(paths.spool)
  const lines = [
    `aang home: ${paths.home}`,
    daemonLine(state, alive),
    `spool: ${String(spool.files)} files, ${String(spool.bytes)} bytes`,
    leaseLine(spool),
    `stop marker: ${spool.stopped ? 'set' : 'not set'}`,
    ...(await thresholdLines(output, alive ? state : null, spool)),
  ]
  for (const line of lines) {
    output.out(line)
  }
  return 0
}
