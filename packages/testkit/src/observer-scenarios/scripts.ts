import type { JsonValue } from '@aang/contract'
import { z } from 'zod'
import { chatAnswerScript, chatCollapseReviewersScript, readChatInput } from './chat.js'
import {
  claimedDoneScript,
  mapBranchesScript,
  mapLayoutScript,
  mapNestedScript,
  mapScript,
  mergeScript,
  outlineScript,
  readObserverInput,
  rejectedScript,
  reportScript,
  reshapeScript,
  revisionScript,
  splitScript,
} from './observer.js'

export const ScenarioScript = z.enum([
  'map',
  'map-layout',
  'map-branches',
  'map-nested',
  'claimed-done',
  'revision',
  'split',
  'merge',
  'report',
  'rejected',
  'outline',
  'reshape',
  'chat-answer',
  'chat-collapse-reviewers',
])
export type ScenarioScript = z.infer<typeof ScenarioScript>

const scripts: Readonly<Record<ScenarioScript, (input: JsonValue | undefined) => JsonValue>> = {
  map: (input) => mapScript(readObserverInput(input)),
  'map-layout': (input) => mapLayoutScript(readObserverInput(input)),
  'map-branches': (input) => mapBranchesScript(readObserverInput(input)),
  'map-nested': (input) => mapNestedScript(readObserverInput(input)),
  'claimed-done': (input) => claimedDoneScript(readObserverInput(input)),
  revision: (input) => revisionScript(readObserverInput(input)),
  report: (input) => reportScript(readObserverInput(input)),
  rejected: (input) => rejectedScript(readObserverInput(input)),
  split: (input) => splitScript(readObserverInput(input)),
  merge: (input) => mergeScript(readObserverInput(input)),
  outline: (input) => outlineScript(readObserverInput(input)),
  reshape: (input) => reshapeScript(readObserverInput(input)),
  'chat-answer': (input) => chatAnswerScript(readChatInput(input)),
  'chat-collapse-reviewers': (input) => chatCollapseReviewersScript(readChatInput(input)),
}

export const runScenarioScript = (script: ScenarioScript, input: JsonValue | undefined): JsonValue =>
  scripts[script](input)
