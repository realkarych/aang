import { execFile } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import {
  endpoints,
  type RunSnapshot,
  type RunSummary,
  type StatusResponse,
} from '@aang/contract'

export interface AangCommand {
  readonly command: string
  readonly prefix: readonly string[]
}

export interface Completed {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

export interface Aang {
  readonly run: (args: readonly string[], timeoutMs?: number) => Promise<Completed>
  readonly ok: (args: readonly string[], timeoutMs?: number) => Promise<string>
}

export const aangCommand = (value: string): AangCommand =>
  value.endsWith('.js') ? { command: process.execPath, prefix: [value] } : { command: value, prefix: [] }

const exitCode = (error: unknown): number =>
  typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'number' ? error.code : 1

export const createAang = (command: AangCommand, env: Readonly<Record<string, string>>): Aang => {
  const run = (args: readonly string[], timeoutMs = 120_000): Promise<Completed> =>
    new Promise((resolve) => {
      execFile(
        command.command,
        [...command.prefix, ...args],
        { env, timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
        (error, stdout, stderr) => {
          resolve({ code: error === null ? 0 : exitCode(error), stdout, stderr })
        },
      )
    })
  return {
    run,
    ok: async (args, timeoutMs) => {
      const result = await run(args, timeoutMs)
      if (result.code !== 0) {
        throw new Error(`aang ${args.join(' ')} exited with ${String(result.code)}\n${result.stdout}${result.stderr}`)
      }
      return result.stdout
    },
  }
}

export const signInLink = (stdout: string): URL => {
  const line = stdout.split('\n').find((candidate) => /^https?:\/\/\S+\/auth\/\S+$/.test(candidate.trim()))
  if (line === undefined) {
    throw new Error(`aang open printed no sign-in link: ${stdout}`)
  }
  return new URL(line.trim())
}

export const otelEndpoint = (stdout: string): string => {
  const endpoint = /endpoint = ("[^"]+")/.exec(stdout)?.[1]
  if (endpoint === undefined) {
    throw new Error(`aang otel-config printed no endpoint: ${stdout}`)
  }
  return JSON.parse(endpoint) as string
}

export interface ApiClient {
  readonly origin: string
  readonly status: () => Promise<StatusResponse>
  readonly runs: () => Promise<RunSummary[]>
  readonly run: (id: string) => Promise<RunSnapshot>
  readonly markViewed: (run: RunSummary) => Promise<number>
}

const cookieOf = (response: Response): string => {
  const cookie = response.headers.getSetCookie().map((header) => header.split(';')[0] ?? '').find((value) => value !== '')
  if (cookie === undefined) {
    throw new Error(`the sign-in link answered ${String(response.status)} without a cookie`)
  }
  return cookie
}

export const signIn = async (link: URL, origin: string = link.origin): Promise<ApiClient> => {
  const target = new URL(`${link.pathname}${link.search}`, origin)
  const response = await fetch(target, { redirect: 'manual', signal: AbortSignal.timeout(30_000) })
  const cookie = cookieOf(response)
  const get = async (path: string): Promise<unknown> => {
    const answer = await fetch(new URL(path, origin), { headers: { cookie }, signal: AbortSignal.timeout(30_000) })
    if (answer.status !== 200) {
      throw new Error(`GET ${path} answered ${String(answer.status)}: ${await answer.text()}`)
    }
    return answer.json()
  }
  return {
    origin,
    status: async () => endpoints.status.response.parse(await get(endpoints.status.path)),
    runs: async () => endpoints.runs.response.parse(await get(endpoints.runs.path)).runs,
    run: async (id) => endpoints.run.response.parse(await get(endpoints.run.path.replace(':run', id))),
    markViewed: async (run) => {
      const answer = await fetch(new URL(endpoints.markViewed.path.replace(':run', run.id), origin), {
        method: 'POST',
        headers: { cookie, origin, 'content-type': 'application/json' },
        body: JSON.stringify({ version: run.version, change_seq: run.change_seq }),
        signal: AbortSignal.timeout(30_000),
      })
      await answer.arrayBuffer()
      return answer.status
    },
  }
}

export const settled = async (api: ApiClient, timeoutMs: number): Promise<StatusResponse> => {
  const deadline = Date.now() + timeoutMs
  let previous: number | null = null
  let stable = 0
  while (Date.now() < deadline) {
    const status = await api.status()
    const sequence = status.database.change_seq
    stable = status.spool.files === 0 && sequence === previous ? stable + 1 : 0
    if (stable >= 4) {
      return status
    }
    previous = sequence
    await delay(500)
  }
  throw new Error(`the daemon did not settle within ${String(timeoutMs / 1000)} s`)
}
