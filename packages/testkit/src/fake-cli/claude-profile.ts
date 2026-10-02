import type { JsonValue } from '@aang/contract'
import { isJsonObject, parseJson, readText } from './io.js'
import { allValues, flag, lastValue, valued, type OptionSpec, type ParsedOptions } from './options.js'
import { environmentRequirement, violations, type ProfileCall, type Requirement } from './profile.js'

export const claudeOptions: readonly OptionSpec[] = [
  flag('print', '-p'),
  valued('output-format'),
  valued('input-format'),
  flag('verbose'),
  valued('json-schema'),
  valued('model'),
  valued('effort'),
  valued('setting-sources'),
  flag('strict-mcp-config'),
  valued('mcp-config'),
  valued('tools'),
  valued('disallowedTools', '--disallowed-tools'),
  flag('disable-slash-commands'),
  valued('system-prompt'),
  valued('system-prompt-file'),
  valued('append-system-prompt'),
  flag('no-session-persistence'),
  valued('permission-mode'),
  valued('session-id'),
  valued('settings'),
  valued('debug-file'),
  flag('include-hook-events'),
]

export interface ClaudeProfileCall extends ProfileCall {
  readonly options: ParsedOptions
}

const jsonArgument = (value: string | undefined): JsonValue | undefined =>
  value?.trimStart().startsWith('{') === true
    ? parseJson(value)
    : parseJson(value === undefined ? undefined : readText(value))

const hasNoMcpServers = (value: string): boolean => {
  const config = jsonArgument(value)
  const servers = isJsonObject(config) ? config.mcpServers : undefined
  return isJsonObject(servers) && Object.keys(servers).length === 0
}

const holdsCrossSessionInbound = (options: ParsedOptions): boolean => {
  const settings = jsonArgument(lastValue(options, 'settings'))
  return isJsonObject(settings) && settings.crossSessionInbound === 'hold'
}

const disallowsMcpTools = (options: ParsedOptions): boolean =>
  allValues(options, 'disallowedTools')
    .flatMap((value) => value.split(/[\s,]+/))
    .includes('mcp__*')

const equals =
  (key: string, expected: string) =>
  ({ options }: ClaudeProfileCall): boolean =>
    lastValue(options, key) === expected

const present =
  (key: string) =>
  ({ options }: ClaudeProfileCall): boolean =>
    options.flags.has(key)

const requirements: readonly Requirement<ClaudeProfileCall>[] = [
  { id: '--output-format stream-json', met: equals('output-format', 'stream-json') },
  { id: '--json-schema', met: ({ options }) => isJsonObject(parseJson(lastValue(options, 'json-schema'))) },
  { id: '--model', met: ({ options }) => (lastValue(options, 'model') ?? '') !== '' },
  { id: '--setting-sources ""', met: equals('setting-sources', '') },
  { id: '--strict-mcp-config', met: present('strict-mcp-config') },
  {
    id: '--mcp-config {"mcpServers":{}}',
    met: ({ options }) => {
      const configs = allValues(options, 'mcp-config')
      return configs.length > 0 && configs.every(hasNoMcpServers)
    },
  },
  { id: '--tools ""', met: equals('tools', '') },
  { id: '--disallowedTools mcp__*', met: ({ options }) => disallowsMcpTools(options) },
  { id: '--disable-slash-commands', met: present('disable-slash-commands') },
  { id: '--no-session-persistence', met: present('no-session-persistence') },
  { id: '--permission-mode dontAsk', met: equals('permission-mode', 'dontAsk') },
  { id: '--settings {"crossSessionInbound":"hold"}', met: ({ options }) => holdsCrossSessionInbound(options) },
  environmentRequirement('CLAUDE_CODE_ENTRYPOINT', 'aang-observer'),
  environmentRequirement('AANG_OBSERVER', '1'),
  environmentRequirement('CLAUDE_CODE_DISABLE_CLAUDE_MDS', '1'),
  environmentRequirement('CLAUDE_CODE_DISABLE_AUTO_MEMORY', '1'),
  environmentRequirement('ENABLE_CLAUDEAI_MCP_SERVERS', 'false'),
  environmentRequirement('DISABLE_TELEMETRY', '1'),
  environmentRequirement('DISABLE_ERROR_REPORTING', '1'),
  environmentRequirement('DISABLE_AUTOUPDATER', '1'),
]

export const claudeViolations = (call: ClaudeProfileCall): string[] => violations(requirements, call)
