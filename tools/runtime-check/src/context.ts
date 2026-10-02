import { readFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { AnthropicStub } from './anthropic-stub.js'
import type { CliInstall, CliName } from './clis.js'
import type { Profile } from './profile.js'
import type { ResponsesStub } from './responses-stub.js'

interface Probe {
  readonly node: string
  readonly script: string
  readonly log: string
}

export interface CheckContext {
  readonly work: string
  readonly profile: Profile
  readonly clis: Readonly<Record<CliName, CliInstall>>
  readonly anthropic: AnthropicStub
  readonly responses: ResponsesStub
  readonly probe: Probe
}

export interface Invocation {
  readonly command: string
  readonly args: readonly string[]
  readonly env: NodeJS.ProcessEnv
  readonly cwd: string
  readonly stdin: string
  readonly arm: () => void
}

export interface ChainLink {
  readonly pid: number
  readonly ppid: number | null
  readonly name: string | null
  readonly commandLine: string | null
  readonly argv: readonly string[] | null
}

export interface ProbeEntry {
  readonly label: string
  readonly action: string
  readonly pid: number
  readonly ppid?: number
  readonly at: number
  readonly argv?: readonly string[]
  readonly event?: string | null
  readonly stdinBytes?: number
  readonly chain?: readonly ChainLink[] | string | null
}

export const probeScript = fileURLToPath(new URL('probe.js', import.meta.url))

export const probeArgs = (probe: Probe, label: string, action: readonly string[]): string[] => [
  probe.script,
  probe.log,
  label,
  ...action,
]

export const readProbeLog = async (probe: Probe): Promise<ProbeEntry[]> => {
  try {
    return (await readFile(probe.log, 'utf8'))
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as ProbeEntry)
  } catch {
    return []
  }
}

export const clearProbeLog = (probe: Probe): Promise<void> => rm(probe.log, { force: true })

export const quote = (value: string): string => `"${value}"`

export const shellCommand = (parts: readonly string[]): string => parts.map(quote).join(' ')
