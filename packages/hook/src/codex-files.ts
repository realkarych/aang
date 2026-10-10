import { createHash } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { codexHookCommand, isAangCommand } from './codex-command.js'
import { isErrorCode, jsonText, replaceFile } from './files.js'
import { hookInstallPaths } from './layout.js'

export type JsonObject = Record<string, unknown>

export const codexHooksFileName = 'hooks.json'
const codexConfigFileName = 'config.toml'
const recordMode = 0o600

export const CodexHooksStatus = z.enum(['not_installed', 'untrusted', 'inactive', 'active'])
export type CodexHooksStatus = z.infer<typeof CodexHooksStatus>

export interface CodexHooksCheck {
  readonly status: CodexHooksStatus
  readonly fingerprint: string | null
}

export interface CodexHooksFiles {
  readonly unregistered: boolean
  readonly fingerprint: string
}

const CodexHooksRecord = z.strictObject({
  codex_home: z.string(),
  command: z.string(),
  fingerprint: z.string(),
  status: CodexHooksStatus,
})

export const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const aangHandlers = (groups: unknown): JsonObject[] =>
  (Array.isArray(groups) ? groups : [])
    .flatMap((group: unknown) => (isObject(group) && Array.isArray(group.hooks) ? (group.hooks as unknown[]) : []))
    .filter(
      (handler): handler is JsonObject =>
        isObject(handler) &&
        handler.type === 'command' &&
        typeof handler.command === 'string' &&
        isAangCommand(handler.command),
    )

const readOptional = (path: string): Promise<Buffer | null> =>
  readFile(path).catch((error: unknown) => {
    if (isErrorCode(error, 'ENOENT')) {
      return null
    }
    throw error
  })

const digest = (content: Buffer | null): string =>
  content === null ? 'absent' : createHash('sha256').update(content).digest('hex')

const parsed = (content: Buffer): unknown => {
  try {
    return JSON.parse(content.toString('utf8').replace(/^\uFEFF/, ''))
  } catch {
    return undefined
  }
}

const lacksCommand = (content: Buffer | null, command: string): boolean => {
  if (content === null) {
    return true
  }
  const document = parsed(content)
  if (!isObject(document)) {
    return false
  }
  const hooks = document.hooks ?? {}
  return (
    isObject(hooks) &&
    Object.values(hooks).every(
      (groups) => Array.isArray(groups) && aangHandlers(groups).every((handler) => handler.command !== command),
    )
  )
}

export const readCodexHooksFiles = async (aangHome: string, codexHome: string): Promise<CodexHooksFiles> => {
  const home = resolve(codexHome)
  const [hooks, config] = await Promise.all([
    readOptional(join(home, codexHooksFileName)),
    readOptional(join(home, codexConfigFileName)),
  ])
  return { unregistered: lacksCommand(hooks, codexHookCommand(aangHome)), fingerprint: `${digest(hooks)}:${digest(config)}` }
}

export const unchangedFingerprint = async (aangHome: string, codexHome: string, files: CodexHooksFiles): Promise<string | null> =>
  (await readCodexHooksFiles(aangHome, codexHome)).fingerprint === files.fingerprint ? files.fingerprint : null

export const writeCodexHooksRecord = (aangHome: string, codexHome: string, check: CodexHooksCheck): Promise<void> => {
  const path = hookInstallPaths(aangHome).codexHooksRecord
  if (check.fingerprint === null) {
    return rm(path, { force: true })
  }
  const record: z.input<typeof CodexHooksRecord> = {
    codex_home: resolve(codexHome),
    command: codexHookCommand(aangHome),
    fingerprint: check.fingerprint,
    status: check.status,
  }
  return replaceFile(path, jsonText(record), recordMode)
}

export const readCodexHooksRecord = async (aangHome: string, codexHome: string): Promise<CodexHooksCheck | null> => {
  const content = await readOptional(hookInstallPaths(aangHome).codexHooksRecord)
  const record = content === null ? undefined : CodexHooksRecord.safeParse(parsed(content)).data
  return record === undefined || record.codex_home !== resolve(codexHome) || record.command !== codexHookCommand(aangHome)
    ? null
    : { status: record.status, fingerprint: record.fingerprint }
}
