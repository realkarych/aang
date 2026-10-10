import type { CollectedRecord, JsonValue, ParseResult, RuntimeEnv, SpoolEnv } from '@aang/contract'
import { canonicalJson, contentHash } from '@aang/contract/ids'
import { z } from 'zod'
import { spawnedAgents } from './agents.js'
import { callStarted } from './calls.js'
import { fact, type FactOrigin, invalid, noRuntimeIds, schemaViolation, unknown } from './facts.js'
import { name, optionalText } from './fields.js'
import { facts, HookCommon, type HookParser, hookParser } from './hook-parser.js'
import { isJsonObject, type JsonObject, parseJson, withinNestingLimit } from './json.js'
import { actionKey, ownerKey, questionKey } from './keys.js'
import { isQuestionTool, questionsAnswered } from './questions.js'
import { sessionHookParsers } from './session-hooks.js'
import { actionKind, exitCode, outputText, persistedOutputPath } from './tools.js'

const durationMs = z.int().nonnegative().nullish()

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

const hookOrigin = (record: CollectedRecord, payload: JsonObject, common: HookCommon, env: SpoolEnv): FactOrigin => ({
  at: record.observed_at,
  ids: {
    ...noRuntimeIds,
    session_id: common.session_id,
    agent_id: common.agent_id ?? null,
    prompt_id: common.prompt_id ?? null,
  },
  env: hookEnv(common, env),
  redeliveryKey: contentHash(canonicalJson(payload)),
})

const questionNotificationTypes: ReadonlySet<string> = new Set([
  'elicitation_dialog',
  'elicitation_url_dialog',
  'agent_needs_input',
])

const verifiedNotificationTypes: ReadonlySet<string> = new Set([
  'permission_prompt',
  'elicitation_response',
  'elicitation_complete',
])

const responseText = (response: JsonValue | undefined): string | null =>
  response === undefined ? null : outputText(response)

const toolHookParsers: ReadonlyMap<string, HookParser> = new Map([
  [
    'PreToolUse',
    hookParser(PreToolUse, (event, { origin }) =>
      facts(
        ...callStarted({
          origin,
          session: event.session_id,
          call: event.tool_use_id,
          tool: event.tool_name,
          input: event.tool_input,
        }),
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
        ...(actionKind(event.tool_name) === 'agent'
          ? spawnedAgents(origin, event.session_id, event.tool_use_id, event.tool_response)
          : []),
        ...(actionKind(event.tool_name) === 'question'
          ? questionsAnswered({ origin, session: event.session_id, call: event.tool_use_id }, event.tool_response)
          : []),
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
    hookParser(PermissionRequest, (event, { origin, spoolFile }) => {
      const request = { tool: event.tool_name, input: event.tool_input }
      if (isQuestionTool(event.tool_name)) {
        return facts(
          fact(origin, {
            kind: 'permission_request',
            entity_key: ownerKey(event.session_id, event.agent_id ?? null),
            speaker: 'runtime',
            urgent: true,
            payload: request,
          }),
        )
      }
      return spoolFile === null
        ? invalid('PermissionRequest is identified by its spool file, and the record has none')
        : facts(
            fact(origin, {
              kind: 'permission_request',
              entity_key: questionKey(event.session_id, spoolFile),
              speaker: 'runtime',
              urgent: true,
              payload: request,
            }),
          )
    }),
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
            fact(origin, {
              kind: 'question_asked',
              entity_key: questionKey(event.session_id, spoolFile),
              speaker: 'runtime',
              urgent: true,
              payload: {
                source: 'notification',
                blocking: true,
                questions: [{ header: event.title ?? null, text: event.message ?? '', options: [] }],
              },
            }),
          )
    }),
  ],
])

const hookParsers: ReadonlyMap<string, HookParser> = new Map([...toolHookParsers, ...sessionHookParsers])

export const parseHook = (record: CollectedRecord): ParseResult => {
  const payload = parseJson(record.payload)
  if (!isJsonObject(payload)) {
    return invalid('hook payload is not a JSON object')
  }
  if (!withinNestingLimit(payload)) {
    return unknown(null)
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
  const env = record.hook?.env ?? {}
  return parser(payload, {
    event: common.data.hook_event_name,
    payload,
    origin: hookOrigin(record, payload, common.data, env),
    env,
    spoolFile: record.position.kind === 'spool' ? record.position.file : null,
  })
}
