import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmod, mkdir, mkdtemp, realpath, rename, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { claudeAdapter } from '@aang/adapter-claude'
import { codexAdapter } from '@aang/adapter-codex'
import { type CollectorService, createCollector, type ReadRetry } from '@aang/collector'
import {
  type CollectedGap,
  type CollectedRecord,
  type CollectorBatch,
  Config,
  type FileCursor,
  type RegistrationTag,
  type Runtime,
} from '@aang/contract'

type Awaitable<T> = T | Promise<T>

export type Register = (cleanup: () => Awaitable<void>) => void

export interface Sandbox {
  readonly root: string
  readonly spool: string
  readonly claude: string
  readonly codex: string
  readonly cleanup: Register
}

export interface Settings {
  readonly fsWatch?: boolean
  readonly spoolScanIntervalMs?: number
  readonly rootsScanIntervalMs?: number
  readonly maxAgeDays?: number
  readonly readRetry?: ReadRetry
  readonly cursors?: readonly FileCursor[]
  readonly lookbackDays?: number
}

export interface Arrival {
  readonly batch: CollectorBatch
  readonly at: number
}

export interface Running {
  readonly collector: CollectorService
  readonly arrivals: readonly Arrival[]
  readonly records: () => CollectedRecord[]
  readonly payloads: () => string[]
  readonly gaps: () => CollectedGap[]
  readonly cursor: (path: string) => FileCursor | undefined
  readonly arrivalOf: (matches: (record: CollectedRecord) => boolean) => number | undefined
  readonly ackAll: () => Promise<void>
  readonly close: () => Promise<void>
}

export interface HookEvent {
  readonly runtime?: Runtime
  readonly registration?: RegistrationTag
  readonly env?: Readonly<Record<string, string>>
  readonly payload: string | Buffer
}

export const createSandbox = async (register: Register): Promise<Sandbox> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aang-collector-')))
  const cleanups: (() => Awaitable<void>)[] = []
  register(async () => {
    for (const cleanup of cleanups.reverse()) {
      await cleanup()
    }
    await rm(root, { recursive: true, force: true, maxRetries: 5 })
  })
  return {
    root,
    spool: join(root, 'home', 'spool'),
    claude: join(root, 'claude'),
    codex: join(root, 'codex'),
    cleanup: (cleanup) => {
      cleanups.push(cleanup)
    },
  }
}

export const runCollector = (sandbox: Sandbox, settings: Settings = {}): Running => {
  const config = Config.parse({
    watch: { lookbackDays: settings.lookbackDays ?? 7 },
    collector: {
      fsWatch: settings.fsWatch ?? true,
      spoolScanIntervalMs: settings.spoolScanIntervalMs ?? 5_000,
      rootsScanIntervalMs: settings.rootsScanIntervalMs ?? 60_000,
    },
    spool: { maxAgeDays: settings.maxAgeDays ?? 7 },
  })
  const collector = createCollector({
    spool: sandbox.spool,
    runtimeRoots: { claude: sandbox.claude, codex: sandbox.codex },
    config,
    adapters: new Map([['claude', claudeAdapter], ['codex', codexAdapter]]),
    ...(settings.readRetry === undefined ? {} : { readRetry: settings.readRetry }),
  })
  const arrivals: Arrival[] = []
  let failure: { readonly error: unknown } | null = null
  const pumping = (async () => {
    for await (const batch of collector.start(settings.cursors ?? [])) {
      arrivals.push({ batch, at: performance.now() })
    }
  })().catch((error: unknown) => {
    failure = { error }
  })
  const close = async (): Promise<void> => {
    await collector.close()
    await pumping
  }
  sandbox.cleanup(close)
  const checked = <T>(value: () => T): T => {
    if (failure !== null) {
      throw failure.error
    }
    return value()
  }
  const records = (): CollectedRecord[] => checked(() => arrivals.flatMap(({ batch }) => batch.records))
  return {
    collector,
    arrivals,
    records,
    payloads: () => records().map(({ payload }) => payload),
    gaps: () => checked(() => arrivals.flatMap(({ batch }) => batch.gaps)),
    cursor: (path) => checked(() => arrivals.flatMap(({ batch }) => batch.cursors).findLast((cursor) => cursor.path === path)),
    arrivalOf: (matches) => arrivals.find(({ batch }) => batch.records.some(matches))?.at,
    ackAll: async () => {
      for (const { batch } of arrivals) {
        await collector.ack(batch)
      }
    },
    close,
  }
}

export const spoolBytes = ({ runtime = 'claude', registration = 'plugin', env = {}, payload }: HookEvent): Buffer =>
  Buffer.concat([
    Buffer.from(`aang-spool/1 ${runtime} ${registration}\n`, 'utf8'),
    ...Object.entries(env).map(([key, value]) => Buffer.from(`${key}=${value}\0`, 'utf8')),
    Buffer.from([0]),
    typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload,
  ])

export const spoolPath = (sandbox: Sandbox, name: string): string => join(sandbox.spool, 'new', name)

export const temporarySpoolPath = (sandbox: Sandbox, name: string): string => join(sandbox.spool, 'tmp', name)

export const putSpoolFile = async (sandbox: Sandbox, name: string, bytes: Buffer, modifiedAt?: Date): Promise<string> => {
  const temporary = temporarySpoolPath(sandbox, name)
  const ready = spoolPath(sandbox, name)
  await mkdir(dirname(temporary), { recursive: true })
  await mkdir(dirname(ready), { recursive: true })
  await writeFile(temporary, bytes)
  if (modifiedAt !== undefined) {
    await utimes(temporary, modifiedAt, modifiedAt)
  }
  await rename(temporary, ready)
  return ready
}

export const daysAgo = (days: number): Date => new Date(Date.now() - days * 24 * 60 * 60 * 1_000)

export const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })

export const preventListing = async (sandbox: Sandbox, path: string): Promise<() => Promise<void>> => {
  const run = promisify(execFile)
  const username = userInfo().username
  if (process.platform === 'win32') {
    await run('icacls.exe', [path, '/deny', `${username}:(RD)`])
  } else {
    await chmod(path, 0o000)
  }
  let held = true
  const release = async (): Promise<void> => {
    if (held) {
      if (process.platform === 'win32') {
        await run('icacls.exe', [path, '/remove:d', username])
      } else {
        await chmod(path, 0o700)
      }
      held = false
    }
  }
  sandbox.cleanup(release)
  return release
}

export const holdExclusively = async (sandbox: Sandbox, path: string): Promise<() => Promise<void>> => {
  if (process.platform !== 'win32') {
    await chmod(path, 0o000)
    let held = true
    const release = async (): Promise<void> => {
      if (held) {
        held = false
        await chmod(path, 0o644)
      }
    }
    sandbox.cleanup(release)
    return release
  }
  const script = `$f = [System.IO.File]::Open('${path.replaceAll("'", "''")}', 'Open', 'ReadWrite', 'None'); [Console]::Out.WriteLine('locked'); [Console]::Out.Flush(); Start-Sleep -Seconds 120`
  const child: ChildProcess = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  await new Promise<void>((resolve, reject) => {
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      if (chunk.includes('locked')) {
        resolve()
      }
    })
    child.on('exit', (code) => {
      reject(new Error(`lock holder exited with ${String(code)}`))
    })
  })
  const release = async (): Promise<void> => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill()
      await exited
    }
  }
  sandbox.cleanup(release)
  return release
}

export const preventRemoval = async (sandbox: Sandbox, path: string): Promise<() => Promise<void>> => {
  if (process.platform === 'win32') {
    return holdExclusively(sandbox, path)
  }
  const directory = dirname(path)
  await chmod(directory, 0o500)
  let held = true
  const release = async (): Promise<void> => {
    if (held) {
      held = false
      await chmod(directory, 0o700)
    }
  }
  sandbox.cleanup(release)
  return release
}
