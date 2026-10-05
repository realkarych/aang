import { join } from 'node:path'
import { type ChatMessage, ChatQuestionResponse, type SessionKey } from '@aang/contract'
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
