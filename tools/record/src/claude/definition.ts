import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { OperatingSystem } from '@aang/contract'
import { z } from 'zod'
import type { ScenarioSession } from '../scenario.js'
import type { ModelMode } from '../schema.js'
import type { HostSummary } from './plan.js'
import type { StubBlock, StubScript } from './stub.js'
import type { ClaudeRun, ClaudeSurfaceName } from './surfaces.js'

export interface Definition {
  readonly name: string
  readonly expectedFacts: readonly string[]
  readonly models?: readonly ModelMode[]
  readonly surfaces?: readonly ClaudeSurfaceName[]
  readonly os?: readonly OperatingSystem[]
  readonly script: (session: ScenarioSession) => StubScript
  readonly run: (run: ClaudeRun) => Promise<void>
}

export const check = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(message)
}

export const present = <T>(value: T | undefined, message: string): T => {
  if (value === undefined) throw new Error(message)
  return value
}

export const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false)

export const sessionOf = (summary: HostSummary): string => present(summary.results.at(-1)?.sessionId, 'The host saw no result')

export const bash = (command: string, description: string): StubBlock => ({ tool: 'Bash', input: { command, description } })

export const playerPath = (session: ScenarioSession, file: string): { readonly root: 'claude'; readonly path: string } =>
  ({ root: 'claude', path: relative(session.claude, file).replaceAll('\\', '/') })

const Task = z.looseObject({ id: z.string(), subject: z.string(), status: z.string() })

export const taskFiles = async (session: ScenarioSession, list: string): Promise<{ readonly file: string; readonly task: z.infer<typeof Task> }[]> => {
  const directory = join(session.claude, 'tasks', list)
  const names = (await readdir(directory).catch(() => [])).filter((name) => name.endsWith('.json'))
  return Promise.all(names.map(async (name) => ({ file: join(directory, name), task: Task.parse(JSON.parse(await readFile(join(directory, name), 'utf8'))) })))
}
