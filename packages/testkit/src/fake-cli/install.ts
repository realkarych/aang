import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Runtime } from '@aang/contract'
import type { z } from 'zod'
import { ClaudeScenario, CodexScenario, type FakeCall } from './scenario.js'
import { readCalls, writeScenario } from './state.js'

export interface FakeCliHold {
  readonly started: string
  readonly gate: string
}

export interface FakeCli<S> {
  readonly runtime: Runtime
  readonly command: string
  readonly args: readonly string[]
  readonly executable: string
  readonly path: string
  readonly held: (hold: FakeCliHold) => string
  readonly setScenario: (scenario: S) => void
  readonly calls: () => FakeCall[]
}

const windows = process.platform === 'win32'

const execShim = fileURLToPath(new URL('../../bin/exec-shim.exe', import.meta.url))

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

const shellLauncher = (path: string, words: readonly string[]): string => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `#!/bin/sh\nexec ${words.map(shellQuote).join(' ')} "$@"\n`)
  chmodSync(path, 0o755)
  return path
}

const nativeLauncher = (path: string, [command, ...args]: readonly string[]): string => {
  mkdirSync(dirname(path), { recursive: true })
  copyFileSync(execShim, path)
  writeFileSync(join(dirname(path), `${basename(path, '.exe')}.json`), JSON.stringify({ command, args }))
  return path
}

const holdPrelude = (hold: FakeCliHold | null): string[] =>
  hold === null
    ? []
    : [
        "import { existsSync, writeFileSync } from 'node:fs'",
        "import { setTimeout as sleep } from 'node:timers/promises'",
        `writeFileSync(${JSON.stringify(hold.started)}, '')`,
        `while (!existsSync(${JSON.stringify(hold.gate)})) await sleep(50)`,
      ]

const entrySource = (script: string, state: string, hold: FakeCliHold | null): string =>
  [
    ...holdPrelude(hold),
    `process.argv.splice(2, 0, ${JSON.stringify(state)})`,
    `await import(${JSON.stringify(pathToFileURL(script).href)})`,
    '',
  ].join('\n')

const npmCodex = (directory: string, source: string): string => {
  const bin = join(directory, 'node_modules', '@openai', 'codex', 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(dirname(bin), 'package.json'), '{"type":"module"}\n')
  writeFileSync(join(bin, 'codex.js'), source)
  const shim = join(directory, 'codex.cmd')
  writeFileSync(shim, `@"${process.execPath}" "%~dp0node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n`)
  return shim
}

const configuredPath = (runtime: Runtime, directory: string, source: string): string => {
  if (windows && runtime === 'codex') {
    return npmCodex(directory, source)
  }
  const entry = join(directory, `${runtime}.mjs`)
  mkdirSync(directory, { recursive: true })
  writeFileSync(entry, source)
  return windows
    ? nativeLauncher(join(directory, `${runtime}.exe`), [process.execPath, entry])
    : shellLauncher(join(directory, runtime), [process.execPath, entry])
}

const launcher = (
  runtime: Runtime,
  directory: string,
  script: string,
  state: string,
): Pick<FakeCli<never>, 'command' | 'args' | 'executable'> => {
  const words = [process.execPath, script, state]
  if (windows) {
    return { command: process.execPath, args: [script, state], executable: nativeLauncher(join(directory, 'bin', `${runtime}.exe`), words) }
  }
  const command = shellLauncher(join(directory, 'bin', runtime), words)
  return { command, args: [], executable: command }
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
    path: configuredPath(runtime, join(root, 'cli'), entrySource(script, state, null)),
    held: (hold) => configuredPath(runtime, mkdtempSync(join(root, 'held-')), entrySource(script, state, hold)),
    setScenario,
    calls: () => readCalls(state),
  }
}

export const installFakeClaude = (directory: string, scenario: ClaudeScenario = {}): FakeCli<ClaudeScenario> =>
  install('claude', ClaudeScenario, directory, scenario)

export const installFakeCodex = (directory: string, scenario: CodexScenario = {}): FakeCli<CodexScenario> =>
  install('codex', CodexScenario, directory, scenario)
