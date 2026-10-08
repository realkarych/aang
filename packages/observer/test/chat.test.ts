import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ChatInput, type ChatMessage, chatOutputJsonSchema, EpochNs, type JsonValue, type RunId } from '@aang/contract'
import { defaultChatLimits, startChat } from '@aang/engine'
import { ChatClosedError, chatSystemPrompt, createChat, type ChatOptions } from '@aang/observer'
import type { ClaudeReply, CodexReply, FakeCall } from '@aang/testkit'
import { expect, test } from 'vitest'
import { briefed, createScene, structured, until } from './scene.js'

type Scene = Awaited<ReturnType<typeof createScene>>

const reply = (output: JsonValue): ClaudeReply & CodexReply => ({ kind: 'answer', output })

const chatOutput = (fields: Record<string, JsonValue>): JsonValue => ({
  needs: [],
  answer: null,
  citations: [],
  insufficient_data: false,
  view_rule: null,
  ...fields,
})

const stageOfInput = { $input: '/model/stages/0/id' }

const chatOf = (scene: Scene, options: Partial<ChatOptions> = {}) =>
  createChat({
    store: scene.store,
    backends: { claude: scene.claude, codex: scene.codex },
    slot: (work) => scene.scheduler.chat(work),
    ...options,
  })

const journal = (scene: Scene, run: RunId) => scene.store.observerCalls.chats(run)

const chatCalls = (calls: readonly FakeCall[]): FakeCall[] => calls.filter(({ purpose }) => purpose === 'chat')

const inputOf = (call: FakeCall | undefined): ChatInput => ChatInput.parse(JSON.parse(call?.prompt ?? 'null'))

const messages = (scene: Scene, run: RunId) => scene.store.chat.messages(run)

const messageOf = (scene: Scene, run: RunId, message: ChatMessage | null): ChatMessage | null =>
  message === null ? null : scene.store.chat.message(run, message.id)

test('a question about an old ground outside the first input gets an answer that cites it through needs, and both phases use the map version of the question', async (context) => {
  const scene = await createScene(context, { admit: ['codex'] })
  const gate = join(scene.root, 'chat-gate')
  scene.fakeCodex.setScenario({
    replies: [structured, briefed],
    chatReplies: [
      { kind: 'answer', output: chatOutput({ needs: [{ kind: 'journal', entity: { kind: 'stage', id: stageOfInput } }] }), gate },
      reply(
        chatOutput({
          answer: 'The permission request opened the review stage.',
          citations: [
            { kind: 'stage', id: stageOfInput },
            { kind: 'fact', id: { $input: '/materials/0/entries/0/evidence/1' } },
          ],
        }),
      ),
    ],
  })
  const session = scene.codexSession('thread-chat')
  await session.start()
  await session.permission()
  scene.scheduler.wake()
  await scene.scheduler.idle()
  const stage = scene.store.model.entities(session.run).find((entity) => entity.kind === 'stage')
  const ground = stage?.kind === 'stage' ? stage.value.evidence[1] : undefined
  if (stage === undefined || ground === undefined) {
    throw new Error('the observer must create a stage grounded on the permission request')
  }
  scene.advance(10_000)
  await session.permission()
  scene.scheduler.wake()
  await scene.scheduler.idle()
  const chat = chatOf(scene, { limits: { ...defaultChatLimits, focus: 1 } })
  const asked = scene.store.model.head(session.run)

  const pending = chat.ask(session.run, { question: 'Why is there a review stage?', stage: null })

  expect(pending).toMatchObject({ status: 'pending', version: asked, question: 'Why is there a review stage?' })
  await until(() => chatCalls(scene.fakeCodex.calls()).length === 1)
  scene.advance(10_000)
  await session.permission()
  scene.scheduler.wake()
  await scene.scheduler.idle()
  expect(scene.store.model.head(session.run)).toBeGreaterThan(asked)
  await writeFile(gate, '')
  await chat.idle()

  const [first, second] = chatCalls(scene.fakeCodex.calls())
  const [firstInput, secondInput] = [inputOf(first), inputOf(second)]
  expect([firstInput.model.version, secondInput.model.version]).toEqual([asked, asked])
  expect(JSON.stringify(firstInput)).not.toContain(ground)
  expect(secondInput.materials).toMatchObject([{ kind: 'journal', entity: { kind: 'stage', id: stage.value.id } }])
  expect(JSON.stringify(secondInput.materials)).toContain(ground)
  expect([first?.systemPrompt, second?.systemPrompt]).toEqual([chatSystemPrompt, chatSystemPrompt])
  expect([first?.schema, second?.schema]).toEqual([chatOutputJsonSchema(), chatOutputJsonSchema()])
  expect(messages(scene, session.run)).toEqual([
    {
      ...pending,
      status: 'answered',
      answer: 'The permission request opened the review stage.',
      citations: [
        { kind: 'stage', id: stage.value.id },
        { kind: 'fact', id: ground },
      ],
      answered_at: expect.any(BigInt) as unknown,
    },
  ])
  const records = journal(scene, session.run)
  expect(records.map(({ run, backend, base_version, previous, verdict, error }) => ({ run, backend, base_version, previous, verdict, error }))).toEqual([
    { run: session.run, backend: 'codex', base_version: asked, previous: null, verdict: 'needs_requested', error: null },
    { run: session.run, backend: 'codex', base_version: asked, previous: records[0]?.id, verdict: 'accepted', error: null },
  ])
  expect(records.every(({ usage, started_at, finished_at }) => usage?.model === 'gpt-6.1-sol' && started_at <= finished_at)).toBe(true)
  expect(scene.failure()).toBeNull()
})

test('an invented citation is removed with a mark, insufficient data and failures reach the message, and the observer goes on', async (context) => {
  const scene = await createScene(context, {
    claude: [structured, briefed],
    claudeChat: [
      reply(
        chatOutput({
          answer: 'The review stage waits for a decision.',
          citations: [
            { kind: 'stage', id: stageOfInput },
            { kind: 'fact', id: 'f'.repeat(32) },
            { kind: 'question', id: { $input: '/model/attention/0/id' } },
          ],
        }),
      ),
      reply(chatOutput({ answer: 'The run says nothing about the reviewer.', insufficient_data: true })),
      reply(chatOutput({ needs: [{ kind: 'fact', fact: 'f'.repeat(32) }] })),
      reply(chatOutput({ needs: [{ kind: 'stage', stage: 'missing-stage' }] })),
      { kind: 'limit' },
      { kind: 'invalid_json', text: 'not a structured answer' },
    ],
  })
  const session = scene.claudeSession('session-chat')
  await session.start()
  await session.permission()
  scene.scheduler.wake()
  await scene.scheduler.idle()
  const chat = chatOf(scene)
  const stage = scene.store.model.entities(session.run).find((entity) => entity.kind === 'stage')
  const item = scene.store.model.entities(session.run).find((entity) => entity.kind === 'attention_item')

  for (const question of ['What waits?', 'Who reviews it?', 'Which fact?', 'Is the limit hit?', 'Broken?']) {
    chat.ask(session.run, { question, stage: null })
    await chat.idle()
  }
  scene.advance(10_000)
  await session.permission()
  scene.scheduler.wake()
  await scene.scheduler.idle()

  expect(messages(scene, session.run).map(({ status, answer, citations, unconfirmed_citations, insufficient_data, error }) => ({ status, answer, citations, unconfirmed_citations, insufficient_data, error }))).toEqual([
    {
      status: 'answered',
      answer: 'The review stage waits for a decision.',
      citations: [
        { kind: 'stage', id: stage?.value.id },
        { kind: 'question', id: item?.value.id },
      ],
      unconfirmed_citations: true,
      insufficient_data: false,
      error: null,
    },
    { status: 'answered', answer: 'The run says nothing about the reviewer.', citations: [], unconfirmed_citations: false, insufficient_data: true, error: null },
    { status: 'answered', answer: null, citations: [], unconfirmed_citations: false, insufficient_data: true, error: null },
    { status: 'failed', answer: null, citations: [], unconfirmed_citations: false, insufficient_data: false, error: expect.stringMatching(/^limit: /) as unknown },
    { status: 'failed', answer: null, citations: [], unconfirmed_citations: false, insufficient_data: false, error: expect.stringMatching(/^invalid_output: /) as unknown },
  ])
  expect(journal(scene, session.run).map(({ verdict, previous, error }) => [verdict, previous === null, error?.class ?? null])).toEqual([
    ['accepted', true, null],
    ['accepted', true, null],
    ['needs_requested', true, null],
    ['accepted', false, null],
    ['failed', true, 'limit'],
    ['rejected', true, 'invalid_output'],
  ])
  const thirdFollowUp = inputOf(chatCalls(scene.fakeClaude.calls())[3])
  expect(thirdFollowUp.materials).toEqual([{ kind: 'unavailable', request: { kind: 'fact', fact: 'f'.repeat(32) }, reason: 'not_found' }])
  expect(scene.calls(session.run).map(({ verdict }) => verdict)).toEqual(['accepted', 'accepted'])
  expect(scene.failure()).toBeNull()
})

test('questions left pending by a stopped daemon fail, a run without a backend fails its question, and a closed chat refuses new ones', async (context) => {
  const scene = await createScene(context, { claude: [structured] })
  const session = scene.claudeSession('session-restart')
  await session.start()
  await session.permission()
  scene.scheduler.wake()
  await scene.scheduler.idle()
  const left = scene.store.transaction((transaction) =>
    startChat(transaction, {
      run: session.run,
      stage: null,
      question: 'Asked before the restart',
      backend: 'claude',
      crossVendor: false,
      at: EpochNs.parse(1_759_000_000_000_000_000n),
    }),
  )

  const chat = chatOf(scene, { backends: {}, now: () => 1_760_000_000_000 })
  expect(scene.store.chat.messages(session.run)).toEqual([
    {
      ...left?.message,
      status: 'failed',
      error: 'the daemon stopped before the chat answered',
      answered_at: 1_760_000_000_000_000_000n,
    },
  ])
  const unserved = chat.ask(session.run, { question: 'Who answers?', stage: null })
  await chat.idle()
  expect(messageOf(scene, session.run, unserved)).toMatchObject({
    status: 'failed',
    error: 'cli_missing: no claude backend',
  })
  expect(chat.ask(scene.claudeSession('no-session').run, { question: 'Anyone?', stage: null })).toBeNull()

  const stopping = chatOf(scene)
  await scene.scheduler.close()
  const late = stopping.ask(session.run, { question: 'Still there?', stage: null })
  await stopping.close()
  expect(messageOf(scene, session.run, late)).toMatchObject({
    status: 'failed',
    error: 'cancelled: the observer stopped before the chat answered',
  })
  expect(() => stopping.ask(session.run, { question: 'After close?', stage: null })).toThrow(ChatClosedError)
  expect(journal(scene, session.run).map(({ verdict, error }) => [verdict, error])).toEqual([['failed', null]])
})

test('an earlier answer reaches a later chat input only when the backend and crossVendor of the daemon admit the input it was built from', async (context) => {
  const own = 'The review stage waits for a decision.'
  const shared = 'One Claude session works in the run.'
  const foreign = 'Codex sees no session of its own.'
  const later = 'The decision is still pending.'
  const scene = await createScene(context, {
    admit: ['claude', 'codex'],
    claude: [structured],
    claudeChat: [reply(chatOutput({ answer: own })), reply(chatOutput({ answer: shared })), reply(chatOutput({ answer: later }))],
    codexChat: [reply(chatOutput({ answer: foreign })), reply(chatOutput({ answer: 'All four answers are known.' }))],
  })
  const session = scene.claudeSession('session-vendors')
  await session.start()
  await session.permission()
  scene.scheduler.wake()
  await scene.scheduler.idle()
  const restarted = async (question: string, options: Partial<ChatOptions>): Promise<ChatInput> => {
    const sent = (): FakeCall[][] => [chatCalls(scene.fakeClaude.calls()), chatCalls(scene.fakeCodex.calls())]
    const before = sent().map((calls) => calls.length)
    const chat = chatOf(scene, options)
    chat.ask(session.run, { question, stage: null })
    await chat.close()
    const call = sent().flatMap((calls, index) => calls.slice(before[index])).at(-1)
    if (call === undefined) {
      throw new Error('the chat must call its backend')
    }
    return inputOf(call)
  }
  const answersOf = (input: ChatInput): (string | null)[] => input.history.map(({ answer }) => answer)

  await restarted('What waits?', {})
  await restarted('Which sessions work?', { crossVendor: true })
  const codexOnly = await restarted('What does Codex see?', { backend: 'codex' })
  const claudeOnly = await restarted('Is it decided?', {})
  const everyVendor = await restarted('What is known?', { backend: 'codex', crossVendor: true })

  expect(answersOf(codexOnly)).toEqual([])
  expect(JSON.stringify(codexOnly)).not.toContain(own)
  expect(answersOf(claudeOnly)).toEqual([own])
  expect(answersOf(everyVendor)).toEqual([own, shared, foreign, later])
  expect(journal(scene, session.run).map(({ backend, verdict }) => [backend, verdict])).toEqual([
    ['claude', 'accepted'],
    ['claude', 'accepted'],
    ['codex', 'accepted'],
    ['claude', 'accepted'],
    ['codex', 'accepted'],
  ])
  expect(messages(scene, session.run).map(({ status, answer }) => [status, answer])).toEqual([
    ['answered', own],
    ['answered', shared],
    ['answered', foreign],
    ['answered', later],
    ['answered', 'All four answers are known.'],
  ])
  expect(scene.failure()).toBeNull()
})
