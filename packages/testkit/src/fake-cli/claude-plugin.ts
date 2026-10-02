import { statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { JsonValue } from '@aang/contract'
import { z } from 'zod'
import { emit, finish, parseJson, readText, say } from './io.js'
import { flag, parseOptions, valued } from './options.js'
import { scenarioMessage } from './profile.js'
import { fakeCliExitCodes, type ClaudePluginCommand } from './scenario.js'
import { readStateDocument, writeStateDocument } from './state.js'

const registryDocument = 'claude-plugins.json'

const Registry = z.strictObject({
  marketplaces: z.record(z.string(), z.string()).default(() => ({})),
  plugins: z.record(z.string(), z.strictObject({ enabled: z.boolean(), version: z.string() })).default(() => ({})),
})
type Registry = z.output<typeof Registry>

const MarketplaceManifest = z.looseObject({
  name: z.string().min(1),
  plugins: z.array(z.looseObject({ name: z.string().min(1), source: z.string().min(1) })),
})

const PluginManifest = z.looseObject({ name: z.string().min(1), version: z.string().optional() })

const pluginOptions = [flag('json'), valued('scope', '-s')]

interface Report {
  readonly command: ClaudePluginCommand
  readonly message: string
  readonly fields?: Readonly<Record<string, JsonValue>>
}

interface Failure extends Report {
  readonly failureCode: string
}

type Outcome = { readonly ok: true; readonly report: Report } | { readonly ok: false; readonly failure: Failure }

const succeeded = (report: Report): Outcome => ({ ok: true, report })

const failed = (failure: Failure): Outcome => ({ ok: false, failure })

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

const manifestPath = (directory: string, name: string): string => join(directory, '.claude-plugin', name)

const readManifest = <S extends z.ZodType>(path: string, schema: S): z.output<S> | undefined => {
  const parsed = schema.safeParse(parseJson(readText(path)))
  return parsed.success ? parsed.data : undefined
}

const splitPluginId = (id: string): readonly [string, string] => {
  const separator = id.lastIndexOf('@')
  return separator < 0 ? [id, ''] : [id.slice(0, separator), id.slice(separator + 1)]
}

const addMarketplace = (registry: Registry, source: string): Outcome => {
  const command = 'marketplace-add'
  const directory = resolve(source)
  if (!isDirectory(directory)) {
    return failed({ command, message: `Path does not exist: ${directory}`, failureCode: 'invalid_source' })
  }
  const path = manifestPath(directory, 'marketplace.json')
  if (readText(path) === undefined) {
    return failed({ command, message: `Marketplace file not found at ${path}`, failureCode: 'manifest_missing' })
  }
  const manifest = readManifest(path, MarketplaceManifest)
  if (manifest === undefined) {
    return failed({ command, message: `Invalid marketplace manifest at ${path}`, failureCode: 'manifest_invalid' })
  }
  registry.marketplaces[manifest.name] = directory
  return succeeded({
    command,
    message: `Successfully added marketplace: ${manifest.name} (declared in user settings)`,
    fields: { marketplace: manifest.name },
  })
}

const removeMarketplace = (registry: Registry, name: string): Outcome => {
  const command = 'marketplace-remove'
  if (registry.marketplaces[name] === undefined) {
    return failed({
      command,
      message: `Marketplace '${name}' not found`,
      failureCode: 'not_configured',
      fields: { marketplace: name },
    })
  }
  Reflect.deleteProperty(registry.marketplaces, name)
  return succeeded({ command, message: `Successfully removed marketplace: ${name}`, fields: { marketplace: name } })
}

const install = (registry: Registry, id: string): Outcome => {
  const command = 'install'
  const [name, marketplace] = splitPluginId(id)
  const directory = registry.marketplaces[marketplace]
  const catalog =
    directory === undefined
      ? undefined
      : readManifest(manifestPath(directory, 'marketplace.json'), MarketplaceManifest)
  const entry = catalog?.plugins.find((plugin) => plugin.name === name)
  if (directory === undefined || entry === undefined) {
    return failed({
      command,
      message: `Plugin "${name}" not found in marketplace "${marketplace}".`,
      failureCode: 'not_found',
      fields: { plugin: id, scope: 'user' },
    })
  }
  const manifest = readManifest(manifestPath(resolve(directory, entry.source), 'plugin.json'), PluginManifest)
  if (manifest?.name !== name) {
    return failed({
      command,
      message: `Plugin "${name}" has no valid plugin.json`,
      failureCode: 'manifest_invalid',
      fields: { plugin: id, scope: 'user' },
    })
  }
  registry.plugins[id] = { enabled: true, version: manifest.version ?? 'unknown' }
  return succeeded({
    command,
    message: `Successfully installed plugin: ${id} (scope: user)`,
    fields: { plugin: id, pluginId: id, scope: 'user' },
  })
}

const uninstall = (registry: Registry, id: string): Outcome => {
  const command = 'uninstall'
  if (registry.plugins[id] === undefined) {
    return failed({
      command,
      message: `Plugin "${id}" not found in installed plugins`,
      failureCode: 'not_installed',
      fields: { plugin: id, scope: 'user' },
    })
  }
  Reflect.deleteProperty(registry.plugins, id)
  return succeeded({
    command,
    message: `Successfully uninstalled plugin: ${splitPluginId(id)[0]} (scope: user)`,
    fields: { plugin: id, pluginId: id, scope: 'user', keptData: false },
  })
}

const disable = (registry: Registry, id: string): Outcome => {
  const command = 'disable'
  const installed = registry.plugins[id]
  if (installed?.enabled !== true) {
    return failed({
      command,
      message:
        installed === undefined
          ? `Plugin "${id}" not found in installed plugins`
          : `Plugin "${id}" is already disabled at user scope`,
      failureCode: installed === undefined ? 'not_installed' : 'already_in_goal_state',
      fields: { plugin: id, scope: 'user' },
    })
  }
  installed.enabled = false
  return succeeded({
    command,
    message: `Successfully disabled plugin: ${splitPluginId(id)[0]} (scope: user)`,
    fields: { plugin: id, pluginId: id, scope: 'user' },
  })
}

const listing = (registry: Registry): JsonValue =>
  Object.entries(registry.plugins).map(([id, plugin]) => ({
    id,
    version: plugin.version,
    scope: 'user',
    enabled: plugin.enabled,
    projectEnabled: false,
  }))

const pluginCommand = (positionals: readonly string[]): ClaudePluginCommand | undefined => {
  const [subcommand, action] = positionals
  if (subcommand === 'marketplace') {
    if (action === 'add') {
      return 'marketplace-add'
    }
    return action === 'remove' || action === 'rm' ? 'marketplace-remove' : undefined
  }
  switch (subcommand) {
    case 'install':
    case 'i':
      return 'install'
    case 'uninstall':
    case 'remove':
      return 'uninstall'
    case 'disable':
      return 'disable'
    case 'list':
      return 'list'
    default:
      return undefined
  }
}

const target = (command: ClaudePluginCommand, positionals: readonly string[]): string =>
  (command === 'marketplace-add' || command === 'marketplace-remove' ? positionals[2] : positionals[1]) ?? ''

const apply = (registry: Registry, command: Exclude<ClaudePluginCommand, 'list'>, argument: string): Outcome => {
  switch (command) {
    case 'marketplace-add':
      return addMarketplace(registry, argument)
    case 'marketplace-remove':
      return removeMarketplace(registry, argument)
    case 'install':
      return install(registry, argument)
    case 'uninstall':
      return uninstall(registry, argument)
    case 'disable':
      return disable(registry, argument)
  }
}

const respond = (outcome: Outcome, json: boolean): void => {
  if (outcome.ok) {
    const { command, message, fields } = outcome.report
    if (json) {
      emit({ command, outcome: 'ok', ...fields, message })
    } else {
      say(process.stdout, `✔ ${message}`)
    }
    finish(0)
    return
  }
  const { command, message, failureCode, fields } = outcome.failure
  if (json) {
    emit({ command, outcome: 'failed', ...fields, message, failureCode })
  }
  say(process.stderr, `✘ ${message}`)
  finish(1)
}

export const emulatePluginCommand = (
  state: string,
  argv: readonly string[],
  failures: readonly ClaudePluginCommand[],
): void => {
  const parsed = parseOptions(argv, pluginOptions)
  const command = parsed.ok ? pluginCommand(parsed.options.positionals) : undefined
  if (!parsed.ok || command === undefined) {
    const emulated = 'plugin marketplace add/remove, install, uninstall, disable and list'
    say(process.stderr, scenarioMessage('claude', `only ${emulated} are emulated`))
    finish(fakeCliExitCodes.scenario)
    return
  }
  const json = parsed.options.flags.has('json')
  if (failures.includes(command)) {
    respond(failed({ command, message: scenarioMessage('claude', `${command} fails`), failureCode: 'scenario' }), json)
    return
  }
  const registry = readStateDocument(state, registryDocument, Registry)
  if (command === 'list') {
    say(process.stdout, JSON.stringify(listing(registry), null, 2))
    finish(0)
    return
  }
  const outcome = apply(registry, command, target(command, parsed.options.positionals))
  if (outcome.ok) {
    writeStateDocument(state, registryDocument, registry)
  }
  respond(outcome, json)
}
