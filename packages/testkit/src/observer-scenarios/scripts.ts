import type { JsonValue } from '@aang/contract'
import { z } from 'zod'
import { chatAnswerScript, chatCollapseReviewersScript, readChatInput } from './chat.js'
import {
  claimedDoneScript,
  mapScript,
  readObserverInput,
  rejectedScript,
  reportScript,
  revisionScript,
} from './observer.js'

export const ScenarioScript = z.enum([
  'map',
  'claimed-done',
  'revision',
  'report',
  'rejected',
  'chat-answer',
  'chat-collapse-reviewers',
])
export type ScenarioScript = z.infer<typeof ScenarioScript>

const scripts: Readonly<Record<ScenarioScript, (input: JsonValue | undefined) => JsonValue>> = {
  map: (input) => mapScript(readObserverInput(input)),
  'claimed-done': (input) => claimedDoneScript(readObserverInput(input)),
  revision: (input) => revisionScript(readObserverInput(input)),
  report: (input) => reportScript(readObserverInput(input)),
  rejected: (input) => rejectedScript(readObserverInput(input)),
  'chat-answer': (input) => chatAnswerScript(readChatInput(input)),
  'chat-collapse-reviewers': (input) => chatCollapseReviewersScript(readChatInput(input)),
}

export const runScenarioScript = (script: ScenarioScript, input: JsonValue | undefined): JsonValue =>
  scripts[script](input)
