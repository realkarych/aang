import type { FactDraft, JsonValue, QuestionAskedPayload, QuestionSource } from '@aang/contract'
import { z } from 'zod'
import { type CallOrigin, callFact, type ToolCall } from './facts.js'
import { optionalText } from './fields.js'
import { isJsonObject, stringField } from './json.js'
import { questionKey } from './keys.js'

type AskedQuestions = QuestionAskedPayload['questions']

const AskedQuestion = z.looseObject({
  question: z.string(),
  header: optionalText,
  options: z.array(z.json()).nullish(),
})

const AnsweredQuestions = z.looseObject({
  questions: z.array(z.json()),
  answers: z.record(z.string(), z.json()),
})

export const answerText = (value: JsonValue): string => (typeof value === 'string' ? value : JSON.stringify(value))

const optionLabel = (option: JsonValue): string[] => {
  if (typeof option === 'string') {
    return [option]
  }
  const label = stringField(option, 'label')
  return label === null ? [] : [label]
}

const askedQuestions = (input: JsonValue): AskedQuestions => {
  const entries = isJsonObject(input) && Array.isArray(input.questions) ? input.questions : []
  return entries.flatMap((entry) => {
    const asked = AskedQuestion.safeParse(entry)
    return asked.success
      ? [{ header: asked.data.header ?? null, text: asked.data.question, options: (asked.data.options ?? []).flatMap(optionLabel) }]
      : []
  })
}

const planApproval = (input: JsonValue): AskedQuestions => [
  { header: null, text: stringField(input, 'plan') ?? '', options: [] },
]

type QuestionReader = readonly [QuestionSource, (input: JsonValue) => AskedQuestions]

const questionReaders: ReadonlyMap<string, QuestionReader> = new Map<string, QuestionReader>([
  ['AskUserQuestion', ['ask_user_question', askedQuestions]],
  ['ExitPlanMode', ['exit_plan_mode', planApproval]],
])

export const questionsAsked = (call: ToolCall): FactDraft[] => {
  const reader = questionReaders.get(call.tool)
  if (reader === undefined) {
    return []
  }
  const [source, read] = reader
  return [
    callFact(call, {
      kind: 'question_asked',
      entity_key: questionKey(call.session, call.call),
      speaker: 'solver',
      urgent: true,
      payload: { source, blocking: true, questions: read(call.input) },
    }),
  ]
}

export const questionsAnswered = (call: CallOrigin, result: JsonValue | undefined): FactDraft[] => {
  const answered = AnsweredQuestions.safeParse(result)
  const answers = answered.success ? Object.entries(answered.data.answers) : []
  return answers.length === 0
    ? []
    : [
        callFact(call, {
          kind: 'question_answered',
          entity_key: questionKey(call.session, call.call),
          speaker: 'human',
          urgent: false,
          payload: {
            outcome: 'answered',
            answers: answers.map(([question, answer]) => ({ question, answer: answerText(answer) })),
          },
        }),
      ]
}
