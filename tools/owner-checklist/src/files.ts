import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'
import { encodeProjectPath } from './anonymize.js'
import { type ChecklistEvent, textField } from './events.js'

export interface RootOverrides {
  readonly claudeConfigDir?: string | undefined
  readonly codexHome?: string | undefined
  readonly claudeDesktopDir?: string | undefined
}

export interface Roots {
  readonly claudeConfigDir: string
  readonly codexHome: string
  readonly claudeDesktopDir: string | null
}

export interface ClaudeTranscript {
  readonly sessionId: string
  readonly path: string | null
  readonly projectDir: string | null
  readonly lines: number
  readonly entrypoints: Readonly<Record<string, number>>
  readonly versions: readonly string[]
  readonly compactBoundaries: number
  readonly subagentFiles: number
}

export interface CodexTurnContext {
  readonly approval_policy: unknown
  readonly sandbox_policy: unknown
  readonly workspace_roots: unknown
  readonly outside_probe_writable: boolean
}

export interface CodexRollout {
  readonly sessionId: string
  readonly path: string | null
  readonly originator: unknown
  readonly source: unknown
  readonly thread_source: unknown
  readonly parent_thread_id: unknown
  readonly cli_version: unknown
  readonly cwd: unknown
  readonly turnContexts: readonly CodexTurnContext[]
}

export interface DesktopSessionMeta {
  readonly path: string
  readonly file: string
  readonly sessionId: string | null
  readonly cliSessionId: string | null
  readonly lastSpawnRootDetected: unknown
  readonly spawnSeed: unknown
  readonly shape: unknown
}

export interface DesktopDeletedMarker {
  readonly path: string
  readonly file: string
  readonly hostSessionId: string
  readonly content: string
}

export interface SessionFiles {
  readonly claudeTranscripts: readonly ClaudeTranscript[]
  readonly codexRollouts: readonly CodexRollout[]
  readonly desktopSessions: readonly DesktopSessionMeta[]
  readonly desktopDeleted: readonly DesktopDeletedMarker[]
}

type JsonObject = Record<string, unknown>

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const localUuidPattern = /^local_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const environmentPath = (name: string): string | undefined => {
  const value = process.env[name]
  return value === undefined || value === '' ? undefined : value
}

export const resolveRoots = (overrides: RootOverrides): Roots => ({
  claudeConfigDir: overrides.claudeConfigDir ?? environmentPath('CLAUDE_CONFIG_DIR') ?? join(homedir(), '.claude'),
  codexHome: overrides.codexHome ?? environmentPath('CODEX_HOME') ?? join(homedir(), '.codex'),
  claudeDesktopDir:
    overrides.claudeDesktopDir ??
    (process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions')
      : null),
})

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isFile = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

const filesUnder = async (root: string): Promise<string[]> => {
  try {
    const entries = await readdir(root, { recursive: true, withFileTypes: true })
    return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name))
  } catch {
    return []
  }
}

const jsonLines = async (path: string): Promise<JsonObject[]> => {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return []
  }
  return text.split(/\r?\n/).flatMap((line) => {
    if (line.trim() === '') {
      return []
    }
    try {
      const value: unknown = JSON.parse(line)
      return isObject(value) ? [value] : []
    } catch {
      return []
    }
  })
}

const sessionIdsOf = (events: readonly ChecklistEvent[], runtime: string): string[] => [
  ...new Set(events.filter((event) => event.runtime === runtime).flatMap((event) => event.sessionId ?? [])),
]

const transcriptCandidates = (events: readonly ChecklistEvent[], runtime: string, sessionId: string): string[] => [
  ...new Set(
    events
      .filter((event) => event.runtime === runtime && event.sessionId === sessionId && event.event !== 'SubagentStop')
      .flatMap((event) => textField(event, 'transcript_path') ?? []),
  ),
]

const firstExisting = async (paths: readonly string[]): Promise<string | null> => {
  for (const path of paths) {
    if (await isFile(path)) {
      return path
    }
  }
  return null
}

const findClaudeTranscript = async (roots: Roots, candidates: readonly string[], sessionId: string): Promise<string | null> => {
  const direct = await firstExisting(candidates)
  if (direct !== null) {
    return direct
  }
  const projects = join(roots.claudeConfigDir, 'projects')
  const names = await readdir(projects).catch(() => [])
  return firstExisting(names.map((name) => join(projects, name, `${sessionId}.jsonl`)))
}

const countSubagentFiles = async (transcript: string, sessionId: string): Promise<number> =>
  (await filesUnder(join(dirname(transcript), sessionId, 'subagents'))).filter((path) => path.endsWith('.jsonl')).length

const inspectClaudeTranscript = async (
  roots: Roots,
  events: readonly ChecklistEvent[],
  sessionId: string,
): Promise<ClaudeTranscript> => {
  const path = await findClaudeTranscript(roots, transcriptCandidates(events, 'claude', sessionId), sessionId)
  if (path === null) {
    return { sessionId, path, projectDir: null, lines: 0, entrypoints: {}, versions: [], compactBoundaries: 0, subagentFiles: 0 }
  }
  const records = await jsonLines(path)
  const entrypoints: Record<string, number> = {}
  for (const record of records) {
    const entrypoint = typeof record.entrypoint === 'string' ? record.entrypoint : '(нет поля)'
    entrypoints[entrypoint] = (entrypoints[entrypoint] ?? 0) + 1
  }
  return {
    sessionId,
    path,
    projectDir: basename(dirname(path)),
    lines: records.length,
    entrypoints,
    versions: [...new Set(records.flatMap((record) => (typeof record.version === 'string' ? [record.version] : [])))],
    compactBoundaries: records.filter((record) => record.type === 'system' && record.subtype === 'compact_boundary').length,
    subagentFiles: await countSubagentFiles(path, sessionId),
  }
}

const findCodexRollout = async (roots: Roots, candidates: readonly string[], sessionId: string): Promise<string | null> => {
  const direct = await firstExisting(candidates)
  if (direct !== null) {
    return direct
  }
  for (const directory of ['sessions', 'archived_sessions']) {
    const found = (await filesUnder(join(roots.codexHome, directory))).find((path) => path.endsWith(`${sessionId}.jsonl`))
    if (found !== undefined) {
      return found
    }
  }
  return null
}

const jsonPathText = (path: string): string => JSON.stringify(path).slice(1, -1)

const turnContext = (payload: JsonObject, outsideDir: string): CodexTurnContext => {
  const policy = { sandbox: payload.sandbox_policy, profile: payload.permission_profile, roots: payload.workspace_roots }
  return {
    approval_policy: payload.approval_policy ?? null,
    sandbox_policy: payload.sandbox_policy ?? null,
    workspace_roots: payload.workspace_roots ?? null,
    outside_probe_writable: JSON.stringify(policy).includes(jsonPathText(outsideDir)),
  }
}

const parentThread = (meta: JsonObject): unknown => {
  if (meta.parent_thread_id !== undefined) {
    return meta.parent_thread_id
  }
  const source = isObject(meta.source) ? meta.source : null
  const subagent = source !== null && isObject(source.subagent) ? source.subagent : null
  const spawn = subagent !== null && isObject(subagent.thread_spawn) ? subagent.thread_spawn : null
  return spawn?.parent_thread_id ?? null
}

const inspectCodexRollout = async (
  roots: Roots,
  events: readonly ChecklistEvent[],
  sessionId: string,
  outsideDir: string,
): Promise<CodexRollout> => {
  const path = await findCodexRollout(roots, transcriptCandidates(events, 'codex', sessionId), sessionId)
  const records = path === null ? [] : await jsonLines(path)
  const payloads = (type: string): JsonObject[] =>
    records.filter((record) => record.type === type).flatMap((record) => (isObject(record.payload) ? [record.payload] : []))
  const meta = payloads('session_meta')[0] ?? {}
  const contexts = new Map<string, CodexTurnContext>()
  for (const payload of payloads('turn_context')) {
    const context = turnContext(payload, outsideDir)
    contexts.set(JSON.stringify(context), context)
  }
  return {
    sessionId,
    path,
    originator: meta.originator ?? null,
    source: meta.source ?? null,
    thread_source: meta.thread_source ?? null,
    parent_thread_id: parentThread(meta),
    cli_version: meta.cli_version ?? null,
    cwd: meta.cwd ?? null,
    turnContexts: [...contexts.values()],
  }
}

const shapeOf = (value: unknown): unknown => {
  if (value === null) {
    return 'null'
  }
  if (Array.isArray(value)) {
    return value.length === 0 ? 'array<empty>' : [`array<${String(value.length)}> of`, shapeOf(value[0])]
  }
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shapeOf(item)]))
  }
  if (typeof value === 'string') {
    return uuidPattern.test(value) ? 'str<uuid>' : localUuidPattern.test(value) ? 'str<local_uuid>' : 'str'
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'int' : 'number'
  }
  return typeof value === 'boolean' ? 'bool' : typeof value
}

const identifierPattern = /^[\w.:@-]{1,64}$/

export const sanitizeSeed = (value: unknown, anonymize: (text: string) => string): unknown => {
  if (typeof value === 'string') {
    const anonymized = anonymize(value)
    return identifierPattern.test(value) || anonymized.startsWith('~') || anonymized.startsWith('<dir>')
      ? anonymized
      : `<text, ${String(value.length)} chars>`
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeSeed(item, anonymize))
  }
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeSeed(item, anonymize)]))
  }
  return value
}

const maskedRelative = (root: string, path: string): string => {
  const parts = path.slice(root.length + 1).split(sep)
  return [...parts.slice(0, -1).map(() => '*'), parts.at(-1) ?? ''].join('/')
}

const textOf = (value: unknown): string | null => (typeof value === 'string' ? value : null)

const inspectDesktop = async (
  roots: Roots,
  events: readonly ChecklistEvent[],
  claudeSessionIds: readonly string[],
  anonymize: (text: string) => string,
): Promise<{ sessions: DesktopSessionMeta[]; deleted: DesktopDeletedMarker[] }> => {
  const root = roots.claudeDesktopDir
  if (root === null) {
    return { sessions: [], deleted: [] }
  }
  const files = await filesUnder(root)
  const hostIds = new Set(
    events.flatMap((event) => (event.runtime === 'claude' ? (event.env.CLAUDE_CODE_HOST_SESSION_ID ?? []) : [])),
  )
  const sessions: DesktopSessionMeta[] = []
  for (const path of files.filter((file) => /^local_.*\.json$/.test(basename(file)))) {
    let document: unknown
    try {
      document = JSON.parse(await readFile(path, 'utf8'))
    } catch {
      continue
    }
    if (!isObject(document)) {
      continue
    }
    const sessionId = textOf(document.sessionId)
    const cliSessionId = textOf(document.cliSessionId)
    const linked =
      (cliSessionId !== null && claudeSessionIds.includes(cliSessionId)) || (sessionId !== null && hostIds.has(sessionId))
    if (!linked) {
      continue
    }
    if (sessionId !== null) {
      hostIds.add(sessionId)
    }
    sessions.push({
      path,
      file: maskedRelative(root, path),
      sessionId,
      cliSessionId,
      lastSpawnRootDetected: document.lastSpawnRootDetected ?? null,
      spawnSeed: sanitizeSeed(document.spawnSeed ?? null, anonymize),
      shape: shapeOf(document),
    })
  }
  const deleted: DesktopDeletedMarker[] = []
  for (const path of files.filter((file) => basename(file).startsWith('deleted_'))) {
    const uuid = basename(path).slice('deleted_'.length).replace(/\.[^.]*$/, '')
    const hostSessionId = `local_${uuid}`
    if (hostIds.has(hostSessionId)) {
      const content = (await readFile(path, 'utf8').catch(() => '')).trim().slice(0, 32)
      deleted.push({ path, file: maskedRelative(root, path), hostSessionId, content })
    }
  }
  return { sessions, deleted }
}

export const inspectSessionFiles = async (
  roots: Roots,
  events: readonly ChecklistEvent[],
  outsideDir: string,
  anonymize: (text: string) => string,
): Promise<SessionFiles> => {
  const claudeIds = sessionIdsOf(events, 'claude')
  const codexIds = sessionIdsOf(events, 'codex')
  const claudeTranscripts = await Promise.all(claudeIds.map((id) => inspectClaudeTranscript(roots, events, id)))
  const codexRollouts = await Promise.all(codexIds.map((id) => inspectCodexRollout(roots, events, id, outsideDir)))
  const desktop = await inspectDesktop(roots, events, claudeIds, anonymize)
  return { claudeTranscripts, codexRollouts, desktopSessions: desktop.sessions, desktopDeleted: desktop.deleted }
}

export const probeProjectDirs = async (roots: Roots, probeRepoForms: readonly string[]): Promise<string[]> => {
  const projects = join(roots.claudeConfigDir, 'projects')
  const prefixes = probeRepoForms.map(encodeProjectPath)
  const names = await readdir(projects).catch(() => [])
  return names
    .filter((name) => prefixes.some((prefix) => name === prefix || name.startsWith(`${prefix}-`)))
    .map((name) => join(projects, name))
}
