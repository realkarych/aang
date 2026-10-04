import {
  ApiError,
  type ApiErrorCode,
  type AttentionItem,
  ChangeSeq,
  endpoints,
  type RunId,
  type RunSnapshot,
  type SseEvent,
} from '@aang/contract'
import { objectId, runId } from '@aang/contract/ids'
import { applyFeed } from '@aang/testkit'
import { describe, type TestContext, test } from 'vitest'
import type { z } from 'zod'
import { bearer, type Home, type RunningDaemon, startDaemon } from './daemon.js'
import { claudeHook, claudeSession, hookEvent, type LiveTranscript, liveTranscript, watchedHome } from './sessions.js'
import { endsWithRun, type EventStream, openStream, segmentsOf } from './stream-client.js'

interface Answer {
  readonly status: number
  readonly body: unknown
}

interface Api {
  readonly get: <S extends z.ZodType>(path: string, schema: S) => Promise<z.output<S>>
  readonly until: <S extends z.ZodType>(
    path: string,
    schema: S,
    accept: (value: z.output<S>) => boolean,
  ) => Promise<z.output<S>>
  readonly send: (method: 'POST' | 'DELETE', path: string, body?: unknown, token?: string | null) => Promise<Answer>
  readonly sent: <S extends z.ZodType>(
    method: 'POST' | 'DELETE',
    path: string,
    schema: S,
    body?: unknown,
  ) => Promise<z.output<S>>
  readonly refused: (method: 'POST' | 'DELETE', path: string, body?: unknown) => Promise<[number, ApiErrorCode]>
}

interface Scene {
  readonly home: Home
  readonly workspace: string
  readonly daemon: RunningDaemon
  readonly api: Api
  readonly transcript: (session: string) => Promise<LiveTranscript>
}

const apiOf = (home: Home, base: string): Api => {
  const answer = async <S extends z.ZodType>(path: string, schema: S): Promise<z.output<S> | null> => {
    const response = await fetch(`${base}${path}`, { headers: bearer(home.token) })
    const body: unknown = await response.json()
    if (response.status === 404) {
      return null
    }
    if (response.status !== 200) {
      throw new Error(`GET ${path} answered ${String(response.status)}: ${JSON.stringify(body)}`)
    }
    return schema.parse(body)
  }
  const send = async (method: 'POST' | 'DELETE', path: string, body?: unknown, token: string | null = home.token) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(token === null ? {} : bearer(token)),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    })
    return { status: response.status, body: await response.json() }
  }
  return {
    get: async (path, schema) => {
      const found = await answer(path, schema)
      if (found === null) {
        throw new Error(`GET ${path} was not found`)
      }
      return found
    },
    until: async (path, schema, accept) => {
      const deadline = Date.now() + 20_000
      for (;;) {
        const found = await answer(path, schema)
        if (found !== null && accept(found)) {
          return found
        }
        if (Date.now() > deadline) {
          throw new Error(`GET ${path} did not meet the condition: ${JSON.stringify(found)}`)
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    },
    send,
    sent: async (method, path, schema, body) => {
      const { status, body: answered } = await send(method, path, body)
      if (status !== 200) {
        throw new Error(`${method} ${path} answered ${String(status)}: ${JSON.stringify(answered)}`)
      }
      return schema.parse(answered)
    },
    refused: async (method, path, body) => {
      const { status, body: answered } = await send(method, path, body)
      return [status, ApiError.parse(answered).error.code]
    },
  }
}

const openScene = async (onTestFinished: TestContext['onTestFinished']): Promise<Scene> => {
  const { home, workspace } = await watchedHome(onTestFinished)
  const daemon = await startDaemon(home, onTestFinished)
  return {
    home,
    workspace,
    daemon,
    api: apiOf(home, daemon.base),
    transcript: (session) => liveTranscript(home, workspace, session),
  }
}

const restarted = async (scene: Scene, onTestFinished: TestContext['onTestFinished']): Promise<Api> => {
  scene.daemon.abort()
  await scene.daemon.stopped
  const daemon = await startDaemon(scene.home, onTestFinished)
  return apiOf(scene.home, daemon.base)
}

const runPath = (run: RunId): string => `/api/runs/${run}`

const settledRun =
  (calls: number) =>
  ({ objects }: RunSnapshot): boolean =>
    objects.actions.length === calls && objects.actions.every(({ ended_at: ended }) => ended !== null)

const follow = (scene: Scene, snapshot: RunSnapshot): Promise<EventStream> =>
  openStream(scene.daemon.base, scene.home.token, {
    run: snapshot.run.id,
    lastEventId: String(snapshot.change_seq),
  })

const runEvents = (events: readonly SseEvent[]) =>
  events.flatMap((event) => (event.event === 'run' ? [event.data] : []))

const replayed = (snapshot: RunSnapshot, events: readonly SseEvent[]): RunSnapshot =>
  segmentsOf(events).reduce(applyFeed, snapshot)

const comparable = (snapshot: RunSnapshot): RunSnapshot => ({
  ...snapshot,
  plan_facts: snapshot.plan_facts.toSorted((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
  change_seq: ChangeSeq.parse(0),
})

const permission = (session: string, workspace: string, command: string): string =>
  claudeHook('PermissionRequest.Bash', session, workspace, { tool_input: { command, description: command } })

const openItems = (snapshot: RunSnapshot): AttentionItem[] =>
  snapshot.attention.items.filter(({ resolution }) => resolution === 'open')

describe.concurrent('the daemon writes the view state of a run and the explicit bindings of sessions', () => {
  test('a view mark fixes the model version and the change position together and stays put while the run goes on', async ({
    expect,
    onTestFinished,
  }) => {
    const scene = await openScene(onTestFinished)
    const { api } = scene
    const session = await scene.transcript('g8-mark')
    await session.append([...session.plan('toolu_g8_plan', ['survey', 'build']), ...session.call('toolu_g8_first')])
    const seen = await api.until(runPath(session.run), endpoints.run.response, settledRun(2))
    const stream = await follow(scene, seen)
    const position = { version: seen.summary.version, change_seq: seen.change_seq }

    const { mark } = await api.sent('POST', `${runPath(session.run)}/viewed`, endpoints.markViewed.response, position)
    expect(mark).toMatchObject({ run: session.run, ...position })
    await stream.until((events) => runEvents(events).some(({ view }) => view.mark?.marked_at === mark.marked_at))

    await session.append(session.call('toolu_g8_after'))
    const continued = await api.until(runPath(session.run), endpoints.run.response, settledRun(3))
    await stream.until((events) => endsWithRun(events) && replayed(seen, events).objects.actions.length === 3)
    await stream.close()
    expect(continued.view.mark).toEqual(mark)
    expect(runEvents(stream.events).every(({ view }) => view.mark === null || view.mark.marked_at === mark.marked_at)).toBe(
      true,
    )
    expect(comparable(replayed(seen, stream.events))).toEqual(comparable(continued))

    const since = `version=${String(mark.version)}&seq=${String(mark.change_seq)}`
    const changes = await api.get(`${runPath(session.run)}/changes?${since}`, endpoints.changes.response)
    expect(changes.from).toEqual(position)
    expect(changes.to).toEqual({ version: continued.summary.version, change_seq: continued.change_seq })
    expect(changes.activity.flatMap(({ tools }) => tools)).toEqual([{ tool: 'Bash', count: 1 }])
    expect(changes.plan_facts).toEqual([])

    const again = await api.sent('POST', `${runPath(session.run)}/viewed`, endpoints.markViewed.response, {
      version: continued.summary.version,
      change_seq: continued.change_seq,
    })
    expect(again.mark.change_seq).toBe(continued.change_seq)
    expect((await api.get(runPath(session.run), endpoints.run.response)).view.mark).toEqual(again.mark)
  })

  test('a view mark is refused for a version and a position that are not one state, a position ahead and an unknown run', async ({
    expect,
    onTestFinished,
  }) => {
    const scene = await openScene(onTestFinished)
    const { api } = scene
    const session = await scene.transcript('g8-mark-refused')
    await session.append(session.call('toolu_g8_refused'))
    const seen = await api.until(runPath(session.run), endpoints.run.response, settledRun(1))
    const path = `${runPath(session.run)}/viewed`
    const unknown = runId(claudeSession('g8-never-seen'))

    expect(
      await api.refused('POST', path, { version: seen.summary.version + 1, change_seq: seen.change_seq }),
    ).toEqual([400, 'invalid_request'])
    expect(
      await api.refused('POST', path, { version: seen.summary.version, change_seq: seen.change_seq + 1_000_000 }),
    ).toEqual([400, 'invalid_request'])
    expect(await api.refused('POST', `${runPath(unknown)}/viewed`, { version: 0, change_seq: 0 })).toEqual([
      404,
      'not_found',
    ])
    for (const body of [{}, { version: 0 }, { version: -1, change_seq: 0 }, { version: 0, change_seq: 0, at: 1 }, '[']) {
      expect(await api.refused('POST', path, body)).toEqual([400, 'invalid_request'])
    }
    expect((await api.send('POST', path, { version: 0, change_seq: 0 }, null)).status).toBe(401)
    expect((await api.get(runPath(session.run), endpoints.run.response)).view.mark).toBeNull()
  })

  test('a viewed item moves down the attention zone, a dismissed one leaves it for the history, and neither changes the model', async ({
    expect,
    onTestFinished,
  }) => {
    const scene = await openScene(onTestFinished)
    const { api, workspace } = scene
    const session = await scene.transcript('g8-attention')
    const other = await scene.transcript('g8-attention-other')
    await session.append(session.call('toolu_g8_attention'))
    await other.append(other.call('toolu_g8_attention_other'))
    await hookEvent(scene.home, permission('g8-attention', workspace, 'touch first'))
    await api.until(runPath(session.run), endpoints.run.response, (snapshot) => openItems(snapshot).length === 1)
    await hookEvent(scene.home, permission('g8-attention', workspace, 'touch second'))
    await hookEvent(scene.home, permission('g8-attention-other', workspace, 'touch other'))
    const seen = await api.until(runPath(session.run), endpoints.run.response, (snapshot) => openItems(snapshot).length === 2)
    const foreign = await api.until(runPath(other.run), endpoints.run.response, (snapshot) => openItems(snapshot).length === 1)
    const [first, second] = seen.view.zone.map(({ item }) => item)
    if (first === undefined || second === undefined) {
      throw new Error('the zone must hold both requests')
    }
    expect(seen.view.zone.map(({ viewed }) => viewed)).toEqual([false, false])
    const stream = await follow(scene, seen)
    const itemPath = (item: string, action: 'viewed' | 'dismiss'): string =>
      `${runPath(session.run)}/attention/${item}/${action}`

    const viewed = await api.sent('POST', itemPath(first, 'viewed'), endpoints.attentionViewed.response, {})
    expect(viewed.view).toMatchObject({ item: first, dismissed_at: null })
    expect(viewed.view.viewed_at).not.toBeNull()
    const lowered = await api.get(runPath(session.run), endpoints.run.response)
    expect(lowered.view.zone.map(({ item, viewed: seenItem }) => [item, seenItem])).toEqual([
      [second, false],
      [first, true],
    ])

    const dismissed = await api.sent('POST', itemPath(first, 'dismiss'), endpoints.attentionDismiss.response, {})
    expect(dismissed.view).toMatchObject({ item: first, viewed_at: viewed.view.viewed_at })
    expect(dismissed.view.dismissed_at).not.toBeNull()
    expect(dismissed.view.change_seq).toBeGreaterThan(viewed.view.change_seq)
    expect(await api.sent('POST', itemPath(first, 'dismiss'), endpoints.attentionDismiss.response, {})).toEqual(dismissed)
    expect(await api.sent('POST', itemPath(first, 'viewed'), endpoints.attentionViewed.response, {})).toEqual(dismissed)

    const after = await api.get(runPath(session.run), endpoints.run.response)
    expect(after.view.zone.map(({ item }) => item)).toEqual([second])
    expect(after.attention.items).toEqual(seen.attention.items)
    expect(after.attention.views).toEqual([dismissed.view])
    expect(after.run).toEqual(seen.run)
    expect(after.model).toEqual(seen.model)
    expect(after.summary.version).toBe(seen.summary.version)
    expect(seen.summary.attention).toMatchObject({ open: 2, waiting_for_human: 2 })
    expect(after.summary.attention).toMatchObject({ open: 1, waiting_for_human: 1 })

    await stream.until((events) => endsWithRun(events) && runEvents(events).at(-1)?.view.zone.length === 1)
    await stream.close()
    expect(stream.events.map(({ event }) => event)).not.toContain('model')
    expect(stream.events.flatMap((event) => (event.event === 'attention' ? event.data.views : []))).toEqual([
      viewed.view,
      dismissed.view,
    ])
    expect(comparable(replayed(seen, stream.events))).toEqual(comparable(after))
    const changes = await api.get(
      `${runPath(session.run)}/changes?version=${String(seen.summary.version)}&seq=${String(seen.change_seq)}`,
      endpoints.changes.response,
    )
    expect(changes).toMatchObject({ stages: [], criteria: [], cards: [], attention: { opened: [], closed: [] } })

    const foreignItem = foreign.view.zone[0]?.item ?? ''
    expect(await api.refused('POST', itemPath(foreignItem, 'dismiss'), {})).toEqual([404, 'not_found'])
    expect(await api.refused('POST', itemPath('g8-no-such-item', 'viewed'), {})).toEqual([404, 'not_found'])
    expect(await api.refused('POST', `${runPath(runId(claudeSession('g8-none')))}/attention/${second}/dismiss`, {})).toEqual([
      404,
      'not_found',
    ])
    for (const body of [{ reason: 'done' }, null, '']) {
      expect(await api.refused('POST', itemPath(second, 'dismiss'), body)).toEqual([400, 'invalid_request'])
    }
    expect((await api.send('POST', itemPath(second, 'dismiss'), {}, null)).status).toBe(401)
    expect((await api.get(runPath(other.run), endpoints.run.response)).view.zone).toEqual(foreign.view.zone)
    expect((await api.get(runPath(session.run), endpoints.run.response)).view.zone.map(({ item }) => item)).toEqual([
      second,
    ])
  })

  test('a view rule from the interface applies at once and to new elements, is revoked, and is refused with an explanation', async ({
    expect,
    onTestFinished,
  }) => {
    const scene = await openScene(onTestFinished)
    const { api } = scene
    const session = await scene.transcript('g8-rules')
    await session.append([
      ...session.call('toolu_g8_bash'),
      ...session.call('toolu_g8_read', 'Read', { file_path: `${scene.workspace}/README.md` }),
    ])
    const seen = await api.until(runPath(session.run), endpoints.run.response, settledRun(2))
    const stream = await follow(scene, seen)
    const rulesPath = `${runPath(session.run)}/view-rules`
    const actionId = (call: string) => objectId({ kind: 'action', runtime: 'claude', session: 'g8-rules', call })
    const hiddenActions = (snapshot: RunSnapshot): string[] =>
      snapshot.view.placements
        .flatMap(({ element, visibility }) =>
          element.kind === 'action' && visibility?.state === 'hidden' ? [element.id] : [],
        )
        .sort()

    const created = await api.sent('POST', rulesPath, endpoints.createViewRule.response, {
      action: 'hide',
      selector: { kind: 'action_tool', tool: ' Bash ' },
      params: null,
    })
    expect(created.rule.rule).toMatchObject({
      run: session.run,
      action: 'hide',
      selector: { kind: 'action_tool', tool: 'Bash' },
      params: null,
      source: 'ui',
      revoked_at: null,
    })
    expect(created.rule.affected).toEqual([{ kind: 'action', id: actionId('toolu_g8_bash') }])
    const applied = await api.get(runPath(session.run), endpoints.run.response)
    expect(applied.view.rules).toEqual([created.rule])
    expect(hiddenActions(applied)).toEqual([actionId('toolu_g8_bash')])
    expect(applied.model).toEqual(seen.model)
    expect(applied.summary.version).toBe(seen.summary.version)
    await stream.until((events) => runEvents(events).some(({ view }) => view.rules.length === 1))

    await session.append(session.call('toolu_g8_later'))
    const later = await api.until(runPath(session.run), endpoints.run.response, settledRun(3))
    expect(hiddenActions(later)).toEqual([actionId('toolu_g8_bash'), actionId('toolu_g8_later')].sort())
    expect(later.view.rules[0]?.affected).toEqual(
      [actionId('toolu_g8_bash'), actionId('toolu_g8_later')].sort().map((id) => ({ kind: 'action', id })),
    )

    const id = created.rule.rule.id
    const revoked = await api.sent('DELETE', `${rulesPath}/${id}`, endpoints.revokeViewRule.response)
    expect(revoked.rule).toMatchObject({ id, run: session.run, action: 'hide' })
    expect(revoked.rule.revoked_at).not.toBeNull()
    expect(await api.sent('DELETE', `${rulesPath}/${id}`, endpoints.revokeViewRule.response)).toEqual(revoked)
    const reverted = await api.get(runPath(session.run), endpoints.run.response)
    expect(reverted.view.rules).toEqual([])
    expect(hiddenActions(reverted)).toEqual([])
    await stream.until((events) => endsWithRun(events) && runEvents(events).at(-1)?.view.rules.length === 0)
    await stream.close()
    expect(stream.events.map(({ event }) => event)).not.toContain('model')
    expect(comparable(replayed(seen, stream.events))).toEqual(comparable(reverted))

    const other = await scene.transcript('g8-rules-other')
    await other.append(other.call('toolu_g8_rules_other'))
    await api.until(runPath(other.run), endpoints.run.response, settledRun(1))
    const refusals: [unknown, string][] = [
      [{ action: 'group', selector: { kind: 'agent_name', name: 'reviewer' }, params: { name: ' ' } }, 'group name'],
      [{ action: 'collapse', selector: { kind: 'stage_ids', stages: ['g8-missing'] }, params: null }, 'g8-missing'],
      [{ action: 'hide', selector: { kind: 'agent_role', role: '' }, params: null }, 'agent role'],
      [{ action: 'explode', selector: { kind: 'service_agents' }, params: null }, 'body'],
      [{ action: 'detail', selector: { kind: 'service_agents' }, params: { level: 'everything' } }, 'body'],
    ]
    for (const [body, explanation] of refusals) {
      const { status, body: answered } = await api.send('POST', rulesPath, body)
      expect(status).toBe(400)
      expect(ApiError.parse(answered).error).toMatchObject({ code: 'invalid_request' })
      expect(ApiError.parse(answered).error.message).toContain(explanation)
    }
    const unknownRun = `${runPath(runId(claudeSession('g8-none')))}/view-rules`
    expect(
      await api.refused('POST', unknownRun, { action: 'collapse', selector: { kind: 'service_agents' }, params: null }),
    ).toEqual([404, 'not_found'])
    expect(await api.refused('DELETE', `${runPath(other.run)}/view-rules/${id}`)).toEqual([404, 'not_found'])
    for (const missing of ['999', 'first']) {
      expect(await api.refused('DELETE', `${rulesPath}/${missing}`)).toEqual([404, 'not_found'])
    }
    expect((await api.send('DELETE', `${rulesPath}/${id}`, undefined, null)).status).toBe(401)
    expect((await api.get(runPath(session.run), endpoints.run.response)).view.rules).toEqual([])
  })

  test('the view mark, the dismissed item and the active view rules survive a restart', async ({
    expect,
    onTestFinished,
  }) => {
    const scene = await openScene(onTestFinished)
    const { api, workspace } = scene
    const session = await scene.transcript('g8-restart')
    await session.append(session.call('toolu_g8_restart'))
    await hookEvent(scene.home, permission('g8-restart', workspace, 'touch kept'))
    const seen = await api.until(
      runPath(session.run),
      endpoints.run.response,
      (snapshot) => settledRun(1)(snapshot) && openItems(snapshot).length === 1,
    )
    const item = seen.view.zone[0]?.item ?? ''
    const { mark } = await api.sent('POST', `${runPath(session.run)}/viewed`, endpoints.markViewed.response, {
      version: seen.summary.version,
      change_seq: seen.change_seq,
    })
    await api.sent('POST', `${runPath(session.run)}/attention/${item}/dismiss`, endpoints.attentionDismiss.response, {})
    const kept = await api.sent('POST', `${runPath(session.run)}/view-rules`, endpoints.createViewRule.response, {
      action: 'collapse',
      selector: { kind: 'action_kind', action_kind: 'command' },
      params: null,
    })
    const dropped = await api.sent('POST', `${runPath(session.run)}/view-rules`, endpoints.createViewRule.response, {
      action: 'group',
      selector: { kind: 'action_tool', tool: 'Bash' },
      params: { name: 'Shell' },
    })
    await api.sent('DELETE', `${runPath(session.run)}/view-rules/${dropped.rule.rule.id}`, endpoints.revokeViewRule.response)
    const before = await api.get(runPath(session.run), endpoints.run.response)

    const after = await (await restarted(scene, onTestFinished)).get(runPath(session.run), endpoints.run.response)

    expect(after.view.mark).toEqual(mark)
    expect(after.view.zone).toEqual([])
    expect(after.attention).toEqual(before.attention)
    expect(after.view.rules.map(({ rule }) => rule)).toEqual([kept.rule.rule])
    expect(after.view).toEqual(before.view)
  })

  test('a binding moves a session between runs and updates both of them over SSE, and its revocation moves it back', async ({
    expect,
    onTestFinished,
  }) => {
    const scene = await openScene(onTestFinished)
    const { api } = scene
    const target = await scene.transcript('g8-target')
    const moved = await scene.transcript('g8-moved')
    await target.append([...target.plan('toolu_g8_target_plan', ['design']), ...target.call('toolu_g8_target')])
    await moved.append([...moved.plan('toolu_g8_moved_plan', ['review']), ...moved.call('toolu_g8_moved')])
    const targetBefore = await api.until(runPath(target.run), endpoints.run.response, settledRun(2))
    const movedBefore = await api.until(runPath(moved.run), endpoints.run.response, settledRun(2))
    const session = objectId(claudeSession('g8-moved'))
    const targetStream = await follow(scene, targetBefore)
    const movedStream = await follow(scene, movedBefore)

    const { binding } = await api.sent('POST', '/api/bindings', endpoints.createBinding.response, {
      kind: 'attach',
      session,
      run: target.run,
    })
    expect(binding).toMatchObject({ kind: 'attach', session, run: target.run, revoked_at: null })

    const targetBound = await api.get(runPath(target.run), endpoints.run.response)
    const movedBound = await api.get(runPath(moved.run), endpoints.run.response)
    expect(targetBound.objects.sessions.map(({ id }) => id).sort()).toEqual(
      [targetBefore.run.root_session, session].sort(),
    )
    expect(targetBound.objects.actions).toHaveLength(4)
    expect(targetBound.plan_facts).toHaveLength(2)
    expect(targetBound.bindings).toEqual([binding])
    expect(targetBound.summary.sessions).toBe(2)
    expect(movedBound.objects.sessions).toEqual([])
    expect(movedBound.objects.actions).toEqual([])
    expect(movedBound.plan_facts).toEqual([])
    expect(movedBound.summary.sessions).toBe(0)

    await targetStream.until(
      (events) => endsWithRun(events) && runEvents(events).at(-1)?.summary.sessions === 2,
    )
    await movedStream.until(
      (events) => endsWithRun(events) && runEvents(events).at(-1)?.summary.sessions === 0,
    )
    expect(comparable(replayed(targetBefore, targetStream.events))).toEqual(comparable(targetBound))
    expect(comparable(replayed(movedBefore, movedStream.events))).toEqual(comparable(movedBound))

    const revoked = await api.sent('DELETE', `/api/bindings/${binding.id}`, endpoints.revokeBinding.response)
    expect(revoked.binding).toMatchObject({ id: binding.id, kind: 'attach', session, run: target.run })
    expect(revoked.binding.revoked_at).not.toBeNull()
    expect(await api.sent('DELETE', `/api/bindings/${binding.id}`, endpoints.revokeBinding.response)).toEqual(revoked)

    const targetAfter = await api.get(runPath(target.run), endpoints.run.response)
    const movedAfter = await api.get(runPath(moved.run), endpoints.run.response)
    expect(targetAfter.objects.sessions.map(({ id }) => id)).toEqual([targetBefore.run.root_session])
    expect(targetAfter.bindings).toEqual([revoked.binding])
    expect(movedAfter.objects.sessions.map(({ id }) => id)).toEqual([session])
    expect(movedAfter.objects.actions.map(({ id }) => id)).toEqual(movedBefore.objects.actions.map(({ id }) => id))
    expect(movedAfter.plan_facts).toEqual(movedBefore.plan_facts)

    await targetStream.until(
      (events) => endsWithRun(events) && runEvents(events).at(-1)?.summary.sessions === 1,
    )
    await movedStream.until(
      (events) => endsWithRun(events) && runEvents(events).at(-1)?.summary.sessions === 1,
    )
    await targetStream.close()
    await movedStream.close()
    expect(comparable(replayed(targetBefore, targetStream.events))).toEqual(comparable(targetAfter))
    expect(comparable(replayed(movedBefore, movedStream.events))).toEqual(comparable(movedAfter))
  })

  test('a binding is refused for an unknown session, run or binding, and a fork parent only binds a fork', async ({
    expect,
    onTestFinished,
  }) => {
    const scene = await openScene(onTestFinished)
    const { api } = scene
    const root = await scene.transcript('g8-bind-root')
    await root.append(root.call('toolu_g8_bind_root'))
    const seen = await api.until(runPath(root.run), endpoints.run.response, settledRun(1))
    const session = seen.run.root_session
    const unknownSession = objectId(claudeSession('g8-bind-none'))
    const unknownRun = runId(claudeSession('g8-bind-none'))

    expect(await api.refused('POST', '/api/bindings', { kind: 'attach', session: unknownSession, run: root.run })).toEqual(
      [404, 'not_found'],
    )
    expect(await api.refused('POST', '/api/bindings', { kind: 'attach', session, run: unknownRun })).toEqual([
      404,
      'not_found',
    ])
    expect(await api.refused('POST', '/api/bindings', { kind: 'detach', session: unknownSession })).toEqual([
      404,
      'not_found',
    ])
    expect(await api.refused('POST', '/api/bindings', { kind: 'fork_parent', run: root.run, parent: session })).toEqual([
      400,
      'invalid_request',
    ])
    for (const body of [{ kind: 'merge', session, run: root.run }, { kind: 'attach', session }, 'session']) {
      expect(await api.refused('POST', '/api/bindings', body)).toEqual([400, 'invalid_request'])
    }
    expect(await api.refused('DELETE', '/api/bindings/g8-no-such-binding')).toEqual([404, 'not_found'])
    expect((await api.send('POST', '/api/bindings', { kind: 'detach', session }, null)).status).toBe(401)
    const after = await api.get(runPath(root.run), endpoints.run.response)
    expect(after.bindings).toEqual([])
    expect(after.summary.version).toBe(seen.summary.version)
  })
})
