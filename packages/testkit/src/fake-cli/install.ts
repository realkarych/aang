import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Runtime } from '@aang/contract'
import type { z } from 'zod'
import { ClaudeScenario, CodexScenario, type FakeCall } from './scenario.js'
import { readCalls, writeScenario } from './state.js'

export interface FakeCli<S> {
  readonly runtime: Runtime
  readonly command: string
  readonly args: readonly string[]
  readonly setScenario: (scenario: S) => void
  readonly calls: () => FakeCall[]
}

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

const launcher = (
  runtime: Runtime,
  directory: string,
  script: string,
  state: string,
): Pick<FakeCli<never>, 'command' | 'args'> => {
  if (process.platform === 'win32') {
    return { command: process.execPath, args: [script, state] }
  }
  const bin = join(directory, 'bin')
  const command = join(bin, runtime)
  mkdirSync(bin, { recursive: true })
  writeFileSync(command, `#!/bin/sh\nexec ${[process.execPath, script, state].map(shellQuote).join(' ')} "$@"\n`)
  chmodSync(command, 0o755)
  return { command, args: [] }
}

const install = <S extends z.ZodType>(
  runtime: Runtime,
  schema: S,
  directory: string,
  scenario: z.input<S>,
): FakeCli<z.input<S>> => {
  const root = join(directory, runtime)
  const state = join(root, 'state')
  const script = fileURLToPath(new URL(`./${runtime}.js`, import.meta.url))
  const setScenario = (next: z.input<S>): void => {
    writeScenario(state, schema.parse(next))
  }
  setScenario(scenario)
  return {
    runtime,
    ...launcher(runtime, root, script, state),
    setScenario,
    calls: () => readCalls(state),
  }
}

export const installFakeClaude = (directory: string, scenario: ClaudeScenario = {}): FakeCli<ClaudeScenario> =>
  install('claude', ClaudeScenario, directory, scenario)

export const installFakeCodex = (directory: string, scenario: CodexScenario = {}): FakeCli<CodexScenario> =>
  install('codex', CodexScenario, directory, scenario)
