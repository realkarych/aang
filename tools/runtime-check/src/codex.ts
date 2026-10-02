import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  type CheckContext,
  clearProbeLog,
  type Invocation,
  probeArgs,
  type ProbeEntry,
  quote,
  readProbeLog,
} from './context.js'
import { createSpool, runtimeEnv, writeJson } from './profile.js'
import { isAlive, killTree, outcome, run, type RunResult } from './process.js'
import type { CodexStep } from './responses-stub.js'
import { countByEvent, readDelivered } from './spool.js'

export const codexEvents: readonly string[] = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PreCompact',
  'PostCompact',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'Interrupt',
  'SessionEnd',
]

export interface CodexHook {
  readonly command: string
  readonly timeout: number
}

export type CodexHooks = Readonly<Record<string, readonly CodexHook[]>>

interface CodexRun {
  readonly result: RunResult
  readonly events: readonly Record<string, unknown>[]
}

interface CodexRunOptions {
  readonly home: string
  readonly steps: readonly CodexStep[]
  readonly adjustEnv?: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv
  readonly wrapper?: boolean
  readonly args?: readonly string[]
  readonly timeoutMs?: number
}

export interface CommandForm {
  readonly id: string
  readonly render: (parts: readonly string[]) => string
}

const forwardSlashes = (value: string): string => value.replaceAll('\\', '/')

const commandForms: readonly CommandForm[] = [
  { id: 'double-quoted', render: (parts) => parts.map(quote).join(' ') },
  {
    id: 'double-quoted-forward-slashes',
    render: (parts) => parts.map((part) => quote(forwardSlashes(part))).join(' '),
  },
  {
    id: 'call-operator-single-quoted',
    render: (parts) => `& ${parts.map((part) => `'${part.replaceAll("'", "''")}'`).join(' ')}`,
  },
  { id: 'call-operator', render: (parts) => `& ${parts.map(quote).join(' ')}` },
  { id: 'single-quoted', render: (parts) => parts.map((part) => `'${part}'`).join(' ') },
  { id: 'unquoted', render: (parts) => parts.join(' ') },
]

interface Patch {
  readonly step: CodexStep
  readonly file: string
}

export const newPatch = (context: CheckContext, label: string): Patch => {
  const name = `${label}-${randomUUID().slice(0, 8)}.txt`
  return {
    step: {
      type: 'custom_tool_call',
      name: 'apply_patch',
      input: `*** Begin Patch\n*** Add File: ${name}\n+aang\n*** End Patch\n`,
    },
    file: join(context.profile.project, name),
  }
}

export const writeCodexHome = async (context: CheckContext, home: string, hooks: CodexHooks | null): Promise<void> => {
  await rm(home, { recursive: true, force: true })
  await mkdir(home, { recursive: true })
  await writeFile(
    join(home, 'config.toml'),
    [
      'model = "gpt-6.1-sol"',
      'model_provider = "aang_stub"',
      'approval_policy = "never"',
      'sandbox_mode = "danger-full-access"',
      '',
      '[model_providers.aang_stub]',
      'name = "aang stub"',
      `base_url = "${context.responses.url}"`,
      'wire_api = "responses"',
      'requires_openai_auth = false',
      '',
    ].join('\n'),
  )
  if (hooks !== null) {
    await writeJson(join(home, 'hooks.json'), {
      hooks: Object.fromEntries(
        Object.entries(hooks).map(([event, entries]) => [
          event,
          [{ hooks: entries.map((entry) => ({ type: 'command', ...entry })) }],
        ]),
      ),
    })
  }
}

const jsonLines = (stdout: string): Record<string, unknown>[] =>
  stdout
    .split(/\r?\n/)
    .filter((line) => line.trim().startsWith('{'))
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>]
      } catch {
        return []
      }
    })

export const codexInvocation = (context: CheckContext, options: CodexRunOptions): Invocation => {
  const [command = context.clis.codex.command, ...prefix] =
    options.wrapper === true && context.clis.codex.wrapper !== null
      ? context.clis.codex.wrapper
      : [context.clis.codex.command]
  return {
    command,
    args: [
      ...prefix,
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--dangerously-bypass-hook-trust',
      ...(options.args ?? []),
      'Apply the patches and reply with done.',
    ],
    env: (options.adjustEnv ?? ((env) => env))({ ...runtimeEnv(context.profile, null), CODEX_HOME: options.home }),
    cwd: context.profile.project,
    stdin: '',
    arm: () => {
      context.responses.use({ steps: options.steps, text: 'done' })
    },
  }
}

export const runCodex = async (context: CheckContext, options: CodexRunOptions): Promise<CodexRun> => {
  const invocation = codexInvocation(context, options)
  invocation.arm()
  const result = await run(invocation.command, invocation.args, {
    env: invocation.env,
    cwd: invocation.cwd,
    timeoutMs: options.timeoutMs ?? 180_000,
  })
  return { result, events: jsonLines(result.stdout) }
}

const itemOf = (event: Record<string, unknown>): Record<string, unknown> | null =>
  typeof event.item === 'object' && event.item !== null ? (event.item as Record<string, unknown>) : null

export const codexOutcome = ({ result, events }: CodexRun): Record<string, unknown> => ({
  ...outcome(result),
  turnCompleted: events.some((event) => event.type === 'turn.completed'),
  turnFailed: events.some((event) => event.type === 'turn.failed'),
  items: events.flatMap((event) => {
    const item = event.type === 'item.completed' ? itemOf(event) : null
    return item === null ? [] : [{ type: item.type, status: item.status ?? null, message: item.message ?? null }]
  }),
})

export const formHook = (context: CheckContext, form: CommandForm, spool: string, timeout = 10): CodexHook => ({
  command: form.render([context.profile.hook, 'codex', 'user', spool]),
  timeout,
})

export const probeHook = (
  context: CheckContext,
  form: CommandForm,
  label: string,
  action: readonly string[],
  timeout: number,
): CodexHook => ({
  command: form.render([context.probe.node, ...probeArgs(context.probe, label, action)]),
  timeout,
})

const formSpool = (context: CheckContext, form: CommandForm): string =>
  join(context.profile.aangHome, `spool-codex-${form.id}`)

interface CodexForms {
  readonly report: Record<string, unknown>
  readonly installForm: CommandForm | null
  readonly probeForm: CommandForm | null
  readonly probes: readonly ProbeEntry[]
}

const probedForms: readonly string[] = [
  'double-quoted',
  'call-operator',
  'call-operator-single-quoted',
  'single-quoted',
]

export const codexForms = async (context: CheckContext): Promise<CodexForms> => {
  await clearProbeLog(context.probe)
  const hooks: CodexHook[] = []
  for (const form of commandForms) {
    await createSpool(formSpool(context, form))
    hooks.push(formHook(context, form, formSpool(context, form)))
  }
  for (const form of commandForms.filter(({ id }) => probedForms.includes(id))) {
    hooks.push(probeHook(context, form, `codex-probe-${form.id}`, ['chain'], 60))
  }
  const home = join(context.work, 'codex-forms')
  await writeCodexHome(context, home, { SessionStart: hooks, PreToolUse: hooks })
  const patch = newPatch(context, 'forms')
  const session = await runCodex(context, { home, steps: [patch.step] })
  const delivered: Record<string, Record<string, number>> = {}
  for (const form of commandForms) {
    delivered[form.id] = countByEvent(await readDelivered(formSpool(context, form)))
  }
  const probes = await readProbeLog(context.probe)
  const works = (form: CommandForm): boolean =>
    Object.values(delivered[form.id] ?? {}).reduce((sum, count) => sum + count, 0) >= 2
  const installForm = commandForms.filter(({ id }) => id !== 'unquoted').find(works) ?? null
  const probeForm = commandForms.find(({ id }) => probes.some(({ label }) => label === `codex-probe-${id}`)) ?? null
  return {
    report: {
      hooks,
      session: codexOutcome(session),
      patchApplied: existsSync(patch.file),
      delivered,
      installForm: installForm?.id ?? null,
      probeForm: probeForm?.id ?? null,
      probes: probes.map(({ label, event, argv, chain }) => ({ label, event, argv, chain })),
    },
    installForm,
    probeForm,
    probes,
  }
}

interface Behaviour {
  readonly id: string
  readonly event: string
  readonly action: readonly string[]
  readonly timeout: number
}

const behaviours: readonly Behaviour[] = [
  { id: 'PreToolUse exit 1', event: 'PreToolUse', action: ['exit', '1'], timeout: 10 },
  { id: 'PreToolUse exit 2', event: 'PreToolUse', action: ['exit', '2'], timeout: 10 },
  { id: 'PreToolUse timeout 2 s', event: 'PreToolUse', action: ['sleep', '20000'], timeout: 2 },
  { id: 'UserPromptSubmit timeout 2 s', event: 'UserPromptSubmit', action: ['sleep', '20000'], timeout: 2 },
  { id: 'Stop timeout 2 s', event: 'Stop', action: ['sleep', '20000'], timeout: 2 },
]

const survivors = async (entries: readonly ProbeEntry[]): Promise<Record<string, boolean>> => {
  const sleepers = entries.filter(({ action }) => action === 'sleep')
  const finished = new Set(entries.filter(({ action }) => action === 'slept').map(({ pid }) => pid))
  const alive: Record<string, boolean> = {}
  for (const { pid } of sleepers) {
    alive[String(pid)] = !finished.has(pid) && isAlive(pid)
  }
  await sleep(1_000)
  for (const { pid } of sleepers) {
    if (isAlive(pid)) {
      killTree(pid)
    }
  }
  return alive
}

export const codexBehaviour = async (
  context: CheckContext,
  probeForm: CommandForm | null,
): Promise<Record<string, unknown>> => {
  if (probeForm === null) {
    return { skipped: 'no probe command form was executed by Codex' }
  }
  const results: Record<string, unknown> = {}
  for (const behaviour of behaviours) {
    await clearProbeLog(context.probe)
    const label = behaviour.id.replaceAll(' ', '-')
    const home = join(context.work, `codex-${label}`)
    await writeCodexHome(context, home, {
      [behaviour.event]: [probeHook(context, probeForm, label, behaviour.action, behaviour.timeout)],
    })
    const patch = newPatch(context, label)
    const session = await runCodex(context, { home, steps: [patch.step], timeoutMs: 120_000 })
    const entries = await readProbeLog(context.probe)
    results[behaviour.id] = {
      hook: { event: behaviour.event, action: behaviour.action.join(' '), timeout: behaviour.timeout },
      session: codexOutcome(session),
      patchApplied: existsSync(patch.file),
      hookStarted: entries.filter(({ action }) => action !== 'slept').length,
      hookFinished: entries.filter(({ action }) => action === 'slept').length,
      aliveAfterSession: await survivors(entries),
    }
  }
  return { probeForm: probeForm.id, results }
}
