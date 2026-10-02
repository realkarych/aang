import type { CollectedRecord, FactDraft, JsonValue, ParseResult, RuntimeEnv, SpoolEnv } from '@aang/contract'
import { canonicalJson, contentHash } from '@aang/contract/ids'
import { z } from 'zod'
import { fact, type FactOrigin, invalid, noRuntimeIds, parsed, schemaViolation, unknown } from './facts.js'
import { isJsonObject, type JsonObject, parseJson } from './json.js'
import { actionKey, ownerKey, questionKey } from './keys.js'
import { actionKind, exitCode, inputDescription, outputText, persistedOutputPath } from './tools.js'

const name = z.string().min(1)
const optionalText = z.string().nullish()
const durationMs = z.int().nonnegative().nullish()

const HookCommon = z.object({
  hook_event_name: name,
  session_id: name,
  cwd: optionalText,
  prompt_id: optionalText,
  agent_id: name.nullish(),
})
type HookCommon = z.infer<typeof HookCommon>

const PreToolUse = HookCommon.extend({ tool_name: name, tool_input: z.json(), tool_use_id: name })

const PostToolUse = HookCommon.extend({
  tool_name: name,
  tool_response: z.json(),
  tool_use_id: name,
  duration_ms: durationMs,
})

const PostToolUseFailure = HookCommon.extend({
  tool_name: name,
  tool_use_id: name,
  error: z.string(),
  is_interrupt: z.boolean().nullish(),
  duration_ms: durationMs,
})

const PostToolBatch = HookCommon.extend({
  tool_calls: z.array(z.object({ tool_name: name, tool_use_id: name, tool_response: z.json().optional() })),
})

const PermissionRequest = HookCommon.extend({ tool_name: name, tool_input: z.json() })

const PermissionDenied = HookCommon.extend({ tool_name: name, tool_use_id: name, reason: optionalText })

const Notification = HookCommon.extend({ notification_type: name, message: optionalText, title: optionalText })

interface HookContext {
  readonly event: string
  readonly origin: FactOrigin
  readonly spoolFile: string | null
}

type HookParser = (payload: JsonObject, context: HookContext) => ParseResult

const engineVersionPattern = /^claude-code_(\d+)-(\d+)-(\d+)(?:_|$)/

const engineVersion = (agent: string | undefined): string | null => {
  const match = engineVersionPattern.exec(agent ?? '')
  return match === null ? null : match.slice(1, 4).join('.')
}

const hookEnv = (common: HookCommon, env: SpoolEnv): RuntimeEnv => ({
  cwd: common.cwd ?? null,
  version: engineVersion(env.AI_AGENT),
  entrypoint: env.CLAUDE_CODE_ENTRYPOINT ?? null,
  originator: null,
  git_branch: null,
})

const hookOrigin = (record: CollectedRecord, payload: JsonObject, common: HookCommon): FactOrigin => ({
  at: record.observed_at,
  ids: {
    ...noRuntimeIds,
    session_id: common.session_id,
    agent_id: common.agent_id ?? null,
    prompt_id: common.prompt_id ?? null,
  },
  env: hookEnv(common, record.hook?.env ?? {}),
  redeliveryKey: contentHash(canonicalJson(payload)),
})

const hookParser =
  <T extends HookCommon>(schema: z.ZodType<T>, build: (event: T, context: HookContext) => ParseResult): HookParser =>
  (payload, context) => {
    const event = schema.safeParse(payload)
    return event.success ? build(event.data, context) : schemaViolation(`${context.event} hook`, event.error)
  }

const facts = (...drafts: FactDraft[]): ParseResult => parsed(null, drafts)

const questionNotificationTypes: ReadonlySet<string> = new Set([
  'elicitation_dialog',
  'elicitation_url_dialog',
  'agent_needs_input',
])

const verifiedNotificationTypes: ReadonlySet<string> = new Set(['permission_prompt'])

const responseText = (response: JsonValue | undefined): string | null =>
  response === undefined ? null : outputText(response)

const hookParsers: ReadonlyMap<string, HookParser> = new Map([
  [
    'PreToolUse',
    hookParser(PreToolUse, (event, { origin }) =>
      facts(
        fact(
          origin,
          {
            kind: 'action_start',
            entity_key: actionKey(event.session_id, event.tool_use_id),
            speaker: 'solver',
            urgent: false,
            payload: {
              tool: event.tool_name,
              action_kind: actionKind(event.tool_name),
              input: event.tool_input,
              description: inputDescription(event.tool_input),
              container_call: null,
            },
          },
          { ids: { call_id: event.tool_use_id } },
        ),
      ),
    ),
  ],
  [
    'PostToolUse',
    hookParser(PostToolUse, (event, { origin }) =>
      facts(
        fact(
          origin,
          {
            kind: 'action_end',
            entity_key: actionKey(event.session_id, event.tool_use_id),
            speaker: 'tool',
            urgent: false,
            payload: {
              outcome: 'ok',
              output: outputText(event.tool_response),
              persisted_output_path: persistedOutputPath(event.tool_response),
              exit_code: null,
              duration_ms: event.duration_ms ?? null,
              result: event.tool_response,
            },
          },
          { ids: { call_id: event.tool_use_id } },
        ),
      ),
    ),
  ],
  [
    'PostToolUseFailure',
    hookParser(PostToolUseFailure, (event, { origin }) => {
      const outcome = event.is_interrupt === true ? 'interrupted' : 'error'
      return facts(
        fact(
          origin,
          {
            kind: 'action_end',
            entity_key: actionKey(event.session_id, event.tool_use_id),
            speaker: 'tool',
            urgent: outcome === 'error',
            payload: {
              outcome,
              output: event.error,
              persisted_output_path: null,
              exit_code: exitCode(event.error),
              duration_ms: event.duration_ms ?? null,
              result: null,
            },
          },
          { ids: { call_id: event.tool_use_id } },
        ),
      )
    }),
  ],
  [
    'PostToolBatch',
    hookParser(PostToolBatch, (event, { origin }) =>
      facts(
        fact(origin, {
          kind: 'tool_batch_end',
          entity_key: ownerKey(event.session_id, event.agent_id ?? null),
          speaker: 'runtime',
          urgent: false,
          payload: {
            calls: event.tool_calls.map((call) => ({
              call_id: call.tool_use_id,
              tool: call.tool_name,
              response: responseText(call.tool_response),
            })),
          },
        }),
      ),
    ),
  ],
  [
    'PermissionRequest',
    hookParser(PermissionRequest, (event, { origin, spoolFile }) =>
      spoolFile === null
        ? invalid('PermissionRequest is identified by its spool file, and the record has none')
        : facts(
            fact(origin, {
              kind: 'permission_request',
              entity_key: questionKey(event.session_id, spoolFile),
              speaker: 'runtime',
              urgent: true,
              payload: { tool: event.tool_name, input: event.tool_input },
            }),
          ),
    ),
  ],
  [
    'PermissionDenied',
    hookParser(PermissionDenied, (event, { origin }) =>
      facts(
        fact(
          origin,
          {
            kind: 'permission_denied',
            entity_key: actionKey(event.session_id, event.tool_use_id),
            speaker: 'runtime',
            urgent: false,
            payload: { tool: event.tool_name, reason: event.reason ?? null },
          },
          { ids: { call_id: event.tool_use_id }, verified: false },
        ),
      ),
    ),
  ],
  [
    'Notification',
    hookParser(Notification, (event, { origin, spoolFile }) => {
      if (!questionNotificationTypes.has(event.notification_type)) {
        return facts(
          fact(
            origin,
            {
              kind: 'notification',
              entity_key: ownerKey(event.session_id, event.agent_id ?? null),
              speaker: 'runtime',
              urgent: false,
              payload: { notification_type: event.notification_type, message: event.message ?? null },
            },
            { verified: verifiedNotificationTypes.has(event.notification_type) },
          ),
        )
      }
      return spoolFile === null
        ? invalid('a question notification is identified by its spool file, and the record has none')
        : facts(
            fact(
              origin,
              {
                kind: 'question_asked',
                entity_key: questionKey(event.session_id, spoolFile),
                speaker: 'runtime',
                urgent: true,
                payload: {
                  source: 'notification',
                  blocking: true,
                  questions: [{ header: event.title ?? null, text: event.message ?? '', options: [] }],
                },
              },
              { verified: false },
            ),
          )
    }),
  ],
])

export const parseHook = (record: CollectedRecord): ParseResult => {
  const payload = parseJson(record.payload)
  if (!isJsonObject(payload)) {
    return invalid('hook payload is not a JSON object')
  }
  const common = HookCommon.safeParse(payload)
  if (!common.success) {
    return typeof payload.hook_event_name === 'string' && !hookParsers.has(payload.hook_event_name)
      ? unknown(null)
      : schemaViolation('hook payload', common.error)
  }
  const parser = hookParsers.get(common.data.hook_event_name)
  if (parser === undefined) {
    return unknown(null)
  }
  const spoolFile = record.position.kind === 'spool' ? record.position.file : null
  return parser(payload, {
    event: common.data.hook_event_name,
    origin: hookOrigin(record, payload, common.data),
    spoolFile,
  })
}
