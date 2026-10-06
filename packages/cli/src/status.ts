import { endpoints, type EpochNs, type HookInstallation, type StatusResponse, type VersionKey } from '@aang/contract'
import { loadConfig, processEnvironment, resolveAangHome } from '@aang/contract/config-file'
import { aangHomePaths, type DaemonState, readDaemonState, readSpoolState, type SpoolState } from '@aang/contract/home'
import { callDaemon, readDaemon } from './admin.js'
import { daemonUrl, isAlive } from './daemon-process.js'
import { describeError, type Output } from './output.js'
import { codexHookSlowdown, codexHooksOffByDefault, onWindows } from './windows.js'

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

const hooksCheckTimeoutMs = 60_000
const storedStatusTimeoutMs = 10_000

const hookNotes: Readonly<Record<HookInstallation, string>> = {
  not_installed: 'not installed',
  untrusted: 'not trusted; trust them in Codex with /hooks',
  disabled: 'disabled',
  active: 'active',
  unknown: 'unknown, the check did not succeed',
}

const versionName = ({ runtime, surface, engine_version: version }: VersionKey): string =>
  surface === null ? `${runtime} ${version} of an unknown surface` : `${surface} ${version}`

const sessionCount = (count: number): string => `${String(count)} ${count === 1 ? 'session' : 'sessions'}`

const windowsCodexNotes: Readonly<Record<HookInstallation, readonly string[]>> = {
  not_installed: [`codex: ${codexHooksOffByDefault}`],
  untrusted: [`codex: ${codexHookSlowdown}`],
  disabled: [`codex: ${codexHookSlowdown}`],
  active: [`codex: ${codexHookSlowdown}`],
  unknown: [],
}

const connectionLines = ({ runtimes, versions, not_observable: unobservable }: StatusResponse): string[] => [
  ...runtimes.flatMap(({ runtime, hooks, hooks_inactive_sessions: inactive, double_registration_sessions: twice }) => [
    `${runtime} hooks: ${hookNotes[hooks]}`,
    ...(onWindows && runtime === 'codex' ? windowsCodexNotes[hooks] : []),
    ...(inactive.length === 0 ? [] : [`${runtime}: hooks inactive in ${sessionCount(inactive.length)}`]),
    ...(twice.length === 0 ? [] : [`${runtime}: hooks registered twice in ${sessionCount(twice.length)}`]),
  ]),
  ...versions.map(
    ({ key, status: support, sessions }) =>
      `version ${versionName(key)} on ${key.os} (${key.placement}): ${support}, ${sessionCount(sessions)}`,
  ),
  `not observable: ${unobservable.join(', ')}`,
]

interface Connection {
  readonly lines: readonly string[]
  readonly code: number
}

const connection = async (output: Output): Promise<Connection> => {
  try {
    return { lines: connectionLines(await callDaemon(endpoints.hooksCheck, {}, hooksCheckTimeoutMs)), code: 0 }
  } catch (error) {
    output.error(`aang status: the hooks check failed: ${describeError(error)}`)
  }
  try {
    const stored = await readDaemon(endpoints.status, storedStatusTimeoutMs)
    return { lines: ['hooks: not checked now, the last stored state follows', ...connectionLines(stored)], code: 0 }
  } catch (error) {
    output.error(`aang status: the connection state is unavailable: ${describeError(error)}`)
    return { lines: [], code: 1 }
  }
}

const disconnected: Connection = { lines: [], code: 0 }

export const status = async (output: Output): Promise<number> => {
  const paths = aangHomePaths(resolveAangHome(processEnvironment()))
  const state = await readDaemonState(paths.daemonState)
  const alive = state !== null && isAlive(state.pid)
  const spool = await readSpoolState(paths.spool)
  const threshold = await thresholdLines(output, alive ? state : null, spool)
  const connected = alive ? await connection(output) : disconnected
  const lines = [
    `aang home: ${paths.home}`,
    daemonLine(state, alive),
    `spool: ${String(spool.files)} files, ${String(spool.bytes)} bytes`,
    leaseLine(spool),
    `stop marker: ${spool.stopped ? 'set' : 'not set'}`,
    ...threshold,
    ...connected.lines,
  ]
  for (const line of lines) {
    output.out(line)
  }
  return connected.code
}
