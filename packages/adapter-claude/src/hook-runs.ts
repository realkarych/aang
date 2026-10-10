import {
  type FactDraft,
  type FactEntityKey,
  type HookOutputKind,
  type HookRunPayload,
  RegistrationTag,
} from '@aang/contract'
import { z } from 'zod'
import { fact, type FactOrigin } from './facts.js'
import { name, optionalText } from './fields.js'

const stopEvent = 'Stop'

const aangHook = new RegExp(`^(?:.*[\\\\/])?aang-hook(?:\\.exe)? claude (?:${RegistrationTag.options.join('|')}) `)

const isAangHook = (command: string): boolean => aangHook.test(command)

const occurrence = { hookEvent: name, hookName: optionalText }

const HookSuccess = z.object({ ...occurrence, type: z.literal('hook_success'), command: name, content: z.string() })

const HookNonBlockingError = z.object({
  ...occurrence,
  type: z.literal('hook_non_blocking_error'),
  command: name,
  stderr: z.string(),
})

const HookAdditionalContext = z.object({
  ...occurrence,
  type: z.literal('hook_additional_context'),
  content: z.array(z.string()),
})

const HookSystemMessage = z.object({ ...occurrence, type: z.literal('hook_system_message'), content: z.string() })

export const HookRunAttachment = z.discriminatedUnion('type', [
  HookSuccess,
  HookNonBlockingError,
  HookAdditionalContext,
  HookSystemMessage,
])
type HookRunAttachment = z.infer<typeof HookRunAttachment>

export const hookRunAttachmentTypes: readonly string[] = HookRunAttachment.options.map(
  (option) => option.shape.type.value,
)

export const StopHookSummary = z.object({
  hookInfos: z.array(z.object({ command: name })),
  hookErrors: z.array(z.unknown()),
  preventedContinuation: z.boolean(),
})
type StopHookSummary = z.infer<typeof StopHookSummary>

const outputOf = (kind: HookOutputKind, text: string): HookRunPayload['output'] =>
  text === '' ? null : { kind, text }

const runOf = (attachment: HookRunAttachment): HookRunPayload => {
  const occurred = { event: attachment.hookEvent, trigger: attachment.hookName ?? null }
  switch (attachment.type) {
    case 'hook_success':
      return {
        name: attachment.command,
        ...occurred,
        outcome: 'success',
        output: outputOf('stdout', attachment.content),
      }
    case 'hook_non_blocking_error':
      return { name: attachment.command, ...occurred, outcome: 'error', output: outputOf('stderr', attachment.stderr) }
    case 'hook_additional_context':
      return {
        name: null,
        ...occurred,
        outcome: 'success',
        output: outputOf('additional_context', attachment.content.join('\n')),
      }
    case 'hook_system_message':
      return { name: null, ...occurred, outcome: 'success', output: outputOf('system_message', attachment.content) }
  }
}

const hookRunFact = (origin: FactOrigin, owner: FactEntityKey, payload: HookRunPayload): FactDraft =>
  fact(origin, { kind: 'hook_run', entity_key: owner, speaker: 'runtime', urgent: false, payload })

export const hookRunFacts = (origin: FactOrigin, owner: FactEntityKey, attachment: HookRunAttachment): FactDraft[] => {
  const payload = runOf(attachment)
  return payload.name !== null && isAangHook(payload.name) ? [] : [hookRunFact(origin, owner, payload)]
}

export const stopHookFacts = (origin: FactOrigin, owner: FactEntityKey, summary: StopHookSummary): FactDraft[] => {
  const outcome = summary.hookErrors.length === 0 && !summary.preventedContinuation ? 'success' : 'unknown'
  const commands = [...new Set(summary.hookInfos.map(({ command }) => command))].filter(
    (command) => !isAangHook(command),
  )
  return commands.map((command) =>
    hookRunFact(origin, owner, { name: command, event: stopEvent, trigger: null, outcome, output: null }),
  )
}
