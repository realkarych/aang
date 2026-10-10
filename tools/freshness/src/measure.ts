import { copyFile, mkdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { type ChatMessage, Config, endpoints, type RunId, type Runtime, type UsageReport } from '@aang/contract'
import { configFileName } from '@aang/contract/config-file'
import { aangHomePaths } from '@aang/contract/home'
import { hookInstallPaths } from '@aang/hook'
import { openStore, type Store } from '@aang/store'
import {
  createPlayer,
  type HookTarget,
  launchDaemon,
  type PlayerRoots,
  playbackShift,
  profileEnvironment,
  type RunningDaemon,
} from '@aang/testkit'
import type { z } from 'zod'
import type { Played } from './control.js'
import { evaluateEvents } from './evaluate.js'
import {
  type Annotations,
  type AskedQuestion,
  createOnce,
  json,
  type MeasuredBackend,
  type MeasuredCall,
  Measurement,
  measurementFiles,
  readFixed,
  type SpentCall,
  type StateSample,
  writeNew,
} from './files.js'
import type { ChatQuestion, FixedProfile, LoadProfile, ObserverSettings } from './profile.js'
import { loadFixedRecording, nativeSessions, type Recording } from './recording.js'

export interface MeasureOptions {
  readonly directory: string
  readonly fixtures: string
  readonly daemonEntry: string
  readonly hookBinary: string
}

interface Scheduled {
  readonly startMs: number
  readonly recording: Recording
  readonly chat: readonly ChatQuestion[]
}

interface Sampler {
  readonly stop: () => Promise<StateSample[]>
}

interface Plan {
  readonly profile: LoadProfile
  readonly scheduled: readonly Scheduled[]
  readonly roots: PlayerRoots
  readonly hook: HookTarget
}

interface Collected {
  readonly backends: MeasuredBackend[]
  readonly startedAt: number
  readonly endedAt: number
  readonly played: Played[]
  readonly states: StateSample[]
  readonly calls: MeasuredCall[]
  readonly questions: AskedQuestion[]
  readonly usage: UsageReport
  readonly version: string
}

const pollMs = 250
const admissionTimeoutMs = 300_000
const runLookupMs = 120_000
const answerTimeoutMs = 300_000
const nanosecondsPerMillisecond = 1_000_000n

const millisecondsOf = (value: bigint): number => Number(value / nanosecondsPerMillisecond)

const until = async (time: number, signal?: AbortSignal): Promise<void> => {
  await sleep(Math.max(0, time - Date.now()), undefined, signal === undefined ? {} : { signal })
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const fetchJson = async <T extends z.ZodType>(
  daemon: RunningDaemon,
  path: string,
  schema: T,
  init?: RequestInit,
): Promise<z.output<T>> => {
  const response = await daemon.request(path, init)
  if (!response.ok) {
    throw new Error(`${path} answered ${String(response.status)}: ${await response.text()}`)
  }
  return schema.parse(await response.json())
}

const admitted = async (daemon: RunningDaemon, runtimes: readonly Runtime[]): Promise<MeasuredBackend[]> => {
  const deadline = Date.now() + admissionTimeoutMs
  for (;;) {
    const { observer } = await fetchJson(daemon, endpoints.status.path, endpoints.status.response)
    const backendOf = (runtime: Runtime) => observer.backends.find(({ vendor }) => vendor === runtime)
    const pending = runtimes.filter((runtime) => (backendOf(runtime)?.admission?.outcome ?? 'pending') === 'pending')
    if (pending.length === 0 || Date.now() > deadline) {
      return runtimes.map((runtime) => {
        const backend = backendOf(runtime)
        const admission = backend?.admission ?? null
        if (backend === undefined || admission?.outcome !== 'admitted') {
          throw new Error(
            `the ${runtime} observer is not admitted: ${backend?.state.state ?? 'absent'}, ${admission?.outcome ?? 'pending'} ${admission?.failure ?? ''}`,
          )
        }
        return {
          vendor: runtime,
          cli_version: backend.cli_version,
          model: backend.model,
          effort: backend.effort,
          admission: admission.outcome,
        }
      })
    }
    await sleep(pollMs)
  }
}

const sampleStates = (daemon: RunningDaemon): Sampler => {
  const samples: StateSample[] = []
  const last = new Map<RunId, string>()
  const running = { value: true }
  const loop = (async (): Promise<Error | null> => {
    while (running.value) {
      const { runs } = await fetchJson(daemon, endpoints.runs.path, endpoints.runs.response)
      const at = Date.now()
      for (const { id, runtime, observer } of runs) {
        const { state } = observer
        const key = JSON.stringify([state.state, 'reason' in state ? state.reason : null, observer.pending_facts])
        if (last.get(id) !== key) {
          last.set(id, key)
          samples.push({ at, run: id, runtime, state, pending_facts: observer.pending_facts })
        }
      }
      await sleep(pollMs)
    }
    return null
  })().catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))))
  return {
    stop: async () => {
      running.value = false
      const failure = await loop
      if (failure !== null) {
        throw failure
      }
      return samples
    },
  }
}

const callsOf = async (daemon: RunningDaemon): Promise<MeasuredCall[]> => {
  const { runs } = await fetchJson(daemon, endpoints.runs.path, endpoints.runs.response)
  const calls = await Promise.all(
    runs.map(async ({ id, runtime }) => {
      const path = endpoints.observerCalls.path.replace(':run', encodeURIComponent(id))
      const { calls: answered } = await fetchJson(daemon, path, endpoints.observerCalls.response)
      return answered.map(
        (call): MeasuredCall => ({
          id: call.id,
          run: id,
          runtime,
          outcome: call.outcome,
          result_version: call.result_version,
          started_at: millisecondsOf(call.started_at),
          ended_at: call.ended_at === null ? null : millisecondsOf(call.ended_at),
          latency_ms: call.latency_ms,
          needs_latency_ms: call.needs_latency_ms,
          error: call.error?.class ?? null,
          facts: call.facts.length,
          usage: call.usage,
        }),
      )
    }),
  )
  return calls.flat()
}

const daemonConfig = (profile: LoadProfile, aang: string): Config => {
  const cliOf = (runtime: Runtime, settings: ObserverSettings | undefined): string | null =>
    settings === undefined ? join(aang, 'absent', runtime) : settings.cli
  const { claude, codex } = profile.observer
  return Config.parse({
    watch: { all: true },
    api: { port: 0 },
    otel: { port: 0 },
    cli: { claude: cliOf('claude', claude), codex: cliOf('codex', codex) },
    observer: {
      models: {
        ...(claude?.model == null ? {} : { claude: claude.model }),
        ...(codex?.model == null ? {} : { codex: codex.model }),
      },
      effort: { claude: claude?.effort ?? null, codex: codex?.effort ?? null },
    },
  })
}

const usedRuntimeHome = (roots: PlayerRoots): string[] => [
  join(roots.claude, 'projects'),
  join(roots.claude, 'sessions'),
  join(roots.claude, 'teams'),
  join(roots.codex, 'sessions'),
  join(roots.codex, 'archived_sessions'),
]

const schedule = async ({ profile, recordings }: FixedProfile, fixtures: string): Promise<Scheduled[]> => {
  const scheduled: Scheduled[] = []
  for (const [index, fixed] of recordings.entries()) {
    scheduled.push({
      startMs: fixed.start_ms,
      recording: await loadFixedRecording(fixtures, fixed),
      chat: profile.runs[index]?.chat ?? [],
    })
  }
  return scheduled
}

const playAll = async ({ profile, scheduled, roots, hook }: Plan, startedAt: number, otlp: string): Promise<Played[]> => {
  const stopping = new AbortController()
  const plays = scheduled.map(async ({ startMs, recording }): Promise<Played> => {
    try {
      await until(startedAt + startMs, stopping.signal)
      const recordTime = Date.now()
      const player = createPlayer(recording.playback, {
        roots,
        timeScale: profile.time_scale,
        recordTime: { startsAt: recordTime },
        hook,
        otlp,
      })
      const startsAt = Date.now()
      const steps = await player.play({ signal: stopping.signal })
      return { recording, shift: playbackShift(recording.playback.sources.values(), recordTime), startsAt, steps }
    } catch (error) {
      stopping.abort(error)
      throw error
    }
  })
  const settled = await Promise.allSettled(plays)
  const failure: unknown = stopping.signal.reason
  if (stopping.signal.aborted) {
    throw failure
  }
  return settled.flatMap((outcome) => (outcome.status === 'fulfilled' ? [outcome.value] : []))
}

const runOf = async (daemon: RunningDaemon, recording: Recording, signal: AbortSignal): Promise<RunId | null> => {
  const sessions = nativeSessions(recording)
  const deadline = Date.now() + runLookupMs
  while (Date.now() < deadline) {
    const { runs } = await fetchJson(daemon, endpoints.runs.path, endpoints.runs.response)
    for (const { id } of runs) {
      const { objects } = await fetchJson(daemon, endpoints.run.path.replace(':run', encodeURIComponent(id)), endpoints.run.response)
      if (objects.sessions.some(({ key }) => sessions.has(key.session))) {
        return id
      }
    }
    await sleep(1_000, undefined, { signal })
  }
  return null
}

const ask = async (
  daemon: RunningDaemon,
  { recording, startMs }: Scheduled,
  { after_ms: after, question }: ChatQuestion,
  startedAt: number,
  signal: AbortSignal,
): Promise<AskedQuestion> => {
  const scheduledAt = startedAt + startMs + after
  await until(scheduledAt, signal)
  const asked = {
    recording: recording.path,
    runtime: recording.manifest.runtime,
    question,
    scheduled_at: scheduledAt,
    asked_at: null,
    answered_at: null,
    insufficient_data: null,
  }
  const run = await runOf(daemon, recording, signal)
  if (run === null) {
    return { ...asked, run, message: null, status: 'not_asked', error: 'the run of the recording did not appear' }
  }
  const response = await daemon.request(endpoints.chatQuestion.path.replace(':run', encodeURIComponent(run)), {
    method: endpoints.chatQuestion.method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question, stage: null }),
  })
  if (!response.ok) {
    return { ...asked, run, message: null, status: 'not_asked', error: `${String(response.status)}: ${await response.text()}` }
  }
  const { message } = endpoints.chatQuestion.response.parse(await response.json())
  return { ...asked, run, message: message.id, status: message.status, asked_at: millisecondsOf(message.asked_at), error: null }
}

const answered = (asked: AskedQuestion, messages: readonly ChatMessage[]): AskedQuestion => {
  const message = messages.find(({ id }) => id === asked.message)
  return message === undefined
    ? asked
    : {
        ...asked,
        status: message.status,
        answered_at: message.answered_at === null ? null : millisecondsOf(message.answered_at),
        insufficient_data: message.status === 'answered' ? message.insufficient_data : null,
        error: message.error,
      }
}

const answersOf = async (daemon: RunningDaemon, questions: readonly AskedQuestion[]): Promise<AskedQuestion[]> => {
  const deadline = Date.now() + answerTimeoutMs
  for (;;) {
    const runs = [...new Set(questions.flatMap(({ run }) => (run === null ? [] : [run])))]
    const histories = await Promise.all(
      runs.map(async (run) => (await fetchJson(daemon, endpoints.chatHistory.path.replace(':run', encodeURIComponent(run)), endpoints.chatHistory.response)).messages),
    )
    const current = questions.map((asked) => answered(asked, histories.flat()))
    if (current.every(({ status }) => status !== 'pending') || Date.now() > deadline) {
      return current
    }
    await sleep(pollMs)
  }
}

const askAll = (daemon: RunningDaemon, { scheduled }: Plan, startedAt: number, signal: AbortSignal): Promise<AskedQuestion[]> =>
  Promise.all(scheduled.flatMap((run) => run.chat.map((question) => ask(daemon, run, question, startedAt, signal))))

const collect = async (daemon: RunningDaemon, plan: Plan): Promise<Collected> => {
  const runtimes = [...new Set(plan.scheduled.map(({ recording }) => recording.manifest.runtime))]
  const backends = await admitted(daemon, runtimes)
  const { endpoint } = await fetchJson(daemon, endpoints.otelConfig.path, endpoints.otelConfig.response, {
    method: endpoints.otelConfig.method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rotate: false }),
  })
  const sampler = sampleStates(daemon)
  const startedAt = Date.now()
  const asking = new AbortController()
  const questions = askAll(daemon, plan, startedAt, asking.signal)
  void questions.catch(() => undefined)
  const played = await playAll(plan, startedAt, endpoint).catch(async (error: unknown) => {
    asking.abort(error)
    await Promise.allSettled([questions, sampler.stop()])
    throw error
  })
  const controlTimes = played.flatMap(({ recording, steps }) =>
    recording.events.map(({ index }) => steps[index]?.playedAt ?? startedAt),
  )
  await until(Math.max(startedAt, ...controlTimes) + plan.profile.window_ms)
  const asked = await answersOf(daemon, await questions)
  const states = await sampler.stop()
  const calls = await callsOf(daemon)
  const usage = await fetchJson(daemon, endpoints.usage.path, endpoints.usage.response)
  const status = await fetchJson(daemon, endpoints.status.path, endpoints.status.response)
  return { backends, startedAt, endedAt: Date.now(), played, states, calls, questions: asked, usage, version: status.daemon.version }
}

const spentCalls = (store: Store, runs: readonly RunId[]): SpentCall[] => [
  ...runs.flatMap((run) =>
    store.observerCalls.chats(run).map(
      (call): SpentCall => ({
        run,
        backend: call.backend,
        kind: 'chat',
        verdict: call.verdict,
        started_at: millisecondsOf(call.started_at),
        ended_at: millisecondsOf(call.finished_at),
        usage: call.usage,
      }),
    ),
  ),
  ...store.observerCalls.checks().map(
    (check): SpentCall => ({
      run: null,
      backend: check.backend,
      kind: check.kind,
      verdict: check.verdict,
      started_at: millisecondsOf(check.started_at),
      ended_at: millisecondsOf(check.finished_at),
      usage: check.usage,
    }),
  ),
]

const shutDown = async (daemon: RunningDaemon): Promise<void> => {
  const exit = await daemon.stop().catch(async (error: unknown) => {
    await daemon.kill()
    throw new Error(
      `the daemon did not shut down and was killed, its observer processes may outlive it: ${messageOf(error)}\n${daemon.output()}`,
      { cause: error },
    )
  })
  if (exit.code !== 0) {
    throw new Error(`the daemon did not stop cleanly: ${JSON.stringify(exit)}\n${daemon.output()}`)
  }
}

export const measure = async (options: MeasureOptions): Promise<Measurement> => {
  const directory = await realpath(options.directory)
  const { fixed, digest } = await readFixed(directory)
  const { profile } = fixed
  const scheduled = await schedule(fixed, options.fixtures)
  const home = join(directory, measurementFiles.home)
  const aang = join(directory, measurementFiles.aang)
  const roots: PlayerRoots = { home, claude: join(home, '.claude'), codex: join(home, '.codex') }
  await createOnce(
    () => mkdir(aang, { mode: 0o700 }),
    `a measurement has already run in ${directory}; fix the profile into a new directory`,
  )
  for (const runtimeDirectory of usedRuntimeHome(roots)) {
    await mkdir(runtimeDirectory, { recursive: true })
  }
  await writeFile(join(aang, configFileName), json(daemonConfig(profile, aang)))
  const launcher = hookInstallPaths(aang).binary
  await mkdir(dirname(launcher), { recursive: true })
  await copyFile(options.hookBinary, launcher)
  const paths = aangHomePaths(aang)
  const env = profileEnvironment(process.env, { AANG_HOME: aang, CLAUDE_CONFIG_DIR: roots.claude, CODEX_HOME: roots.codex })
  const daemon = await launchDaemon(paths, env, { entry: options.daemonEntry })
  const plan: Plan = { profile, scheduled, roots, hook: { binary: options.hookBinary, spool: paths.spool, env } }
  const collected = await collect(daemon, plan).catch(async (error: unknown) => {
    const stopped: unknown = await shutDown(daemon).then(
      () => null,
      (failure: unknown) => failure,
    )
    throw stopped === null ? error : new Error(`${messageOf(error)}\n${messageOf(stopped)}`, { cause: error })
  })
  await shutDown(daemon)
  const store = openStore({ home: aang })
  const { events, spent, calls } = (() => {
    try {
      return {
        events: evaluateEvents({
          store,
          played: collected.played,
          calls: collected.calls,
          roots,
          windowMs: profile.window_ms,
          timeScale: profile.time_scale,
        }),
        spent: spentCalls(store, store.model.runs().map(({ id }) => id)),
        calls: collected.calls.map((call) => ({ ...call, error: store.observerCalls.get(call.id)?.error?.class ?? call.error })),
      }
    } finally {
      store.close()
    }
  })()
  const measurement: Measurement = {
    format: 'aang-freshness-measurement/1',
    profile_digest: digest,
    daemon_version: collected.version,
    started_at: collected.startedAt,
    ended_at: collected.endedAt,
    backends: collected.backends,
    recordings: collected.played.map(({ recording, startsAt, steps }) => ({
      recording: recording.path,
      runtime: recording.manifest.runtime,
      started_at: startsAt,
      finished_at: steps.at(-1)?.playedAt ?? startsAt,
    })),
    events,
    calls,
    states: collected.states,
    questions: collected.questions,
    spent,
    usage: collected.usage,
  }
  await writeNew(join(directory, measurementFiles.measurement), Measurement.encode(measurement))
  const annotations: Annotations = {
    format: 'aang-freshness-annotations/1',
    events: events.flatMap(({ recording, label, description, evaluation }) =>
      evaluation.kind === 'annotation' ? [{ recording, label, description, candidates: evaluation.candidates, verdict: null }] : [],
    ),
  }
  await writeNew(join(directory, measurementFiles.annotations), annotations)
  return measurement
}
