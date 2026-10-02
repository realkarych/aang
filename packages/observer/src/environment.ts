import { accessSync, closeSync, constants, existsSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, parse, resolve } from 'node:path'
import type { Runtime } from '@aang/contract'
import type { CliCommand } from './process.js'

export type InheritedEnvironment = Readonly<Record<string, string | undefined>>

const environmentValue = (env: InheritedEnvironment, name: string): string | undefined =>
  Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]

export const cleanEnvironment = (runtime: Runtime, source: InheritedEnvironment): Record<string, string> => {
  const windows = process.platform === 'win32'
  const names = windows
    ? ['USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'TEMP', 'TMP', 'USERNAME']
    : ['HOME', 'USER', 'LOGNAME', 'LANG']
  const environment: Record<string, string> = {}
  for (const name of names) {
    const value = windows ? environmentValue(source, name) : source[name]
    if (value !== undefined) environment[name] = value
  }
  const systemRoot = environment.SystemRoot ?? 'C:\\Windows'
  environment.PATH = windows ? [join(systemRoot, 'System32'), systemRoot, join(systemRoot, 'System32', 'Wbem')].join(';') : '/usr/bin:/bin'
  environment.AANG_OBSERVER = '1'
  if (runtime === 'claude') Object.assign(environment, {
    CLAUDE_CODE_ENTRYPOINT: 'aang-observer',
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    DISABLE_AUTOUPDATER: '1',
  })
  else environment.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = 'aang_observer'
  return environment
}

const executable = (path: string): boolean => {
  try {
    accessSync(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
    return statSync(path).isFile()
  } catch { return false }
}

const envNodeScript = (path: string): boolean => {
  const file = openSync(path, 'r')
  try {
    const prefix = Buffer.alloc(128)
    const length = readSync(file, prefix, 0, prefix.length, 0)
    return /^#![ \t]*\/usr\/bin\/env[ \t]+node[ \t]*(?:\r?\n|$)/.test(prefix.toString('utf8', 0, length))
  } finally { closeSync(file) }
}

export const resolveCli = (runtime: Runtime, cli: string | CliCommand, env: InheritedEnvironment): CliCommand => {
  if (typeof cli !== 'string') {
    if (!isAbsolute(cli.command) || !executable(cli.command) || /\.(cmd|bat|ps1)$/i.test(cli.command)) throw new Error('CLI must be an absolute executable path')
    return cli
  }
  const windows = process.platform === 'win32'
  const suffixes = windows ? ['.exe', '.cmd', '.ps1', ''] : ['']
  const candidates = isAbsolute(cli) ? [cli] : (environmentValue(env, 'PATH') ?? '').split(delimiter).filter(Boolean).flatMap((directory) => suffixes.map((suffix) => resolve(directory, cli + suffix)))
  const path = candidates.find(executable)
  if (path === undefined) throw new Error(`CLI not found: ${cli}`)
  const command = realpathSync(path)
  if (!windows) return envNodeScript(command) ? { command: process.execPath, args: [command] } : { command }
  if (/\.(exe|com)$/i.test(command)) return { command }
  const native = join(dirname(path), `${runtime}.exe`)
  if (executable(native)) return { command: realpathSync(native) }
  if (runtime === 'codex') {
    const script = join(dirname(path), 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
    if (existsSync(script)) return { command: process.execPath, args: [realpathSync(script)] }
  }
  throw new Error(`No native executable for ${path}`)
}

const checkAncestors = (directory: string): void => {
  let ancestor = directory
  for (;;) {
    if (['CLAUDE.md', 'AGENTS.md'].some((name) => existsSync(join(ancestor, name)))) throw new Error(`Instructions in observer directory ancestry: ${ancestor}`)
    if (ancestor === parse(ancestor).root) return
    ancestor = dirname(ancestor)
  }
}

export const prepareWorkspace = (temporaryDirectory = tmpdir()): string => {
  const directory = resolve(temporaryDirectory, 'aang-observer', 'empty')
  checkAncestors(directory)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  checkAncestors(realpathSync(directory))
  if (readdirSync(directory).length > 0) throw new Error('Observer working directory must be empty')
  return directory
}
