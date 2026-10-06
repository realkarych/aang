import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CallUsage } from '@aang/contract'
import { authenticate, createBackend, events, failureClass, json, LaunchError, number, object, requireSuccess, resetTime, validateOutput, type BackendOptions, type CallOutcome, type CallProtocol, type Invocation, type JsonObject } from './backend.js'

const disabledFeatures = ['hooks', 'plugins', 'apps', 'multi_agent', 'multi_agent_v2', 'shell_tool', 'unified_exec', 'browser_use', 'browser_use_external', 'computer_use', 'image_generation', 'view_image', 'goals', 'sleep_tool', 'tool_suggest', 'skill_search', 'recommended_plugins', 'shell_snapshot']
const settings = [
  'include_environment_context=false', 'include_permissions_instructions=false', 'include_apps_instructions=false',
  'include_collaboration_mode_instructions=false', 'project_doc_max_bytes=0', 'web_search="disabled"',
  'skills.include_instructions=false', 'analytics.enabled=false', 'history.persistence="none"', 'memories.generate_memories=false',
  'tools.experimental_request_user_input={enabled=false}',
]

const pathSetting = (key: string, path: string): string => `${key}=${JSON.stringify(path.replaceAll('\\', '/'))}`

const usageOf = (completed: JsonObject | undefined, model: string): CallUsage => {
  const usage = object(completed?.usage) ? completed.usage : {}
  const cached = number(usage.cached_input_tokens) ?? 0
  return {
    model,
    cost_usd: null,
    tokens: {
      uncached_input_tokens: Math.max(0, (number(usage.input_tokens) ?? 0) - cached),
      cache_read_input_tokens: cached,
      cache_write_input_tokens: number(usage.cache_write_input_tokens) ?? 0,
      output_tokens: number(usage.output_tokens) ?? 0,
      reasoning_output_tokens: number(usage.reasoning_output_tokens),
    },
  }
}

export const createCodexLauncher = (options: BackendOptions, admittedVersion?: string) => {
  let authenticated = false
  let catalogVersion: string | undefined
  let catalog: JsonObject | undefined
  return createBackend('codex', options, async <T>({ directory, run, input, protocol }: Invocation<T>): Promise<CallOutcome<T>> => {
    if (!authenticated) {
      await authenticate('codex', run)
      authenticated = true
    }
    const version = await run(['--version'])
    requireSuccess(version)
    if (admittedVersion !== undefined && version.stdout.trim() !== `codex-cli ${admittedVersion}`) throw new LaunchError('version_not_admitted', 'Codex version changed after admission')
    if (catalog === undefined || catalogVersion !== version.stdout.trim()) {
      const models = await run(['debug', 'models', '--bundled'])
      requireSuccess(models)
      catalog = codexCatalog(models.stdout, options.model)
      catalogVersion = version.stdout.trim()
    }
    const args = await codexArguments(directory, catalog, options, protocol)
    const lastPath = join(directory, 'last.json')
    const result = await run(args, input)
    const unsupported = result.stderr.includes('codex_core::tools::router: error=unsupported')
    if (result.failure !== null && !unsupported) requireSuccess(result)
    let stream: JsonObject[]
    try { stream = events(result.stdout) }
    catch (error) {
      if (unsupported) throw new LaunchError('isolation', 'Codex attempted an unsupported tool call')
      throw error
    }
    const completed = stream.filter((event) => event.type === 'turn.completed')
    const usage = usageOf(completed[0], options.model)
    if (unsupported) throw new LaunchError('isolation', 'Codex attempted an unsupported tool call', usage)
    const failed = stream.find((event) => event.type === 'turn.failed')
    if (result.exitCode !== 0 || completed.length !== 1 || failed !== undefined) {
      const text = result.stdout + result.stderr
      const kind = failureClass(text)
      if (kind === 'auth') authenticated = false
      const message = object(failed?.error) && typeof failed.error.message === 'string' ? `: ${failed.error.message}` : ''
      throw new LaunchError(kind, `Codex did not complete its turn${message}`, usage, kind === 'limit' ? resetTime(text) : null)
    }
    let output
    try { output = json(await readFile(lastPath, 'utf8')) }
    catch { throw new LaunchError('invalid_output', 'Codex last.json is missing or invalid', usage) }
    return validateOutput(protocol, output, usage)
  })
}

export const codexArguments = async <T>(directory: string, catalog: JsonObject, options: BackendOptions, protocol: CallProtocol<T>): Promise<string[]> => {
  const catalogPath = join(directory, 'models.json')
  const promptPath = join(directory, 'instructions.txt')
  const schemaPath = join(directory, 'schema.json')
  const lastPath = join(directory, 'last.json')
  await Promise.all([
    writeFile(catalogPath, JSON.stringify(catalog), { mode: 0o600 }),
    writeFile(promptPath, protocol.systemPrompt, { mode: 0o600 }),
    writeFile(schemaPath, JSON.stringify(protocol.schema), { mode: 0o600 }),
  ])
  return [
    'exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '-s', 'read-only',
    '--thread-source', 'aang-observer', '-m', options.model, '--output-schema', schemaPath, '-o', lastPath,
    '-c', pathSetting('model_catalog_json', catalogPath), '-c', pathSetting('model_instructions_file', promptPath),
    ...(options.effort === undefined ? [] : ['-c', `model_reasoning_effort=${JSON.stringify(options.effort)}`]),
    ...settings.flatMap((setting) => ['-c', setting]), ...disabledFeatures.flatMap((feature) => ['--disable', feature]), '-',
  ]
}

export const codexCatalog = (text: string, selectedModel: string): JsonObject => {
  const bundled = json(text)
  const entry = object(bundled) && Array.isArray(bundled.models) ? bundled.models.find((model) => object(model) && model.slug === selectedModel) : undefined
  if (!object(entry)) throw new LaunchError('isolation', 'Configured Codex model is absent from the bundled catalog')
  return { models: [{ ...entry, tool_mode: null, multi_agent_version: null, apply_patch_tool_type: null, experimental_supported_tools: [] }] }
}
