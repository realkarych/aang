import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type Action,
  ApiError,
  type ApiErrorCode,
  ChangeSeq,
  endpoints,
  type RunId,
  type RunSnapshot,
  type SseEvent,
} from '@aang/contract'
import { runId } from '@aang/contract/ids'
import { createReadQueries } from '@aang/engine'
import { openStore } from '@aang/store'
import { applyFeed } from '@aang/testkit'
import { describe, type TestContext, test } from 'vitest'
import type { z } from 'zod'
import { bearer, createHome, type Home, missingCli, type RunningDaemon, startDaemon } from './daemon.js'
import { admin, storedCount, waitUntil } from './sessions.js'
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
      cli: missingCli(home.root),
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

const read = async <S extends z.ZodType>(
  { home, daemon }: Pick<Scene, 'home' | 'daemon'>,
  path: string,
  schema: S,
): Promise<z.output<S>> => {
  const response = await fetch(new URL(path, daemon.base), { headers: bearer(home.token) })
  const body: unknown = await response.json()
  if (response.status !== 200) {
    throw new Error(`GET ${path} answered ${String(response.status)}: ${JSON.stringify(body)}`)
  }
  return schema.parse(body)
}

const runPath = (run: RunId): string => `/api/runs/${run}`

const stopped = async (daemon: RunningDaemon): Promise<void> => {
  daemon.abort()
  await daemon.stopped
}

const ok = () => ({ state: { state: 'ok' }, isolation_unverified: false }) as const

const endedAction = `SELECT count(*) AS count FROM objects WHERE kind = 'action' AND run_id = ?
  AND json_extract(entity_key, '$.call') = ? AND json_extract(data, '$.ended_at') IS NOT NULL`

describe.concurrent('the run stream delivers the change feed over SSE', () => {
  test('a reconnection with Last-Event-ID after the last received event neither loses nor repeats events', async ({
    expect,
    onTestFinished,
  }) => {
    const scene = await openScene(onTestFinished)
    const { home, daemon, transcript } = scene
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

    const final = await read(scene, runPath(session.run), endpoints.run.response)
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
    const caughtUp = await openStream(daemon.base, home.token, {
      run: session.run,
      lastEventId: String(replayed.change_seq),
    })
    await caughtUp.until(endsWithRun)
    await caughtUp.close()
    expect(caughtUp.events.map(({ event }) => event)).toEqual(['run'])
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

  test('a prune makes positions taken before it stale for its run formed again and for any other run, also after a restart', async ({
    expect,
    onTestFinished,
  }) => {
    const { home, daemon, transcript } = await openScene(onTestFinished)
    const session = await transcript('g5-pruned')
    const other = await transcript('g5-other')
    await session.append(session.call('toolu_g5_pruned'))
    await other.append(other.call('toolu_g5_other'))
    const holding = async (run: RunId, call: string): Promise<string> => {
      const known = await openKnownRun(daemon.base, home.token, { run, lastEventId: '0' })
      await known.until(ended(call))
      await known.close()
      return String(lastId(known.events))
    }
    const held = await holding(session.run, 'toolu_g5_pruned')
    const otherHeld = await holding(other.run, 'toolu_g5_other')
    const live = await openStream(daemon.base, home.token, { run: session.run, lastEventId: held })
    const otherLive = await openStream(daemon.base, home.token, { run: other.run, lastEventId: otherHeld })
    await live.until(endsWithRun)
    await otherLive.until(endsWithRun)

    const pruned = await admin(home, daemon.base, 'prune', { scope: 'run', run: session.run })
    await live.ended
    await otherLive.ended
    await session.append(session.call('toolu_g5_continued'))
    await waitUntil(() => storedCount(home, endedAction, session.run, 'toolu_g5_continued') === 1)
    const resumed = await openStream(daemon.base, home.token, { run: session.run, lastEventId: held })
    const otherResumed = await openStream(daemon.base, home.token, { run: other.run, lastEventId: otherHeld })
    await resumed.ended
    await otherResumed.ended
    await stopped(daemon)

    const store = openStore({ home: home.paths.home })
    const [reread, otherReread] = (() => {
      try {
        const reads = createReadQueries({ store, observer: ok })
        return [reads.snapshot(session.run), reads.snapshot(other.run)]
      } finally {
        store.close()
      }
    })()
    const restarted = await startDaemon(home, onTestFinished)
    const afterRestart = await openStream(restarted.base, home.token, { run: session.run, lastEventId: held })
    const otherAfterRestart = await openStream(restarted.base, home.token, { run: other.run, lastEventId: otherHeld })
    await afterRestart.ended
    await otherAfterRestart.ended
    const current = await openStream(restarted.base, home.token, {
      run: session.run,
      lastEventId: String(reread?.change_seq),
    })
    const otherCurrent = await openStream(restarted.base, home.token, {
      run: other.run,
      lastEventId: String(otherReread?.change_seq),
    })
    await current.until(endsWithRun)
    await otherCurrent.until(endsWithRun)
    await current.close()
    await otherCurrent.close()

    const reset = { event: 'reset', id: null, data: { reason: 'stale_position' } }
    expect(pruned).toEqual({ status: 200, body: { runs: [session.run], streams: 1 } })
    expect([live.events.at(-1), otherLive.events.at(-1)]).toEqual([reset, reset])
    expect([resumed.events, otherResumed.events]).toEqual([[reset], [reset]])
    expect([afterRestart.events, otherAfterRestart.events]).toEqual([[reset], [reset]])
    expect(reread?.summary.start_pruned).toBe(true)
    expect(reread?.objects.actions.map(({ key }) => key.call)).toEqual(['toolu_g5_continued'])
    expect(otherReread?.objects.actions.map(({ key }) => key.call)).toEqual(['toolu_g5_other'])
    expect([current.events, otherCurrent.events].map((events) => events.map(({ event }) => event))).toEqual([
      ['run'],
      ['run'],
    ])
  })

  test('without Last-Event-ID the stream starts at the current position, agrees with the reads over GET and then follows new changes', async ({
    expect,
    onTestFinished,
  }) => {
    const scene = await openScene(onTestFinished)
    const { home, daemon, transcript } = scene
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
    const listed = await read(scene, '/api/runs', endpoints.runs.response)
    const snapshot = await read(scene, runPath(session.run), endpoints.run.response)
    expect(listed.runs).toEqual([current.data.summary])
    expect({ summary: snapshot.summary, view: snapshot.view, bindings: snapshot.bindings }).toEqual(current.data)
    await session.append(session.call('toolu_g5_after'))
    await live.until(ended('toolu_g5_after'))
    await live.close()

    expect(actionsOf(live.events).map(({ key }) => key.call)).not.toContain('toolu_g5_before')
    expect(actionsOf(live.events).map(({ key }) => key.call)).toContain('toolu_g5_after')
    expect(following.every(({ id }) => id !== null && id > current.id)).toBe(true)
  })

  test('the stream refuses a request without the token, with a malformed or unknown run or a malformed position', async ({
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
    expect(await refusal({ lastEventId: 'first' })).toEqual([400, 'invalid_request'])
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
