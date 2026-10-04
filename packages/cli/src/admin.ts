import { resolve } from 'node:path'
import { ApiError, endpoints, EpochNs, type PruneRequest, type WatchState } from '@aang/contract'
import { processEnvironment, resolveAangHome } from '@aang/contract/config-file'
import { aangHomePaths, readDaemonState, readUiToken } from '@aang/contract/home'
import type { z } from 'zod'
import { daemonUrl, isAlive } from './daemon-process.js'
import type { Output } from './output.js'

const requestTimeoutMs = 600_000

interface AdminSpec<B extends z.ZodType, R extends z.ZodType> {
  readonly method: string
  readonly path: string
  readonly body: B
  readonly response: R
}

interface ReadSpec<R extends z.ZodType> {
  readonly method: 'GET'
  readonly path: string
  readonly response: R
}

interface DaemonRequest {
  readonly method: string
  readonly path: string
  readonly body: string | null
  readonly timeoutMs: number
}

const requestDaemon = async <R extends z.ZodType>(request: DaemonRequest, schema: R): Promise<z.output<R>> => {
  const paths = aangHomePaths(resolveAangHome(processEnvironment()))
  const state = await readDaemonState(paths.daemonState)
  if (state === null || !isAlive(state.pid)) {
    throw new Error('aang is not running; start it with `aang start`')
  }
  const token = await readUiToken(paths.uiToken)
  if (token === null) {
    throw new Error(`no UI token in ${paths.uiToken}`)
  }
  const response = await fetch(`${daemonUrl(state.api)}${request.path}`, {
    method: request.method,
    headers:
      request.body === null
        ? { authorization: `Bearer ${token}` }
        : { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: request.body,
    signal: AbortSignal.timeout(request.timeoutMs),
  })
  const answer: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const failure = ApiError.safeParse(answer)
    throw new Error(failure.success ? failure.data.error.message : `the daemon answered ${String(response.status)}`)
  }
  return schema.parse(answer)
}

export const callDaemon = <B extends z.ZodType, R extends z.ZodType>(
  spec: AdminSpec<B, R>,
  body: z.output<B>,
  timeoutMs = requestTimeoutMs,
): Promise<z.output<R>> =>
  requestDaemon(
    { method: spec.method, path: spec.path, body: JSON.stringify(spec.body.encode(body)), timeoutMs },
    spec.response,
  )

export const readDaemon = <R extends z.ZodType>(spec: ReadSpec<R>, timeoutMs = requestTimeoutMs): Promise<z.output<R>> =>
  requestDaemon({ method: spec.method, path: spec.path, body: null, timeoutMs }, spec.response)

export const reparse = async (output: Output): Promise<number> => {
  const result = await callDaemon(endpoints.reparse, {})
  for (const line of [
    `records reparsed: ${String(result.records)}`,
    `facts added: ${String(result.facts_added)}`,
    `facts kept: ${String(result.facts_kept)}`,
    `facts no longer produced: ${String(result.facts_missing)}`,
  ]) {
    output.out(line)
  }
  return 0
}

const watchLines = (state: WatchState): string[] => [
  state.all ? 'watching: all sessions' : `watching: ${String(state.roots.length)} ${state.roots.length === 1 ? 'root' : 'roots'}`,
  ...state.roots.map((root) => `  ${root}`),
  `lookback: ${String(state.lookback_days)} days`,
]

export const watch = async (
  output: Output,
  target: { readonly path: string } | { readonly all: true },
  lookbackDays: number | null,
): Promise<number> => {
  const { watch: state, rescanned_streams: rescanned } = await callDaemon(
    endpoints.watch,
    'path' in target
      ? { scope: 'path', path: resolve(target.path), lookback_days: lookbackDays }
      : { scope: 'all', lookback_days: lookbackDays },
  )
  for (const line of [...watchLines(state), `streams to reread: ${String(rescanned)}`]) {
    output.out(line)
  }
  return 0
}

export const unwatch = async (output: Output, target: { readonly path: string } | { readonly all: true }): Promise<number> => {
  const { watch: state } = await callDaemon(
    endpoints.unwatch,
    'path' in target ? { scope: 'path', path: resolve(target.path) } : { scope: 'all' },
  )
  for (const line of watchLines(state)) {
    output.out(line)
  }
  return 0
}

export const prune = async (output: Output, request: PruneRequest): Promise<number> => {
  const { runs, streams } = await callDaemon(endpoints.prune, request)
  if (runs.length === 0) {
    output.out('no runs to prune')
    return 0
  }
  output.out(`pruned ${String(runs.length)} ${runs.length === 1 ? 'run' : 'runs'}, ${String(streams)} ${streams === 1 ? 'stream' : 'streams'} bounded`)
  for (const run of runs) {
    output.out(`  ${run}`)
  }
  return 0
}

export const epochOfDate = (value: string): EpochNs | null => {
  const milliseconds = Date.parse(value)
  return Number.isNaN(milliseconds) ? null : EpochNs.parse(BigInt(milliseconds) * 1_000_000n)
}
