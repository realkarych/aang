import { randomUUID } from 'node:crypto'
import { observerOutputJsonSchema, type CallUsage, type JsonValue } from '@aang/contract'
import { authenticate, createBackend, events, failureClass, LaunchError, number, object, requireSuccess, resetTime, systemPrompt, validateOutput, type BackendOptions, type ObserverOutcome, type JsonObject } from './backend.js'

import type { ProcessResult } from './process.js'

export interface ClaudeBuiltins {
  readonly mcpServers: readonly string[]
  readonly skills: readonly string[]
  readonly plugins: readonly string[]
}

export interface ClaudeBackendOptions extends BackendOptions {
  readonly builtins?: ClaudeBuiltins
}

const approved = (items: JsonValue | undefined, names: readonly string[], plugins = false): boolean =>
  Array.isArray(items) && items.every((item) => {
    if (typeof item === 'string') return !plugins && names.includes(item)
    return object(item) && typeof item.name === 'string' && names.includes(item.name) && (!plugins || (item.path === 'builtin' && item.source === `${item.name}@builtin`))
  })

const isolated = (init: JsonObject, allowed: ClaudeBuiltins): boolean =>
  Array.isArray(init.tools) && init.tools.length === 1 && init.tools[0] === 'StructuredOutput' &&
  approved(init.mcp_servers, allowed.mcpServers) && approved(init.skills, allowed.skills) && approved(init.plugins, allowed.plugins, true)

const usageOf = (result: JsonObject, model: string): CallUsage => {
  const usage = object(result.usage) ? result.usage : {}
  const details = object(usage.output_tokens_details) ? usage.output_tokens_details : {}
  return {
    model,
    cost_usd: number(result.total_cost_usd),
    tokens: {
      uncached_input_tokens: number(usage.input_tokens) ?? 0,
      cache_read_input_tokens: number(usage.cache_read_input_tokens) ?? 0,
      cache_write_input_tokens: number(usage.cache_creation_input_tokens) ?? 0,
      output_tokens: number(usage.output_tokens) ?? 0,
      reasoning_output_tokens: number(details.thinking_tokens),
    },
  }
}

export const createClaudeLauncher = (options: ClaudeBackendOptions, admittedVersion?: string) => {
  let authenticated = false
  return createBackend('claude', options, async ({ run, input }) => {
    if (admittedVersion !== undefined) {
      const version = await run(['--version'])
      requireSuccess(version)
      if (version.stdout.trim() !== `${admittedVersion} (Claude Code)`) throw new LaunchError('version_not_admitted', 'Claude version changed after admission')
    }
    if (!authenticated) {
      await authenticate('claude', run)
      authenticated = true
    }
    const result = await run(claudeArguments(options, randomUUID()), input)
    try { return parseClaudeResult(result, options) }
    catch (error) {
      if (error instanceof LaunchError && error.kind === 'auth') authenticated = false
      throw error
    }
  })
}

export const claudeArguments = (options: ClaudeBackendOptions, sessionId: string): string[] => [
  '-p', '--output-format', 'stream-json', '--verbose',
  '--json-schema', JSON.stringify(observerOutputJsonSchema()),
  '--model', options.model,
  ...(options.effort === undefined ? [] : ['--effort', options.effort]),
  '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
  '--tools', '', '--disallowedTools', 'mcp__*', '--disable-slash-commands',
  '--system-prompt', systemPrompt, '--no-session-persistence', '--permission-mode', 'dontAsk',
  '--settings', '{"crossSessionInbound":"hold"}', '--session-id', sessionId,
]

export const parseClaudeResult = (result: ProcessResult, options: ClaudeBackendOptions): ObserverOutcome => {
  const allowed = options.builtins ?? { mcpServers: [], skills: [], plugins: [] }
  let parseError: Error | null = null
  const stream: JsonObject[] = []
  for (const line of result.stdout.split(/\r?\n/)) {
    try { stream.push(...events(line)) }
    catch (error) { parseError ??= error instanceof Error ? error : new Error(String(error)) }
  }
  const init = stream.filter((event) => event.type === 'system' && event.subtype === 'init')
  const results = stream.filter((event) => event.type === 'result')
  const response = results[0]
  const usage = response === undefined ? null : usageOf(response, options.model)
  const missingInit = init.length === 0 && result.failure === null && parseError === null
  if (missingInit || init.length > 1 || init.some((event) => !isolated(event, allowed))) throw new LaunchError('isolation', 'Claude init does not match the admitted isolation profile', usage)
  if (result.failure !== null) requireSuccess(result)
  if (parseError !== null) throw parseError
  if (response === undefined || results.length !== 1 || response.subtype !== 'success' || response.is_error !== false || result.exitCode !== 0) {
    const message = typeof response?.result === 'string' ? response.result : ''
    const status = number(response?.api_error_status)
    const limit = stream.filter((event) => event.type === 'rate_limit_event').map((event) => event.rate_limit_info).find((info) => object(info) && info.status === 'rejected')
    const kind = status === 429 || limit !== undefined ? 'limit' : status !== null && status >= 500 ? 'network' : failureClass(message + result.stderr)
    const resets = object(limit) ? number(limit.resetsAt) : null
    throw new LaunchError(kind, `Claude did not produce a successful result${message === '' ? '' : `: ${message}`}`, usage, kind !== 'limit' ? null : resets === null ? resetTime(message) : resets * 1000)
  }
  return validateOutput(response.structured_output, usageOf(response, options.model))
}
