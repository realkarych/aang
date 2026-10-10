import { randomBytes } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { deployHookBinary } from './binary.js'
import { type CodexAppServerOptions, listCodexHooks } from './codex-app-server.js'
import { codexHookCommand } from './codex-command.js'
import {
  aangHandlers,
  codexHooksFileName,
  type CodexHooksStatus,
  isObject,
  type JsonObject,
  readCodexHooksFiles,
  unchangedFingerprint,
  writeCodexHooksRecord,
} from './codex-files.js'
import { codexHooksStateOf, verifyForeignTrust } from './codex-state.js'
import { HookInstallError } from './errors.js'
import {
  createFileExclusively,
  hasContent,
  isErrorCode,
  jsonText,
  withStagedFile,
  writeNewFile,
} from './files.js'
import { hookInstallPaths } from './layout.js'
import { acquireLock, type Unlock } from './lock.js'

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

const hookTimeoutSeconds = 2
const neutralCommand = process.platform === 'win32' ? 'exit 0' : 'true'
const lockSuffix = '.aang-lock'
const newHooksFileMode = 0o600
const hooksFileAttempts = 5

export interface CodexHooksOptions {
  readonly codexHome: string
}

export interface CodexHooksInstallOptions extends CodexAppServerOptions {
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
  readonly status: CodexHooksStatus
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

type Attempt<R> = (loaded: LoadedHooks) => Promise<{ readonly done: R } | null>

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
  const path = join(resolve(codexHome), codexHooksFileName)
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

const rollbackHooks = async (loaded: LoadedHooks, backup: string | null): Promise<void> => {
  const { file, document } = loaded
  const saved = Buffer.from(jsonText(document.root))
  const version = await stat(file.target, { bigint: true }).catch(() => undefined)
  const restore = async (staged?: string): Promise<void> => {
    if (version === undefined || !(await hasContent(file.target, saved)) || !(await isCurrentVersion(file.target, version))) {
      throw new HookInstallError(
        'hooks_file_changed',
        `${file.path}: another program changed the file after installation; its changes are preserved${backup === null ? '' : `; restore from ${backup} after review`}`,
      )
    }
    if (staged === undefined) {
      await rm(file.target)
    } else {
      await rename(staged, file.target)
    }
  }
  if (file.existing === null) {
    await restore()
  } else {
    await withStagedFile(file.target, file.existing.content, file.existing.mode, restore)
  }
}

const hooksLock = (file: HooksFile, signal?: AbortSignal): Promise<Unlock> =>
  acquireLock(`${file.target}${lockSuffix}`, `another change or check of ${file.path}`, signal)

const changeHooksFile = async <R>(codexHome: string, file: HooksFile, attempt: Attempt<R>): Promise<R> => {
  await mkdir(dirname(file.target), { recursive: true })
  const unlock = await hooksLock(file)
  try {
    for (let attempted = 1; attempted <= hooksFileAttempts; attempted += 1) {
      const outcome = await attempt(await readHooks(codexHome))
      if (outcome !== null) {
        return outcome.done
      }
    }
  } finally {
    await unlock()
  }
  throw new HookInstallError(
    'hooks_file_changed',
    `${file.path}: another program kept changing the file; it is left as that program wrote it`,
  )
}

export const withCodexHooksLock = async <T>(codexHome: string, signal: AbortSignal | undefined, use: () => Promise<T>): Promise<T> => {
  const unlock = await hooksLock(await readHooksFile(codexHome), signal)
  try {
    return await use()
  } finally {
    await unlock()
  }
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

export const installCodexHooks = async (options: CodexHooksInstallOptions): Promise<CodexHooksInstallation> => {
  const { aangHome, codexHome } = options
  const initial = await readHooks(codexHome)
  const binary = hookInstallPaths(aangHome).binary
  const command = codexHookCommand(aangHome)
  const list = () => listCodexHooks(options, options.hookBinarySource)
  const { backup, status } = await changeHooksFile(codexHome, initial.file, async (loaded) => {
    const before = await list()
    await deployHookBinary(options)
    const changed = registerAang(loaded.document, command)
    const outcome: SaveOutcome = changed ? await saveHooksDocument(loaded) : { saved: true, backup: null }
    if (!outcome.saved) {
      return null
    }
    try {
      const files = await readCodexHooksFiles(aangHome, codexHome)
      const after = await list()
      verifyForeignTrust(before, after)
      const check = {
        status: codexHooksStateOf(after, aangHome).status,
        fingerprint: await unchangedFingerprint(aangHome, codexHome, files),
      }
      await writeCodexHooksRecord(aangHome, codexHome, check)
      return { done: { backup: outcome.backup, status: check.status } }
    } catch (error) {
      if (changed) {
        await rollbackHooks(loaded, outcome.backup)
      }
      throw error
    }
  })
  return { binary, command, hooksFile: initial.file.path, backup, status }
}

export const uninstallCodexHooks = async ({ codexHome }: CodexHooksOptions): Promise<CodexHooksChange> => {
  const initial = await readHooks(codexHome)
  const backup = neutralizeAang(initial.document)
    ? await changeHooksFile(codexHome, initial.file, async (loaded) => {
        if (!neutralizeAang(loaded.document)) {
          return { done: null }
        }
        const outcome = await saveHooksDocument(loaded)
        return outcome.saved ? { done: outcome.backup } : null
      })
    : null
  return { hooksFile: initial.file.path, backup }
}
