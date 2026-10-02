import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type RegistrationTag, type Runtime, SpoolHeader, spoolFormat, spoolLayout } from '@aang/contract'
import { leaseFileName } from '@aang/contract/home'
import { type Environment, hookEnvironment, type InheritedEnvironment } from '../profile/environment.js'

export interface HookTarget {
  readonly binary: string
  readonly spool: string
  readonly env?: InheritedEnvironment
}

export interface HookEvent {
  readonly runtime: Runtime
  readonly registration: RegistrationTag
  readonly env?: Environment
  readonly payload: string | Uint8Array
}

export interface SpoolEvent {
  readonly name: string
  readonly receivedAt: bigint
  readonly header: SpoolHeader
  readonly payload: Buffer
}

export class HookContractError extends Error {
  override readonly name = 'HookContractError'
}

const hookTimeoutMs = 10_000
const defaultLeaseTtlMs = 60 * 60 * 1_000

const collect = (stream: NodeJS.ReadableStream): (() => string) => {
  let text = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => {
    text += chunk
  })
  return () => text
}

export const invokeHook = async ({ binary, spool, env = process.env }: HookTarget, event: HookEvent): Promise<void> => {
  const child = spawn(binary, [event.runtime, event.registration, spool], {
    env: hookEnvironment(env, event.env ?? {}),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    timeout: hookTimeoutMs,
    killSignal: 'SIGKILL',
  })
  const stdout = collect(child.stdout)
  const stderr = collect(child.stderr)
  const closed = once(child, 'close') as Promise<[number | null, NodeJS.Signals | null]>
  child.stdin.on('error', () => undefined)
  child.stdin.end(event.payload)
  const [code, signal] = await closed
  if (code !== 0 || stdout() !== '' || stderr() !== '') {
    throw new HookContractError(
      `aang-hook ${event.runtime} ${event.registration} broke its contract: exit ${String(code ?? signal)}, stdout ${JSON.stringify(stdout())}, stderr ${JSON.stringify(stderr())}`,
    )
  }
}

export const leaseSpool = async (spool: string, ttlMs: number = defaultLeaseTtlMs): Promise<void> => {
  for (const directory of [spoolLayout.readyDirectory, spoolLayout.temporaryDirectory]) {
    await mkdir(join(spool, directory), { recursive: true, mode: 0o700 })
  }
  await writeFile(join(spool, leaseFileName((Date.now() + ttlMs) / 1_000)), '')
}

const parseSpoolFile = (name: string, receivedAt: bigint, bytes: Buffer): SpoolEvent => {
  const lineEnd = bytes.indexOf(spoolFormat.headerLineTerminator)
  const [magic, runtime, registration, ...extra] = bytes
    .subarray(0, Math.max(lineEnd, 0))
    .toString('utf8')
    .split(spoolFormat.headerFieldSeparator)
  if (lineEnd < 0 || magic !== spoolFormat.magic || extra.length > 0) {
    throw new HookContractError(`spool file ${name} has a malformed header line`)
  }
  const env: Record<string, string> = {}
  let offset = lineEnd + spoolFormat.headerLineTerminator.length
  for (;;) {
    const entryEnd = bytes.indexOf(spoolFormat.envEntryTerminator, offset)
    if (entryEnd < 0) {
      throw new HookContractError(`spool file ${name} has an unterminated header`)
    }
    if (entryEnd === offset) {
      return {
        name,
        receivedAt,
        header: SpoolHeader.parse({ runtime, registration, env }),
        payload: bytes.subarray(entryEnd + spoolFormat.envEntryTerminator.length),
      }
    }
    const entry = bytes.subarray(offset, entryEnd).toString('utf8')
    const assignment = entry.indexOf(spoolFormat.envAssignment)
    if (assignment < 1) {
      throw new HookContractError(`spool file ${name} has a malformed header entry`)
    }
    env[entry.slice(0, assignment)] = entry.slice(assignment + spoolFormat.envAssignment.length)
    offset = entryEnd + spoolFormat.envEntryTerminator.length
  }
}

const isMissing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT'

const byReceipt = (left: SpoolEvent, right: SpoolEvent): number =>
  left.receivedAt === right.receivedAt
    ? Number(left.name > right.name) - Number(left.name < right.name)
    : Number(left.receivedAt > right.receivedAt) - Number(left.receivedAt < right.receivedAt)

export const readSpool = async (spool: string): Promise<SpoolEvent[]> => {
  const ready = join(spool, spoolLayout.readyDirectory)
  const names = await readdir(ready).catch((error: unknown): string[] => {
    if (isMissing(error)) {
      return []
    }
    throw error
  })
  const events = await Promise.all(
    names.map(async (name): Promise<SpoolEvent[]> => {
      const path = join(ready, name)
      try {
        const [stats, bytes] = await Promise.all([stat(path, { bigint: true }), readFile(path)])
        return [parseSpoolFile(name, stats.mtimeNs, bytes)]
      } catch (error) {
        if (isMissing(error)) {
          return []
        }
        throw error
      }
    }),
  )
  return events.flat().sort(byReceipt)
}
