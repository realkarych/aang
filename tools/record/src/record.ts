import { constants } from 'node:fs'
import { access, mkdir, mkdtemp, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { Runtime, Surface } from '@aang/contract'
import { writeClaudePlugin } from '@aang/hook'
import { createProcessRunner } from '@aang/observer'
import { leaseSpool } from '@aang/testkit'
import { createAnonymizer } from './anonymize.js'
import { createCapture, type ControlTarget } from './capture.js'
import { isMissing } from './files.js'
import { RecordMetadata, recordingOs, RecordingManifest } from './schema.js'
import { verifyRecording } from './verify.js'

export interface RecordOptions {
  readonly runtime: Runtime
  readonly engineVersion: string
  readonly appVersion?: string | undefined
  readonly surface: Surface
  readonly scenario: string
  readonly expectedFacts: readonly string[]
  readonly fixturesRoot: string
  readonly hookBinary: string
}

export interface RecordContext {
  readonly project: string
  readonly home: string
  readonly claude: string
  readonly codex: string
  readonly spool: string
  readonly plugin: string
  readonly run: (command: string, args: readonly string[]) => Promise<void>
  readonly checkpoint: (label: string, target: ControlTarget, expectedMapChange: string) => Promise<void>
}

const removeTree = (directory: string): Promise<void> => rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`
const isExecutable = async (path: string): Promise<boolean> => {
  const info = await stat(path).catch(() => undefined)
  if (!info?.isFile()) return false
  return process.platform === 'win32' || await access(path, constants.X_OK).then(() => true, () => false)
}

export const recordSession = async (options: RecordOptions, scenario: (context: RecordContext) => Promise<void>): Promise<string> => {
  const metadata = RecordMetadata.parse({
    runtime: options.runtime,
    engineVersion: options.engineVersion,
    ...(options.appVersion === undefined ? {} : { appVersion: options.appVersion }),
    surface: options.surface,
    scenario: options.scenario,
    expectedFacts: options.expectedFacts,
  })
  const os = recordingOs()
  const destination = resolve(options.fixturesRoot, metadata.runtime, metadata.engineVersion, metadata.surface, os, metadata.scenario)
  const exists = await stat(destination).then(() => true).catch((error: unknown) => {
    if (isMissing(error)) return false
    throw error
  })
  if (exists) throw new Error('Recording destination already exists')
  const hookBinary = resolve(options.hookBinary)
  if (!await isExecutable(hookBinary)) throw new Error('Hook binary must be an existing executable file')
  const temporary = await mkdtemp(join(tmpdir(), 'aang-record-'))
  let staging: string | undefined
  const controller = new AbortController()
  const pending = new Set<Promise<unknown>>()
  try {
    const root = await realpath(temporary)
    const home = join(root, 'home')
    const project = join(home, 'project')
    const claude = join(home, '.claude')
    const codex = join(home, '.codex')
    const spool = join(root, 'spool')
    const plugin = join(root, 'plugin')
    for (const directory of [project, claude, codex]) await mkdir(directory, { recursive: true, mode: 0o700 })
    await leaseSpool(spool, 24 * 60 * 60 * 1_000)
    await writeClaudePlugin({ directory: plugin, hookBinary, spool })
    const started = Date.now()
    const capture = createCapture({ home, claude, codex }, spool, started)
    const runner = createProcessRunner({ windowsLauncher: hookBinary, temporaryDirectory: root })
    const excluded = new Set(['AANG_OBSERVER', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_HOST_SESSION_ID', 'CLAUDE_PLUGIN_ROOT', 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE'])
    const env: Record<string, string> = {
      ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && !excluded.has(entry[0]))), HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex,
      AANG_RECORD_SPOOL: spool, AANG_RECORD_HOOK: hookBinary,
    }
    const execution: { running: boolean; failure?: Error } = { running: false }
    await scenario({
      project, home, claude, codex, spool, plugin,
      checkpoint: async (...args) => {
        if (execution.running) throw new Error('Await the recording command before adding a checkpoint')
        await capture.checkpoint(...args)
      },
      run: (command, args) => {
        const commandRun = async (): Promise<void> => {
          if (execution.running) throw new Error('Recording commands must be awaited sequentially')
          execution.running = true
          const runtimeArgs = metadata.runtime === 'claude' ? [...args, '--plugin-dir', plugin] : [...args]
          const request = runner.run({ command, args: runtimeArgs, cwd: project, env, input: '', timeoutMs: 300_000, signal: controller.signal })
          const scanState: { error?: Error } = {}
          let scan = Promise.resolve()
          const poll = setInterval(() => {
            scan = scan.then(() => capture.scan()).catch((error: unknown) => {
              scanState.error = error instanceof Error ? error : new Error('Recording scan failed', { cause: error })
              controller.abort()
            })
          }, 25)
          try {
            const result = await request
            clearInterval(poll)
            await scan
            if (scanState.error !== undefined) throw scanState.error
            if (result.failure !== null) throw new Error(`Recording command failed: ${result.failure}`)
            if (result.exitCode !== 0) throw new Error(`Recording command failed: ${String(result.exitCode)}`)
            capture.output(result.stdout)
            capture.output(result.stderr)
            await capture.scan(true)
          } finally {
            clearInterval(poll)
            await scan
            execution.running = false
          }
        }
        const commandRunPromise = commandRun().catch((error: unknown) => {
          execution.failure = error instanceof Error ? error : new Error('Recording command failed', { cause: error })
          throw execution.failure
        })
        pending.add(commandRunPromise)
        void commandRunPromise.then(() => pending.delete(commandRunPromise), () => pending.delete(commandRunPromise))
        return commandRunPromise
      },
    })
    if (execution.running) throw new Error('Scenario returned before its recording command finished')
    if (execution.failure) throw execution.failure
    await capture.scan(true)
    if (capture.steps.length === 0) throw new Error('Recording has no captured events')
    const manifest = RecordingManifest.parse({
      format: 'aang-recording/1', runtime: metadata.runtime, engine_version: metadata.engineVersion,
      app_version: metadata.appVersion ?? null, surface: metadata.surface, os, scenario: metadata.scenario,
      recorded_at: new Date(started).toISOString(), expected_facts: metadata.expectedFacts,
      control_events: capture.controlEvents,
      artifacts: capture.artifacts.map(({ source, observed_at, mtime_ns }) => ({ source, observed_at, mtime_ns })),
      playback: 'playback.json',
    })
    const canonicalHome = os === 'windows' ? 'C:\\Users\\USER' : os === 'macos' ? '/Users/USER' : '/home/USER'
    const canonicalProject = os === 'windows' ? 'C:\\fixture\\project' : '/fixture/project'
    const paths = new Map([
      [project, canonicalProject],
      [project.replaceAll(/[^a-zA-Z0-9]/g, '-'), '-fixture-project'],
      [home, canonicalHome],
      [root, os === 'windows' ? 'C:\\fixture\\recording' : '/fixture/recording'],
      [hookBinary, os === 'windows' ? 'C:\\fixture\\aang-hook.exe' : '/fixture/aang-hook'],
    ])
    for (const [before, after] of [...paths]) {
      paths.set(before.replaceAll('\\', '/'), after.replaceAll('\\', '/'))
    }
    const files = new Map(capture.artifacts.map((artifact) => [artifact.source, artifact.content]))
    files.set('manifest.json', json(manifest))
    files.set('playback.json', json({ steps: capture.steps }))
    const anonymizer = createAnonymizer(paths)
    anonymizer.discover(files.values())
    await mkdir(dirname(destination), { recursive: true })
    staging = await mkdtemp(join(dirname(destination), '.record-'))
    for (const [file, content] of files) {
      const path = join(staging, file)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, anonymizer.text(content), { mode: 0o600 })
    }
    await verifyRecording(staging)
    await rename(staging, destination)
    staging = undefined
    return destination
  } finally {
    controller.abort()
    await Promise.allSettled([...pending])
    if (staging !== undefined) await removeTree(staging)
    await removeTree(temporary)
  }
}
