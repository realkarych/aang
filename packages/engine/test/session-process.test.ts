import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { CollectorBatch, JsonValue } from '@aang/contract'
import { contentHash, objectId } from '@aang/contract/ids'
import type { Store } from '@aang/store'
import { createPlayer } from '@aang/testkit'
import { expect, onTestFinished, test, vi } from 'vitest'
import { batchOf, hookBatch, joinBatches } from './batches.js'
import { factsOf, startEngine } from './harness.js'
import { createHome } from './home.js'
import { createLiveRoots, runLive } from './live.js'
import { claudeHook } from './samples.js'
import { at, clockedEngine, sessionId, source } from './session-fixtures.js'

const milliseconds = (time: number): number => Number(at(time) / 1_000_000n)

const processHook = (pid: number, event: string, time: number, fields: Record<string, JsonValue> = {}): CollectorBatch =>
  hookBatch({
    file: `${String(pid)}-${event}-${String(time)}.evt`,
    arrival: time * 1_000_000,
    env: { CLAUDE_PID: String(pid) },
    payload: claudeHook('SessionStart.startup.json', source, { hook_event_name: event, ...fields }),
  })

const entry = (pid: number, status: string, startedAt: number): string =>
  JSON.stringify({
    pid,
    sessionId: source.session,
    cwd: source.cwd,
    kind: 'interactive',
    status,
    startedAt: milliseconds(startedAt),
    statusUpdatedAt: milliseconds(startedAt),
  })

const registryPath = (pid: number): string => `/claude/sessions/${String(pid)}.json`

const registry = (pid: number, time: number, startedAt = time, status = 'busy'): CollectorBatch => {
  const payload = entry(pid, status, startedAt)
  return batchOf({ records: [{
    runtime: 'claude',
    channel: 'registry',
    stream: null,
    hook: null,
    observed_at: at(time),
    position: { kind: 'file', path: registryPath(pid), content_hash: contentHash(payload) },
    payload,
  }] })
}

const exited = (pid: number, time: number, startedAt: number): CollectorBatch => {
  const payload = entry(pid, 'busy', startedAt)
  return batchOf({ records: [{
    runtime: 'claude',
    channel: 'registry',
    stream: null,
    hook: null,
    observed_at: at(time),
    position: { kind: 'process_exited', path: registryPath(pid), pid, content_hash: contentHash(payload) },
    payload,
  }] })
}

const bash = (call: string, command: string): Record<string, JsonValue> => ({
  tool_use_id: call,
  tool_name: 'Bash',
  tool_input: { command },
})

const actionOf = (store: Store, call: string) =>
  store.observations.getAction(objectId({ kind: 'action', runtime: 'claude', session: source.session, call }))

const exitFact = (store: Store, pid: number) => {
  const fact = factsOf(store).find((candidate) => candidate.kind === 'process_exited' && candidate.payload.pid === pid)
  if (fact === undefined) {
    throw new Error(`no process_exited fact of ${String(pid)}`)
  }
  return fact
}

const unknownAfter = (store: Store, pid: number, time: number) => ({
  execution: { state: 'unknown' },
  outcome: { value: 'unknown', basis: { kind: 'observed' }, evidence: [exitFact(store, pid).id] },
  ended_at: at(time),
})

const started = (pid: number, time: number): CollectorBatch =>
  joinBatches(
    processHook(pid, 'SessionStart', time, { source: time === 0 ? 'startup' : 'resume' }),
    registry(pid, time + 1, time),
    processHook(pid, 'UserPromptSubmit', time + 2, { prompt: 'Run the checks' }),
  )

test('a process that exits without SessionEnd leaves the session unknown and nothing in it failed', async () => {
  const store = (await createHome(onTestFinished)).open()
  const { engine } = clockedEngine(store)
  const helper = objectId({ kind: 'agent', runtime: 'claude', session: source.session, agent: { kind: 'subagent', agent_id: 'helper' } })
  await engine.ingest(joinBatches(
    started(123, 0),
    processHook(123, 'PreToolUse', 10, bash('build', 'pnpm build')),
    processHook(123, 'SubagentStart', 11, { agent_id: 'helper', agent_type: 'checker' }),
    processHook(123, 'PreToolUse', 12, { agent_id: 'helper', ...bash('lint', 'pnpm lint') }),
    processHook(123, 'PreToolUse', 13, bash('deploy', 'make deploy')),
    processHook(123, 'PermissionRequest', 14, { tool_name: 'Bash', tool_input: { command: 'make deploy' } }),
  ))
  expect(store.observations.getSession(sessionId())).toMatchObject({ state: 'turn_running', execution: { state: 'waiting', reason: 'human' } })
  expect(store.observations.questions(sessionId())).toMatchObject([{ decision: { value: 'requested' } }])

  await engine.ingest(exited(123, 100, 0))

  expect(store.observations.getSession(sessionId())).toMatchObject({ state: 'unknown', execution: { state: 'unknown' } })
  for (const call of ['build', 'lint', 'deploy']) {
    expect(actionOf(store, call)).toMatchObject(unknownAfter(store, 123, 100))
  }
  expect(store.observations.getAgent(helper)?.execution).toEqual({ state: 'unknown' })
  expect(store.observations.questions(sessionId())).toMatchObject([{ decision: { value: 'unknown' }, answered_at: null }])
  expect(store.observations.actions(sessionId()).map(({ execution }) => execution.state)).not.toContain('failed')
})

test('a finished action keeps its outcome when the process exits afterwards', async () => {
  const store = (await createHome(onTestFinished)).open()
  const { engine } = clockedEngine(store)
  await engine.ingest(joinBatches(
    started(123, 0),
    processHook(123, 'PreToolUse', 10, bash('build', 'pnpm build')),
    processHook(123, 'PostToolUse', 11, { ...bash('build', 'pnpm build'), tool_response: { stdout: 'ok', stderr: '', interrupted: false } }),
    exited(123, 100, 0),
  ))
  expect(actionOf(store, 'build')).toMatchObject({ execution: { state: 'done' }, outcome: { value: 'ok' }, ended_at: at(11) })
})

test('a new launch revives the session while the action of the exited process stays unknown', async () => {
  const store = (await createHome(onTestFinished)).open()
  const { engine } = clockedEngine(store)
  await engine.ingest(joinBatches(started(123, 0), processHook(123, 'PreToolUse', 10, bash('old', 'pnpm build'))))
  await engine.ingest(exited(123, 100, 0))
  expect(store.observations.getSession(sessionId())).toMatchObject({ state: 'unknown' })

  await engine.ingest(joinBatches(started(456, 200), processHook(456, 'PreToolUse', 210, bash('new', 'pnpm test'))))

  expect(store.observations.getSession(sessionId())).toMatchObject({ state: 'turn_running', execution: { state: 'running' } })
  expect(actionOf(store, 'new')).toMatchObject({ execution: { state: 'running' }, outcome: null, ended_at: null })
  expect(actionOf(store, 'old')).toMatchObject(unknownAfter(store, 123, 100))
})

test('an exit found after a newer process of the session appeared does not end the session', async () => {
  const store = (await createHome(onTestFinished)).open()
  const { engine } = clockedEngine(store)
  await engine.ingest(joinBatches(
    started(123, 0),
    processHook(123, 'PreToolUse', 10, bash('old', 'pnpm build')),
    started(456, 50),
    processHook(456, 'PreToolUse', 60, bash('new', 'pnpm test')),
    processHook(456, 'PermissionRequest', 61, { tool_name: 'Bash', tool_input: { command: 'pnpm test' } }),
  ))

  await engine.ingest(exited(123, 100, 0))

  expect(store.observations.getSession(sessionId())).toMatchObject({ state: 'turn_running', execution: { state: 'waiting', reason: 'human' } })
  expect(actionOf(store, 'new')).toMatchObject({ execution: { state: 'running' }, outcome: null })
  expect(actionOf(store, 'old')).toMatchObject(unknownAfter(store, 123, 100))
  expect(store.observations.questions(sessionId())).toMatchObject([{ decision: { value: 'requested' } }])
})

test('a resumed session that crashes again is unknown although the first crash was found after the resume', async () => {
  const store = (await createHome(onTestFinished)).open()
  const { engine } = clockedEngine(store)
  await engine.ingest(joinBatches(
    started(123, 0),
    processHook(123, 'PreToolUse', 10, bash('old', 'pnpm build')),
    started(456, 50),
  ))
  await engine.ingest(joinBatches(
    exited(123, 100, 0),
    processHook(456, 'PreToolUse', 110, bash('new', 'pnpm test')),
    processHook(456, 'PermissionRequest', 111, { tool_name: 'Bash', tool_input: { command: 'pnpm test' } }),
  ))
  expect(store.observations.getSession(sessionId())).toMatchObject({ state: 'turn_running', execution: { state: 'waiting', reason: 'human' } })

  await engine.ingest(exited(456, 200, 50))

  expect(store.observations.getSession(sessionId())).toMatchObject({ state: 'unknown', execution: { state: 'unknown' } })
  expect(actionOf(store, 'new')).toMatchObject(unknownAfter(store, 456, 200))
  expect(actionOf(store, 'old')).toMatchObject(unknownAfter(store, 123, 100))
  expect(store.observations.questions(sessionId())).toMatchObject([{ decision: { value: 'unknown' }, answered_at: null }])
})

test('an older process still running after a newer one started does not hide the exit of the newer one', async () => {
  const store = (await createHome(onTestFinished)).open()
  const { engine } = clockedEngine(store)
  await engine.ingest(joinBatches(
    started(123, 0),
    started(456, 50),
    registry(123, 60, 0, 'idle'),
    exited(123, 100, 0),
    processHook(456, 'PreToolUse', 110, bash('new', 'pnpm test')),
  ))
  expect(store.observations.getSession(sessionId())).toMatchObject({ state: 'turn_running', execution: { state: 'running' } })

  await engine.ingest(exited(456, 200, 50))

  expect(store.observations.getSession(sessionId())).toMatchObject({ state: 'unknown', execution: { state: 'unknown' } })
  expect(actionOf(store, 'new')).toMatchObject(unknownAfter(store, 456, 200))
})

test('an ended session stays ended when the stale registry file of its process is found later', async () => {
  const store = (await createHome(onTestFinished)).open()
  const { engine } = clockedEngine(store)
  await engine.ingest(joinBatches(
    started(123, 0),
    processHook(123, 'Stop', 10),
    processHook(123, 'SessionEnd', 11, { reason: 'other' }),
    exited(123, 100, 0),
  ))
  expect(store.observations.getSession(sessionId())).toMatchObject({ state: 'ended', execution: { state: 'done' } })
})

test('the collector never finds exited a played process that removes and writes its registry entry again', async () => {
  const processCheckIntervalMs = 20
  const store = (await createHome(onTestFinished)).open()
  const roots = await createLiveRoots(onTestFinished)
  const home = join(dirname(roots.spool), 'home')
  await mkdir(home, { recursive: true })
  const live = runLive(onTestFinished, roots, store, startEngine(store, { all: true }), { processCheckIntervalMs })
  const target = { root: 'claude', path: 'sessions/4545.json' } as const
  const player = createPlayer(
    {
      file: 'rewritten registry entry',
      steps: [
        { at: 0, kind: 'write', target, source: 'busy.json' },
        { at: 0, kind: 'remove', target },
        { at: 0, kind: 'write', target, source: 'idle.json' },
        { at: 0, kind: 'remove', target, label: 'removed' },
      ],
      sources: new Map([
        ['busy.json', Buffer.from(entry(4545, 'busy', 0))],
        ['idle.json', Buffer.from(entry(4545, 'idle', 0))],
      ]),
    },
    { roots: { home, claude: roots.claude, codex: roots.codex }, timeScale: 0 },
  )
  onTestFinished(player.close)
  const positions = () =>
    live.batches().flatMap(({ records }) => records.map(({ position, payload }) => ({ kind: position.kind, payload })))

  await player.play({ until: 'removed' })
  await vi.waitFor(() => {
    expect(positions()).toContainEqual({ kind: 'file', payload: expect.stringContaining('"status":"idle"') as string })
  }, { timeout: 15_000 })
  await sleep(processCheckIntervalMs * 10)
  await player.play()
  await vi.waitFor(() => {
    expect(positions().at(-1)).toMatchObject({ kind: 'file_removed' })
  }, { timeout: 15_000 })

  expect(positions().map(({ kind }) => kind)).not.toContain('process_exited')
})
