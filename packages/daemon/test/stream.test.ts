import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type Action, ApiError, type ApiErrorCode, ChangeSeq, type RunId, type RunSnapshot, type SseEvent } from '@aang/contract'
import { runId } from '@aang/contract/ids'
import { createReadQueries } from '@aang/engine'
import { openStore } from '@aang/store'
import { applyFeed } from '@aang/testkit'
import { describe, type TestContext, test } from 'vitest'
import { bearer, createHome, type Home, type RunningDaemon, startDaemon } from './daemon.js'
import { endsWithRun, lastId, openKnownRun, openStream, requestStream, segmentsOf } from './stream-client.js'

interface Transcript {
  readonly run: RunId
  readonly append: (lines: readonly string[]) => Promise<void>
  readonly call: (call: string, tool?: string, input?: Record<string, unknown>) => string[]
  readonly plan: (call: string, items: readonly string[]) => string[]
}

interface Scene {
  readonly home: Home
  readonly daemon: RunningDaemon
  readonly transcript: (session: string) => Promise<Transcript>
}

const openScene = async (onTestFinished: TestContext['onTestFinished']): Promise<Scene> => {
  const home = await createHome(onTestFinished)
  const workspace = join(home.root, 'work')
  await mkdir(workspace)
  await writeFile(
    join(home.paths.home, 'config.json'),
    JSON.stringify({
      api: { port: 0 },
      otel: { port: 0 },
      collector: { rootsScanIntervalMs: 200 },
      watch: { roots: [{ path: workspace }] },
    }),
  )
  const daemon = await startDaemon(home, onTestFinished)
  const project = join(home.root, '.claude', 'projects', '-work')
  await mkdir(project, { recursive: true })
  return {
    home,
    daemon,
    transcript: async (session) => {
      const file = join(project, `${session}.jsonl`)
      await writeFile(file, '')
      const line = (record: Record<string, unknown>): string =>
        JSON.stringify({ sessionId: session, cwd: workspace, timestamp: new Date().toISOString(), ...record })
      const call = (id: string, tool = 'Bash', input: Record<string, unknown> = { command: `echo ${id}` }): string[] => [
        line({
          type: 'assistant',
          uuid: `${id}-use`,
          message: { id: `${id}-message`, role: 'assistant', content: [{ type: 'tool_use', id, name: tool, input }] },
        }),
        line({
          type: 'user',
          uuid: `${id}-result`,
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', is_error: false }] },
        }),
      ]
      return {
        run: runId({ kind: 'session', runtime: 'claude', session }),
        append: (lines) => appendFile(file, lines.map((entry) => `${entry}\n`).join('')),
        call,
        plan: (id, items) =>
          call(id, 'TodoWrite', { todos: items.map((content) => ({ content, status: 'pending' })) }),
      }
    },
  }
}

const actionsOf = (events: readonly SseEvent[]): Action[] =>
  events.flatMap((event) => (event.event === 'facts' ? event.data.objects.actions : []))

const ended =
  (call: string) =>
  (events: readonly SseEvent[]): boolean =>
    actionsOf(events).some(({ key, ended_at: endedAt }) => key.call === call && endedAt !== null) &&
    endsWithRun(events)

const emptyOf = (snapshot: RunSnapshot): RunSnapshot => ({
  ...snapshot,
  model: { stages: [], criteria: [], cards: [], links: [] },
  objects: {
    sessions: [],
    agents: [],
    actions: [],
    questions: [],
    artifact_versions: [],
    git_snapshots: [],
    usage_records: [],
    gaps: [],
  },
  plan_facts: [],
  attention: { items: [], views: [] },
  bindings: [],
  change_seq: ChangeSeq.parse(0),
})

const stopped = async (daemon: RunningDaemon): Promise<void> => {
  daemon.abort()
  await daemon.stopped
}

const ok = () => ({ state: { state: 'ok' }, isolation_unverified: false }) as const

describe.concurrent('the run stream delivers the change feed over SSE', () => {
  test('a reconnection with Last-Event-ID after the last received event neither loses nor repeats events', async ({
    expect,
    onTestFinished,
  }) => {
    const { home, daemon, transcript } = await openScene(onTestFinished)
    const session = await transcript('g5-reconnect')
    await session.append(session.call('toolu_g5_first'))

    const first = await openKnownRun(daemon.base, home.token, { run: session.run, lastEventId: '0' })
    await first.until(ended('toolu_g5_first'))
    await session.append([...session.plan('toolu_g5_plan', ['read', 'write']), ...session.call('toolu_g5_live')])
    await first.until(ended('toolu_g5_live'))
    await first.close()

    await session.append([
      ...session.call('toolu_g5_away'),
      ...session.plan('toolu_g5_replan', ['read', 'write', 'test']),
      ...session.call('toolu_g5_back'),
    ])
    const resumedAt = lastId(first.events)
    const second = await openStream(daemon.base, home.token, { run: session.run, lastEventId: String(resumedAt) })
    await second.until(ended('toolu_g5_back'))
    await second.close()
    await stopped(daemon)

    const store = openStore({ home: home.paths.home })
    onTestFinished(() => {
      store.close()
    })
    const reads = createReadQueries({ store, observer: ok })
    const final = reads.snapshot(session.run)
    if (final === null) {
      throw new Error('the run must exist')
    }
    const delivered = [...first.events, ...second.events]
    const dataIds = delivered.flatMap(({ event, id }) => (event === 'run' || id === null ? [] : [id]))
    expect(dataIds).toEqual([...new Set(dataIds)].sort((left, right) => left - right))
    expect(
      second.events.every(({ event, id }) => id !== null && (event === 'run' ? id >= resumedAt : id > resumedAt)),
    ).toBe(true)
    expect(actionsOf(first.events).map(({ key }) => key.call)).toContain('toolu_g5_live')
    expect(actionsOf(second.events).map(({ key }) => key.call)).not.toContain('toolu_g5_live')
    expect(actionsOf(second.events).map(({ key }) => key.call)).toContain('toolu_g5_away')

    const replayed = segmentsOf(delivered).reduce(applyFeed, emptyOf(final))
    expect(reads.feed(session.run, replayed.change_seq)?.events).toEqual([])
    expect({ ...replayed, change_seq: final.change_seq }).toEqual(final)
    expect(replayed.plan_facts).toHaveLength(2)
    expect(replayed.objects.actions).toHaveLength(6)
  })

  test('a position ahead of the change feed gives a reset without an id and ends the stream', async ({
    expect,
    onTestFinished,
  }) => {
    const { home, daemon, transcript } = await openScene(onTestFinished)
    const session = await transcript('g5-stale')
    await session.append(session.call('toolu_g5_stale'))
    const known = await openKnownRun(daemon.base, home.token, { run: session.run, lastEventId: '0' })
    await known.until(ended('toolu_g5_stale'))
    await known.close()

    const stale = await openStream(daemon.base, home.token, {
      run: session.run,
      lastEventId: String(lastId(known.events) + 1_000_000),
    })
    await stale.ended

    expect(stale.events).toEqual([{ event: 'reset', id: null, data: { reason: 'stale_position' } }])
  })

  test('without Last-Event-ID the stream starts at the current position and then follows new changes', async ({
    expect,
    onTestFinished,
  }) => {
    const { home, daemon, transcript } = await openScene(onTestFinished)
    const session = await transcript('g5-from-now')
    await session.append(session.call('toolu_g5_before'))
    const known = await openKnownRun(daemon.base, home.token, { run: session.run, lastEventId: '0' })
    await known.until(ended('toolu_g5_before'))
    await known.close()

    const live = await openStream(daemon.base, home.token, { run: session.run })
    await live.until((events) => events.length > 0)
    const [current, ...following] = live.events
    if (current?.event !== 'run') {
      throw new Error(`the stream started with ${String(current?.event)} instead of the run delta`)
    }
    expect(current.id).toBeGreaterThanOrEqual(lastId(known.events))
    await session.append(session.call('toolu_g5_after'))
    await live.until(ended('toolu_g5_after'))
    await live.close()

    expect(actionsOf(live.events).map(({ key }) => key.call)).not.toContain('toolu_g5_before')
    expect(actionsOf(live.events).map(({ key }) => key.call)).toContain('toolu_g5_after')
    expect(following.every(({ id }) => id !== null && id > current.id)).toBe(true)
  })

  test('the stream refuses a request without the token, without a run, with an unknown run or a malformed position', async ({
    expect,
    onTestFinished,
  }) => {
    const { home, daemon, transcript } = await openScene(onTestFinished)
    const session = await transcript('g5-refusals')
    await session.append(session.call('toolu_g5_refusals'))
    const known = await openKnownRun(daemon.base, home.token, { run: session.run, lastEventId: '0' })
    await known.close()
    const refusal = async (request: Parameters<typeof requestStream>[2]): Promise<[number, ApiErrorCode]> => {
      const response = await requestStream(daemon.base, home.token, request)
      return [response.status, ApiError.parse(await response.json()).error.code]
    }
    const unknown = runId({ kind: 'session', runtime: 'claude', session: 'g5-never-seen' })

    expect(await refusal({ run: session.run, token: null })).toEqual([401, 'unauthorized'])
    expect(await refusal({})).toEqual([400, 'invalid_request'])
    expect(await refusal({ run: 'not a run' })).toEqual([400, 'invalid_request'])
    expect(await refusal({ run: unknown, lastEventId: '0' })).toEqual([404, 'not_found'])
    for (const position of ['first', '-1', '1.5', '01']) {
      expect(await refusal({ run: session.run, lastEventId: position })).toEqual([400, 'invalid_request'])
    }
    const other = await fetch(new URL(`/api/stream?run=${session.run}`, daemon.base), {
      method: 'POST',
      headers: { ...bearer(home.token), 'content-type': 'application/json' },
      body: '{}',
    })
    expect(other.status).toBe(404)
  })

  test('a shutdown ends the open streams cleanly and the daemon stops', async ({ expect, onTestFinished }) => {
    const { home, daemon, transcript } = await openScene(onTestFinished)
    const session = await transcript('g5-shutdown')
    await session.append(session.call('toolu_g5_shutdown'))
    const open = await openKnownRun(daemon.base, home.token, { run: session.run })
    await open.until((events) => events.length > 0)

    const shutdown = await fetch(new URL('/api/admin/shutdown', daemon.base), {
      method: 'POST',
      headers: { ...bearer(home.token), 'content-type': 'application/json' },
      body: '{}',
    })
    expect(shutdown.status).toBe(200)

    await expect(open.ended).resolves.toBeUndefined()
    await expect(daemon.stopped).resolves.toBe('shutdown')
  })
})
