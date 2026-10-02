import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ToolStep } from './anthropic-stub.js'
import {
  type CheckContext,
  clearProbeLog,
  type Invocation,
  probeArgs,
  type ProbeEntry,
  readProbeLog,
  shellCommand,
} from './context.js'
import { createSpool, runtimeEnv, writeJson } from './profile.js'
import { excerpt, outcome, run, type RunResult } from './process.js'
import { clearDelivered, countByEvent, readDelivered } from './spool.js'

const claudeEvents: readonly string[] = [
  'SessionStart',
  'Setup',
  'InstructionsLoaded',
  'UserPromptSubmit',
  'UserPromptExpansion',
  'PreToolUse',
  'PermissionRequest',
  'PermissionDenied',
  'PostToolUse',
  'PostToolUseFailure',
  'PostToolBatch',
  'Notification',
  'SubagentStart',
  'SubagentStop',
  'TaskCreated',
  'TaskCompleted',
  'Stop',
  'StopFailure',
  'TeammateIdle',
  'ConfigChange',
  'CwdChanged',
  'DirectoryAdded',
  'FileChanged',
  'PreCompact',
  'PostCompact',
  'PostModelSwitch',
  'Elicitation',
  'ElicitationResult',
  'SessionEnd',
]

interface ClaudeHook {
  readonly type: 'command'
  readonly command: string
  readonly args?: readonly string[]
  readonly timeout: number
}

interface ClaudeRun {
  readonly result: RunResult
  readonly final: Record<string, unknown> | null
}

interface ClaudeRunOptions {
  readonly steps: number
  readonly toolSteps?: readonly ToolStep[]
  readonly tools?: string
  readonly configDir?: string
  readonly args?: readonly string[]
  readonly timeoutMs?: number
}

const marketplaceName = 'aang-local'

const aangClaudeHook = (context: CheckContext): ClaudeHook => ({
  type: 'command',
  command: context.profile.hook,
  args: ['claude', 'plugin', context.profile.spool],
  timeout: 2,
})

const hooksFile = (entries: Readonly<Record<string, readonly ClaudeHook[]>>): Record<string, unknown> => ({
  hooks: Object.fromEntries(Object.entries(entries).map(([event, hooks]) => [event, [{ hooks }]])),
})

const writePlugin = async (
  directory: string,
  name: string,
  entries: Readonly<Record<string, readonly ClaudeHook[]>>,
): Promise<void> => {
  await mkdir(join(directory, '.claude-plugin'), { recursive: true })
  await mkdir(join(directory, 'hooks'), { recursive: true })
  await writeJson(join(directory, '.claude-plugin', 'plugin.json'), {
    name,
    version: '0.0.0',
    description: 'aang runtime check',
  })
  await writeJson(join(directory, 'hooks', 'hooks.json'), hooksFile(entries))
}

const finalResult = (stdout: string): Record<string, unknown> | null => {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim() !== '')
  for (const line of lines.reverse()) {
    try {
      const value: unknown = JSON.parse(line)
      if (typeof value === 'object' && value !== null && 'type' in value && value.type === 'result') {
        return value
      }
    } catch {
      continue
    }
  }
  return null
}

export const claudeInvocation = (context: CheckContext, options: ClaudeRunOptions): Invocation => {
  const { profile, anthropic, clis } = context
  return {
    command: clis.claude.command,
    args: [
      '-p',
      'Read note.txt and reply with done.',
      '--output-format',
      'stream-json',
      '--verbose',
      '--allowedTools',
      options.tools ?? 'Read',
      ...(options.args ?? []),
    ],
    env: {
      ...runtimeEnv(profile, anthropic.url),
      ...(options.configDir === undefined ? {} : { CLAUDE_CONFIG_DIR: options.configDir }),
    },
    cwd: profile.project,
    stdin: '',
    arm: () => {
      anthropic.use({ steps: options.toolSteps ?? readSteps(context, options.steps), text: 'done' })
    },
  }
}

export const readSteps = (context: CheckContext, count: number): ToolStep[] =>
  Array.from({ length: count }, () => ({
    name: 'Read',
    input: { file_path: join(context.profile.project, 'note.txt') },
  }))

export const runClaude = async (context: CheckContext, options: ClaudeRunOptions): Promise<ClaudeRun> => {
  const invocation = claudeInvocation(context, options)
  invocation.arm()
  const result = await run(invocation.command, invocation.args, {
    env: invocation.env,
    cwd: invocation.cwd,
    timeoutMs: options.timeoutMs ?? 180_000,
  })
  return { result, final: finalResult(result.stdout) }
}

export const claudeOutcome = ({ result, final }: ClaudeRun): Record<string, unknown> => ({
  ...outcome(result),
  result: final === null ? null : { subtype: final.subtype, is_error: final.is_error, num_turns: final.num_turns },
})

const installClaudePlugin = async (
  context: CheckContext,
  configDir: string,
): Promise<Record<string, unknown>> => {
  const { profile, clis } = context
  const root = join(profile.aangHome, 'claude-plugin')
  await writePlugin(
    join(root, 'aang'),
    'aang',
    Object.fromEntries(claudeEvents.map((event) => [event, [aangClaudeHook(context)]])),
  )
  await mkdir(join(root, '.claude-plugin'), { recursive: true })
  await writeJson(join(root, '.claude-plugin', 'marketplace.json'), {
    name: marketplaceName,
    owner: { name: 'aang' },
    plugins: [{ name: 'aang', source: './aang', description: 'aang runtime check' }],
  })
  const options = {
    env: { ...runtimeEnv(profile, null), CLAUDE_CONFIG_DIR: configDir },
    cwd: profile.home,
    timeoutMs: 120_000,
  }
  const added = await run(clis.claude.command, ['plugin', 'marketplace', 'add', root], options)
  const installed = await run(clis.claude.command, ['plugin', 'install', `aang@${marketplaceName}`], options)
  const listed = await run(clis.claude.command, ['plugin', 'list'], options)
  return {
    marketplace: root,
    marketplaceAdd: { ...outcome(added), stdout: excerpt(added.stdout.trim()) },
    install: { ...outcome(installed), stdout: excerpt(installed.stdout.trim()) },
    list: excerpt(listed.stdout.trim(), 1200),
  }
}

const payloadField = (payload: unknown, field: string): unknown =>
  typeof payload === 'object' && payload !== null && field in payload
    ? (payload as Record<string, unknown>)[field]
    : undefined

export const claudeDelivery = async (context: CheckContext): Promise<Record<string, unknown>> => {
  const { profile } = context
  const install = await installClaudePlugin(context, profile.claudeConfigDir)
  await clearDelivered(profile.spool)
  const session = await runClaude(context, { steps: 2 })
  const delivered = await readDelivered(profile.spool)
  const sessionStart = delivered.find(({ event }) => event === 'SessionStart')
  const transcriptPath = payloadField(sessionStart?.payload, 'transcript_path')
  await clearDelivered(profile.spool)
  return {
    hookCommand: aangClaudeHook(context),
    install,
    session: claudeOutcome(session),
    modelRequests: context.anthropic.requests.length,
    delivered: delivered.length,
    byEvent: countByEvent(delivered),
    registrations: [...new Set(delivered.map(({ registration }) => registration))],
    headerEnv: sessionStart?.env ?? null,
    payloadPaths: {
      cwd: payloadField(sessionStart?.payload, 'cwd') ?? null,
      transcript_path: transcriptPath ?? null,
      transcriptExists: typeof transcriptPath === 'string' ? existsSync(transcriptPath) : null,
    },
  }
}

interface ClaudeLaunchers {
  readonly report: Record<string, unknown>
  readonly probes: readonly ProbeEntry[]
}

export const claudeLaunchers = async (context: CheckContext): Promise<ClaudeLaunchers> => {
  const { profile, probe } = context
  const shellSpool = join(profile.aangHome, 'spool-claude-shell')
  await createSpool(shellSpool)
  await clearProbeLog(probe)
  const pluginDirectory = join(profile.home, 'claude probe plugin')
  const probeHooks: ClaudeHook[] = [
    { type: 'command', command: probe.node, args: probeArgs(probe, 'claude-exec-form', ['chain']), timeout: 60 },
    {
      type: 'command',
      command: shellCommand([probe.node, ...probeArgs(probe, 'claude-shell-form', ['chain'])]),
      timeout: 60,
    },
    { type: 'command', command: shellCommand([profile.hook, 'claude', 'plugin', shellSpool]), timeout: 10 },
  ]
  await writePlugin(pluginDirectory, 'aang-probe', { SessionStart: probeHooks, PreToolUse: probeHooks })
  const session = await runClaude(context, { steps: 1, args: ['--plugin-dir', pluginDirectory] })
  const entries = await readProbeLog(probe)
  const delivered = await readDelivered(shellSpool)
  await clearDelivered(profile.spool)
  return {
    report: {
      pluginDirectory,
      hooks: probeHooks,
      session: claudeOutcome(session),
      probes: entries.map(({ label, event, argv, chain }) => ({ label, event, argv, chain })),
      shellFormHookDelivered: countByEvent(delivered),
    },
    probes: entries,
  }
}
