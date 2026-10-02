import type { FactDraft, ParseResult, SpoolEnv } from '@aang/contract'
import { z } from 'zod'
import { type FactOrigin, parsed, schemaViolation } from './facts.js'
import { name, optionalText } from './fields.js'
import type { JsonObject } from './json.js'

export const HookCommon = z.object({
  hook_event_name: name,
  session_id: name,
  cwd: optionalText,
  prompt_id: optionalText,
  agent_id: name.nullish(),
})
export type HookCommon = z.infer<typeof HookCommon>

export interface HookContext {
  readonly event: string
  readonly payload: JsonObject
  readonly origin: FactOrigin
  readonly env: SpoolEnv
  readonly spoolFile: string | null
}

export type HookParser = (payload: JsonObject, context: HookContext) => ParseResult

export const hookParser =
  <T extends HookCommon>(schema: z.ZodType<T>, build: (event: T, context: HookContext) => ParseResult): HookParser =>
  (payload, context) => {
    const event = schema.safeParse(payload)
    return event.success ? build(event.data, context) : schemaViolation(`${context.event} hook`, event.error)
  }

export const facts = (...drafts: FactDraft[]): ParseResult => parsed(null, drafts)
