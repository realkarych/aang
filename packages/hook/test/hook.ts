import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { type RegistrationTag, type Runtime, SpoolHeader, spoolEnvKeys, spoolFormat, spoolLayout } from '@aang/contract'
import { inject, type TestContext } from 'vitest'

export type HookBinary = 'plain' | 'covered'

export type HookStdin = Buffer | Iterable<Buffer> | 'ignored' | 'closed'

export interface HookOptions {
  readonly binary?: HookBinary
  readonly env?: Readonly<Record<string, string>>
  readonly stdin?: HookStdin
}

export interface HookResult {
  readonly status: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
  readonly stdinAccepted: boolean
}

export interface SpoolEvent {
  readonly name: string
  readonly header: SpoolHeader
  readonly payload: Buffer
}

export interface SpoolEntries {
  readonly ready: readonly string[]
  readonly pending: readonly string[]
}

export interface Spool {
  readonly root: string
  readonly path: string
  readonly args: (runtime?: Runtime, tag?: RegistrationTag) => string[]
  readonly add: (name: string) => Promise<void>
  readonly remove: (name: string) => Promise<void>
  readonly denyWrites: () => Promise<void>
  readonly entries: () => Promise<SpoolEntries>
  readonly events: () => Promise<SpoolEvent[]>
}

export interface SpoolOptions {
  readonly location?: string
  readonly leases?: readonly number[]
}

type Cleanup = () => Promise<void>

const execFileAsync = promisify(execFile)

const samplePath = (name: string): URL => new URL(`../../../docs/research/samples/claude-code-hooks/${name}`, import.meta.url)

export const typicalPayload = await readFile(samplePath('PreToolUse.Bash.json'))

const pluginEnvelope = JSON.parse(await readFile(samplePath('envelope.command.SessionStart.plugin.json'), 'utf8')) as {
  readonly env: Readonly<Record<string, string>>
}

export const typicalEnv: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(pluginEnvelope.env).filter(([name]) => (spoolEnvKeys as readonly string[]).includes(name)),
)

const controlledEnvNames: readonly string[] = [...spoolEnvKeys, 'AANG_OBSERVER', 'GOCOVERDIR']

const workerCoverageDirectory = join(inject('hookBinaries').coverageDirectory, process.env.VITEST_POOL_ID ?? 'main')

await mkdir(workerCoverageDirectory, { recursive: true })

export const hookEnvironment = (overrides: Readonly<Record<string, string>>): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !controlledEnvNames.includes(name.toUpperCase())),
  ),
  GOCOVERDIR: workerCoverageDirectory,
  ...overrides,
})

const launch = (binary: string, args: readonly string[], stdin: HookStdin): [string, string[]] =>
  stdin === 'closed' ? ['/bin/sh', ['-c', 'exec "$0" "$@" 0<&-', binary, ...args]] : [binary, [...args]]

const collect = (stream: Readable | null): (() => string) => {
  if (stream === null) {
    throw new Error('hook output must be piped')
  }
  let text = ''
  stream.setEncoding('utf8').on('data', (chunk: string) => {
    text += chunk
  })
  return () => text
}

export const runProcess = async (
  command: string,
  commandArgs: readonly string[],
  { env = {}, stdin = typicalPayload }: Omit<HookOptions, 'binary'> = {},
): Promise<HookResult> => {
  const piped = stdin !== 'ignored' && stdin !== 'closed'
  const child = spawn(command, commandArgs, {
    env: hookEnvironment(env),
    stdio: [piped ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  })
  const stdout = collect(child.stdout)
  const stderr = collect(child.stderr)
  const closed = once(child, 'close') as Promise<[number | null, NodeJS.Signals | null]>
  const stdinAccepted =
    piped && child.stdin !== null
      ? pipeline(Readable.from(stdin), child.stdin).then(
          () => true,
          () => false,
        )
      : Promise.resolve(true)
  const [[status, signal], accepted] = await Promise.all([closed, stdinAccepted])
  return { status, signal, stdout: stdout(), stderr: stderr(), stdinAccepted: accepted }
}

export const runHook = async (args: readonly string[], options: HookOptions = {}): Promise<HookResult> => {
  const stdin = options.stdin ?? typicalPayload
  const [command, commandArgs] = launch(inject('hookBinaries')[options.binary ?? 'covered'], args, stdin)
  return runProcess(command, commandArgs, { ...options, stdin })
}

export const withoutNames = (events: readonly SpoolEvent[]): Omit<SpoolEvent, 'name'>[] =>
  events.map(({ header, payload }) => ({ header, payload }))

export const cleanExit: HookResult = { status: 0, signal: null, stdout: '', stderr: '', stdinAccepted: true }

export const nowSeconds = (): number => Math.floor(Date.now() / 1000)

const leaseName = (expiresAt: number): string => `${spoolLayout.leasePrefix}${String(expiresAt)}`

const namesIn = async (directory: string): Promise<string[]> => {
  try {
    return (await readdir(directory)).sort()
  } catch {
    return []
  }
}

const parseSpoolFile = (name: string, bytes: Buffer): SpoolEvent => {
  const lineEnd = bytes.indexOf(spoolFormat.headerLineTerminator)
  const [magic, runtime, registration, ...extra] = bytes
    .subarray(0, lineEnd)
    .toString('utf8')
    .split(spoolFormat.headerFieldSeparator)
  if (lineEnd < 0 || magic !== spoolFormat.magic || extra.length > 0) {
    throw new Error(`${name}: malformed header line`)
  }
  const env: Record<string, string> = {}
  let offset = lineEnd + spoolFormat.headerLineTerminator.length
  let entryEnd = bytes.indexOf(spoolFormat.envEntryTerminator, offset)
  while (entryEnd > offset) {
    const entry = bytes.subarray(offset, entryEnd).toString('utf8')
    const assignment = entry.indexOf(spoolFormat.envAssignment)
    if (assignment < 1) {
      throw new Error(`${name}: malformed header entry`)
    }
    env[entry.slice(0, assignment)] = entry.slice(assignment + spoolFormat.envAssignment.length)
    offset = entryEnd + spoolFormat.envEntryTerminator.length
    entryEnd = bytes.indexOf(spoolFormat.envEntryTerminator, offset)
  }
  if (entryEnd < 0) {
    throw new Error(`${name}: unterminated header`)
  }
  return {
    name,
    header: SpoolHeader.parse({ runtime, registration, env }),
    payload: bytes.subarray(entryEnd + spoolFormat.envEntryTerminator.length),
  }
}

export const readSpoolEvents = async (spool: string): Promise<SpoolEvent[]> => {
  const ready = join(spool, spoolLayout.readyDirectory)
  return Promise.all((await namesIn(ready)).map(async (name) => parseSpoolFile(name, await readFile(join(ready, name)))))
}

const denyDirectoryWrites = async (directory: string): Promise<Cleanup> => {
  if (process.platform === 'win32') {
    await execFileAsync('icacls', [directory, '/deny', '*S-1-1-0:(WD,AD)'])
    return async () => {
      await execFileAsync('icacls', [directory, '/remove:d', '*S-1-1-0'])
    }
  }
  await chmod(directory, 0o500)
  return () => chmod(directory, 0o700)
}

export const createSpool = async (
  onTestFinished: TestContext['onTestFinished'],
  { location = 'spool', leases = [nowSeconds() + 3600] }: SpoolOptions = {},
): Promise<Spool> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aang-hook-')))
  const cleanups: Cleanup[] = []
  onTestFinished(async () => {
    for (const cleanup of cleanups.reverse()) {
      await cleanup()
    }
    await rm(root, { recursive: true, force: true, maxRetries: 5 })
  })
  const path = join(root, location)
  const ready = join(path, spoolLayout.readyDirectory)
  const pending = join(path, spoolLayout.temporaryDirectory)
  await mkdir(ready, { recursive: true, mode: 0o700 })
  await mkdir(pending, { recursive: true, mode: 0o700 })
  const add = (name: string): Promise<void> => writeFile(join(path, name), '')
  for (const expiresAt of leases) {
    await add(leaseName(expiresAt))
  }
  return {
    root,
    path,
    args: (runtime = 'claude', tag = 'plugin') => [runtime, tag, path],
    add,
    remove: (name) => rm(join(path, name), { recursive: true, force: true }),
    denyWrites: async () => {
      for (const directory of [pending, ready]) {
        cleanups.push(await denyDirectoryWrites(directory))
      }
    },
    entries: async () => ({ ready: await namesIn(ready), pending: await namesIn(pending) }),
    events: () => readSpoolEvents(path),
  }
}
