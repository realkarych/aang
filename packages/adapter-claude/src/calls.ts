import type { FactDraft } from '@aang/contract'
import { callFact, type ToolCall } from './facts.js'
import { actionKey } from './keys.js'
import { planUpdates } from './plan.js'
import { questionsAsked } from './questions.js'
import { actionKind, inputDescription } from './tools.js'

export const callStarted = (call: ToolCall): FactDraft[] => [
  callFact(call, {
    kind: 'action_start',
    entity_key: actionKey(call.session, call.call),
    speaker: 'solver',
    urgent: false,
    payload: {
      tool: call.tool,
      action_kind: actionKind(call.tool),
      input: call.input,
      description: inputDescription(call.input),
      container_call: null,
    },
  }),
  ...questionsAsked(call),
  ...planUpdates(call),
]
