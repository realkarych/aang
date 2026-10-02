import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'
import { Config, defaultConfig } from './config.js'
import type { Runtime } from './primitives.js'

export const configFileName = 'config.json'

export interface ConfigEnvironment {
  readonly env: Readonly<Partial<Record<string, string>>>
  readonly homedir: string
}

export interface LoadedConfig {
  readonly aangHome: string
  readonly path: string
  readonly exists: boolean
  readonly config: Config
  readonly runtimeRoots: Readonly<Record<Runtime, string>>
}

export class ConfigError extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
  ) {
    super(`${path}: ${reason}`)
    this.name = 'ConfigError'
  }
}

export const processEnvironment = (): ConfigEnvironment => ({ env: process.env, homedir: homedir() })

const variable = (value: string | undefined): string | undefined => (value === '' ? undefined : value)

export const resolveAangHome = ({ env, homedir }: ConfigEnvironment): string =>
  resolve(variable(env.AANG_HOME) ?? join(homedir, '.aang'))

export const resolveRuntimeRoots = (config: Config, { env, homedir }: ConfigEnvironment): Record<Runtime, string> => ({
  claude: config.runtimes.claude.configDir ?? resolve(variable(env.CLAUDE_CONFIG_DIR) ?? join(homedir, '.claude')),
  codex: config.runtimes.codex.home ?? resolve(variable(env.CODEX_HOME) ?? join(homedir, '.codex')),
})

interface ConfiguredPath {
  readonly at: PropertyKey[]
  readonly value: string | null
}

const configuredPaths = (config: Config): ConfiguredPath[] => [
  { at: ['runtimes', 'claude', 'configDir'], value: config.runtimes.claude.configDir },
  { at: ['runtimes', 'codex', 'home'], value: config.runtimes.codex.home },
  { at: ['cli', 'claude'], value: config.cli.claude },
  { at: ['cli', 'codex'], value: config.cli.codex },
  ...config.watch.roots.map((root, index) => ({ at: ['watch', 'roots', index, 'path'], value: root.path })),
]

const LocalConfig = Config.superRefine((config, context) => {
  for (const { at, value } of configuredPaths(config)) {
    if (value !== null && !isAbsolute(value)) {
      context.addIssue({ code: 'custom', path: at, message: 'must be an absolute path' })
    }
  }
})

const isMissing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT'

const readSource = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (isMissing(error)) {
      return undefined
    }
    throw error
  }
}

const parseDocument = (path: string, source: string): unknown => {
  try {
    return JSON.parse(source.replace(/^\uFEFF/, ''))
  } catch (error) {
    throw new ConfigError(path, `invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const parseConfig = (path: string, source: string): Config => {
  const result = LocalConfig.safeParse(parseDocument(path, source))
  if (!result.success) {
    throw new ConfigError(path, z.prettifyError(result.error))
  }
  return result.data
}

export const loadConfig = async (environment: ConfigEnvironment): Promise<LoadedConfig> => {
  const aangHome = resolveAangHome(environment)
  const path = join(aangHome, configFileName)
  const source = await readSource(path)
  const config = source === undefined ? defaultConfig() : parseConfig(path, source)
  return {
    aangHome,
    path,
    exists: source !== undefined,
    config,
    runtimeRoots: resolveRuntimeRoots(config, environment),
  }
}
