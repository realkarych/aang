import { randomBytes } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, rm, stat } from 'node:fs/promises'
import { dirname, join, posix, resolve } from 'node:path'
import type { RegistrationTag, Runtime } from '@aang/contract'
import { deployHookBinary } from './binary.js'
import { HookInstallError, requireHookInstallSupport } from './errors.js'
import {
  createFileExclusively,
  hasContent,
  isErrorCode,
  jsonText,
  withStagedFile,
  writeNewFile,
} from './files.js'
import { hookInstallPaths } from './layout.js'
import { acquireLock } from './lock.js'
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
const lockSuffix = '.aang-lock'
const hookBinaryNames: readonly string[] = ['aang-hook', 'aang-hook.exe']
const newHooksFileMode = 0o600
const hooksFileAttempts = 5

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

interface ExistingHooksFile {
  readonly content: Buffer
  readonly mode: number
  readonly version: BigIntStats
}

interface HooksFile {
  readonly path: string
  readonly target: string
  readonly existing: ExistingHooksFile | null
}

interface HooksDocument {
  readonly root: JsonObject
  readonly hooks: JsonObject
}

interface LoadedHooks {
  readonly file: HooksFile
  readonly document: HooksDocument
}

type SaveOutcome = { readonly saved: true; readonly backup: string | null } | { readonly saved: false }

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

const invalid = (path: string, problem: string): HookInstallError =>
  new HookInstallError('invalid_hooks_file', `${path}: ${problem}; the file is left unchanged`)

const exists = (path: string): Promise<boolean> =>
  lstat(path).then(
    () => true,
    (error: unknown) => {
      if (isErrorCode(error, 'ENOENT')) {
        return false
      }
      throw error
    },
  )

const readExisting = async (target: string): Promise<ExistingHooksFile> => {
  const handle = await open(target, 'r')
  try {
    const version = await handle.stat({ bigint: true })
    return { content: await handle.readFile(), mode: Number(version.mode & 0o777n), version }
  } finally {
    await handle.close()
  }
}

const isCurrentVersion = async (path: string, version: BigIntStats): Promise<boolean> => {
  const current = await stat(path, { bigint: true }).catch(() => undefined)
  return (
    current !== undefined &&
    current.dev === version.dev &&
    current.ino === version.ino &&
    current.size === version.size &&
    current.mtimeNs === version.mtimeNs
  )
}

const readHooksFile = async (codexHome: string): Promise<HooksFile> => {
  const path = join(resolve(codexHome), hooksFileName)
  try {
    const target = await realpath(path)
    return { path, target, existing: await readExisting(target) }
  } catch (error) {
    if (!isErrorCode(error, 'ENOENT')) {
      throw error
    }
  }
  if (await exists(path)) {
    throw invalid(path, 'a symlink to a missing file')
  }
  return { path, target: path, existing: null }
}

const parseDocument = (file: HooksFile): unknown => {
  try {
    return JSON.parse(file.existing?.content.toString('utf8').replace(/^\uFEFF/, '') ?? '{}')
  } catch (error) {
    throw invalid(file.path, `invalid JSON (${error instanceof Error ? error.message : String(error)})`)
  }
}

const readHooksDocument = (file: HooksFile): HooksDocument => {
  const root = parseDocument(file)
  if (!isObject(root)) {
    throw invalid(file.path, 'the top level is not an object')
  }
  const hooks = root.hooks ?? {}
  if (!isObject(hooks)) {
    throw invalid(file.path, '"hooks" is not an object')
  }
  const malformed = codexHookEvents.find((event) => hooks[event] !== undefined && !Array.isArray(hooks[event]))
  if (malformed !== undefined) {
    throw invalid(file.path, `"hooks.${malformed}" is not an array`)
  }
  return { root: { ...root, hooks }, hooks }
}

const backupName = (target: string): string =>
  `${target}.aang-backup-${new Date().toISOString().replace(/[-:.]/g, '')}-${randomBytes(2).toString('hex')}`

const readHooks = async (codexHome: string): Promise<LoadedHooks> => {
  const file = await readHooksFile(codexHome)
  return { file, document: readHooksDocument(file) }
}

const saveHooksDocument = async ({ file, document }: LoadedHooks): Promise<SaveOutcome> => {
  const text = jsonText(document.root)
  if (file.existing === null) {
    const created = await createFileExclusively(file.target, text, newHooksFileMode)
    return created ? { saved: true, backup: null } : { saved: false }
  }
  const { content, mode, version } = file.existing
  const backup = backupName(file.target)
  await writeNewFile(backup, content, mode)
  const replaced = await withStagedFile(file.target, text, mode, async (staged) => {
    if (!(await hasContent(file.target, content)) || !(await isCurrentVersion(file.target, version))) {
      return false
    }
    await rename(staged, file.target)
    return true
  })
  if (!replaced) {
    await rm(backup, { force: true })
    return { saved: false }
  }
  return { saved: true, backup }
}

const changeHooksFile = async (
  codexHome: string,
  initial: LoadedHooks,
  change: (document: HooksDocument) => boolean,
): Promise<string | null> => {
  if (!change(initial.document)) {
    return null
  }
  const { path, target } = initial.file
  await mkdir(dirname(target), { recursive: true })
  const unlock = await acquireLock(`${target}${lockSuffix}`, `another change of ${path}`)
  try {
    for (let attempt = 1; attempt <= hooksFileAttempts; attempt += 1) {
      const loaded = await readHooks(codexHome)
      if (!change(loaded.document)) {
        return null
      }
      const outcome = await saveHooksDocument(loaded)
      if (outcome.saved) {
        return outcome.backup
      }
    }
  } finally {
    await unlock()
  }
  throw new HookInstallError(
    'hooks_file_changed',
    `${path}: another program kept changing the file; it is left as that program wrote it`,
  )
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
  const initial = await readHooks(codexHome)
  const binary = await deployHookBinary({ aangHome, hookBinarySource })
  const command = [posixQuote(binary), runtime, registration, posixQuote(hookInstallPaths(aangHome).spool)].join(' ')
  const backup = await changeHooksFile(codexHome, initial, (document) => registerAang(document, command))
  return { binary, command, hooksFile: initial.file.path, backup }
}

export const uninstallCodexHooks = async ({ codexHome }: CodexHooksOptions): Promise<CodexHooksChange> => {
  requireHookInstallSupport()
  const initial = await readHooks(codexHome)
  const backup = await changeHooksFile(codexHome, initial, neutralizeAang)
  return { hooksFile: initial.file.path, backup }
}
