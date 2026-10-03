import { chmod, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { CodexRegistration } from './state.js'
import { posixQuote } from './shell.js'

export const codexHookEvents: readonly string[] = [
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
const neutralCommand = 'true'
const newFileMode = 0o600
const byteOrderMark = new RegExp(`^${String.fromCharCode(0xfeff)}`)

type JsonObject = Record<string, unknown>

interface HooksFile {
  readonly target: string
  readonly original: Buffer | null
  readonly mode: number
}

interface HooksDocument {
  readonly root: JsonObject
  readonly hooks: JsonObject
}

export interface CodexHooksPlan {
  readonly registration: CodexRegistration
  readonly file: HooksFile
  readonly text: string
}

export interface CodexHooksRemoval {
  readonly removed: number
  readonly neutralized: number
  readonly deletedFile: boolean
  readonly missingFile: boolean
}

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isMissing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT'

export const codexHookCommand = (hookBinary: string, spool: string): string =>
  [posixQuote(hookBinary), 'codex', 'user', posixQuote(spool)].join(' ')

const readHooksFile = async (path: string): Promise<HooksFile> => {
  let target = path
  try {
    target = await realpath(path)
  } catch (error) {
    if (!isMissing(error)) {
      throw error
    }
    return { target, original: null, mode: newFileMode }
  }
  const [original, stats] = await Promise.all([readFile(target), stat(target)])
  return { target, original, mode: stats.mode & 0o777 }
}

const parseDocument = (path: string, file: HooksFile): HooksDocument => {
  let root: unknown
  try {
    root = JSON.parse(file.original?.toString('utf8').replace(byteOrderMark, '') ?? '{}')
  } catch (error) {
    throw new Error(
      `${path}: некорректный JSON (${error instanceof Error ? error.message : String(error)}); файл не изменён`,
      { cause: error },
    )
  }
  if (!isObject(root)) {
    throw new Error(`${path}: верхний уровень не объект; файл не изменён`)
  }
  const hooks = root.hooks ?? {}
  if (!isObject(hooks)) {
    throw new Error(`${path}: "hooks" не объект; файл не изменён`)
  }
  const malformed = codexHookEvents.find((event) => hooks[event] !== undefined && !Array.isArray(hooks[event]))
  if (malformed !== undefined) {
    throw new Error(`${path}: "hooks.${malformed}" не массив; файл не изменён`)
  }
  root.hooks = hooks
  return { root, hooks }
}

const handlersOf = (group: unknown): unknown[] =>
  isObject(group) && Array.isArray(group.hooks) ? (group.hooks as unknown[]) : []

const isOurHandler = (handler: unknown, command: string): handler is JsonObject =>
  isObject(handler) && handler.type === 'command' && handler.command === command

const isOurGroup = (group: unknown, command: string): boolean => {
  const handlers = handlersOf(group)
  return handlers.length > 0 && handlers.every((handler) => isOurHandler(handler, command))
}

const groupsOf = (hooks: JsonObject, event: string): unknown[] => {
  const groups = hooks[event]
  return Array.isArray(groups) ? (groups as unknown[]) : []
}

const backupStamp = (): string => new Date().toISOString().replace(/[-:.]/g, '')

const documentText = (root: JsonObject): string => `${JSON.stringify(root, null, 2)}\n`

export const planCodexHooks = async (codexHome: string, command: string): Promise<CodexHooksPlan> => {
  const hooksFile = join(codexHome, 'hooks.json')
  const file = await readHooksFile(hooksFile)
  const { root, hooks } = parseDocument(hooksFile, file)
  const createdEvents: string[] = []
  for (const event of codexHookEvents) {
    if (hooks[event] === undefined) {
      hooks[event] = []
      createdEvents.push(event)
    }
    const groups = groupsOf(hooks, event)
    if (!groups.some((group) => handlersOf(group).some((handler) => isOurHandler(handler, command)))) {
      groups.push({ hooks: [{ type: 'command', command, timeout: hookTimeoutSeconds }] })
    }
  }
  return {
    registration: {
      codexHome,
      hooksFile,
      command,
      createdFile: file.original === null,
      createdEvents,
      backup: file.original === null ? null : `${file.target}.aang-d7-backup-${backupStamp()}`,
    },
    file,
    text: documentText(root),
  }
}

const replaceContent = async (file: HooksFile, text: string | Buffer): Promise<void> => {
  const staged = `${file.target}.aang-d7-${String(process.pid)}.tmp`
  try {
    await writeFile(staged, text, { flag: 'wx', mode: newFileMode })
    await chmod(staged, file.mode)
    const current = await readFile(file.target).catch(() => null)
    if (file.original !== null && (current === null || !current.equals(file.original))) {
      throw new Error(`${file.target}: файл изменился во время записи; повторите команду`)
    }
    await rename(staged, file.target)
  } finally {
    await rm(staged, { force: true })
  }
}

export const applyCodexHooks = async ({ registration, file, text }: CodexHooksPlan): Promise<void> => {
  await mkdir(dirname(file.target), { recursive: true })
  if (file.original === null) {
    try {
      await writeFile(file.target, text, { flag: 'wx', mode: newFileMode })
    } catch (error) {
      throw new Error(`${file.target}: файл появился во время подготовки; повторите команду`, { cause: error })
    }
    return
  }
  if (registration.backup !== null) {
    await writeFile(registration.backup, file.original, { flag: 'wx', mode: newFileMode })
    await chmod(registration.backup, file.mode)
  }
  await replaceContent(file, text)
}

const removeFromEvent = (groups: unknown[], command: string): { removed: number; neutralized: number } => {
  let removed = 0
  let neutralized = 0
  while (groups.length > 0 && isOurGroup(groups.at(-1), command)) {
    groups.pop()
    removed += 1
  }
  for (const group of groups) {
    for (const handler of handlersOf(group)) {
      if (isOurHandler(handler, command)) {
        handler.command = neutralCommand
        neutralized += 1
      }
    }
  }
  return { removed, neutralized }
}

const restoredText = async (backup: string | null, root: JsonObject): Promise<string | Buffer> => {
  const original = backup === null ? null : await readFile(backup).catch(() => null)
  if (original === null) {
    return documentText(root)
  }
  try {
    const parsed: unknown = JSON.parse(original.toString('utf8').replace(byteOrderMark, ''))
    return isDeepStrictEqual(parsed, root) ? original : documentText(root)
  } catch {
    return documentText(root)
  }
}

export const removeCodexHooks = async (registration: CodexRegistration): Promise<CodexHooksRemoval> => {
  const file = await readHooksFile(registration.hooksFile)
  if (file.original === null) {
    return { removed: 0, neutralized: 0, deletedFile: false, missingFile: true }
  }
  const { root, hooks } = parseDocument(registration.hooksFile, file)
  let removed = 0
  let neutralized = 0
  let deletedEvents = 0
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      continue
    }
    const change = removeFromEvent(groups as unknown[], registration.command)
    removed += change.removed
    neutralized += change.neutralized
    if (groups.length === 0 && registration.createdEvents.includes(event)) {
      Reflect.deleteProperty(hooks, event)
      deletedEvents += 1
    }
  }
  const onlyEmptyHooks = Object.keys(root).length === 1 && Object.keys(hooks).length === 0
  if (registration.createdFile && onlyEmptyHooks) {
    await rm(file.target)
    return { removed, neutralized, deletedFile: true, missingFile: false }
  }
  if (removed > 0 || neutralized > 0 || deletedEvents > 0) {
    await replaceContent(file, await restoredText(registration.backup, root))
  }
  return { removed, neutralized, deletedFile: false, missingFile: false }
}
