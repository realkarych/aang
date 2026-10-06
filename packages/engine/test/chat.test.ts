import { ChangeSeq, type ChatInput, type ChatNeed, ChatOutput, FactId, RunId, StageId, TempId } from '@aang/contract'
import {
  answerChat,
  ChatError,
  createReadQueries,
  defaultChatLimits,
  failChat,
  failInterruptedChats,
  followUpChat,
  inputScope,
  observerInputTokens,
  resolveObserverNeeds,
  startChat,
  verifyCitations,
} from '@aang/engine'
import { objectId } from '@aang/contract/ids'
import type { Store } from '@aang/store'
import { expect, test } from 'vitest'
import { recordsOf, sessionKey } from './harness.js'
import { at } from './model.js'
import {
  chatRun,
  chatSession,
  observe,
  otherRun,
  reportAction,
  reportText,
  setupChat,
  stageTitled,
  testsAction,
} from './chat-fixtures.js'

const readsOf = (store: Store) =>
  createReadQueries({ store, observer: () => ({ state: { state: 'ok' }, isolation_unverified: false }) })

const started = <T>(value: T | null): T => {
  if (value === null) {
    throw new Error('the chat must start')
  }
  return value
}

const answer = (overrides: Partial<ChatOutput> = {}): ChatOutput =>
  ChatOutput.parse({ needs: [], answer: 'The report is written.', citations: [], insufficient_data: false, view_rule: null, ...overrides })

test('a question without a stage is asked on the current map version with the run, the attention zone, the recent changes and the earlier answers', async (context) => {
  const chat = await setupChat(context)
  const { store, reportStage, testsStage, prompt, final } = chat
  const first = started(chat.ask('What is left?'))
  const head = store.model.head(chatRun)

  expect(first.message).toMatchObject({ run: chatRun, stage: null, question: 'What is left?', status: 'pending', version: head })
  const { input } = first
  expect(input).toMatchObject({ question: 'What is left?', history: [], materials: [] })
  expect(input.model.version).toBe(head)
  expect(input.model.stages.map(({ id, title, summary }) => [id, title, summary]).sort()).toEqual(
    [
      [reportStage, 'Write the report', 'The report is written'],
      [testsStage, 'Run the tests', null],
    ].sort(),
  )
  expect(input.run.sessions.map(({ cwd }) => cwd)).toEqual([chat.project])
  expect(input.focus).toMatchObject({ kind: 'run', attention: [{ kind: 'review_request', author: 'observer', text: 'Review the report', stage: reportStage }] })
  const changes = input.focus.kind === 'run' ? input.focus.recent_changes : []
  expect(changes.map(({ version, op, author, target }) => [version, op, author, target.kind])).toEqual([
    [2, 'stage.create', 'observer', 'stage'],
    [2, 'stage.create', 'observer', 'stage'],
    [3, 'attention.add', 'observer', 'attention_item'],
    [3, 'stage.update', 'observer', 'stage'],
    [4, 'stage.execution', 'rule', 'stage'],
  ])
  expect(changes.map(({ evidence }) => evidence)).toEqual([[prompt.id], [prompt.id], [final.id], [final.id], [final.id]])
  expect(changes[3]).toMatchObject({ before: { summary: null }, after: { summary: 'The report is written' } })

  store.transaction((transaction) =>
    answerChat(transaction, { run: chatRun, message: first.message.id, input, output: answer(), at: at(41) }),
  )
  const failed = started(chat.ask('Will it fail?', null, undefined, 42))
  store.transaction((transaction) =>
    failChat(transaction, { run: chatRun, message: failed.message.id, error: 'limit: hit', at: at(43) }),
  )
  const second = started(chat.ask('And now?', null, undefined, 44))
  expect(second.input.history).toEqual([
    { question: 'What is left?', answer: 'The report is written.', version: head, asked_at: new Date(Number(at(40) / 1_000_000n)).toISOString() },
  ])
  expect(second.message.version).toBe(head)
  expect(store.chat.messages(chatRun).map(({ status }) => status)).toEqual(['answered', 'failed', 'pending'])
})

test('a question on a stage carries its assigned actions with their facts, its evidence and its saved artifact versions', async (context) => {
  const chat = await setupChat(context)
  const { store, reportStage, final, version } = chat
  const asked = started(chat.ask('What does the report stage produce?', reportStage))

  expect(asked.message).toMatchObject({ stage: reportStage, status: 'pending' })
  const { focus } = asked.input
  if (focus.kind !== 'stage') {
    throw new Error('a stage question has a stage focus')
  }
  expect(focus.stage).toBe(reportStage)
  expect(focus.facts.map(({ id, kind }) => [id, kind])).toEqual([
    [chat.starts(reportAction).id, 'action_start'],
    [expect.any(String), 'action_end'],
    [final.id, 'message'],
  ])
  expect(focus.facts.every(({ session }) => session === asked.input.run.sessions[0]?.id)).toBe(true)
  expect(focus.actions).toMatchObject([
    { kind: 'action', action: reportAction, tool: 'Write', input: { file_path: chat.report, content: reportText } },
  ])
  expect(focus.artifact_versions).toEqual([
    { id: version.id, ref: { kind: 'file', path: chat.report }, produced_by: reportAction, retained: true },
  ])

  const refused = (stage: StageId): unknown => {
    try {
      chat.ask('Where is it?', stage)
      return null
    } catch (error) {
      return error
    }
  }
  observe(
    store,
    'call-other',
    [chat.foreign],
    (evidence) => [
      {
        op: 'stage.create',
        temp_id: TempId.parse('other'),
        title: 'Another task',
        expected_result: null,
        summary: null,
        parent: null,
        origin: 'inferred',
        evidence: [...evidence],
        rationale: 'The other run',
      },
    ],
    50,
    otherRun,
  )
  const foreign = store.model.entities(otherRun).flatMap((entity) => (entity.kind === 'stage' ? [entity.value.id] : []))
  expect([...foreign, StageId.parse('missing-stage')].map(refused)).toEqual([
    expect.objectContaining({ code: 'unknown_stage' }),
    expect.objectContaining({ code: 'unknown_stage' }),
  ])
  expect(refused(StageId.parse('missing-stage'))).toBeInstanceOf(ChatError)
  expect(store.chat.messages(chatRun).map(({ question }) => question)).toEqual(['What does the report stage produce?'])
})

test('needs are answered on the version of the question: a stage and its journal as they were, facts, records, actions and saved versions, and requests out of scope are refused', async (context) => {
  const chat = await setupChat(context)
  const { store, reportStage, testsStage, prompt, version } = chat
  const asked = started(chat.ask('Why was the report stage created?'))
  const asked_on = asked.message.version
  observe(
    store,
    'call-replace',
    [chat.final],
    (evidence) => [
      {
        op: 'stage.create',
        temp_id: TempId.parse('publish'),
        title: 'Publish the report',
        expected_result: null,
        summary: null,
        parent: null,
        origin: 'inferred',
        evidence: [...evidence],
        rationale: 'The report is published',
      },
      { op: 'stage.replace', stage: { kind: 'existing', id: reportStage }, by: [{ kind: 'new', temp_id: TempId.parse('publish') }], evidence: [...evidence], rationale: 'Revised' },
    ],
    45,
  )
  const publish = stageTitled(store, 'Publish the report')
  expect(store.model.head(chatRun)).toBeGreaterThan(asked_on)
  const promptRecord = recordsOf(store).find(({ seq }) => seq === prompt.seq)
  const needs: ChatNeed[] = [
    { kind: 'stage', stage: reportStage },
    { kind: 'journal', entity: { kind: 'stage', id: reportStage } },
    { kind: 'fact', fact: prompt.id },
    { kind: 'stage', stage: reportStage },
    { kind: 'raw_record', seq: prompt.seq },
    { kind: 'action', action: testsAction },
    { kind: 'artifact_version', version: version.id },
    { kind: 'stage', stage: publish },
    { kind: 'fact', fact: chat.foreign.id },
    { kind: 'fact', fact: FactId.parse('f'.repeat(32)) },
  ]

  const followed = followUpChat(store, { input: asked.input, needs, backend: 'claude', crossVendor: false })
  if (followed === null) {
    throw new Error('the materials must fit')
  }
  expect(followed.model).toEqual(asked.input.model)
  expect(followed.focus).toEqual(asked.input.focus)
  expect(followed.materials).toMatchObject([
    {
      kind: 'stage',
      stage: { id: reportStage, title: 'Write the report', summary: 'The report is written' },
      lifecycle: { state: 'active' },
    },
    { kind: 'journal', entity: { kind: 'stage', id: reportStage } },
    { kind: 'fact', fact: { id: prompt.id, kind: 'prompt', speaker: 'human', payload: { text: 'Write the parser report and run the tests' } } },
    { kind: 'raw_record', seq: prompt.seq, channel: 'transcript', payload: promptRecord?.payload },
    { kind: 'action', action: testsAction, tool: 'Bash', input: { command: 'pnpm test' } },
    { kind: 'artifact_version', version: version.id, retention: 'action_payload', content: reportText, read_at: null, truncated: null },
    { kind: 'unavailable', request: { kind: 'stage', stage: publish }, reason: 'not_found' },
    { kind: 'unavailable', request: { kind: 'fact', fact: chat.foreign.id }, reason: 'out_of_scope' },
  ])
  const journal = followed.materials[1]
  expect(journal?.kind === 'journal' ? journal.entries.map(({ version: at_version, op }) => [at_version, op]) : []).toEqual([
    [2, 'stage.create'],
    [3, 'stage.update'],
    [4, 'stage.execution'],
  ])
  expect(store.model.entity(chatRun, { kind: 'stage', id: reportStage })).toMatchObject({
    value: { lifecycle: { state: 'replaced', by: [publish] } },
  })
  expect(observerInputTokens(followed)).toBeLessThanOrEqual(defaultChatLimits.inputTokens)

  const narrow = followUpChat(store, {
    input: asked.input,
    needs: [{ kind: 'stage', stage: testsStage }, { kind: 'fact', fact: FactId.parse('f'.repeat(32)) }],
    backend: 'claude',
    crossVendor: false,
    limits: { ...defaultChatLimits, needs: 1 },
  })
  expect(narrow?.materials).toMatchObject([{ kind: 'stage', stage: { id: testsStage } }])
  expect(
    followUpChat(store, {
      input: asked.input,
      needs: [{ kind: 'fact', fact: FactId.parse('f'.repeat(32)) }],
      backend: 'claude',
      crossVendor: false,
      limits: { ...defaultChatLimits, inputTokens: observerInputTokens(asked.input) },
    }),
  ).toBeNull()
})

test('citations are kept only for ids in the input of the answer, invented ones are removed with a mark, and a missing answer is insufficient data', async (context) => {
  const chat = await setupChat(context)
  const { store, reportStage, prompt, final, version } = chat
  const staged = started(chat.ask('What does the report stage produce?', reportStage))
  const review = staged.input.model.attention[0]?.id
  if (review === undefined) {
    throw new Error('the snapshot keeps the review request')
  }
  const confirmed = [
    { kind: 'stage', id: reportStage },
    { kind: 'fact', id: final.id },
    { kind: 'action', id: reportAction },
    { kind: 'artifact_version', id: version.id },
    { kind: 'question', id: review },
  ] as const
  const invented = [
    { kind: 'fact', id: prompt.id },
    { kind: 'stage', id: StageId.parse(prompt.id) },
    { kind: 'action', id: testsAction },
  ] as const

  expect(verifyCitations(staged.input, [...confirmed, confirmed[0]])).toEqual({ citations: confirmed, unconfirmed: false })
  expect(verifyCitations(staged.input, [...invented, ...confirmed])).toEqual({ citations: confirmed, unconfirmed: true })

  const followed = followUpChat(store, {
    input: staged.input,
    needs: [{ kind: 'fact', fact: prompt.id }, { kind: 'journal', entity: { kind: 'attention_item', id: review } }],
    backend: 'claude',
    crossVendor: false,
  }) as ChatInput
  expect(verifyCitations(followed, [{ kind: 'fact', id: prompt.id }, { kind: 'action', id: testsAction }])).toEqual({
    citations: [{ kind: 'fact', id: prompt.id }],
    unconfirmed: true,
  })

  const answered = store.transaction((transaction) =>
    answerChat(transaction, {
      run: chatRun,
      message: staged.message.id,
      input: staged.input,
      output: answer({ citations: [...invented, ...confirmed] }),
      at: at(41),
    }),
  )
  expect(answered).toMatchObject({
    status: 'answered',
    version: staged.message.version,
    answer: 'The report is written.',
    citations: confirmed,
    unconfirmed_citations: true,
    insufficient_data: false,
    view_rule: null,
    answered_at: at(41),
  })
  expect(
    store.transaction((transaction) =>
      answerChat(transaction, { run: chatRun, message: staged.message.id, input: staged.input, output: answer(), at: at(42) }),
    ),
  ).toBeNull()

  const unanswered = started(chat.ask('Who approved it?', null, undefined, 43))
  const insufficient = store.transaction((transaction) =>
    answerChat(transaction, {
      run: chatRun,
      message: unanswered.message.id,
      input: unanswered.input,
      output: answer({ answer: null, needs: [{ kind: 'fact', fact: prompt.id }] }),
      at: at(44),
    }),
  )
  expect(insufficient).toMatchObject({ status: 'answered', answer: null, citations: [], insufficient_data: true })
  const noted = started(chat.ask('Who reviews it?', null, undefined, 45))
  expect(
    store.transaction((transaction) =>
      answerChat(transaction, {
        run: chatRun,
        message: noted.message.id,
        input: noted.input,
        output: answer({ answer: 'Nobody yet.', insufficient_data: true }),
        at: at(46),
      }),
    ),
  ).toMatchObject({ answer: 'Nobody yet.', insufficient_data: true })
})

test('the input stays within its limit: the focus narrows, and a question that cannot fit is refused', async (context) => {
  const chat = await setupChat(context)
  const { store } = chat
  const whole = started(chat.ask('What is left?'))
  const tokens = observerInputTokens(whole.input)
  const limits = { ...defaultChatLimits, inputTokens: tokens }
  const narrowed = started(chat.ask('What is left?', null, limits, 41))
  const sizes = (input: ChatInput): number => (input.focus.kind === 'run' ? input.focus.recent_changes.length : 0)

  expect(observerInputTokens(narrowed.input)).toBeLessThanOrEqual(tokens - Math.floor(tokens / 8))
  expect(sizes(narrowed.input)).toBeLessThan(sizes(whole.input))
  expect(narrowed.input.model).toEqual(whole.input.model)

  const before = store.chat.messages(chatRun)
  let refusal: unknown = null
  try {
    chat.ask('?'.repeat(400_000), null, undefined, 42)
  } catch (error) {
    refusal = error
  }
  expect(refusal).toBeInstanceOf(ChatError)
  expect(refusal).toMatchObject({ code: 'input_limit' })
  expect(store.chat.messages(chatRun)).toEqual(before)
  expect(() => chat.ask('Why?', null, { ...defaultChatLimits, history: 0 })).toThrow(RangeError)
})

test('a question left pending by a stopped daemon fails, and the run feed and the history carry the chat', async (context) => {
  const chat = await setupChat(context)
  const { store } = chat
  const reads = readsOf(store)
  const position = store.changes.head()
  const pending = started(chat.ask('What is left?'))
  const asked = store.changes.head()

  expect(reads.feed(chatRun, position)?.events.filter(({ event }) => event === 'chat')).toEqual([
    { event: 'chat', id: asked, data: { message: pending.message } },
  ])
  const [failed] = store.transaction((transaction) => failInterruptedChats(transaction, at(60)))
  expect(failed).toEqual({
    ...pending.message,
    status: 'failed',
    error: 'the daemon stopped before the chat answered',
    answered_at: at(60),
  })
  expect(reads.feed(chatRun, asked)?.events).toEqual([{ event: 'chat', id: asked + 1, data: { message: failed } }])
  expect(reads.feed(chatRun, ChangeSeq.parse(0))?.events.filter(({ event }) => event === 'chat')).toHaveLength(1)
  expect(reads.chat(chatRun)).toEqual({ messages: [failed] })
  expect(reads.chat(otherRun)).toEqual({ messages: [] })
  expect(reads.chat(RunId.parse('0'.repeat(32)))).toBeNull()
  expect(store.transaction((transaction) => failInterruptedChats(transaction, at(61)))).toEqual([])
})

test('a saved version whose producing action is gone is refused to the chat and to the observer, whatever the vendor scope', async (context) => {
  const chat = await setupChat(context)
  const { store, engine, version, reportStage } = chat
  const need: ChatNeed = { kind: 'artifact_version', version: version.id }
  const scopes = [
    { backend: 'claude', crossVendor: false },
    { backend: 'claude', crossVendor: true },
    { backend: 'codex', crossVendor: false },
    { backend: 'codex', crossVendor: true },
  ] as const
  const refusals = () =>
    scopes.map((options) => {
      const asked = started(
        store.transaction((transaction) =>
          startChat(transaction, {
            run: chatRun,
            stage: options.crossVendor ? reportStage : null,
            question: 'What is in the report?',
            ...options,
            at: at(60),
          }),
        ),
      )
      const followed = followUpChat(store, { input: asked.input, needs: [need], ...options })
      return {
        focus: asked.input.focus.kind === 'stage' ? asked.input.focus.artifact_versions.map(({ id }) => id) : null,
        chat: followed?.materials,
        observer: resolveObserverNeeds(store, inputScope(store, { run: chatRun, ...options }), [need]),
      }
    })

  expect(refusals()[1]).toMatchObject({
    focus: [version.id],
    chat: [{ kind: 'artifact_version', content: reportText }],
    observer: [{ kind: 'artifact_version', content: reportText }],
  })
  await engine.bind({ kind: 'attach', session: objectId(sessionKey('claude', chatSession)), run: otherRun })
  await engine.prune({ scope: 'run', run: otherRun }, () => Promise.resolve(null))
  expect(store.artifacts.getVersion(version.id)?.produced_by).toBe(reportAction)
  expect(store.observations.getAction(reportAction)).toBeNull()

  const refused = { kind: 'unavailable', request: need, reason: 'out_of_scope' }
  expect(refusals()).toEqual(
    scopes.map(({ crossVendor }) => ({ focus: crossVendor ? [] : null, chat: [refused], observer: [refused] })),
  )
})
