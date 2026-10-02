import { type ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import { appendFile, chmod, mkdir, mkdtemp, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createCollector, type ReadRetry } from '@aang/collector'
import {
  type CollectorBatch,
  Config,
  type RegistrationTag,
  type Runtime,
  type SpoolEnv,
  spoolFormat,
  spoolLayout,
} from '@aang/contract'
import type { Engine, IngestResult } from '@aang/engine'
import type { Store } from '@aang/store'
import type { Register } from './workspace.js'

export interface LiveRoots {
  readonly spool: string
  readonly claude: string
  readonly codex: string
}

export interface SpoolDelivery {
  readonly payload: string
  readonly runtime?: Runtime
  readonly registration?: RegistrationTag
  readonly env?: SpoolEnv
}

export interface Live {
  readonly batches: () => readonly CollectorBatch[]
  readonly results: () => readonly IngestResult[]
  readonly stop: () => Promise<void>
}

export const createLiveRoots = async (register: Register): Promise<LiveRoots> => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'aang-live-')))
  register(() => rm(base, { recursive: true, force: true, maxRetries: 5 }))
  const roots = { spool: join(base, 'spool'), claude: join(base, 'claude'), codex: join(base, 'codex') }
  await mkdir(join(roots.spool, spoolLayout.readyDirectory), { recursive: true })
  await mkdir(join(roots.spool, spoolLayout.temporaryDirectory), { recursive: true })
  return roots
}

const spoolBytes = ({ payload, runtime = 'claude', registration = 'plugin', env = {} }: SpoolDelivery): Buffer =>
  Buffer.concat([
    Buffer.from(
      `${spoolFormat.magic}${spoolFormat.headerFieldSeparator}${runtime}${spoolFormat.headerFieldSeparator}${registration}${spoolFormat.headerLineTerminator}`,
    ),
    ...Object.entries(env).map(([key, value]) =>
      Buffer.from(`${key}${spoolFormat.envAssignment}${value}${spoolFormat.envEntryTerminator}`),
    ),
    Buffer.from(spoolFormat.envEntryTerminator),
    Buffer.from(payload),
  ])

export const deliverHook = async (roots: LiveRoots, name: string, delivery: SpoolDelivery): Promise<void> => {
  const temporary = join(roots.spool, spoolLayout.temporaryDirectory, name)
  await writeFile(temporary, spoolBytes(delivery))
  await rename(temporary, join(roots.spool, spoolLayout.readyDirectory, name))
}

export const spoolLeft = (roots: LiveRoots): Promise<string[]> => readdir(join(roots.spool, spoolLayout.readyDirectory))

export const writeLines = async (path: string, lines: readonly string[]): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${lines.join('\n')}\n`)
}

export const appendLines = (path: string, lines: readonly string[]): Promise<void> =>
  appendFile(path, `${lines.join('\n')}\n`)

export const runLive = (
  register: Register,
  roots: LiveRoots,
  store: Store,
  engine: Engine,
  readRetry?: ReadRetry,
): Live => {
  const collector = createCollector({
    spool: roots.spool,
    runtimeRoots: { claude: roots.claude, codex: roots.codex },
    config: Config.parse({ collector: { spoolScanIntervalMs: 50, rootsScanIntervalMs: 50 } }),
    ...(readRetry === undefined ? {} : { readRetry }),
  })
  const batches: CollectorBatch[] = []
  const results: IngestResult[] = []
  let failure: Error | null = null
  const loop = (async () => {
    for await (const batch of collector.start(store.cursors.list())) {
      const result = await engine.ingest(batch)
      for (const settled of result.settled) {
        await collector.ack(settled)
      }
      batches.push(batch)
      results.push(result)
    }
  })().catch((error: unknown) => {
    failure = error instanceof Error ? error : new Error(String(error))
  })
  const checked = <T>(value: T): T => {
    if (failure !== null) {
      throw failure
    }
    return value
  }
  const stop = async (): Promise<void> => {
    await collector.close()
    await loop
  }
  register(stop)
  return { batches: () => checked(batches), results: () => checked(results), stop }
}

export const lockFile = async (register: Register, path: string): Promise<() => Promise<void>> => {
  if (process.platform !== 'win32') {
    await chmod(path, 0o000)
    let held = true
    const release = async (): Promise<void> => {
      if (held) {
        held = false
        await chmod(path, 0o644)
      }
    }
    register(release)
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
  register(release)
  return release
}
