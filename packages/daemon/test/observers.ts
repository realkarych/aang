import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { type InterpretationStatus, ObserverInput, type ObserverErrorClass, type RunId, type Runtime } from '@aang/contract'
import { hookInstallPaths } from '@aang/hook'
import type { ClaudeReply, CodexReply, FakeCli } from '@aang/testkit'
import type { Home } from './daemon.js'
import { hookBinary } from './sessions.js'

export interface Batch {
  readonly verdict: string | null
  readonly error: ObserverErrorClass | null
}

export interface Hold {
  readonly gate: string
  readonly started: string
}

export interface RunProgress {
  readonly statuses: readonly InterpretationStatus[]
  readonly batches: readonly Batch[]
}

export const singlePathClaude = process.platform !== 'win32'

const briefing = {
  base_version: { $input: '/model/version' },
  ops: [{ op: 'brief.update', text: 'The observer read the batch', evidence: { $input: '/batch/facts/*/id' }, rationale: 'Batch' }],
  needs: [],
}

export const briefed: ClaudeReply & CodexReply = { kind: 'answer', output: briefing }

export const toolAttempt: CodexReply = { kind: 'answer', output: briefing, toolAttempts: ['exec'] }

const dropped = /^(?:path|aang_.*|claude.*|codex_.*|ai_agent)$/i

export const observerEnvironment = (home: Home): Record<string, string> => ({
  ...Object.fromEntries(
    Object.entries(process.env).flatMap(([name, value]) => (value === undefined || dropped.test(name) ? [] : [[name, value]])),
  ),
  HOME: home.root,
  USERPROFILE: home.root,
})

export const configure = (home: Home, workspace: string, config: Record<string, unknown>): Promise<void> =>
  writeFile(
    join(home.paths.home, 'config.json'),
    JSON.stringify({
      api: { port: 0 },
      otel: { port: 0 },
      collector: { rootsScanIntervalMs: 200 },
      watch: { roots: [{ path: workspace }] },
      ...config,
    }),
  )

export const installLauncher = async (home: Home): Promise<void> => {
  const { binary } = hookInstallPaths(home.paths.home)
  await mkdir(dirname(binary), { recursive: true })
  await copyFile(hookBinary, binary)
}

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

const heldShell = async <S>(fake: FakeCli<S>, { gate, started }: Hold): Promise<string> => {
  const path = join(dirname(fake.command), 'held')
  await writeFile(
    path,
    [
      '#!/bin/sh',
      `: > ${shellQuote(started)}`,
      `while [ ! -e ${shellQuote(gate)} ]; do sleep 0.05; done`,
      `exec ${shellQuote(fake.command)} "$@"`,
      '',
    ].join('\n'),
  )
  await chmod(path, 0o755)
  return path
}

const heldPrelude = (hold: Hold | null): string[] =>
  hold === null
    ? []
    : [
        "import { existsSync, writeFileSync } from 'node:fs'",
        "import { setTimeout as sleep } from 'node:timers/promises'",
        `writeFileSync(${JSON.stringify(hold.started)}, '')`,
        `while (!existsSync(${JSON.stringify(hold.gate)})) await sleep(50)`,
      ]

const npmCodex = async (script: string, state: string, hold: Hold | null): Promise<string> => {
  const directory = join(dirname(state), 'npm')
  const bin = join(directory, 'node_modules', '@openai', 'codex', 'bin')
  await mkdir(bin, { recursive: true })
  await writeFile(join(dirname(bin), 'package.json'), '{"type":"module"}\n')
  await writeFile(
    join(bin, 'codex.js'),
    [
      ...heldPrelude(hold),
      `process.argv.splice(2, 0, ${JSON.stringify(state)})`,
      `await import(${JSON.stringify(pathToFileURL(script).href)})`,
      '',
    ].join('\n'),
  )
  const shim = join(directory, 'codex.cmd')
  await writeFile(shim, '')
  return shim
}

export const configuredPath = async <S>(fake: FakeCli<S>, hold: Hold | null = null): Promise<string> => {
  if (process.platform !== 'win32') {
    return hold === null ? fake.command : heldShell(fake, hold)
  }
  const [script, state] = fake.args
  if (fake.runtime !== 'codex' || script === undefined || state === undefined) {
    throw new Error('on Windows only the npm layout of codex runs from one configured path')
  }
  return npmCodex(script, state, hold)
}

const parsedInput = (prompt: string | null): ObserverInput | null => {
  try {
    const input = ObserverInput.safeParse(JSON.parse(prompt ?? ''))
    return input.success ? input.data : null
  } catch {
    return null
  }
}

export const observerInputs = <S>(fake: FakeCli<S>, run: RunId): ObserverInput[] =>
  fake.calls().flatMap(({ prompt }) => {
    const input = parsedInput(prompt)
    return input?.run.id === run ? [input] : []
  })

export const admissionOf = async (home: Home, runtime: Runtime): Promise<Record<string, unknown> | null> => {
  try {
    return JSON.parse(await readFile(join(home.paths.home, 'support', `${runtime}-observer.json`), 'utf8')) as Record<
      string,
      unknown
    >
  } catch {
    return null
  }
}

export const progressOf = (home: Home, run: RunId): RunProgress => {
  const database = new DatabaseSync(join(home.paths.home, 'aang.db'), { readOnly: true })
  try {
    const statuses = database
      .prepare('SELECT status FROM fact_interpretation WHERE run_id = ? ORDER BY fact_id')
      .all(run)
      .map((row) => row['status'] as InterpretationStatus)
    const batches = database
      .prepare(
        "SELECT verdict, error_class FROM observer_calls WHERE kind = 'batch' AND run_id = ? AND finished_at IS NOT NULL ORDER BY started_at, rowid",
      )
      .all(run)
      .map((row) => ({ verdict: row['verdict'] as string | null, error: row['error_class'] as ObserverErrorClass | null }))
    return { statuses, batches }
  } finally {
    database.close()
  }
}

export const settled = ({ statuses }: RunProgress): boolean =>
  statuses.length > 0 && statuses.every((status) => status !== 'pending' && status !== 'in_call')
