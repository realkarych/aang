import { ApiError, endpoints } from '@aang/contract'
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

const callDaemon = async <B extends z.ZodType, R extends z.ZodType>(
  spec: AdminSpec<B, R>,
  body: z.output<B>,
): Promise<z.output<R>> => {
  const paths = aangHomePaths(resolveAangHome(processEnvironment()))
  const state = await readDaemonState(paths.daemonState)
  if (state === null || !isAlive(state.pid)) {
    throw new Error('aang is not running; start it with `aang start`')
  }
  const token = await readUiToken(paths.uiToken)
  if (token === null) {
    throw new Error(`no UI token in ${paths.uiToken}`)
  }
  const response = await fetch(`${daemonUrl(state.api)}${spec.path}`, {
    method: spec.method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(spec.body.encode(body)),
    signal: AbortSignal.timeout(requestTimeoutMs),
  })
  const answer: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const failure = ApiError.safeParse(answer)
    throw new Error(failure.success ? failure.data.error.message : `the daemon answered ${String(response.status)}`)
  }
  return spec.response.parse(answer)
}

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
