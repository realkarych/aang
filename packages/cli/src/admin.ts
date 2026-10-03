import { join } from 'node:path'
import { ApiError, endpoints } from '@aang/contract'
import { loadConfig, processEnvironment, resolveAangHome } from '@aang/contract/config-file'
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

const restartNotice = 'then restart the Codex TUI daemon with `codex app-server daemon restart` and restart Codex Desktop'

export const otelConfig = async (output: Output, rotate: boolean): Promise<number> => {
  const { runtimeRoots } = await loadConfig(processEnvironment())
  const codexConfig = join(runtimeRoots.codex, 'config.toml')
  const { endpoint } = await callDaemon(endpoints.otelConfig, { rotate })
  output.out('[otel]')
  output.out(`exporter = { otlp-http = { endpoint = ${JSON.stringify(endpoint)}, protocol = "json" } }`)
  output.error(
    rotate
      ? `aang otel-config: the OTel ingest token is replaced and the previous endpoint no longer accepts records; replace the [otel] section in ${codexConfig}, ${restartNotice}`
      : `aang otel-config: add this section to ${codexConfig} yourself, aang does not change it; ${restartNotice}`,
  )
  return 0
}
