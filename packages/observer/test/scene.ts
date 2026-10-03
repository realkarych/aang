import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { claudeAdapter } from '@aang/adapter-claude'
import { codexAdapter } from '@aang/adapter-codex'
import {
  type Adapter,
  CollectedRecord,
  EpochNs,
  type FactInterpretation,
  type JsonValue,
  ObserverCallId,
  ObserverInput,
  type RunId,
  type Runtime,
} from '@aang/contract'
import { objectId, runId } from '@aang/contract/ids'
import { applyChangeSet, createEngine } from '@aang/engine'
import {
  type CliCommand,
  createClaudeBackend,
  createClaudeLauncher,
  createCodexBackend,
  createObserverScheduler,
  type ObserverExecutor,
  type SchedulerClock,
  type SchedulerLimits,
} from '@aang/observer'
import { openStore, type StoredObserverCall } from '@aang/store'
import { type ClaudeReply, type CodexReply, installFakeClaude, installFakeCodex } from '@aang/testkit'
import type { TestContext } from 'vitest'

type JsonObject = { readonly [key: string]: JsonValue }

export interface ManualClock extends SchedulerClock {
  readonly advance: (milliseconds: number) => void
}

export const manualClock = (start: number): ManualClock => {
  let now = start
  let sequence = 0
  const timers = new Map<number, { readonly due: number; readonly task: () => void }>()
  return {
    now: () => now,
    schedule: (delayMs, task) => {
      sequence += 1
      const id = sequence
      timers.set(id, { due: now + delayMs, task })
      return () => {
        timers.delete(id)
      }
    },
    advance: (milliseconds) => {
      const target = now + milliseconds
      for (;;) {
        const [next] = [...timers].filter(([, timer]) => timer.due <= target).sort(([a, left], [b, right]) => left.due - right.due || a - b)
        if (next === undefined) {
          break
        }
        const [id, timer] = next
        timers.delete(id)
        now = timer.due
        timer.task()
      }
      now = target
    },
  }
}

const samples = new URL('../../../docs/research/samples/', import.meta.url)

const sampleObject = (path: string): JsonObject => JSON.parse(readFileSync(new URL(path, samples), 'utf8')) as JsonObject

export const claudeHook = (name: string, session: string, cwd: string, changes: JsonObject = {}): string =>
  JSON.stringify({ ...sampleObject(`claude-code-hooks/${name}`), session_id: session, cwd, ...changes })

export const codexHook = (name: string, session: string, cwd: string, changes: JsonObject = {}): string =>
  JSON.stringify({ ...(sampleObject(`codex-cli/hooks/${name}`)['stdin'] as JsonObject), session_id: session, cwd, ...changes })

export const accepted: ClaudeReply & CodexReply = {
  kind: 'answer',
  output: { base_version: { $input: '/model/version' }, ops: [], needs: [] },
}

export const briefed: ClaudeReply & CodexReply = {
  kind: 'answer',
  output: {
    base_version: { $input: '/model/version' },
    ops: [{ op: 'brief.update', text: 'The observer read the batch', evidence: { $input: '/batch/facts/*/id' }, rationale: 'Batch' }],
    needs: [],
  },
}

export const structured: ClaudeReply & CodexReply = {
  kind: 'answer',
  output: {
    base_version: { $input: '/model/version' },
    ops: [
      { op: 'brief.update', text: 'The observer read the batch', evidence: { $input: '/batch/facts/*/id' }, rationale: 'Batch' },
      {
        op: 'stage.create',
        temp_id: 'review',
        title: 'Review the requested command',
        expected_result: 'A decision on the command',
        summary: null,
        parent: null,
        origin: 'inferred',
        evidence: { $input: '/batch/facts/*/id' },
        rationale: 'Permission request',
      },
      {
        op: 'criterion.add',
        temp_id: 'decided',
        stage: { kind: 'new', temp_id: 'review' },
        text: 'The command is allowed or denied',
        source: 'task',
        evidence: { $input: '/batch/facts/*/id' },
        rationale: 'Permission request',
      },
    ],
    needs: [],
  },
}

export const outdated: ClaudeReply & CodexReply = {
  kind: 'answer',
  output: { base_version: 1_000_000, ops: [], needs: [] },
}

export const needing: ClaudeReply & CodexReply = {
  kind: 'answer',
  output: {
    base_version: { $input: '/model/version' },
    ops: [],
    needs: [{ kind: 'raw_record', seq: { $input: '/batch/facts/0/seq' } }],
  },
}

const parsed = (text: string | null): unknown => {
  try {
    return text === null ? null : JSON.parse(text)
  } catch {
    return null
  }
}

const adapters = new Map<Runtime, Adapter>([
  ['claude', claudeAdapter],
  ['codex', codexAdapter],
])

const builtins = { mcpServers: [], skills: [], plugins: ['cc-plugin-agents-md', 'cc-plugin-plugin-authoring'] }

export const start = Date.parse('2026-10-03T09:00:00.000Z')

export const epochOf = (milliseconds: number): EpochNs => EpochNs.parse(BigInt(milliseconds) * 1_000_000n)

export interface SceneLaunch {
  readonly root: string
  readonly claude: CliCommand
  readonly launcher: (cli: CliCommand) => ObserverExecutor
}

export interface SceneOptions {
  readonly claude?: readonly ClaudeReply[]
  readonly codex?: readonly CodexReply[]
  readonly admit?: readonly Runtime[]
  readonly backend?: Runtime | null
  readonly crossVendor?: boolean
  readonly limits?: Partial<SchedulerLimits>
  readonly timeoutMs?: number
  readonly systemClock?: boolean
  readonly executors?: (launch: SceneLaunch) => Partial<Record<Runtime, ObserverExecutor>>
}

export const createScene = async ({ onTestFinished }: TestContext, options: SceneOptions = {}) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aang-scheduler-')))
  const home = join(root, 'Имя Фамилия')
  const workspace = join(root, 'workspace')
  await mkdir(home)
  await mkdir(workspace)
  const fakeClaude = installFakeClaude(root, { replies: [...(options.claude ?? [])] })
  const fakeCodex = installFakeCodex(root, { replies: [...(options.codex ?? [])] })
  const launch = {
    temporaryDirectory: root,
    environment: { ...process.env, HOME: home, USERPROFILE: home },
    windowsLauncher: resolve('packages/hook/bin/aang-hook.exe'),
    timeoutMs: options.timeoutMs ?? 20_000,
  }
  const claude = createClaudeBackend({
    ...launch,
    cli: fakeClaude,
    model: 'claude-opus-5-5',
    builtins,
    admissionStatusPath: join(root, 'claude-observer.json'),
  })
  const codex = createCodexBackend({
    ...launch,
    cli: fakeCodex,
    model: 'gpt-6.1-sol',
    admissionStatusPath: join(root, 'codex-observer.json'),
  })
  const admitted = options.admit ?? ['claude']
  await Promise.all(admitted.map((runtime) => (runtime === 'claude' ? claude : codex).admit()))
  const launcher = (cli: CliCommand): ObserverExecutor =>
    createClaudeLauncher({ ...launch, cli, model: 'claude-opus-5-5', builtins })
  const backends = { claude, codex, ...options.executors?.({ root, claude: fakeClaude, launcher }) }
  const manual = options.systemClock === true ? null : manualClock(start)
  let failure: unknown = null
  const boot = (crossVendor = options.crossVendor) => {
    const store = openStore({ home: join(root, 'aang') })
    const engine = createEngine({ store, adapters, watch: { all: true, roots: [] } })
    const scheduler = createObserverScheduler({
      store,
      backends,
      ...(options.backend === undefined ? {} : { backend: options.backend }),
      ...(crossVendor === undefined ? {} : { crossVendor }),
      ...(manual === null ? {} : { clock: manual }),
      ...(options.limits === undefined ? {} : { limits: options.limits }),
    })
    void scheduler.failure.then((error: unknown) => {
      failure = error
    })
    return { store, engine, scheduler }
  }
  let daemon = boot()
  onTestFinished(async () => {
    await daemon.scheduler.close()
    database.close()
    daemon.store.close()
    await rm(root, { recursive: true, force: true, maxRetries: 10 })
  })
  let delivered = 0
  const now = (): number => manual?.now() ?? Date.now()
  const deliver = async (runtime: Runtime, payloads: readonly string[], offsetMs = 0): Promise<void> => {
    const records = payloads.map((payload) => {
      delivered += 1
      return CollectedRecord.parse({
        channel: 'hook',
        runtime,
        stream: null,
        position: { kind: 'spool', file: `${String(delivered).padStart(6, '0')}.evt` },
        hook: { registration: 'plugin', env: {} },
        observed_at: epochOf(now() + offsetMs),
        payload,
      })
    })
    await daemon.engine.ingest({ records, cursors: [], gaps: [] })
  }
  const claudeSession = (session: string) => ({
    run: runId({ kind: 'session', runtime: 'claude', session }),
    start: (offsetMs = 0) => deliver('claude', [claudeHook('SessionStart.startup.json', session, workspace)], offsetMs),
    tools: (count: number, offsetMs = 0) =>
      deliver(
        'claude',
        Array.from({ length: count }, (_, index) =>
          claudeHook('PreToolUse.Bash.json', session, workspace, { tool_use_id: `${session}-tool-${String(index)}` }),
        ),
        offsetMs,
      ),
    permission: (offsetMs = 0) => deliver('claude', [claudeHook('PermissionRequest.Bash.json', session, workspace)], offsetMs),
    command: (command: string) =>
      deliver('claude', [
        claudeHook('PreToolUse.Bash.json', session, workspace, {
          tool_use_id: `${session}-command`,
          tool_input: { command, description: 'Run a command' },
        }),
      ]),
  })
  const codexSession = (session: string) => ({
    run: runId({ kind: 'session', runtime: 'codex', session }),
    start: () => deliver('codex', [codexHook('SessionStart.startup.json', session, workspace)]),
    permission: () => deliver('codex', [codexHook('PermissionRequest.json', session, workspace)]),
  })
  const statuses = (run: RunId): FactInterpretation[] => daemon.store.interpretations.ofRun(run)
  const tally = (run: RunId): Record<string, number> =>
    statuses(run).reduce<Record<string, number>>((counts, { status }) => ({ ...counts, [status]: (counts[status] ?? 0) + 1 }), {})
  const database = new DatabaseSync(join(root, 'aang', 'aang.db'), { readOnly: true })
  const selectCalls = database.prepare('SELECT id FROM observer_calls WHERE run_id = ? ORDER BY started_at, rowid')
  const calls = (run: RunId): StoredObserverCall[] =>
    (selectCalls.all(run) as { readonly id: string }[]).flatMap(({ id }) => {
      const call = daemon.store.observerCalls.get(ObserverCallId.parse(id))
      return call === null ? [] : [call]
    })
  const prompts = (runtime: Runtime): ObserverInput[] =>
    (runtime === 'claude' ? fakeClaude : fakeCodex).calls().flatMap((call) => {
      const input = ObserverInput.safeParse(parsed(call.prompt))
      return input.success ? [input.data] : []
    })
  return {
    root,
    get store() {
      return daemon.store
    },
    get scheduler() {
      return daemon.scheduler
    },
    get engine() {
      return daemon.engine
    },
    restart: async (changes: { readonly crossVendor?: boolean } = {}): Promise<void> => {
      await daemon.scheduler.close()
      daemon.store.close()
      daemon = boot(changes.crossVendor)
    },
    attach: (runtime: Runtime, session: string, run: RunId): void => {
      daemon.store.transaction((transaction) => {
        applyChangeSet(transaction, {
          run,
          author: 'rule',
          at: epochOf(now()),
          changes: [
            {
              op: 'session.move',
              put: { kind: 'session_membership', value: { run, session: objectId({ kind: 'session', runtime, session }) } },
              basis: { kind: 'observed' },
              evidence: [],
            },
          ],
        })
      })
    },
    advance: (milliseconds: number): void => {
      if (manual === null) {
        throw new Error('the scene runs on the system clock')
      }
      manual.advance(milliseconds)
    },
    claude,
    codex,
    launcher,
    fakeClaude,
    fakeCodex,
    claudeSession,
    codexSession,
    statuses,
    tally,
    calls,
    prompts,
    failure: () => failure,
  }
}
