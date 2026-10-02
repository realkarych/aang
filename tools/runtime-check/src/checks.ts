import { z } from 'zod'
import { isWindows } from './process.js'

const yes = z.literal(true)
const no = z.literal(false)
const zero = z.literal(0)
const positive = z.number().positive()
const empty = z.array(z.unknown()).length(0)
const success = z.looseObject({ status: zero, timedOut: no, error: z.null() })
const claudeSession = success.extend({ result: z.looseObject({ subtype: z.literal('success'), is_error: no }) })
const codexSession = success.extend({ turnCompleted: yes })
const markerControl = z.looseObject({ session: success, marker: z.boolean() })
const events = z.looseObject({ SessionStart: positive, PreToolUse: positive, PostToolUse: positive, Stop: positive, SessionEnd: positive })
const channel = z.looseObject({ records: positive, states: z.looseObject({ parsed: positive, invalid: zero.optional(), threw: zero.optional() }), invalid: empty })
const hookChannel = (actions: number) => channel.extend({ facts: z.looseObject({
  session_start: positive, action_start: z.literal(actions), action_end: z.literal(actions), turn_end: positive, session_end: positive,
}) })
const rootCounts = z.record(z.string(), z.number())
const rootPlacement = (before: Record<string, number>, after: Record<string, number>): boolean =>
  Object.entries(after).some(([root, count]) => count > (before[root] ?? 0))
const seriesRun = z.looseObject({ ok: yes, events: z.number() })
const series = z.looseObject({
  failures: zero,
  withHooks: z.array(seriesRun.extend({ events: positive })).min(1),
  withoutHooks: z.array(seriesRun.extend({ events: zero })).min(1),
  warmup: z.looseObject({ withHooks: seriesRun.extend({ events: positive }), withoutHooks: seriesRun.extend({ events: zero }) }),
})
const measurement = z.looseObject({ failures: zero, runs: positive, delivered: positive })
const persistence = z.looseObject({ clean: yes, databases: z.array(z.unknown()).length(2) })
const structured = z.looseObject({ ok: yes })
const claudeObserver = claudeSession.extend({
  init: z.looseObject({ tools: z.tuple([z.literal('StructuredOutput')]), mcp_servers: empty, skills: empty,
    plugins: z.array(z.enum(['cc-plugin-agents-md', 'cc-plugin-plugin-authoring'])) }),
  toolsOfferedToModel: z.tuple([z.literal('StructuredOutput')]),
  result: z.looseObject({ subtype: z.literal('success'), is_error: no, structured_output: structured }),
  transcriptsWritten: zero,
  registryEntrypoints: z.array(z.literal('aang-observer')).min(1),
})
const codexObserver = codexSession.extend({
  lastMessage: z.string().refine((value) => {
    try { return structured.safeParse(JSON.parse(value)).success } catch { return false }
  }, 'missing structured output'),
  originator: z.literal('aang_observer'),
  bodyTools: z.union([z.null(), empty]),
  additionalTools: z.array(empty).min(1),
  routerUnsupportedInStderr: yes,
  probeOutputs: z.array(z.string()).refine((outputs) => ['exec', 'spawn_agent', 'request_user_input'].every((name) =>
    outputs.some((output) => output.includes('unsupported') && output.includes(name))), 'every tool attempt must be rejected'),
  rolloutsWritten: zero,
  sqlite: persistence,
})

const schemas: Readonly<Record<string, z.ZodType>> = {
  executables: z.looseObject(Object.fromEntries(['claude', 'codex'].map((runtime) => [runtime,
    z.looseObject({ spawnChecks: z.looseObject({ 'spawn(real executable)': z.string().startsWith('exit 0:') }) }),
  ]))),
  'claude hook delivery': z.looseObject({
    install: z.looseObject({ marketplaceAdd: success, install: success }), session: claudeSession,
    delivered: positive, byEvent: events, registrations: z.tuple([z.literal('plugin')]),
    payloadPaths: z.looseObject({ transcriptExists: yes }),
  }),
  'claude hook launchers': z.looseObject({ session: claudeSession, probes: z.array(z.looseObject({ label: z.string() })).refine(
    (probes) => ['claude-exec-form', 'claude-shell-form'].every((label) => probes.some((probe) => probe.label === label)),
    'both command forms must run',
  ) }),
  'codex hook command forms': z.looseObject({ session: codexSession, patchApplied: z.boolean(), installForm: z.string(), probeForm: z.string(),
    delivered: z.record(z.string(), z.record(z.string(), z.number())) }).refine(
    (value) => (value.delivered[value.installForm]?.SessionStart ?? 0) > 0 && (value.delivered[value.installForm]?.PreToolUse ?? 0) > 0,
    'the selected command form must deliver both events',
  ),
  'codex hook exit and timeout': z.looseObject({ results: z.looseObject(Object.fromEntries([
    'PreToolUse exit 1', 'PreToolUse exit 2', 'PreToolUse timeout 2 s', 'UserPromptSubmit timeout 2 s', 'Stop timeout 2 s',
  ].map((name) => [name, z.looseObject({ session: codexSession, hookStarted: positive, hookFinished: zero,
    patchApplied: z.literal(name !== 'PreToolUse exit 2' || isWindows), aliveAfterSession: z.record(z.string(), no),
  })]))) }),
  'collector and adapters on real files': z.looseObject({
    sessions: z.looseObject({ claude: claudeSession, codex: codexSession }),
    collector: z.looseObject({ records: positive, gaps: empty, spoolLeft: zero,
      channels: z.looseObject({ 'claude/transcript': channel, 'claude/hook': hookChannel(3), 'codex/rollout': channel, 'codex/hook': hookChannel(2) }),
      allFileLinesCollected: yes,
    }),
    fsWatch: z.array(z.looseObject({ events: positive, errors: empty })).length(3),
    concurrentReads: z.looseObject({ reads: positive, failures: z.record(z.string(), zero) }),
  }),
  'hook latency by launcher': z.looseObject({
    'direct spawn (exec form, strict aang-hook benchmark)': measurement,
    'direct spawn without a lease (no spool write)': measurement.extend({ delivered: zero }),
    'claude shell form': measurement,
    'codex command': measurement,
    ...(isWindows ? { 'codex command without pwsh on PATH': measurement.extend({ session: codexSession }) } : {}),
  }).refine((value) => Object.entries(value).every(([name, entry]) => {
    if (typeof entry !== 'object' || entry === null || !('runs' in entry) || !('delivered' in entry)) return true
    return entry.delivered === (name.includes('without a lease') ? 0 : Number(entry.runs) + (name.includes('without pwsh') ? 5 : 20))
  }), 'each benchmark invocation must deliver exactly one event when leased'),
  'claude series with and without hooks': series,
  'codex series with and without hooks': series,
  'observer admission': z.looseObject({
    claude: z.looseObject({ cleanEnv: claudeObserver, cwd: z.looseObject({ instructionsInAncestors: empty }),
      controlHook: z.looseObject({ positiveSettingSourcesProject: markerControl.extend({ marker: yes }), negativeSettingSourcesEmpty: markerControl.extend({ marker: no }) }),
      toolExecution: z.looseObject({ positive: z.looseObject({ session: claudeSession, marker: yes, attempted: yes }),
        negative: z.looseObject({ session: claudeSession, marker: no, attempted: yes, rejected: yes }) }),
    }),
    codex: z.looseObject({ cleanEnv: codexObserver, catalog: z.looseObject({ selected: z.literal(1) }), cwd: z.looseObject({ instructionsInAncestors: empty }),
      controlHook: z.looseObject({ positiveWithoutDisableHooks: markerControl.extend({ marker: yes }), negativeWithDisableHooks: markerControl.extend({ marker: no }) }),
    }),
  }),
  'process trees in a job object': z.looseObject(Object.fromEntries([
    'claude session with hooks and Bash', 'codex.exe session with hooks and a shell command', 'codex npm wrapper session',
    'claude observer profile', 'codex observer profile',
  ].map((name) => [name, z.looseObject({ harness: success, error: z.null(), rootExitCode: zero, rootTimedOut: no,
    activeAfterTerminate: zero, stopConfirmedMs: z.number().nonnegative(), traceError: z.null(), jobTotalProcesses: positive,
    treeFromTrace: z.looseObject({ processes: positive }),
  }).refine((entry) => entry.jobTotalProcesses === entry.treeFromTrace.processes, 'the traced process tree must be contained in the job')]))),
  'default roots': z.looseObject({
    claude: z.looseObject({ run: success, transcriptsBefore: rootCounts, transcriptsAfter: rootCounts })
      .refine((value) => rootPlacement(value.transcriptsBefore, value.transcriptsAfter), 'no transcript was created'),
    codex: z.looseObject({ run: success, rolloutsBefore: rootCounts, rolloutsAfter: rootCounts })
      .refine((value) => rootPlacement(value.rolloutsBefore, value.rolloutsAfter), 'no rollout was created'),
  }),
}

export interface SectionCheck {
  readonly status: 'passed' | 'failed' | 'skipped'
  readonly reasons: readonly string[]
}

export const checkSection = (name: string, value: unknown): SectionCheck => {
  if (typeof value === 'object' && value !== null && 'skipped' in value && typeof value.skipped === 'string' &&
    (name === 'default roots' || (name === 'process trees in a job object' && !isWindows))) {
    return { status: 'skipped', reasons: [value.skipped] }
  }
  const schema = schemas[name]
  if (schema === undefined) return { status: 'failed', reasons: ['no acceptance conditions defined'] }
  const parsed = schema.safeParse(value)
  return parsed.success ? { status: 'passed', reasons: [] } : {
    status: 'failed', reasons: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
  }
}
