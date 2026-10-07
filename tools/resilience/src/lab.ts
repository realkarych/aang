import { mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  endpoints,
  type RunId,
  RunSnapshot,
  type RunSummary,
  type Session,
  type StatusResponse,
} from '@aang/contract'
import { aangHomePaths } from '@aang/contract/home'
import {
  type ClaudeStubScript,
  type CodexStubScript,
  type ModelStub,
  type ResponsesStub,
  startModelStub,
  startResponsesStub,
} from '@aang/record'
import { type ConfigInput, createProfile, type Profile, type RunningDaemon } from '@aang/testkit'
import type { Clis } from './clis.js'
import { writeGate } from './gate.js'
import type { Journal } from './journal.js'
import { type Finished, killProcess, type Launched, launch, processesUnder, runToEnd, shellPath, tail } from './processes.js'
import { type RawCount, rawCounts, storedCursors, type UnknownRecord, unknownRecords } from './store.js'

export interface LabPaths {
  readonly project: string
  readonly gate: (name: string) => string
}

export interface Scripts {
  readonly claude?: ClaudeStubScript
  readonly codex?: CodexStubScript
}

export interface LabOptions {
  readonly clis: Clis
  readonly aangEntry: string
  readonly journal: Journal
  readonly scripts?: (paths: LabPaths) => Scripts
  readonly config?: ConfigInput
}

export interface CliOptions {
  readonly timeoutMs?: number
  readonly cwd?: string
}

export interface Gate {
  readonly command: string
  readonly reached: () => Promise<void>
  readonly release: () => Promise<void>
}

export interface SessionView {
  readonly run: RunSnapshot
  readonly session: Session
}

export interface Lab {
  readonly profile: Profile
  readonly project: string
  readonly work: string
  readonly journal: Journal
  readonly config: ConfigInput
  readonly daemon: () => RunningDaemon
  readonly startDaemon: () => Promise<RunningDaemon>
  readonly killDaemon: () => Promise<void>
  readonly stopDaemon: () => Promise<void>
  readonly aang: (...args: readonly string[]) => Promise<Finished>
  readonly claude: (args: readonly string[], options?: CliOptions) => Launched
  readonly codex: (args: readonly string[], options?: CliOptions) => Launched
  readonly gate: (name: string) => Gate
  readonly status: () => Promise<StatusResponse>
  readonly write: (method: 'POST' | 'DELETE', path: string, body: unknown) => Promise<unknown>
  readonly runs: () => Promise<readonly RunSummary[]>
  readonly snapshot: (run: RunId) => Promise<RunSnapshot>
  readonly sessionView: (runtimeSession: string) => Promise<SessionView | null>
  readonly spoolFiles: () => Promise<readonly string[]>
  readonly settle: (quietMs?: number, timeoutMs?: number) => Promise<number>
  readonly sourceFiles: () => Promise<readonly string[]>
  readonly records: () => Promise<{ readonly unknown: UnknownRecord[]; readonly counts: RawCount[] }>
  readonly dispose: (keep: boolean) => Promise<void>
}

const stubApiKey = 'sk-ant-api03-aang-resilience-stub'

const cliTimeoutMs = 120_000

const hangLimitMs = 60_000

const strayKillLimitMs = 30_000

const strippedVariables = /^(?:ANTHROPIC_|OPENAI_|CLAUDE|CODEX_|AANG_|AI_AGENT$)/i

const cleanEnvironment = (env: Readonly<Record<string, string>>): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter(([name]) => !strippedVariables.test(name)))

const gateScript = [
  "import { existsSync, writeFileSync } from 'node:fs'",
  "import { setTimeout as sleep } from 'node:timers/promises'",
  'const [gate] = process.argv.slice(2)',
  "writeFileSync(`${gate}.reached`, '')",
  'while (!existsSync(`${gate}.open`)) await sleep(50)',
  "process.stdout.write('released\\n')",
  '',
].join('\n')

const codexConfig = (provider: string): string =>
  [
    'model_provider = "aang_stub"',
    'approval_policy = "never"',
    'sandbox_mode = "danger-full-access"',
    'check_for_update_on_startup = false',
    '',
    '[features]',
    'plugins = false',
    '',
    '[model_providers.aang_stub]',
    'name = "aang stub"',
    `base_url = ${JSON.stringify(provider.replaceAll('\\', '/'))}`,
    'wire_api = "responses"',
    'requires_openai_auth = false',
    '',
  ].join('\n')

const parse = async <T>(response: Response, schema: { parse: (value: unknown) => T }): Promise<T> => {
  const body: unknown = await response.json()
  if (!response.ok) {
    throw new Error(`${response.url}: ${String(response.status)} ${JSON.stringify(body)}`)
  }
  return schema.parse(body)
}

export const waitFor = async <T>(
  what: string,
  probe: () => Promise<T | null | undefined | false>,
  timeoutMs = 30_000,
  intervalMs = 250,
): Promise<T> => {
  const deadline = performance.now() + timeoutMs
  let last: unknown = null
  for (;;) {
    try {
      const value = await probe()
      if (value !== null && value !== undefined && value !== false) return value
    } catch (error) {
      last = error
    }
    if (performance.now() > deadline) {
      throw new Error(`timed out after ${String(timeoutMs)} ms waiting for ${what}`, { cause: last })
    }
    await sleep(intervalMs)
  }
}

export const createLab = async (options: LabOptions): Promise<Lab> => {
  const { clis, aangEntry, journal } = options
  const profile = await createProfile({ homeName: 'Имя Фамилия' })
  const project = join(profile.home, 'проект q4')
  const work = join(profile.root, 'work')
  const gates = join(work, 'gates')
  await mkdir(project, { recursive: true })
  await mkdir(gates, { recursive: true })
  for (const root of [join(profile.claude, 'projects'), join(profile.codex, 'sessions')]) {
    await mkdir(root, { recursive: true })
  }
  await writeFile(join(project, 'notes.txt'), 'aang Q.4 resilience project\n')
  await writeFile(join(work, 'gate.mjs'), gateScript)
  const gateCommand = (name: string): string => `node ${shellPath(join(work, 'gate.mjs'))} ${shellPath(join(gates, name))}`
  const scripts = options.scripts?.({ project, gate: gateCommand }) ?? {}
  const claudeStub: ModelStub = await startModelStub(scripts.claude ?? {}, join(work, 'claude-stub.jsonl'))
  const codexStub: ResponsesStub = await startResponsesStub(scripts.codex ?? {}, join(work, 'codex-stub.jsonl'))
  await writeFile(join(profile.codex, 'config.toml'), codexConfig(codexStub.url))
  const claudeGate = await writeGate(join(work, 'cli'), clis.claude)
  const codexGate = await writeGate(join(work, 'cli'), clis.codex)
  const config: ConfigInput = {
    ...options.config,
    runtimes: { claude: { configDir: profile.claude }, codex: { home: profile.codex } },
    watch: { roots: [{ path: project }], ...options.config?.watch },
    cli: { claude: claudeGate, codex: codexGate },
  }
  await profile.configure(config)
  const baseEnv = cleanEnvironment(profile.env)
  const runtimeEnv: Record<string, string> = {
    ...baseEnv,
    HOME: profile.home,
    USERPROFILE: profile.home,
    CLAUDE_CONFIG_DIR: profile.claude,
    CODEX_HOME: profile.codex,
  }
  const claudeEnv: Record<string, string> = {
    ...runtimeEnv,
    ANTHROPIC_BASE_URL: claudeStub.url,
    ANTHROPIC_API_KEY: stubApiKey,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
  }
  const launched: Launched[] = []
  let current: RunningDaemon | null = null

  const daemon = (): RunningDaemon => {
    if (current === null || !current.running()) throw new Error('the daemon is not running')
    return current
  }

  const request = (path: string, init: RequestInit = {}): Promise<Response> => daemon().request(path, init)

  const status = async (): Promise<StatusResponse> =>
    parse(await request(endpoints.status.path), endpoints.status.response)

  const write = async (method: 'POST' | 'DELETE', path: string, body: unknown): Promise<unknown> => {
    const response = await request(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const answer: unknown = await response.json()
    if (!response.ok) throw new Error(`${method} ${path}: ${String(response.status)} ${JSON.stringify(answer)}`)
    return answer
  }

  const runs = async (): Promise<readonly RunSummary[]> =>
    (await parse(await request(endpoints.runs.path), endpoints.runs.response)).runs

  const snapshot = async (run: RunId): Promise<RunSnapshot> =>
    parse(await request(endpoints.run.path.replace(':run', run)), RunSnapshot)

  const sessionView = async (runtimeSession: string): Promise<SessionView | null> => {
    for (const summary of await runs()) {
      const run = await snapshot(summary.id)
      const session = run.objects.sessions.find(({ key }) => key.session === runtimeSession)
      if (session !== undefined) return { run, session }
    }
    return null
  }

  const spoolFiles = async (): Promise<readonly string[]> => {
    try {
      return (await readdir(aangHomePaths(profile.aangHome).spoolReady)).sort()
    } catch {
      return []
    }
  }

  const sourceFiles = async (): Promise<readonly string[]> => {
    const roots = [join(profile.claude, 'projects'), join(profile.codex, 'sessions'), join(profile.codex, 'archived_sessions')]
    const found = await Promise.all(
      roots.map(async (root) => {
        try {
          return (await readdir(root, { recursive: true, withFileTypes: true }))
            .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
            .map((entry) => join(entry.parentPath, entry.name))
        } catch {
          return []
        }
      }),
    )
    return found.flat().sort()
  }

  const unread = async (database: string): Promise<string[]> => {
    const cursors = new Map(storedCursors(database).map((cursor) => [cursor.path, cursor]))
    const pending: string[] = []
    for (const path of await sourceFiles()) {
      const stats = await stat(path, { bigint: true }).catch(() => null)
      const cursor = cursors.get(path)
      if (stats !== null && (cursor === undefined || cursor.inode !== stats.ino.toString() || BigInt(cursor.offset) < stats.size)) {
        pending.push(path)
      }
    }
    return pending
  }

  const settle = async (quietMs = 1_000, timeoutMs = 90_000): Promise<number> => {
    const started = performance.now()
    let previous = -1
    let stableSince = performance.now()
    let pending: readonly string[] = []
    try {
      await waitFor(
        'the daemon to take in the spool and every source file',
        async () => {
          const { database } = await status()
          pending = [...(await spoolFiles()), ...(await unread(database.path))]
          if (pending.length > 0 || database.change_seq !== previous) {
            previous = database.change_seq
            stableSince = performance.now()
            return false
          }
          return performance.now() - stableSince >= quietMs
        },
        timeoutMs,
      )
    } catch (error) {
      throw new Error(`still unread: ${pending.join(', ')}`, { cause: error })
    }
    const elapsed = Math.round(performance.now() - started - quietMs)
    journal.step('daemon settled', { afterMs: elapsed })
    return elapsed
  }

  const startDaemon = async (): Promise<RunningDaemon> => {
    current = await profile.startDaemon({ entry: aangEntry })
    journal.step('daemon started', { pid: current.pid })
    return current
  }

  const bounded = async <T>(what: string, work: Promise<T>): Promise<T> => {
    const finished = async (limitMs: number): Promise<{ readonly value: T } | null> => {
      const timer = new AbortController()
      try {
        return await Promise.race([work.then((value) => ({ value })), sleep(limitMs, null, { signal: timer.signal })])
      } finally {
        timer.abort()
      }
    }
    const first = await finished(hangLimitMs)
    if (first !== null) return first.value
    const strays = processesUnder(profile.root)
    journal.observe(`processes of the profile still running when ${what} hung`, strays.map(({ command }) => command))
    for (const { pid } of strays) killProcess(pid)
    const second = await finished(strayKillLimitMs)
    throw new Error(
      `${what} did not finish within ${String(hangLimitMs)} ms; ${String(strays.length)} processes of the profile were still running and were killed${second === null ? ', and it still did not finish' : ''}`,
    )
  }

  const killDaemon = async (): Promise<void> => {
    const exit = await bounded('the killed daemon exit', daemon().kill())
    journal.step('daemon killed with SIGKILL', exit)
  }

  const stopDaemon = async (): Promise<void> => {
    const exit = await bounded('the daemon shutdown', daemon().stop())
    journal.step('daemon shut down through the API', exit)
  }

  const aang = async (...args: readonly string[]): Promise<Finished> => {
    const result = await runToEnd(process.execPath, [aangEntry, ...args], {
      cwd: profile.home,
      env: profile.env,
      timeoutMs: cliTimeoutMs,
    })
    journal.step(`aang ${args.join(' ')}`, { code: result.code, stdout: tail(result.stdout), stderr: tail(result.stderr) })
    return result
  }

  const start = (cli: 'claude' | 'codex', args: readonly string[], cliOptions: CliOptions = {}): Launched => {
    const child = launch(clis[cli].command, args, {
      cwd: cliOptions.cwd ?? project,
      env: cli === 'claude' ? claudeEnv : runtimeEnv,
      timeoutMs: cliOptions.timeoutMs ?? cliTimeoutMs,
    })
    launched.push(child)
    journal.step(`${cli} started`, { pid: child.pid, args: args.filter((arg) => !arg.includes('[aang:')) })
    return child
  }

  const gate = (name: string): Gate => {
    const path = join(gates, name)
    return {
      command: gateCommand(name),
      reached: async () => {
        await waitFor(
          `the gate ${name} to be reached`,
          async () => (await readdir(gates)).includes(`${name}.reached`),
          cliTimeoutMs,
        )
        journal.step(`gate ${name} reached`)
      },
      release: async () => {
        await writeFile(`${path}.open`, '')
        journal.step(`gate ${name} released`)
      },
    }
  }

  return {
    profile,
    project,
    work,
    journal,
    config,
    daemon,
    startDaemon,
    killDaemon,
    stopDaemon,
    aang,
    claude: (args, cliOptions) => start('claude', args, cliOptions),
    codex: (args, cliOptions) => start('codex', args, cliOptions),
    gate,
    status,
    write,
    runs,
    snapshot,
    sessionView,
    spoolFiles,
    settle,
    sourceFiles,
    records: async () => {
      const { database } = await status()
      return { unknown: unknownRecords(database.path), counts: rawCounts(database.path) }
    },
    dispose: async (keep) => {
      const reached = (await readdir(gates)).filter((name) => name.endsWith('.reached'))
      await Promise.all(reached.map((name) => writeFile(join(gates, name.replace(/\.reached$/, '.open')), '')))
      await sleep(reached.length === 0 ? 0 : 500)
      await bounded('killing the CLIs', Promise.allSettled(launched.map((child) => child.kill())))
      await bounded('closing the model stubs', Promise.allSettled([claudeStub.close(), codexStub.close()]))
      if (keep) {
        if (current?.running() === true) await bounded('the daemon shutdown', current.stop().catch(() => current?.kill()))
        process.stdout.write(`    kept ${profile.root}\n`)
        return
      }
      await bounded('the profile disposal', profile.dispose())
    },
  }
}
