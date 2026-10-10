import { join } from 'node:path'
import {
  type ChatMessage,
  ChatHistoryResponse,
  ChatQuestionResponse,
  endpoints,
  type JsonValue,
  type RunDelta,
  type SessionKey,
} from '@aang/contract'
import { runId } from '@aang/contract/ids'
import { type CodexReply, installFakeCodex } from '@aang/testkit'
import { test } from 'vitest'
import { bearer, startDaemon } from './daemon.js'
import { configure, installLauncher, observerEnvironment, progressOf, settled } from './observers.js'
import { codexHook, enqueue, waitUntil, watchedHome } from './sessions.js'
import { openStream } from './stream-client.js'

const codexKey = (session: string): SessionKey => ({ kind: 'session', runtime: 'codex', session })

const staged: CodexReply = {
  kind: 'answer',
  output: {
    base_version: { $input: '/model/version' },
    ops: [
      {
        op: 'stage.create',
        temp_id: 'review',
        title: 'Review the requested command',
        expected_result: null,
        summary: null,
        parent: null,
        origin: 'inferred',
        evidence: { $input: '/batch/facts/*/id' },
        rationale: 'Permission request',
      },
    ],
    needs: [],
  },
}

const insufficient: CodexReply = {
  kind: 'answer',
  output: {
    needs: [],
    answer: 'The run does not say who approved the command.',
    citations: [
      { kind: 'stage', id: { $input: '/model/stages/0/id' } },
      { kind: 'fact', id: 'f'.repeat(32) },
    ],
    insufficient_data: true,
    view_rule: null,
  },
}

test('a chat question is answered over the stream on its map version, with unconfirmed citations removed and insufficient data marked, and the history keeps it', async ({
  expect,
  onTestFinished,
}) => {
  const { home, workspace } = await watchedHome(onTestFinished)
  const codex = installFakeCodex(join(home.root, 'fake-cli'), { replies: [staged], chatReplies: [insufficient] })
  await installLauncher(home)
  await configure(home, workspace, { cli: { codex: codex.path } })
  const session = codexKey('thread-k1-chat')
  const run = runId(session)
  const daemon = await startDaemon(home, onTestFinished, { env: observerEnvironment(home) })
  const headers = { ...bearer(home.token), 'content-type': 'application/json' }
  const chatUrl = `${daemon.base}/api/runs/${run}/chat`
  const ask = (body: unknown, target = chatUrl, request: RequestInit = {}) =>
    fetch(target, { method: 'POST', headers, body: JSON.stringify(body), ...request })

  await enqueue(
    home,
    'codex',
    [codexHook('SessionStart.startup', session.session, workspace), codexHook('PermissionRequest', session.session, workspace)],
    'codex',
  )
  await waitUntil(() => settled(progressOf(home, run)))
  const snapshot = (await (await fetch(`${daemon.base}/api/runs/${run}`, { headers })).json()) as {
    change_seq: number
    model: { stages: { id: string }[] }
    summary: { version: number }
  }
  const [stage] = snapshot.model.stages
  const stream = await openStream(daemon.base, home.token, { run, lastEventId: String(snapshot.change_seq) })
  onTestFinished(() => stream.close())

  const response = await ask({ question: 'Who approved the command?', stage: null })
  expect(response.status).toBe(200)
  const { message: pending } = ChatQuestionResponse.parse(await response.json())
  expect(pending).toMatchObject({ run, stage: null, status: 'pending', version: snapshot.summary.version, answer: null })
  const chatEvents = (): ChatMessage[] => stream.events.flatMap((event) => (event.event === 'chat' ? [event.data.message] : []))
  await stream.until(() => chatEvents().some(({ status }) => status === 'answered'))

  const answered = {
    ...pending,
    status: 'answered',
    answer: 'The run does not say who approved the command.',
    citations: [{ kind: 'stage', id: stage?.id }],
    unconfirmed_citations: true,
    insufficient_data: true,
    answered_at: expect.any(BigInt) as unknown,
  }
  expect(chatEvents()).toEqual([pending, answered])
  const history = await fetch(chatUrl, { headers })
  expect(history.status).toBe(200)
  expect(await history.json()).toEqual({
    messages: [{ ...answered, asked_at: String(pending.asked_at), answered_at: expect.any(String) as unknown }],
  })
  expect(codex.calls().filter(({ purpose }) => purpose === 'chat')).toHaveLength(1)
  const usage = endpoints.usage.response.parse(await (await fetch(`${daemon.base}${endpoints.usage.path}?run=${run}`, { headers })).json())
  expect(usage.chat).toMatchObject({ calls: 1, totals: { records: 1 } })
  expect(usage.chat.totals.tokens.output_tokens).toBeGreaterThan(0)

  const unknownRun = `${daemon.base}/api/runs/${'0'.repeat(32)}/chat`
  const refusals = await Promise.all([
    ask({ question: 'Where?', stage: null }, unknownRun),
    fetch(unknownRun, { headers }),
    ask({ question: 'Where?', stage: 'missing-stage' }),
    ask({ question: '', stage: null }),
    ask({ question: 'Where?' }),
    fetch(chatUrl, { method: 'POST', headers, body: '{' }),
    ask({ question: 'Where?', stage: null }, chatUrl, { headers: { 'content-type': 'application/json' } }),
  ])
  expect(refusals.map(({ status }) => status)).toEqual([404, 404, 400, 400, 400, 400, 401])
  expect(await refusals[2].json()).toEqual({
    error: { code: 'invalid_request', message: `stage missing-stage is not in the chat scope of run ${run}` },
  })
  expect(((await (await fetch(chatUrl, { headers })).json()) as { messages: unknown[] }).messages).toHaveLength(1)
})

const stageOfInput = { $input: '/model/stages/0/id' }

const chatReply = (fields: Record<string, JsonValue>): CodexReply => ({
  kind: 'answer',
  output: { needs: [], answer: null, citations: [], insufficient_data: false, view_rule: null, ...fields },
})

test('a view rule of a chat answer applies with the answer over the stream, counts its elements and is revoked from the list, and an invalid selector is rejected with an explanation', async ({
  expect,
  onTestFinished,
}) => {
  const { home, workspace } = await watchedHome(onTestFinished)
  const codex = installFakeCodex(join(home.root, 'fake-cli'), {
    replies: [staged],
    chatReplies: [
      chatReply({
        needs: [{ kind: 'journal', entity: { kind: 'stage', id: stageOfInput } }],
        view_rule: { action: 'hide', selector: { kind: 'stage_ids', stages: [stageOfInput] }, params: null },
      }),
      chatReply({
        answer: 'The review stage is collapsed into one node.',
        citations: [{ kind: 'stage', id: stageOfInput }],
        view_rule: { action: 'collapse', selector: { kind: 'stage_ids', stages: [stageOfInput] }, params: null },
      }),
      chatReply({
        answer: 'The deploy stage is hidden.',
        view_rule: { action: 'hide', selector: { kind: 'stage_ids', stages: ['k2-missing-stage'] }, params: null },
      }),
    ],
  })
  await installLauncher(home)
  await configure(home, workspace, { cli: { codex: codex.path } })
  const session = codexKey('thread-k2-rule')
  const run = runId(session)
  const daemon = await startDaemon(home, onTestFinished, { env: observerEnvironment(home) })
  const headers = { ...bearer(home.token), 'content-type': 'application/json' }
  const runUrl = `${daemon.base}/api/runs/${run}`
  const ask = async (question: string): Promise<ChatMessage> => {
    const response = await fetch(`${runUrl}/chat`, { method: 'POST', headers, body: JSON.stringify({ question, stage: null }) })
    expect(response.status).toBe(200)
    return ChatQuestionResponse.parse(await response.json()).message
  }
  const snapshotOf = async () => endpoints.run.response.parse(await (await fetch(runUrl, { headers })).json())

  await enqueue(
    home,
    'codex',
    [codexHook('SessionStart.startup', session.session, workspace), codexHook('PermissionRequest', session.session, workspace)],
    'codex',
  )
  await waitUntil(() => settled(progressOf(home, run)))
  const seen = await snapshotOf()
  const [stage] = seen.model.stages
  if (stage === undefined) {
    throw new Error('the observer must create the review stage')
  }
  const stream = await openStream(daemon.base, home.token, { run, lastEventId: String(seen.change_seq) })
  onTestFinished(() => stream.close())
  const answered = (question: ChatMessage): ChatMessage | undefined =>
    stream.events
      .flatMap((event) => (event.event === 'chat' ? [event.data.message] : []))
      .find(({ id, status }) => id === question.id && status === 'answered')
  const latestRun = (): RunDelta | undefined =>
    stream.events.flatMap((event) => (event.event === 'run' ? [event.data] : [])).at(-1)

  const collapse = await ask('Collapse the review stage')
  await stream.until(() => answered(collapse) !== undefined)
  const applied = answered(collapse)
  const id = applied?.view_rule
  expect(applied).toMatchObject({
    answer: 'The review stage is collapsed into one node.',
    citations: [{ kind: 'stage', id: stage.id }],
    view_rule: expect.any(String) as unknown,
    view_rule_error: null,
  })
  const rule = {
    id,
    run,
    source: 'chat',
    action: 'collapse',
    selector: { kind: 'stage_ids', stages: [stage.id] },
    params: null,
    created_at: applied?.answered_at,
    revoked_at: null,
  }
  await stream.until(() => latestRun()?.view.rules.length === 1)
  expect(latestRun()?.view.rules).toEqual([{ rule, affected: [{ kind: 'stage', id: stage.id }] }])
  const collapsed = await snapshotOf()
  expect(collapsed.view.rules).toEqual([{ rule, affected: [{ kind: 'stage', id: stage.id }] }])
  expect(collapsed.view.placements).toMatchObject([
    { element: { kind: 'stage', id: stage.id }, visibility: { state: 'collapsed', rule: id } },
  ])
  expect(collapsed.model).toEqual(seen.model)
  expect(collapsed.summary.version).toBe(seen.summary.version)
  expect(codex.calls().filter(({ purpose }) => purpose === 'chat')).toHaveLength(2)

  const revoked = await fetch(`${runUrl}/view-rules/${String(id)}`, { method: 'DELETE', headers: bearer(home.token) })
  expect(revoked.status).toBe(200)
  expect(endpoints.revokeViewRule.response.parse(await revoked.json()).rule).toEqual({
    ...rule,
    revoked_at: expect.any(BigInt) as unknown,
  })
  await stream.until(() => latestRun()?.view.rules.length === 0)
  expect((await snapshotOf()).view.placements).toEqual([])

  const hide = await ask('Hide the deploy stage')
  await stream.until(() => answered(hide) !== undefined)
  expect(answered(hide)).toMatchObject({
    answer: 'The deploy stage is hidden.',
    view_rule: null,
    view_rule_error: 'invalid_selector: the run has no stages k2-missing-stage',
  })
  const after = await snapshotOf()
  expect(after.view.rules).toEqual([])
  expect(after.summary.version).toBe(seen.summary.version)
  const history = ChatHistoryResponse.parse(await (await fetch(`${runUrl}/chat`, { headers })).json())
  expect(history.messages.map(({ view_rule: ruleId, view_rule_error: reason }) => [ruleId, reason])).toEqual([
    [id, null],
    [null, 'invalid_selector: the run has no stages k2-missing-stage'],
  ])
  expect(codex.calls().filter(({ purpose }) => purpose === 'chat')).toHaveLength(3)
})
