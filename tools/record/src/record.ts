import { constants } from 'node:fs'
import { access, mkdir, mkdtemp, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { type OperatingSystem, type Runtime, spoolFormat, type Surface } from '@aang/contract'
import { writeClaudePlugin } from '@aang/hook'
import { createProcessRunner } from '@aang/observer'
import { leaseSpool } from '@aang/testkit'
import { createAnonymizer } from './anonymize.js'
import { createCapture, type ControlTarget } from './capture.js'
import { isMissing } from './files.js'
import { machineIdentities } from './machine.js'
import { startOtlpReceiver } from './otlp.js'
import { type CodexHome, type ModelMode, RecordMetadata, recordingOs, RecordingManifest } from './schema.js'
import { verifyRecording } from './verify.js'

export interface RecordOptions {
  readonly runtime: Runtime
  readonly engineVersion: string
  readonly appVersion?: string | undefined
  readonly surface: Surface
  readonly scenario: string
  readonly model?: ModelMode | undefined
  readonly expectedFacts: readonly string[]
  readonly fixturesRoot: string
  readonly hookBinary: string
  readonly codexHome?: CodexHome | undefined
}

export interface RunOptions {
  readonly env?: Readonly<Record<string, string>>
  readonly timeoutMs?: number
}

export interface RunOutput {
  readonly stdout: string
  readonly stderr: string
}

export interface RecordContext {
  readonly os: OperatingSystem
  readonly project: string
  readonly home: string
  readonly claude: string
  readonly codex: string
  readonly spool: string
  readonly plugin: string
  readonly hook: string
  readonly otlp: string
  readonly work: string
  readonly run: (command: string, args: readonly string[], options?: RunOptions) => Promise<RunOutput>
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
    ...(options.model === undefined ? {} : { model: options.model }),
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
  const otlp = await startOtlpReceiver()
  try {
    const root = await realpath(temporary)
    const home = join(root, 'home')
    const project = join(home, 'project')
    const claude = join(home, '.claude')
    const regular = options.codexHome === 'regular'
    const userHome = homedir()
    const codex = regular ? resolve(process.env['CODEX_HOME'] ?? join(userHome, '.codex')) : join(home, '.codex')
    const spool = join(root, 'spool')
    const plugin = join(root, 'plugin')
    const work = join(root, 'work')
    for (const directory of [project, claude, work, ...regular ? [] : [codex]]) await mkdir(directory, { recursive: true, mode: 0o700 })
    await leaseSpool(spool, 24 * 60 * 60 * 1_000)
    await writeClaudePlugin({ directory: plugin, hookBinary, spool })
    const started = Date.now()
    const codexOwner = (first: unknown): boolean => typeof first === 'object' && first !== null && 'type' in first && first.type === 'session_meta' &&
      'payload' in first && typeof first.payload === 'object' && first.payload !== null && 'cwd' in first.payload && first.payload.cwd === project
    const capture = await createCapture({ home, claude, codex }, spool, started, regular ? { codexOwner } : {})
    otlp.listen((body, receivedAt) => {
      capture.otlp(body, receivedAt)
    })
    const runner = createProcessRunner({ windowsLauncher: hookBinary, temporaryDirectory: root })
    const excluded = new Set(['AANG_OBSERVER', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_HOST_SESSION_ID', 'CLAUDE_PLUGIN_ROOT', 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE'])
    const env: Record<string, string> = {
      ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && !excluded.has(entry[0]))),
      ...regular ? { HOME: userHome, USERPROFILE: userHome } : { HOME: home, USERPROFILE: home }, CODEX_HOME: codex, CLAUDE_CONFIG_DIR: claude,
      AANG_RECORD_SPOOL: spool, AANG_RECORD_HOOK: hookBinary,
    }
    const execution: { running: boolean; failure?: Error } = { running: false }
    await scenario({
      os, project, home, claude, codex, spool, plugin, hook: hookBinary, otlp: otlp.endpoint, work,
      checkpoint: async (...args) => {
        if (execution.running) throw new Error('Await the recording command before adding a checkpoint')
        await capture.checkpoint(...args)
      },
      run: (command, args, runOptions = {}) => {
        const commandRun = async (): Promise<RunOutput> => {
          if (execution.running) throw new Error('Recording commands must be awaited sequentially')
          execution.running = true
          const runtimeArgs = metadata.runtime === 'claude' ? [...args, '--plugin-dir', plugin] : [...args]
          const request = runner.run({ command, args: runtimeArgs, cwd: project, env: { ...env, ...runOptions.env }, input: '', timeoutMs: runOptions.timeoutMs ?? 300_000, signal: controller.signal })
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
            const detail = result.stderr.trim().slice(-2_000)
            const reason = detail ? `\n${detail}` : ''
            if (result.failure !== null) throw new Error(`Recording command failed: ${result.failure}${reason}`)
            if (result.exitCode !== 0) throw new Error(`Recording command failed: ${String(result.exitCode)}${reason}`)
            capture.output(result.stdout)
            capture.output(result.stderr)
            await capture.scan(true)
            return { stdout: result.stdout, stderr: result.stderr }
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
    otlp.check()
    await capture.scan(true)
    if (capture.steps.length === 0) throw new Error('Recording has no captured events')
    const manifest = RecordingManifest.parse({
      format: 'aang-recording/1', runtime: metadata.runtime, engine_version: metadata.engineVersion,
      app_version: metadata.appVersion ?? null, surface: metadata.surface, os, scenario: metadata.scenario,
      model: metadata.model ?? null, recorded_at: new Date(started).toISOString(), expected_facts: metadata.expectedFacts,
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
      ...regular ? [[codex, os === 'windows' ? 'C:\\Users\\USER\\.codex' : `${canonicalHome}/.codex`] as const, [userHome, canonicalHome] as const] : [],
    ])
    for (const [before, after] of [...paths]) {
      paths.set(before.replaceAll('\\', '/'), after.replaceAll('\\', '/'))
    }
    const anonymizer = createAnonymizer(paths, await machineIdentities())
    anonymizer.discover([...capture.artifacts.map(({ content }) => content), json({ steps: capture.steps })])
    const anonymous = (source: string, content: string): string => {
      const header = source.startsWith('spool/') ? content.indexOf(spoolFormat.headerLineTerminator) + spoolFormat.headerLineTerminator.length : 0
      return content.slice(0, header) + anonymizer.text(content.slice(header))
    }
    const files = new Map(capture.artifacts.map(({ source, content }) => [source, anonymous(source, content)]))
    files.set('manifest.json', json(manifest))
    files.set('playback.json', json({
      steps: capture.steps.map((step) => ({
        ...step,
        ...'target' in step ? { target: { ...step.target, path: anonymizer.path(step.target.path) } } : {},
        ...'env' in step ? { env: Object.fromEntries(Object.entries(step.env).map(([key, value]) => [key, anonymizer.text(value)])) } : {},
      })),
    }))
    await mkdir(dirname(destination), { recursive: true })
    staging = await mkdtemp(join(dirname(destination), '.record-'))
    for (const [file, content] of files) {
      const path = join(staging, file)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, content, { mode: 0o600 })
    }
    await verifyRecording(staging)
    await rename(staging, destination)
    staging = undefined
    return destination
  } finally {
    controller.abort()
    await Promise.allSettled([...pending])
    await otlp.close()
    if (staging !== undefined) await removeTree(staging)
    await removeTree(temporary)
  }
}
