import { claudeAdapter } from '@aang/adapter-claude'
import { FactDraft, type JsonValue } from '@aang/contract'
import { describe, test } from 'vitest'
import { cliEnv, factsOf, hookRecord, type JsonObject, lineRecord, readJsonSample } from './samples.js'

const mainSession = '86f93ed5-1acd-4c6e-8c60-f1c98335c2ef'
const hookSession = '80e34e98-8248-4fe4-b913-0bed557bed27'
const call = 'toolu_01Ask'

const parseLine = (payload: JsonObject) => claudeAdapter.parse(lineRecord({ payload: JSON.stringify(payload), line: 1 }))

const toolUse = async (tool: string, input: JsonValue): Promise<readonly FactDraft[]> => {
  const sample = await readJsonSample('claude-code-transcripts/rec-assistant-tool-use-bash.json')
  return factsOf(
    parseLine({
      ...sample,
      message: { ...(sample.message as JsonObject), content: [{ type: 'tool_use', id: call, name: tool, input }] },
    }),
  ).filter((fact) => fact.kind !== 'usage')
}

const toolResult = async (result: JsonValue, content = 'done'): Promise<readonly FactDraft[]> => {
  const sample = await readJsonSample('claude-code-transcripts/rec-user-tool-result-bash.json')
  return factsOf(
    parseLine({
      ...sample,
      toolUseResult: result,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: call, content }] },
    }),
  )
}

const hook = async (sample: string, fields: JsonObject): Promise<readonly FactDraft[]> => {
  const payload = { ...(await readJsonSample(`claude-code-hooks/${sample}`)), ...fields, tool_use_id: call }
  return factsOf(claudeAdapter.parse(hookRecord({ payload: JSON.stringify(payload), file: 'hook', env: await cliEnv() })))
}

const preToolUse = (tool: string, input: JsonValue) => hook('PreToolUse.Bash.json', { tool_name: tool, tool_input: input })

const postToolUse = (tool: string, response: JsonValue) =>
  hook('PostToolUse.Bash.json', { tool_name: tool, tool_response: response })

const ofKind = (facts: readonly FactDraft[], kind: FactDraft['kind']) => facts.filter((fact) => fact.kind === kind)

const askInput = {
  questions: [
    {
      question: 'Which format should the report use?',
      header: 'Format',
      options: [
        { label: 'JSON', description: 'Machine readable' },
        { label: 'Markdown', description: 'For people' },
      ],
      multiSelect: false,
    },
    { question: 'Anything else?', header: 'Extra', options: [], multiSelect: false },
  ],
}

const askedQuestions = [
  { header: 'Format', text: 'Which format should the report use?', options: ['JSON', 'Markdown'] },
  { header: 'Extra', text: 'Anything else?', options: [] },
]

const answered = {
  questions: askInput.questions,
  answers: { 'Which format should the report use?': 'Markdown', 'Anything else?': 'Keep it short' },
  annotations: { 'Which format should the report use?': { notes: 'for the wiki' } },
}

const plan = '1. Read the spool\n2. Write the parser'

describe.concurrent('Claude questions: AskUserQuestion', () => {
  test('the question is asked by the solver under the key of its call, from the transcript and from PreToolUse', async ({
    expect,
  }) => {
    for (const [channel, facts] of [
      ['transcript', await toolUse('AskUserQuestion', askInput)],
      ['hook', await preToolUse('AskUserQuestion', askInput)],
    ] as const) {
      const session = channel === 'transcript' ? mainSession : hookSession

      expect(facts.map((fact) => fact.kind), channel).toEqual(['action_start', 'question_asked'])
      expect(facts[0]?.payload, channel).toMatchObject({ tool: 'AskUserQuestion', action_kind: 'question' })
      expect(facts[1], channel).toMatchObject({
        entity_key: { kind: 'question', runtime: 'claude', session, question: call },
        speaker: 'solver',
        urgent: true,
        format_verified: false,
        runtime_ids: { call_id: call },
        payload: { source: 'ask_user_question', blocking: true, questions: askedQuestions },
      })
      for (const fact of facts) {
        expect(FactDraft.parse(fact), channel).toEqual(fact)
      }
    }
  })

  test('the answers of the human come back from toolUseResult and from PostToolUse', async ({ expect }) => {
    const expected = {
      kind: 'question_answered',
      entity_key: { kind: 'question', question: call },
      speaker: 'human',
      urgent: false,
      format_verified: false,
      runtime_ids: { call_id: call },
      payload: {
        outcome: 'answered',
        answers: [
          { question: 'Which format should the report use?', answer: 'Markdown' },
          { question: 'Anything else?', answer: 'Keep it short' },
        ],
      },
    }
    const transcript = await toolResult(answered, 'User has answered your questions')
    const post = await postToolUse('AskUserQuestion', answered)

    expect(transcript.map((fact) => fact.kind)).toEqual(['action_end', 'question_answered'])
    expect(transcript[1]).toMatchObject(expected)
    expect(post.map((fact) => fact.kind)).toEqual(['action_end', 'question_answered'])
    expect(post[1]).toMatchObject({ ...expected, entity_key: { ...expected.entity_key, session: hookSession } })
  })

  test('an answer that is not text is kept as JSON', async ({ expect }) => {
    const [, answer] = await toolResult({ questions: [], answers: { 'Pick several': ['JSON', 'Markdown'] } })

    expect(answer?.payload).toEqual({ outcome: 'answered', answers: [{ question: 'Pick several', answer: '["JSON","Markdown"]' }] })
  })

  test('a result without answers answers nothing, and only a question tool answers through PostToolUse', async ({
    expect,
  }) => {
    expect((await toolResult({ questions: askInput.questions, answers: {} })).map((fact) => fact.kind)).toEqual([
      'action_end',
    ])
    expect((await toolResult({ answers: { a: 'b' } })).map((fact) => fact.kind)).toEqual(['action_end'])
    expect((await postToolUse('Bash', answered)).map((fact) => fact.kind)).toEqual(['action_end'])
    expect((await postToolUse('AskUserQuestion', { stdout: '' })).map((fact) => fact.kind)).toEqual(['action_end'])
  })

  test('a question with an unfamiliar shape is still asked with what can be read', async ({ expect }) => {
    const [, partly] = await preToolUse('AskUserQuestion', {
      questions: [
        { question: 'Proceed?', options: ['yes', { label: 'no' }, 5, { value: 'maybe' }] },
        { header: 'No text' },
        'junk',
        { question: 'Why?', header: 'Reason' },
      ],
    })
    const [, empty] = await toolUse('AskUserQuestion', { prompt: 'Proceed?' })

    expect(partly?.payload).toMatchObject({
      questions: [
        { header: null, text: 'Proceed?', options: ['yes', 'no'] },
        { header: 'Reason', text: 'Why?', options: [] },
      ],
    })
    expect(empty?.payload).toMatchObject({ source: 'ask_user_question', questions: [] })
  })
})

describe.concurrent('Claude plan: ExitPlanMode', () => {
  test('ExitPlanMode asks the human to approve the plan and is an urgent unverified plan of its call', async ({
    expect,
  }) => {
    const input = { plan, planFilePath: '/home/user/.claude/plans/plan.md' }

    for (const [channel, facts] of [
      ['transcript', await toolUse('ExitPlanMode', input)],
      ['hook', await preToolUse('ExitPlanMode', input)],
    ] as const) {
      const session = channel === 'transcript' ? mainSession : hookSession

      expect(facts.map((fact) => fact.kind), channel).toEqual(['action_start', 'question_asked', 'plan_update'])
      expect(facts[0]?.payload, channel).toMatchObject({ tool: 'ExitPlanMode', action_kind: 'plan' })
      expect(facts[1], channel).toMatchObject({
        entity_key: { kind: 'question', session, question: call },
        speaker: 'solver',
        urgent: true,
        format_verified: false,
        payload: { source: 'exit_plan_mode', blocking: true, questions: [{ header: null, text: plan, options: [] }] },
      })
      expect(facts[2], channel).toMatchObject({
        entity_key: { kind: 'action', runtime: 'claude', session, call },
        speaker: 'solver',
        urgent: true,
        format_verified: false,
        runtime_ids: { call_id: call },
        payload: { source: 'exit_plan_mode', text: plan, items: [] },
      })
    }
  })

  test('ExitPlanMode without a plan text still asks and still is a plan', async ({ expect }) => {
    const [, question, update] = await toolUse('ExitPlanMode', {})

    expect(question?.payload).toMatchObject({ questions: [{ text: '' }] })
    expect(update?.payload).toEqual({ source: 'exit_plan_mode', text: null, items: [] })
  })
})

describe.concurrent('Claude plan: task tools', () => {
  test('TaskCreate, TaskUpdate and TodoWrite are unverified plan updates of their call', async ({ expect }) => {
    const planOf = async (tool: string, input: JsonValue) => ofKind(await toolUse(tool, input), 'plan_update')
    const [created] = await planOf('TaskCreate', {
      subject: 'Write the parser',
      description: 'Parse the hook payloads',
      activeForm: 'Writing the parser',
    })
    const [started] = await planOf('TaskUpdate', { taskId: '3', status: 'in_progress' })
    const [renamed] = await planOf('TaskUpdate', { taskId: '3', subject: 'Write both parsers', description: 'Hooks too' })
    const [deleted] = await planOf('TaskUpdate', { taskId: '3', status: 'deleted' })
    const [todos] = await planOf('TodoWrite', {
      todos: [
        { content: 'Read the spool', status: 'completed', activeForm: 'Reading' },
        { content: 'Write the parser', status: 'in_progress', activeForm: 'Writing', id: 't2' },
        { content: 'Ship', status: 'blocked' },
      ],
    })

    expect(created).toMatchObject({
      entity_key: { kind: 'action', session: mainSession, call },
      speaker: 'solver',
      urgent: true,
      format_verified: false,
      runtime_ids: { call_id: call, message_id: 'msg_011CfbTzJhEoJe1pZ3Wdd3xK' },
      payload: {
        source: 'task_tool',
        text: 'Parse the hook payloads',
        items: [{ id: null, text: 'Write the parser', status: 'pending' }],
      },
    })
    expect(started?.payload).toEqual({ source: 'task_tool', text: null, items: [{ id: '3', text: '', status: 'in_progress' }] })
    expect(renamed?.payload).toEqual({
      source: 'task_tool',
      text: 'Hooks too',
      items: [{ id: '3', text: 'Write both parsers', status: 'unknown' }],
    })
    expect(deleted?.payload).toMatchObject({ items: [{ id: '3', text: '', status: 'cancelled' }] })
    expect(todos?.payload).toEqual({
      source: 'task_tool',
      text: null,
      items: [
        { id: null, text: 'Read the spool', status: 'completed' },
        { id: 't2', text: 'Write the parser', status: 'in_progress' },
        { id: null, text: 'Ship', status: 'unknown' },
      ],
    })
  })

  test('PreToolUse of a task tool gives the same plan update as the transcript', async ({ expect }) => {
    const facts = await preToolUse('TaskCreate', { subject: 'Write the parser' })

    expect(facts.map((fact) => fact.kind)).toEqual(['action_start', 'plan_update'])
    expect(facts[1]).toMatchObject({
      entity_key: { kind: 'action', session: hookSession, call },
      payload: { source: 'task_tool', text: null, items: [{ id: null, text: 'Write the parser', status: 'pending' }] },
    })
  })

  test('reading the task list, an unreadable task input and the Agent tool under its old name change no plan', async ({
    expect,
  }) => {
    const kinds = async (tool: string, input: JsonValue) => (await toolUse(tool, input)).map((fact) => fact.kind)

    expect(await kinds('TaskList', {})).toEqual(['action_start'])
    expect(await kinds('TaskGet', { taskId: '3' })).toEqual(['action_start'])
    expect((await toolUse('TaskList', {}))[0]?.payload).toMatchObject({ action_kind: 'plan' })
    expect(await kinds('TaskCreate', { description: 'no subject' })).toEqual(['action_start'])
    expect(await kinds('TaskUpdate', { status: 'completed' })).toEqual(['action_start'])
    expect(await kinds('TodoWrite', { todos: 'none' })).toEqual(['action_start'])
    expect(await kinds('Task', { subagent_type: 'pinger', prompt: 'ping' })).toEqual(['action_start'])
  })
})

describe.concurrent('Claude prompts: background task notifications', () => {
  test('a task notification is the runtime speaking, unverified, while a typed prompt stays verified', async ({
    expect,
  }) => {
    const sample = await readJsonSample('claude-code-transcripts/rec-user-prompt.json')
    const notification =
      '<task-notification>\n<task-id>a2623c7ee141c2838</task-id>\n<status>completed</status>\n</task-notification>'
    const [notified] = factsOf(
      parseLine({
        ...sample,
        origin: { kind: 'task-notification' },
        promptSource: 'system',
        message: { role: 'user', content: notification },
      }),
    )
    const [typed] = factsOf(parseLine(sample))

    expect(notified).toMatchObject({
      kind: 'prompt',
      speaker: 'runtime',
      format_verified: false,
      payload: { text: notification, origin: 'task_notification', origin_raw: 'task-notification' },
    })
    expect(typed).toMatchObject({ speaker: 'human', format_verified: true, payload: { origin: 'human' } })
  })
})
