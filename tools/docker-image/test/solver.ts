import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import { endpoints, type RunSummary } from '@aang/contract'
import { configFileName } from '@aang/contract/config-file'
import { aangHomeLayout } from '@aang/contract/home'
import type { ConfigInput } from '@aang/testkit'
import { type Completed, docker, dockerOk, type RunOptions } from './docker.js'

export const aangHome = '/home/node/.aang'
export const aangPaths = {
  spool: posix.join(aangHome, aangHomeLayout.spool),
  daemonLog: posix.join(aangHome, aangHomeLayout.daemonLog),
}

const apiPort = 4280
const started = new RegExp(`^aang started: pid ([0-9]+), http://127\\.0\\.0\\.1:${String(apiPort)}$`, 'm')

type Watch = NonNullable<ConfigInput['watch']>

export interface SolverOptions {
  readonly watch?: Watch
  readonly prepare?: readonly string[]
}

export interface SignedIn {
  readonly runs: () => Promise<RunSummary[]>
}

export interface Solver {
  readonly pid: number
  readonly origin: string
  readonly exec: (args: readonly string[], options?: RunOptions) => Promise<Completed>
  readonly signIn: () => Promise<SignedIn>
}

const outputOf = ({ code, stdout, stderr }: Completed): string => `exit ${String(code)}\n${stdout}${stderr}`

export const startSolver = async (
  image: string,
  cleanup: (remove: () => Promise<void>) => void,
  { watch = { all: true }, prepare = [] }: SolverOptions = {},
): Promise<Solver> => {
  const name = `aang-smoke-${randomUUID()}`
  await dockerOk(['run', '--detach', '--name', name, '--publish', `127.0.0.1::${String(apiPort)}`, image, 'sleep', 'infinity'])
  cleanup(async () => {
    await docker(['rm', '--force', name])
  })
  const exec = (args: readonly string[], options: RunOptions = {}): Promise<Completed> =>
    docker(['exec', ...(options.input === undefined ? [] : ['--interactive']), name, ...args], options)
  const execOk = async (args: readonly string[], options: RunOptions = {}): Promise<string> => {
    const result = await exec(args, options)
    if (result.code !== 0) {
      throw new Error(`${args.join(' ')} in ${image}: ${outputOf(result)}`)
    }
    return result.stdout
  }

  const config: ConfigInput = { api: { port: apiPort }, watch, collector: { rootsScanIntervalMs: 250 } }
  await execOk(['sh', '-c', 'umask 077 && mkdir -p "$1" && cat > "$2"', 'sh', aangHome, posix.join(aangHome, configFileName)], {
    input: JSON.stringify(config),
  })
  if (prepare.length > 0) {
    await execOk(prepare)
  }
  const start = await exec(['aang', 'start', '--bind', '0.0.0.0'])
  const pid = started.exec(start.stdout)?.[1]
  if (start.code !== 0 || pid === undefined) {
    const log = await exec(['cat', aangPaths.daemonLog])
    throw new Error(`aang start in ${image}: ${outputOf(start)}\n${aangPaths.daemonLog}:\n${log.stdout}`)
  }
  const origin = `http://${(await dockerOk(['port', name, `${String(apiPort)}/tcp`])).trim()}`

  const signIn = async (): Promise<SignedIn> => {
    const link = new URL((await execOk(['aang', 'open'])).trim())
    const response = await fetch(new URL(link.pathname, origin))
    const cookie = response.headers.get('set-cookie')?.split(';')[0]
    if (response.status !== 200 || cookie === undefined) {
      throw new Error(`the sign-in link ${link.href} answered ${String(response.status)} through ${origin}`)
    }
    return {
      runs: async () => {
        const runs = await fetch(new URL(endpoints.runs.path, origin), { headers: { cookie } })
        return endpoints.runs.response.parse(await runs.json()).runs
      },
    }
  }

  return { pid: Number(pid), origin, exec, signIn }
}
