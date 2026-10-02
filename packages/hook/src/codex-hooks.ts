import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, mkdir, readFile, realpath, stat } from 'node:fs/promises'
import { dirname, join, posix, resolve } from 'node:path'
import type { RegistrationTag, Runtime } from '@aang/contract'
import { deployHookBinary } from './binary.js'
import { HookInstallError, requireHookInstallSupport } from './errors.js'
import { isErrorCode, jsonText, replaceFile } from './files.js'
import { hookInstallPaths } from './layout.js'
import { leadingWords, posixQuote } from './shell.js'

const codexHookEvents: readonly string[] = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PreCompact',
  'PostCompact',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'Interrupt',
]

const runtime: Runtime = 'codex'
const registration: RegistrationTag = 'user'
const hookTimeoutSeconds = 2
const neutralCommand = 'true'
const hooksFileName = 'hooks.json'
const hookBinaryNames: readonly string[] = ['aang-hook', 'aang-hook.exe']

type JsonObject = Record<string, unknown>

export interface CodexHooksOptions {
  readonly codexHome: string
}

export interface CodexHooksInstallOptions extends CodexHooksOptions {
  readonly aangHome: string
  readonly hookBinarySource: string
}

export interface CodexHooksChange {
  readonly hooksFile: string
  readonly backup: string | null
}

export interface CodexHooksInstallation extends CodexHooksChange {
  readonly binary: string
  readonly command: string
}

interface HooksFile {
  readonly path: string
  readonly target: string
  readonly existing: { readonly text: string; readonly mode: number } | null
}

interface HooksDocument {
  readonly root: JsonObject
  readonly hooks: JsonObject
}

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isAangCommand = (command: string): boolean => {
  const [program = '', subcommand] = leadingWords(command, 2)
  const name = posix.basename(program)
  return hookBinaryNames.includes(name) || (name === 'aang' && subcommand === 'hook')
}

const aangHandlers = (groups: unknown): JsonObject[] =>
  (Array.isArray(groups) ? groups : [])
    .flatMap((group: unknown) => (isObject(group) && Array.isArray(group.hooks) ? (group.hooks as unknown[]) : []))
    .filter(
      (handler): handler is JsonObject =>
        isObject(handler) &&
        handler.type === 'command' &&
        typeof handler.command === 'string' &&
        isAangCommand(handler.command),
    )

const readHooksFile = async (codexHome: string): Promise<HooksFile> => {
  const path = join(resolve(codexHome), hooksFileName)
  try {
    const target = await realpath(path)
    const [text, stats] = await Promise.all([readFile(target, 'utf8'), stat(target)])
    return { path, target, existing: { text, mode: stats.mode & 0o777 } }
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) {
      return { path, target: path, existing: null }
    }
    throw error
  }
}

const invalid = (file: HooksFile, problem: string): HookInstallError =>
  new HookInstallError('invalid_hooks_file', `${file.path}: ${problem}; the file is left unchanged`)

const parseDocument = (file: HooksFile): unknown => {
  try {
    return JSON.parse(file.existing?.text.replace(/^\uFEFF/, '') ?? '{}')
  } catch (error) {
    throw invalid(file, `invalid JSON (${error instanceof Error ? error.message : String(error)})`)
  }
}

const readHooksDocument = (file: HooksFile): HooksDocument => {
  const root = parseDocument(file)
  if (!isObject(root)) {
    throw invalid(file, 'the top level is not an object')
  }
  const hooks = root.hooks ?? {}
  if (!isObject(hooks)) {
    throw invalid(file, '"hooks" is not an object')
  }
  const malformed = codexHookEvents.find((event) => hooks[event] !== undefined && !Array.isArray(hooks[event]))
  if (malformed !== undefined) {
    throw invalid(file, `"hooks.${malformed}" is not an array`)
  }
  return { root: { ...root, hooks }, hooks }
}

const backupName = (target: string): string =>
  `${target}.aang-backup-${new Date().toISOString().replace(/[-:.]/g, '')}-${randomBytes(2).toString('hex')}`

const saveHooksDocument = async (file: HooksFile, { root }: HooksDocument): Promise<string | null> => {
  const backup = file.existing === null ? null : backupName(file.target)
  if (backup === null) {
    await mkdir(dirname(file.target), { recursive: true })
  } else {
    await copyFile(file.target, backup, constants.COPYFILE_EXCL)
  }
  await replaceFile(file.target, jsonText(root), file.existing?.mode ?? 0o600)
  return backup
}

const aangGroup = (command: string): JsonObject => ({
  hooks: [{ type: 'command', command, timeout: hookTimeoutSeconds }],
})

const registerAang = ({ hooks }: HooksDocument, command: string): boolean => {
  let changed = false
  for (const [event, groups] of Object.entries(hooks)) {
    let registered = false
    for (const handler of aangHandlers(groups)) {
      if (handler.command === command && !registered) {
        registered = true
      } else {
        handler.command = neutralCommand
        changed = true
      }
    }
    if (codexHookEvents.includes(event) && !registered && Array.isArray(groups)) {
      groups.push(aangGroup(command))
      changed = true
    }
  }
  for (const event of codexHookEvents.filter((name) => hooks[name] === undefined)) {
    hooks[event] = [aangGroup(command)]
    changed = true
  }
  return changed
}

const neutralizeAang = ({ hooks }: HooksDocument): boolean => {
  const handlers = Object.values(hooks).flatMap(aangHandlers)
  for (const handler of handlers) {
    handler.command = neutralCommand
  }
  return handlers.length > 0
}

export const installCodexHooks = async ({
  aangHome,
  hookBinarySource,
  codexHome,
}: CodexHooksInstallOptions): Promise<CodexHooksInstallation> => {
  requireHookInstallSupport()
  const file = await readHooksFile(codexHome)
  const document = readHooksDocument(file)
  const binary = await deployHookBinary({ aangHome, hookBinarySource })
  const command = [posixQuote(binary), runtime, registration, posixQuote(hookInstallPaths(aangHome).spool)].join(' ')
  const backup = registerAang(document, command) ? await saveHooksDocument(file, document) : null
  return { binary, command, hooksFile: file.path, backup }
}

export const uninstallCodexHooks = async ({ codexHome }: CodexHooksOptions): Promise<CodexHooksChange> => {
  requireHookInstallSupport()
  const file = await readHooksFile(codexHome)
  const document = readHooksDocument(file)
  const backup = neutralizeAang(document) ? await saveHooksDocument(file, document) : null
  return { hooksFile: file.path, backup }
}
