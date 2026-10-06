import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  endpoints,
  EpochNs,
  type ObserverBackendStatus,
  type RunSummary,
  type Runtime,
  type SessionKey,
  type SseEvent,
  type StatusResponse,
} from '@aang/contract'
import { runId } from '@aang/contract/ids'
import { installFakeClaude, installFakeCodex } from '@aang/testkit'
import { test } from 'vitest'
import type { z } from 'zod'
import { bearer, type Home, type RunningDaemon, startDaemon } from './daemon.js'
import {
  admissionMs,
  briefed,
  configure,
  installLauncher,
  observerEnvironment,
  progressOf,
  settled,
  toolAttempt,
} from './observers.js'
import { claudeHook, codexHook, enqueue, waitUntil, watchedHome } from './sessions.js'
import { openKnownRun, openStream } from './stream-client.js'

const codexKey = (session: string): SessionKey => ({ kind: 'session', runtime: 'codex', session })

const claudeKey = (session: string): SessionKey => ({ kind: 'session', runtime: 'claude', session })

const codexEvents = (session: string, workspace: string): string[] => [
  codexHook('SessionStart.startup', session, workspace),
  codexHook('PermissionRequest', session, workspace),
]

const statusesOf = (events: readonly SseEvent[]): StatusResponse[] =>
  events.flatMap((event) => (event.event === 'status' ? [event.data] : []))

const summariesOf = (events: readonly SseEvent[]): RunSummary[] =>
  events.flatMap((event) => (event.event === 'run' ? [event.data.summary] : []))

const backendOf = (status: StatusResponse | undefined, vendor: Runtime): ObserverBackendStatus | undefined =>
  status?.observer.backends.find((backend) => backend.vendor === vendor)

const latestBackend = (events: readonly SseEvent[], vendor: Runtime): ObserverBackendStatus | undefined =>
  backendOf(statusesOf(events).at(-1), vendor)

const get = async <S extends z.ZodType>(daemon: RunningDaemon, home: Home, path: string, schema: S): Promise<z.output<S>> => {
  const response = await fetch(`${daemon.base}${path}`, { headers: bearer(home.token) })
  if (response.status !== 200) {
    throw new Error(`GET ${path} answered ${String(response.status)}`)
  }
  return schema.parse(await response.json())
}

const absentClaude: ObserverBackendStatus = {
  vendor: 'claude',
  state: { state: 'disabled', reason: 'cli_missing' },
  cli_path: null,
  cli_version: null,
  model: 'claude-opus-5-5',
  effort: null,
  admission: null,
}

test('the admission and an isolation violation of the Codex observer reach /api/status, the run summary and both streams', async ({
  expect,
  onTestFinished,
}) => {
  const { home, workspace } = await watchedHome(onTestFinished)
  const codex = installFakeCodex(join(home.root, 'fake-cli'), { replies: [toolAttempt] })
  await installLauncher(home)
  const path = codex.path
  await configure(home, workspace, { cli: { codex: path }, observer: { effort: { codex: 'low' } } })
  const launched = EpochNs.parse(BigInt(Date.now()) * 1_000_000n)
  const daemon = await startDaemon(home, onTestFinished, { env: observerEnvironment(home) })
  const status = await openStream(daemon.base, home.token, {})

  await status.until(
    (events) =>
      latestBackend(events, 'codex')?.admission?.outcome === 'admitted' &&
      latestBackend(events, 'claude')?.state.state === 'disabled',
  )
  const admitted = await get(daemon, home, '/api/status', endpoints.status.response)
  const checkedAt = backendOf(admitted, 'codex')?.admission?.checked_at
  const codexAdmitted: ObserverBackendStatus = {
    vendor: 'codex',
    state: { state: 'ok' },
    cli_path: path,
    cli_version: '0.159.3',
    model: 'gpt-6.1-sol',
    effort: 'low',
    admission: {
      vendor: 'codex',
      cli_version: '0.159.3',
      outcome: 'admitted',
      failure: null,
      cross_session_inbound_verified: true,
      checked_at: checkedAt ?? launched,
    },
  }
  expect(admitted.observer).toEqual({ cross_vendor: false, backends: [absentClaude, codexAdmitted] })
  expect(checkedAt).toBeGreaterThanOrEqual(launched)
  expect(statusesOf(status.events).at(-1)?.observer).toEqual(admitted.observer)
  const joined = await openStream(daemon.base, home.token, { lastEventId: '0' })
  await joined.until((events) => statusesOf(events).length > 0)
  expect(statusesOf(joined.events).map(({ observer }) => observer)).toEqual([admitted.observer])

  const observed = runId(codexKey('thread-g6-status'))
  await enqueue(home, 'codex', codexEvents('thread-g6-status', workspace), 'codex')
  const feed = await openKnownRun(daemon.base, home.token, { run: observed })
  await feed.until((events) => {
    const observer = summariesOf(events).at(-1)?.observer
    return observer?.state.state === 'disabled' && observer.pending_facts === 2
  })
  await status.until((events) => latestBackend(events, 'codex')?.admission?.outcome === 'failed')

  const violated = latestBackend(status.events, 'codex')
  expect(violated).toEqual({
    ...codexAdmitted,
    state: { state: 'disabled', reason: 'isolation' },
    admission: {
      ...codexAdmitted.admission,
      outcome: 'failed',
      failure: 'Codex attempted an unsupported tool call',
      cross_session_inbound_verified: false,
    },
  })
  expect((await get(daemon, home, '/api/status', endpoints.status.response)).observer.backends).toEqual([absentClaude, violated])
  const summary = summariesOf(feed.events).at(-1)
  expect(summary?.observer).toMatchObject({
    state: { state: 'disabled', reason: 'isolation' },
    pending_facts: 2,
    not_interpreted_facts: 0,
    last_success_at: null,
    isolation_unverified: false,
  })
  expect((await get(daemon, home, '/api/runs', endpoints.runs.response)).runs.map(({ observer }) => observer)).toEqual([
    summary?.observer,
  ])

  const statusEvents = status.events.filter((event) => event.event === 'status')
  expect(statusEvents.map(({ id }) => id)).toEqual(statusEvents.map(({ data }) => data.database.change_seq))
  const sections = statusesOf(status.events).map(({ observer }) => observer)
  sections.slice(1).forEach((section, index) => {
    expect(section).not.toEqual(sections[index])
  })
  await Promise.all([status.close(), joined.close(), feed.close()])
})

test('a subscription limit of the Codex observer shows in /api/status and both streams with the time of the next attempt', async ({
  expect,
  onTestFinished,
}) => {
  const { home, workspace } = await watchedHome(onTestFinished)
  const resetsAt = Math.floor(Date.now() / 1_000) + 3_600
  const codex = installFakeCodex(join(home.root, 'fake-cli'), { replies: [{ kind: 'limit', resetsAt }] })
  await installLauncher(home)
  await configure(home, workspace, { cli: { codex: codex.path } })
  const daemon = await startDaemon(home, onTestFinished, { env: observerEnvironment(home) })
  const status = await openStream(daemon.base, home.token, {})
  const observed = runId(codexKey('thread-g6-limit'))

  await enqueue(home, 'codex', codexEvents('thread-g6-limit', workspace), 'codex')
  const feed = await openKnownRun(daemon.base, home.token, { run: observed })
  await feed.until((events) => summariesOf(events).at(-1)?.observer.state.state === 'unavailable')
  await status.until((events) => latestBackend(events, 'codex')?.state.state === 'unavailable')

  const limited = { state: 'unavailable', reason: 'limit', retry_at: BigInt(resetsAt) * 1_000_000_000n }
  expect(latestBackend(status.events, 'codex')?.state).toEqual(limited)
  expect(summariesOf(feed.events).at(-1)?.observer.state).toEqual(limited)
  const current = await get(daemon, home, '/api/status', endpoints.status.response)
  expect(backendOf(current, 'codex')).toMatchObject({ state: limited, admission: { outcome: 'admitted' } })
  await waitUntil(() => progressOf(home, observed).statuses.every((value) => value === 'pending'))
  await Promise.all([status.close(), feed.close()])
})

test('a run stream follows its observer through admission when no facts change', async ({ expect, onTestFinished }) => {
  const { home, workspace } = await watchedHome(onTestFinished)
  const codex = installFakeCodex(join(home.root, 'fake-cli'), { replies: [briefed] })
  await installLauncher(home)
  await configure(home, workspace, { cli: { codex: codex.path } })
  const observed = runId(codexKey('thread-g6-admission'))
  const first = await startDaemon(home, onTestFinished, { env: observerEnvironment(home) })
  await enqueue(home, 'codex', codexEvents('thread-g6-admission', workspace), 'codex')
  await waitUntil(() => settled(progressOf(home, observed)))
  first.abort()
  await first.stopped

  const hold = { gate: join(home.root, 'gate'), started: join(home.root, 'started') }
  await configure(home, workspace, { cli: { codex: codex.held(hold) } })
  const daemon = await startDaemon(home, onTestFinished, { env: observerEnvironment(home) })
  await waitUntil(() => existsSync(hold.started))
  const feed = await openStream(daemon.base, home.token, { run: observed })
  await feed.until((events) => summariesOf(events).length > 0)
  await writeFile(hold.gate, '')
  await feed.until((events) => summariesOf(events).at(-1)?.observer.state.state === 'ok')

  const states = summariesOf(feed.events).map(({ observer }) => observer.state)
  expect([states[0], states.at(-1)]).toEqual([{ state: 'disabled', reason: 'version_not_admitted' }, { state: 'ok' }])
  expect(feed.events.every(({ event }) => event === 'run')).toBe(true)
  expect(progressOf(home, observed).batches).toEqual([{ verdict: 'accepted', error: null }])
  await feed.close()
})

test(
  'a Claude run carries the unverified isolation mark in its summary and stream, and the status shows which admission left it',
  async ({ expect, onTestFinished }) => {
    const { home, workspace } = await watchedHome(onTestFinished)
    const claude = installFakeClaude(join(home.root, 'fake-cli'), { replies: [briefed], admissionMs })
    const codex = installFakeCodex(join(home.root, 'fake-cli'), { replies: [briefed] })
    await installLauncher(home)
    await configure(home, workspace, { cli: { claude: claude.path, codex: codex.path } })
    const daemon = await startDaemon(home, onTestFinished, { env: observerEnvironment(home) })
    const claudeRun = runId(claudeKey('session-g6-mark'))
    const codexRun = runId(codexKey('thread-g6-mark'))

    await enqueue(home, 'claude', [
      claudeHook('SessionStart.startup', 'session-g6-mark', workspace),
      claudeHook('PermissionRequest.Bash', 'session-g6-mark', workspace),
    ])
    await enqueue(home, 'codex', codexEvents('thread-g6-mark', workspace), 'codex')
    await waitUntil(() => settled(progressOf(home, claudeRun)) && settled(progressOf(home, codexRun)))

    const { runs } = await get(daemon, home, '/api/runs', endpoints.runs.response)
    expect(
      Object.fromEntries(runs.map(({ id, observer }) => [id, { state: observer.state, unverified: observer.isolation_unverified }])),
    ).toEqual({
      [claudeRun]: { state: { state: 'ok' }, unverified: true },
      [codexRun]: { state: { state: 'ok' }, unverified: false },
    })
    const feed = await openStream(daemon.base, home.token, { run: claudeRun })
    await feed.until((events) => summariesOf(events).length > 0)
    expect(summariesOf(feed.events)[0]?.observer.isolation_unverified).toBe(true)
    const current = await get(daemon, home, '/api/status', endpoints.status.response)
    expect(
      current.observer.backends.map(({ vendor, state, admission }) => ({
        vendor,
        state,
        version: admission?.cli_version,
        outcome: admission?.outcome,
        verified: admission?.cross_session_inbound_verified,
      })),
    ).toEqual([
      { vendor: 'claude', state: { state: 'ok' }, version: '2.1.286', outcome: 'admitted', verified: false },
      { vendor: 'codex', state: { state: 'ok' }, version: '0.159.3', outcome: 'admitted', verified: true },
    ])
    await feed.close()
  },
)
