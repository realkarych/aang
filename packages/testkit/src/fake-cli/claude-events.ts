import { randomBytes, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { JsonValue } from '@aang/contract'
import type { ClaudeUsage } from './scenario.js'

export interface ClaudeSession {
  readonly sessionId: string
  readonly model: string
  readonly version: string
  readonly cwd: string
  readonly tools: readonly string[]
  readonly permissionMode: string
  readonly startedAt: number
}

export const defaultClaudeUsage: ClaudeUsage = {
  inputTokens: 2,
  cacheCreationInputTokens: 3064,
  cacheReadInputTokens: 0,
  outputTokens: 872,
  costUsd: 0.04196,
}

const noUsage: ClaudeUsage = {
  inputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
}

const fiveHoursInSeconds = 5 * 60 * 60
const thinkingTokens = 190

const builtinPlugins = ['cc-plugin-agents-md', 'cc-plugin-plugin-authoring'].map((name) => ({
  name,
  path: 'builtin',
  source: `${name}@builtin`,
}))

const capabilities = [
  'interrupt_receipt_v1',
  'interrupt_cancel_queued_v1',
  'msg_lifecycle_v1',
  'sdk_mcp_tools_list_changed',
  'sdk_mcp_manifests',
  'mcp_read_resource_v1',
  'mcp_tool_ui_meta_v1',
  'ui_surface_v1',
]

const nowInSeconds = (): number => Math.floor(Date.now() / 1000)

const elapsed = (session: ClaudeSession): number => Math.round(performance.now() - session.startedAt)

const cacheCreation = (usage: ClaudeUsage): JsonValue => ({
  ephemeral_5m_input_tokens: 0,
  ephemeral_1h_input_tokens: usage.cacheCreationInputTokens,
})

const messageUsage = (usage: ClaudeUsage): JsonValue => ({
  input_tokens: usage.inputTokens,
  cache_creation_input_tokens: usage.cacheCreationInputTokens,
  cache_read_input_tokens: usage.cacheReadInputTokens,
  cache_creation: cacheCreation(usage),
  output_tokens: usage.outputTokens,
  service_tier: 'standard',
  inference_geo: 'not_available',
})

const resultUsage = (usage: ClaudeUsage): JsonValue => ({
  input_tokens: usage.inputTokens,
  cache_creation_input_tokens: usage.cacheCreationInputTokens,
  cache_read_input_tokens: usage.cacheReadInputTokens,
  output_tokens: usage.outputTokens,
  output_tokens_details: { thinking_tokens: usage.outputTokens === 0 ? 0 : thinkingTokens },
  server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
  service_tier: 'standard',
  cache_creation: cacheCreation(usage),
  inference_geo: usage.outputTokens === 0 ? '' : 'not_available',
  iterations: [],
  speed: 'standard',
  fallback_credit: null,
})

const modelUsage = (session: ClaudeSession, usage: ClaudeUsage): JsonValue => ({
  [session.model]: {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadInputTokens: usage.cacheReadInputTokens,
    cacheCreationInputTokens: usage.cacheCreationInputTokens,
    webSearchRequests: 0,
    costUSD: usage.costUsd,
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    thinkingTokens,
    canonicalModel: session.model,
    provider: 'firstParty',
    costBasis: 'list',
  },
})

const subagentStats: JsonValue = {
  spawned: 0,
  requested: { background: 0, foreground: 0, unset: 0 },
  started_in_background: 0,
  max_depth: 0,
  spawned_by_subagents: 0,
  completed: 0,
  failed: 0,
  killed: { parent: 0, user: 0, system: 0 },
  refused: { depth_limit: 0, concurrency_limit: 0, budget: 0 },
  by_type: {},
}

export const initEvent = (session: ClaudeSession): JsonValue => ({
  type: 'system',
  subtype: 'init',
  cwd: session.cwd,
  session_id: session.sessionId,
  tools: [...session.tools],
  mcp_servers: [],
  model: session.model,
  permissionMode: session.permissionMode,
  slash_commands: [],
  apiKeySource: 'none',
  claude_code_version: session.version,
  output_style: 'default',
  agents: ['claude', 'Explore', 'general-purpose', 'Plan', 'statusline-setup'],
  skills: [],
  plugins: builtinPlugins,
  capabilities,
  analytics_disabled: true,
  product_feedback_disabled: false,
  uuid: randomUUID(),
  messaging_socket_path: join(tmpdir(), 'cc-socks', `${String(process.pid)}.sock`),
  fast_mode_state: 'off',
  fast_mode_disabled_reason: 'sdk_opt_in_required',
  per_turn_effort_active: true,
  view_mode: 'default',
})

const thinkingTokensEvent = (session: ClaudeSession, estimated: number, delta: number): JsonValue => ({
  type: 'system',
  subtype: 'thinking_tokens',
  estimated_tokens: estimated,
  estimated_tokens_delta: delta,
  session_id: session.sessionId,
  uuid: randomUUID(),
})

interface AssistantTurn {
  readonly messageId: string
  readonly requestId: string
}

const assistantEvent = (
  session: ClaudeSession,
  turn: AssistantTurn,
  content: JsonValue,
  usage: ClaudeUsage,
): JsonValue => ({
  type: 'assistant',
  message: {
    model: session.model,
    id: turn.messageId,
    type: 'message',
    role: 'assistant',
    content,
    container: null,
    stop_reason: null,
    stop_sequence: null,
    stop_details: null,
    usage: messageUsage(usage),
    input_transformations: [],
    diagnostics: null,
    context_management: null,
  },
  parent_tool_use_id: null,
  session_id: session.sessionId,
  uuid: randomUUID(),
  timestamp: new Date().toISOString(),
  request_id: turn.requestId,
})

export const rateLimitEvent = (
  session: ClaudeSession,
  status: 'allowed' | 'rejected',
  resetsAt?: number,
): JsonValue => ({
  type: 'rate_limit_event',
  rate_limit_info: {
    status,
    ...(resetsAt === undefined ? {} : { resetsAt }),
    rateLimitType: 'five_hour',
    overageStatus: 'rejected',
    overageDisabledReason: 'org_level_disabled',
    isUsingOverage: false,
  },
  uuid: randomUUID(),
  session_id: session.sessionId,
})

const resultEvent = (session: ClaudeSession, fields: Record<string, JsonValue>): JsonValue => ({
  type: 'result',
  subtype: 'success',
  session_id: session.sessionId,
  permission_denials: [],
  fast_mode_state: 'off',
  fast_mode_disabled_reason: 'sdk_opt_in_required',
  subagent_stats: subagentStats,
  uuid: randomUUID(),
  duration_ms: elapsed(session),
  queued_turn_count: 0,
  result_index: 0,
  ...fields,
})

const completedFields = (session: ClaudeSession, usage: ClaudeUsage): Record<string, JsonValue> => ({
  is_error: false,
  api_error_status: null,
  duration_api_ms: elapsed(session),
  total_cost_usd: usage.costUsd,
  usage: resultUsage(usage),
  modelUsage: modelUsage(session, usage),
  terminal_reason: 'completed',
  ttft_ms: elapsed(session),
  ttft_stream_ms: elapsed(session),
  time_to_request_ms: 0,
  first_content_frame_ms: elapsed(session),
})

export const answerEvents = (session: ClaudeSession, output: JsonValue, usage: ClaudeUsage): JsonValue[] => {
  const turn: AssistantTurn = {
    messageId: `msg_${randomBytes(12).toString('hex')}`,
    requestId: `req_${randomBytes(12).toString('hex')}`,
  }
  const toolUseId = `toolu_${randomBytes(12).toString('hex')}`
  const confirmation = 'Structured output provided successfully'
  return [
    thinkingTokensEvent(session, 50, 50),
    thinkingTokensEvent(session, thinkingTokens, thinkingTokens - 50),
    assistantEvent(session, turn, [{ type: 'thinking', thinking: '', signature: randomUUID() }], usage),
    assistantEvent(
      session,
      turn,
      [{ type: 'tool_use', id: toolUseId, name: 'StructuredOutput', input: output, caller: { type: 'direct' } }],
      usage,
    ),
    {
      type: 'user',
      message: { role: 'user', content: [{ tool_use_id: toolUseId, type: 'tool_result', content: confirmation }] },
      parent_tool_use_id: null,
      session_id: session.sessionId,
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
      tool_use_result: confirmation,
    },
    rateLimitEvent(session, 'allowed', nowInSeconds() + fiveHoursInSeconds),
    resultEvent(session, {
      ...completedFields(session, usage),
      num_turns: 2,
      result: JSON.stringify(output),
      stop_reason: 'tool_use',
      structured_output: output,
    }),
  ]
}

export const textResultEvent = (session: ClaudeSession, text: string, usage: ClaudeUsage): JsonValue =>
  resultEvent(session, {
    ...completedFields(session, usage),
    num_turns: 1,
    result: text,
    stop_reason: 'end_turn',
  })

export const errorResultEvent = (session: ClaudeSession, message: string, apiErrorStatus: number | null): JsonValue =>
  resultEvent(session, {
    is_error: true,
    api_error_status: apiErrorStatus,
    duration_api_ms: 0,
    num_turns: 1,
    result: message,
    stop_reason: 'stop_sequence',
    total_cost_usd: 0,
    usage: resultUsage(noUsage),
    modelUsage: {},
    terminal_reason: 'api_error',
  })
