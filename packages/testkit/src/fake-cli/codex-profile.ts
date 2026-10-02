import { resolve } from 'node:path'
import type { JsonValue } from '@aang/contract'
import { toolFreeTraits } from './codex-catalog.js'
import { isJsonObject, parseJson, readText } from './io.js'
import { allValues, flag, lastValue, valued, type OptionSpec, type ParsedOptions } from './options.js'
import { environmentRequirement, violations, type ProfileCall, type Requirement } from './profile.js'
import { configValue } from './toml.js'

export const codexExecOptions: readonly OptionSpec[] = [
  flag('json'),
  valued('model', '-m'),
  valued('output-schema'),
  valued('output-last-message', '-o'),
  flag('ephemeral'),
  flag('ignore-user-config'),
  flag('ignore-rules'),
  flag('skip-git-repo-check'),
  valued('sandbox', '-s'),
  valued('thread-source'),
  valued('cd', '-C'),
  valued('config', '-c'),
  valued('disable'),
  valued('enable'),
  flag('dangerously-bypass-hook-trust'),
  valued('color'),
]

type JsonObject = { readonly [key: string]: JsonValue }

export interface CodexProfileCall extends ProfileCall {
  readonly options: ParsedOptions
  readonly config: JsonValue
  readonly catalog: readonly JsonObject[] | undefined
}

export const disabledFeatures = [
  'hooks',
  'plugins',
  'apps',
  'multi_agent',
  'multi_agent_v2',
  'shell_tool',
  'unified_exec',
  'browser_use',
  'browser_use_external',
  'computer_use',
  'image_generation',
  'view_image',
  'goals',
  'sleep_tool',
  'tool_suggest',
  'skill_search',
  'recommended_plugins',
] as const

const configSettings: readonly (readonly [string, string | boolean | number])[] = [
  ['include_environment_context', false],
  ['include_permissions_instructions', false],
  ['include_apps_instructions', false],
  ['include_collaboration_mode_instructions', false],
  ['project_doc_max_bytes', 0],
  ['web_search', 'disabled'],
  ['skills.include_instructions', false],
  ['analytics.enabled', false],
  ['history.persistence', 'none'],
  ['memories.generate_memories', false],
]

export const readCatalog = (config: JsonValue, cwd: string): JsonObject[] | undefined => {
  const path = configValue(config, 'model_catalog_json')
  const catalog = typeof path === 'string' ? parseJson(readText(resolve(cwd, path))) : undefined
  const models = isJsonObject(catalog) ? catalog.models : undefined
  return Array.isArray(models) && models.every(isJsonObject) ? models : undefined
}

export const catalogEntry = (call: Pick<CodexProfileCall, 'options' | 'catalog'>): JsonObject | undefined =>
  call.catalog?.find((entry) => entry.slug === lastValue(call.options, 'model'))

const isToolFree = (entry: JsonObject): boolean =>
  toolFreeTraits.every((trait) => entry[trait] === null) &&
  Array.isArray(entry.experimental_supported_tools) &&
  entry.experimental_supported_tools.length === 0

const present =
  (key: string) =>
  ({ options }: CodexProfileCall): boolean =>
    options.flags.has(key)

const equals =
  (key: string, expected: string) =>
  ({ options }: CodexProfileCall): boolean =>
    lastValue(options, key) === expected

const tomlLiteral = (value: string | boolean | number): string =>
  typeof value === 'string' ? JSON.stringify(value) : String(value)

const requirements: readonly Requirement<CodexProfileCall>[] = [
  { id: '--json', met: present('json') },
  { id: '-m', met: ({ options }) => (lastValue(options, 'model') ?? '') !== '' },
  {
    id: '--output-schema',
    met: ({ options }) => {
      const path = lastValue(options, 'output-schema')
      return path !== undefined && isJsonObject(parseJson(readText(path)))
    },
  },
  { id: '-o', met: ({ options }) => lastValue(options, 'output-last-message') !== undefined },
  { id: '--ephemeral', met: present('ephemeral') },
  { id: '--ignore-user-config', met: present('ignore-user-config') },
  { id: '--ignore-rules', met: present('ignore-rules') },
  { id: '--skip-git-repo-check', met: present('skip-git-repo-check') },
  { id: '-s read-only', met: equals('sandbox', 'read-only') },
  { id: '--thread-source aang-observer', met: equals('thread-source', 'aang-observer') },
  { id: '-c model_catalog_json', met: ({ catalog }) => catalog !== undefined },
  {
    id: '-m matches the catalog slug',
    met: (call) =>
      call.catalog === undefined || lastValue(call.options, 'model') === undefined || catalogEntry(call) !== undefined,
  },
  {
    id: 'catalog entry without tools',
    met: (call) => {
      const entry = catalogEntry(call)
      return entry === undefined || isToolFree(entry)
    },
  },
  {
    id: '-c tools.experimental_request_user_input={enabled=false}',
    met: ({ config }) => configValue(config, 'tools.experimental_request_user_input.enabled') === false,
  },
  ...configSettings.map(([key, value]): Requirement<CodexProfileCall> => ({
    id: `-c ${key}=${tomlLiteral(value)}`,
    met: ({ config }) => configValue(config, key) === value,
  })),
  ...disabledFeatures.map((feature): Requirement<CodexProfileCall> => ({
    id: `--disable ${feature}`,
    met: ({ options }) => allValues(options, 'disable').includes(feature),
  })),
  environmentRequirement('CODEX_INTERNAL_ORIGINATOR_OVERRIDE', 'aang_observer'),
  environmentRequirement('AANG_OBSERVER', '1'),
]

export const codexViolations = (call: CodexProfileCall): string[] => violations(requirements, call)
