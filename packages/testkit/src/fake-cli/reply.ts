import type { JsonValue } from '@aang/contract'
import { runScenarioScript, type ScenarioScript } from '../observer-scenarios/scripts.js'
import { renderTemplate } from './template.js'

export type AnswerReply =
  | { readonly kind: 'answer'; readonly output: JsonValue }
  | { readonly kind: 'script'; readonly script: ScenarioScript }

export const answerOutput = (reply: AnswerReply, input: JsonValue | undefined): JsonValue =>
  reply.kind === 'answer' ? renderTemplate(reply.output, input) : runScenarioScript(reply.script, input)
