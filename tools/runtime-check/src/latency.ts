import { readFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { spoolEnvKeys } from '@aang/contract'
import { revokeLeases } from '@aang/contract/home'
import { runClaude } from './claude.js'
import {
  type CodexHooks,
  codexEvents,
  codexOutcome,
  type CommandForm,
  formHook,
  newPatch,
  probeHook,
  runCodex,
  writeCodexHome,
} from './codex.js'
import {
  type ChainLink,
  type CheckContext,
  clearProbeLog,
  type ProbeEntry,
  probeArgs,
  readProbeLog,
  shellCommand,
} from './context.js'
import { createSpool, inheritedEnv } from './profile.js'
import { isWindows, quoteWindowsArgument, run } from './process.js'
import { clearDelivered, deliveredNames } from './spool.js'

interface Launcher {
  readonly id: string
  readonly command: string
  readonly args: readonly string[]
  readonly argv0?: string
  readonly verbatim: boolean
}

interface Series {
  readonly warmup: number
  readonly runs: number
}

interface LatencySummary {
  readonly launcher: Launcher
  readonly runs: number
  readonly p50: number
  readonly p95: number
  readonly max: number
  readonly failures: number
  readonly delivered: number
}

const samples = new URL('../../../docs/research/samples/claude-code-hooks/', import.meta.url)

const typicalPayload = await readFile(new URL('PreToolUse.Bash.json', samples))

const envelope = JSON.parse(await readFile(new URL('envelope.command.SessionStart.plugin.json', samples), 'utf8')) as {
  readonly env: Readonly<Record<string, string>>
}

const typicalEnv: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(envelope.env).filter(([name]) => (spoolEnvKeys as readonly string[]).includes(name)),
)

const strictSeries: Series = { warmup: 20, runs: 500 }

const percentile = (sorted: readonly number[], fraction: number): number =>
  sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)] ?? Number.NaN

const round = (value: number): number => Math.round(value * 100) / 100

const median = (values: readonly number[]): number =>
  percentile(
    [...values].sort((left, right) => left - right),
    0.5,
  )

const measure = async (launcher: Launcher, spool: string, series: Series): Promise<LatencySummary> => {
  await clearDelivered(spool)
  const durations: number[] = []
  let failures = 0
  for (let index = 0; index < series.warmup + series.runs; index += 1) {
    const result = await run(launcher.command, launcher.args, {
      env: { ...inheritedEnv(), ...typicalEnv },
      stdin: typicalPayload,
      timeoutMs: 10_000,
      verbatim: launcher.verbatim,
      ...(launcher.argv0 === undefined ? {} : { argv0: launcher.argv0 }),
    })
    failures += result.status === 0 && result.stdout === '' && result.stderr === '' ? 0 : 1
    if (index >= series.warmup) {
      durations.push(result.durationMs)
    }
  }
  const delivered = (await deliveredNames(spool)).length
  await clearDelivered(spool)
  const sorted = durations.sort((left, right) => left - right)
  return {
    launcher,
    runs: series.runs,
    p50: round(percentile(sorted, 0.5)),
    p95: round(percentile(sorted, 0.95)),
    max: round(sorted.at(-1) ?? Number.NaN),
    failures,
    delivered,
  }
}

const splitWindowsCommandLine = (
  commandLine: string,
): { readonly token: string; readonly image: string; readonly rest: string } => {
  const end = commandLine.startsWith('"') ? commandLine.indexOf('"', 1) + 1 : commandLine.indexOf(' ')
  const token = end <= 0 ? commandLine : commandLine.slice(0, end)
  return { token, image: token.replaceAll('"', ''), rest: commandLine.slice(token.length).replace(/^ /, '') }
}

type DerivedLauncher =
  | { readonly launcher: Launcher; readonly chain: readonly string[]; readonly measurementScope: 'launcher' | 'binary only; shell may have exec-replaced itself' }
  | { readonly unavailable: string; readonly chain: readonly string[] }

interface Replacement {
  readonly probe: string
  readonly hook: string
  readonly direct: readonly string[]
}

const reproduce = (id: string, link: ChainLink, replacement: Replacement): Launcher | null => {
  const commandLine = link.commandLine
  const match = [
    [replacement.probe, replacement.hook],
    [quoteWindowsArgument(replacement.probe), quoteWindowsArgument(replacement.hook)],
  ].find(([probe = '']) => commandLine?.includes(probe) === true)
  if (isWindows && commandLine !== null && match !== undefined) {
    const [probe = '', hook = ''] = match
    const { token, image, rest } = splitWindowsCommandLine(commandLine.replace(probe, hook))
    return { id, command: image, args: rest === '' ? [] : [rest], argv0: token, verbatim: true }
  }
  if (link.argv !== null && link.argv.some((part) => part.includes(replacement.probe))) {
    const [command = '', ...args] = link.argv.map((part) => part.replace(replacement.probe, replacement.hook))
    return { id, command, args, verbatim: false }
  }
  return null
}

const launcherFromProbe = (
  id: string,
  entry: ProbeEntry | undefined,
  replacement: Replacement,
  runtime: string,
): DerivedLauncher => {
  const chain = typeof entry?.chain === 'object' && entry.chain !== null ? entry.chain : []
  const names = chain.map(({ name }) => name ?? '?')
  const runtimeIndex = names.findIndex((name) => name.toLowerCase().includes(runtime))
  if (runtimeIndex === 0) {
    const [command = '', ...args] = replacement.direct
    return { launcher: { id, command, args, verbatim: false }, chain: names, measurementScope: 'binary only; shell may have exec-replaced itself' }
  }
  const below = runtimeIndex < 0 ? chain.slice(0, 1) : chain.slice(0, runtimeIndex)
  for (const link of below.toReversed()) {
    const launcher = reproduce(id, link, replacement)
    if (launcher !== null) {
      return { launcher, chain: names, measurementScope: 'launcher' }
    }
  }
  return {
    unavailable:
      typeof entry?.chain === 'string'
        ? entry.chain
        : chain.length === 0
          ? 'no probe entry with a process chain'
          : 'no launcher command line contains the probe command verbatim',
    chain: names,
  }
}

interface SeriesRun {
  readonly durationMs: number
  readonly ok: boolean
  readonly events: number
}

const seriesIncrement = async (
  once: (hooks: boolean) => Promise<SeriesRun>,
  pairs: number,
): Promise<Record<string, unknown>> => {
  const warmup = { withHooks: await once(true), withoutHooks: await once(false) }
  const withHooks: SeriesRun[] = []
  const withoutHooks: SeriesRun[] = []
  for (let pair = 0; pair < pairs; pair += 1) {
    for (const hooks of pair % 2 === 0 ? [true, false] : [false, true]) {
      const sample = await once(hooks)
      if (hooks) {
        withHooks.push(sample)
      } else {
        withoutHooks.push(sample)
      }
    }
  }
  const medianWith = median(withHooks.map(({ durationMs }) => durationMs))
  const medianWithout = median(withoutHooks.map(({ durationMs }) => durationMs))
  const medianEvents = median(withHooks.map(({ events }) => events))
  return {
    pairs,
    warmup,
    withHooks,
    withoutHooks,
    medianWithHooksMs: round(medianWith),
    medianWithoutHooksMs: round(medianWithout),
    medianEventsPerRun: medianEvents,
    perEventMs: medianEvents > 0 ? round((medianWith - medianWithout) / medianEvents) : null,
    failures: [...withHooks, ...withoutHooks].filter(({ ok }) => !ok).length,
    withHooksMs: withHooks.map(({ durationMs }) => round(durationMs)),
    withoutHooksMs: withoutHooks.map(({ durationMs }) => round(durationMs)),
  }
}

const seriesSteps = 20

const seriesPairs = 5

export const claudeSeries = async (context: CheckContext): Promise<Record<string, unknown>> => {
  const { profile } = context
  const bareConfigDir = join(profile.home, '.claude-bare')
  return seriesIncrement(async (hooks) => {
    await clearDelivered(profile.spool)
    const session = await runClaude(context, {
      steps: seriesSteps,
      configDir: hooks ? profile.claudeConfigDir : bareConfigDir,
    })
    const events = (await deliveredNames(profile.spool)).length
    await clearDelivered(profile.spool)
    return {
      durationMs: session.result.durationMs,
      ok: session.result.status === 0 && session.final?.subtype === 'success',
      events,
    }
  }, seriesPairs)
}

export const allEventHooks = (context: CheckContext, form: CommandForm): CodexHooks =>
  Object.fromEntries(codexEvents.map((event) => [event, [formHook(context, form, context.profile.spool, 2)]]))

export const codexSeries = async (context: CheckContext, form: CommandForm): Promise<Record<string, unknown>> => {
  const { profile } = context
  const hooksHome = join(context.work, 'codex-series-hooks')
  const bareHome = join(context.work, 'codex-series-bare')
  await writeCodexHome(context, hooksHome, allEventHooks(context, form))
  await writeCodexHome(context, bareHome, null)
  return seriesIncrement(async (hooks) => {
    await clearDelivered(profile.spool)
    const session = await runCodex(context, {
      home: hooks ? hooksHome : bareHome,
      steps: Array.from({ length: seriesSteps }, () => newPatch(context, 'series').step),
    })
    const events = (await deliveredNames(profile.spool)).length
    await clearDelivered(profile.spool)
    return {
      durationMs: session.result.durationMs,
      ok: session.result.status === 0 && session.events.some((event) => event.type === 'turn.completed'),
      events,
    }
  }, seriesPairs)
}

const withoutPwsh = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH'
  return {
    ...env,
    [key]: (env[key] ?? '')
      .split(delimiter)
      .filter((entry) => !/powershell[\\/]7/i.test(entry))
      .join(delimiter),
  }
}

const codexWithoutPwsh = async (
  context: CheckContext,
  probeForm: CommandForm,
  installForm: CommandForm,
  spool: string,
): Promise<Record<string, unknown>> => {
  const { probe, profile } = context
  const label = 'codex-probe-without-pwsh'
  await clearProbeLog(probe)
  const home = join(context.work, 'codex-without-pwsh')
  const hook = probeHook(context, probeForm, label, ['chain'], 60)
  await writeCodexHome(context, home, { SessionStart: [hook] })
  const session = await runCodex(context, { home, steps: [], adjustEnv: withoutPwsh })
  const entry = (await readProbeLog(probe)).find(withChain(label))
  const codexDirect = [profile.hook, 'codex', 'user', spool]
  const derived = launcherFromProbe(
    'codex command without pwsh on PATH',
    entry,
    { probe: hook.command, hook: installForm.render(codexDirect), direct: codexDirect },
    'codex',
  )
  return {
    session: codexOutcome(session),
    ...('launcher' in derived
      ? { chain: derived.chain, measurementScope: derived.measurementScope, ...(await measure(derived.launcher, spool, { warmup: 5, runs: 100 })) }
      : derived),
  }
}

interface LatencyInputs {
  readonly claudeProbes: readonly ProbeEntry[]
  readonly codexProbes: readonly ProbeEntry[]
  readonly installForm: CommandForm | null
  readonly probeForm: CommandForm | null
}

const withChain =
  (label: string) =>
  (entry: ProbeEntry): boolean =>
    entry.label === label && Array.isArray(entry.chain)

export const hookLatency = async (context: CheckContext, inputs: LatencyInputs): Promise<Record<string, unknown>> => {
  if (inputs.installForm === null || inputs.probeForm === null || inputs.claudeProbes.length === 0) {
    return { unavailable: 'runtime launcher probes did not complete; latency cannot be validated' }
  }
  const { profile, probe } = context
  const spool = join(profile.aangHome, 'spool-latency')
  await createSpool(spool)
  const claudeDirect = [profile.hook, 'claude', 'plugin', spool]
  const codexDirect = [profile.hook, 'codex', 'user', spool]
  const codexLabel = `codex-probe-${inputs.probeForm.id}`
  const derived: Record<string, DerivedLauncher> = {
    'claude shell form': launcherFromProbe(
      'claude shell form',
      inputs.claudeProbes.find(withChain('claude-shell-form')),
      {
        probe: shellCommand([probe.node, ...probeArgs(probe, 'claude-shell-form', ['chain'])]),
        hook: shellCommand(claudeDirect),
        direct: claudeDirect,
      },
      'claude',
    ),
    'codex command': launcherFromProbe(
      'codex command',
      inputs.codexProbes.find(withChain(codexLabel)),
      {
        probe: inputs.probeForm.render([probe.node, ...probeArgs(probe, codexLabel, ['chain'])]),
        hook: inputs.installForm.render(codexDirect),
        direct: codexDirect,
      },
      'codex',
    ),
  }
  const execFormChain = inputs.claudeProbes.find(withChain('claude-exec-form'))?.chain
  const unleased = join(profile.aangHome, 'spool-latency-unleased')
  await createSpool(unleased)
  await revokeLeases(unleased)
  const results: Record<string, unknown> = {
    series: strictSeries,
    claudeExecFormParent:
      typeof execFormChain === 'object' && execFormChain !== null ? (execFormChain[0]?.name ?? null) : null,
    'direct spawn (exec form, strict aang-hook benchmark)': await measure(
      { id: 'direct spawn', command: profile.hook, args: claudeDirect.slice(1), verbatim: false },
      spool,
      strictSeries,
    ),
    'direct spawn without a lease (no spool write)': await measure(
      {
        id: 'direct spawn without a lease',
        command: profile.hook,
        args: ['claude', 'plugin', unleased],
        verbatim: false,
      },
      unleased,
      strictSeries,
    ),
  }
  for (const [id, launcher] of Object.entries(derived)) {
    results[id] =
      'launcher' in launcher
        ? { chain: launcher.chain, measurementScope: launcher.measurementScope, ...(await measure(launcher.launcher, spool, strictSeries)) }
        : launcher
  }
  if (isWindows) {
    results['codex command without pwsh on PATH'] = await codexWithoutPwsh(
      context,
      inputs.probeForm,
      inputs.installForm,
      spool,
    )
  }
  return results
}
