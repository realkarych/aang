import { isAbsolute, join, resolve } from 'node:path'
import {
  type Action,
  type ContentHash,
  ContextSourceKind,
  DedupeKey,
  type EpochNs,
  type Fact,
  type FactDraftOf,
  type FactOf,
  type GitSnapshotPayload,
  type JsonValue,
  NormalizerVersion,
  type RawSeq,
  RunContext,
  type RunContextEntry,
  type RunId,
  type Runtime,
  type Session,
  type SessionKey,
} from '@aang/contract'
import { canonicalJson, contentHash } from '@aang/contract/ids'
import type { RawRecordReader, Store } from '@aang/store'
import { agentKey, compareText } from '../observations/evidence.js'
import {
  ancestors,
  definitionPaths,
  type FileText,
  firstText,
  frontmatterDescription,
  readText,
  safeName,
} from './context-files.js'
import { worktreeOf } from './worktree.js'

export interface ContextLimits {
  readonly textLength: number
}

export interface RunContextOptions {
  readonly run: RunId
  readonly backend: Runtime
  readonly crossVendor: boolean
  readonly at: EpochNs
  readonly claudeConfigDir?: string | null
  readonly limits?: Partial<ContextLimits>
}

type ContextReader = Pick<Store, 'model' | 'observations' | 'facts'>

interface Source {
  readonly kind: ContextSourceKind
  readonly ref: string
  readonly text: string
  readonly length: number
}

interface SessionFacts {
  readonly session: Session
  readonly facts: readonly Fact[]
}

const defaultLimits: ContextLimits = { textLength: 4_000 }

const daemonNormalizer = NormalizerVersion.parse(1)

const instructionFiles: Readonly<Record<Runtime, string>> = { claude: 'CLAUDE.md', codex: 'AGENTS.md' }

const unusedOutcomes: ReadonlySet<string> = new Set(['denied', 'error'])

const skillTool = 'Skill'

const mcpPrefix = 'mcp__'

const kindOrder = ContextSourceKind.options

const StoredContext = RunContext.omit({ seq: true })

const noRuntimeIds = {
  session_id: null,
  agent_id: null,
  thread_id: null,
  turn_id: null,
  prompt_id: null,
  record_uuid: null,
  parent_uuid: null,
  message_id: null,
  call_id: null,
  ordinal: null,
}

const noRuntimeEnv = { cwd: null, version: null, entrypoint: null, originator: null, git_branch: null }

const plain = (kind: ContextSourceKind, ref: string, text: string): Source => ({ kind, ref, text, length: text.length })

const fromFile = (kind: ContextSourceKind, ref: string, file: FileText): Source => ({
  kind,
  ref,
  text: file.text,
  length: file.length,
})

const fieldOf = (input: JsonValue, name: string): JsonValue | undefined =>
  input !== null && typeof input === 'object' && !Array.isArray(input) ? input[name] : undefined

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)]

const byStart = (left: Session, right: Session): number =>
  left.started_at < right.started_at ? -1 : left.started_at > right.started_at ? 1 : compareText(left.id, right.id)

const byFactTime = (left: Fact, right: Fact): number =>
  left.at < right.at ? -1 : left.at > right.at ? 1 : compareText(left.id, right.id)

const directoryOf = (path: string | null): string | null => (path !== null && isAbsolute(path) ? path : null)

const runSessions = (reader: ContextReader, run: RunId): Session[] =>
  reader.model
    .entities(run)
    .flatMap((entity) => {
      const session = entity.kind === 'session_membership' ? reader.observations.getSession(entity.value.session) : null
      return session?.run === run ? [session] : []
    })
    .sort(byStart)

const taskSources = ({ facts }: SessionFacts): Source[] => {
  const prompt = facts
    .filter(
      (fact): fact is FactOf<'prompt'> =>
        fact.kind === 'prompt' &&
        fact.speaker === 'human' &&
        fact.payload.text.trim() !== '' &&
        agentKey(fact).agent.kind === 'main',
    )
    .sort(byFactTime)[0]
  return prompt === undefined ? [] : [plain('task', prompt.id, prompt.payload.text)]
}

const instructionPaths = ({ session, facts }: SessionFacts): string[] => {
  const loaded = facts.flatMap((fact) => (fact.kind === 'instructions_loaded' ? [fact.payload.path] : []))
  const cwd = directoryOf(session.cwd)
  if (loaded.length > 0 || cwd === null) {
    return loaded.filter(isAbsolute)
  }
  return ancestors(cwd)
    .reverse()
    .map((directory) => join(directory, instructionFiles[session.key.runtime]))
}

const instructionSources = async (sessions: readonly SessionFacts[]): Promise<Source[]> => {
  const files = await Promise.all(unique(sessions.flatMap(instructionPaths)).map(readText))
  return files.flatMap((file) => (file === null ? [] : [fromFile('instructions', file.path, file)]))
}

const claudeSessions = (sessions: readonly SessionFacts[]): Session[] =>
  sessions.flatMap(({ session }) => (session.key.runtime === 'claude' ? [session] : []))

interface Named {
  readonly name: string
  readonly cwd: string | null
}

const distinctNamed = (named: readonly Named[]): Named[] => [
  ...new Map(named.map((entry) => [canonicalJson([entry.name, entry.cwd]), entry])).values(),
]

const distinctSources = (sources: readonly Source[]): Source[] => [
  ...new Map(sources.map((source) => [canonicalJson([source.kind, source.ref]), source])).values(),
]

const agentDefinitionSources = async (
  reader: ContextReader,
  sessions: readonly SessionFacts[],
  home: string | null,
): Promise<Source[]> => {
  const types = distinctNamed(
    claudeSessions(sessions).flatMap((session) =>
      reader.observations.agents(session.id).flatMap((agent) =>
        (agent.role === 'subagent' || agent.role === 'teammate') &&
        agent.agent_type !== null &&
        safeName(agent.agent_type)
          ? [{ name: agent.agent_type, cwd: directoryOf(session.cwd) }]
          : [],
      ),
    ),
  )
  const definitions = await Promise.all(
    types.map(async ({ name, cwd }) => {
      const file = await firstText(definitionPaths(cwd, home, ['agents', `${name}.md`]))
      return file === null ? [] : [fromFile('agent_definition', file.path, file)]
    }),
  )
  return distinctSources(definitions.flat())
}

const invokedSkill = (reader: ContextReader, action: Action): string | null => {
  if (action.tool !== skillTool || unusedOutcomes.has(action.outcome?.value ?? 'unknown')) {
    return null
  }
  const start = action.input_fact === null ? null : reader.facts.get(action.input_fact)
  const skill = start?.kind === 'action_start' ? fieldOf(start.payload.input, 'skill') : undefined
  return typeof skill === 'string' && skill !== '' ? skill : null
}

const skillSources = async (
  reader: ContextReader,
  sessions: readonly SessionFacts[],
  home: string | null,
): Promise<Source[]> => {
  const skills = distinctNamed(
    claudeSessions(sessions).flatMap((session) =>
      reader.observations.actions(session.id).flatMap((action) => {
        const name = invokedSkill(reader, action)
        return name === null ? [] : [{ name, cwd: directoryOf(session.cwd) }]
      }),
    ),
  )
  const resolved = await Promise.all(
    skills.map(async ({ name, cwd }) => {
      const file = safeName(name) ? await firstText(definitionPaths(cwd, home, ['skills', name, 'SKILL.md'])) : null
      return file === null ? plain('skill', name, '') : plain('skill', file.path, frontmatterDescription(file.text) ?? '')
    }),
  )
  return distinctSources(resolved)
}

const mcpCall = (tool: string): readonly [string, string] => {
  const name = tool.startsWith(mcpPrefix) ? tool.slice(mcpPrefix.length) : tool
  const slash = name.indexOf('/')
  const index = slash < 0 ? name.indexOf('__') : slash
  const width = slash < 0 ? 2 : 1
  return index < 0 ? [name, ''] : [name.slice(0, index), name.slice(index + width)]
}

const mcpSources = (reader: ContextReader, sessions: readonly SessionFacts[]): Source[] => {
  const servers = new Map<string, Set<string>>()
  const calls = sessions
    .flatMap(({ session }) => reader.observations.actions(session.id))
    .flatMap((action) => (action.action_kind === 'mcp' ? [mcpCall(action.tool)] : []))
  for (const [server, tool] of calls.filter(([server]) => server !== '')) {
    servers.set(server, new Set([...(servers.get(server) ?? []), ...(tool === '' ? [] : [tool])]))
  }
  return [...servers].map(([server, tools]) => plain('mcp_server', server, [...tools].sort(compareText).join(', ')))
}

const masksOf = (snapshot: GitSnapshotPayload): string => canonicalJson([...snapshot.masks].sort(compareText))

const snapshotLines = (masks: string, snapshot: GitSnapshotPayload): string[] => [
  `masks: ${masks}`,
  `commit: ${snapshot.head ?? 'unknown'}`,
  `clean under masks: ${String(snapshot.clean)}`,
  ...snapshot.entries.map(({ status, path }) => `${status} ${path}`),
  ...(snapshot.error === null ? [] : [`error: ${snapshot.error}`]),
]

const workDirectories = (sessions: readonly SessionFacts[]): string[] =>
  unique(
    sessions.flatMap(({ session, facts }) =>
      [session.cwd, ...facts.flatMap((fact) => (fact.entity_key.kind === 'run' ? [] : [fact.runtime_env.cwd]))].flatMap(
        (cwd) => directoryOf(cwd) ?? [],
      ),
    ),
  )

interface WorktreeState {
  readonly branches: Set<string>
  readonly snapshots: Map<string, GitSnapshotPayload>
}

const gitSources = async (
  reader: ContextReader,
  root: SessionKey,
  sessions: readonly SessionFacts[],
): Promise<Source[]> => {
  const worktreeByDirectory = new Map(
    await Promise.all(
      workDirectories(sessions).map(async (directory) => [directory, await worktreeOf(directory)] as const),
    ),
  )
  const reachable = new Set(
    [...worktreeByDirectory].flatMap(([directory, worktree]) =>
      worktree === null ? [resolve(directory)] : [resolve(directory), worktree],
    ),
  )
  const worktrees = new Map<string, WorktreeState>()
  const stateOf = (ref: string): WorktreeState => {
    const state = worktrees.get(ref) ?? { branches: new Set<string>(), snapshots: new Map<string, GitSnapshotPayload>() }
    worktrees.set(ref, state)
    return state
  }
  for (const { session } of sessions) {
    const cwd = directoryOf(session.cwd)
    const ref = cwd === null ? session.id : (worktreeByDirectory.get(cwd) ?? cwd)
    if (session.git_branch !== null) {
      stateOf(ref).branches.add(`branch: ${session.git_branch}`)
    }
  }
  const runSnapshots = reader.facts
    .ofEntity({ kind: 'run', runtime: root.runtime, session: root.session })
    .flatMap((fact) => (fact.kind === 'git_snapshot' ? [fact.payload] : []))
  for (const snapshot of runSnapshots) {
    const worktree = directoryOf(snapshot.worktree)
    const ref = worktree === null ? null : resolve(worktree)
    if (ref !== null && reachable.has(ref)) {
      stateOf(ref).snapshots.set(masksOf(snapshot), snapshot)
    }
  }
  return [...worktrees].map(([ref, { branches, snapshots }]) =>
    plain(
      'git',
      ref,
      [
        ...branches,
        ...[...snapshots]
          .sort(([left], [right]) => compareText(left, right))
          .flatMap(([masks, snapshot]) => snapshotLines(masks, snapshot)),
      ].join('\n'),
    ),
  )
}

const collectSources = async (
  reader: ContextReader,
  root: SessionFacts,
  sessions: readonly SessionFacts[],
  home: string | null,
): Promise<Source[]> => {
  const [instructions, definitions, skills, git] = await Promise.all([
    instructionSources(sessions),
    agentDefinitionSources(reader, sessions, home),
    skillSources(reader, sessions, home),
    gitSources(reader, root.session.key, sessions),
  ])
  return [
    ...taskSources(root),
    ...instructions,
    ...definitions,
    ...skills,
    ...mcpSources(reader, sessions),
    ...git,
  ]
}

const entryOf = ({ kind, ref, text, length }: Source, limit: number): RunContextEntry =>
  text.length > limit || length > text.length
    ? { kind, ref, text: text.slice(0, limit), truncated: { path: 'text', length } }
    : { kind, ref, text, truncated: null }

const byKindAndRef = (left: RunContextEntry, right: RunContextEntry): number =>
  kindOrder.indexOf(left.kind) - kindOrder.indexOf(right.kind) || compareText(left.ref, right.ref)

const contextFact = (
  root: SessionKey,
  at: EpochNs,
  hash: ContentHash,
  entries: readonly RunContextEntry[],
): FactDraftOf<'context'> => ({
  kind: 'context',
  entity_key: { kind: 'run', runtime: root.runtime, session: root.session },
  speaker: 'runtime',
  urgent: false,
  at,
  runtime_ids: noRuntimeIds,
  runtime_env: noRuntimeEnv,
  format_verified: true,
  redelivery_key: null,
  payload: { content_hash: hash, sources: entries.map(({ kind, ref }) => ({ kind, ref })) },
})

export const recordRunContext = async (store: Store, options: RunContextOptions): Promise<RunContext | null> => {
  const { run, backend, crossVendor, at } = options
  const limits = { ...defaultLimits, ...options.limits }
  const entity = store.model.entity(run, { kind: 'run', id: run })
  const rootId = entity?.kind === 'run' ? entity.value.root_session : null
  const sessions = runSessions(store, run)
    .filter((session) => session.key.runtime === backend || crossVendor)
    .map((session) => ({ session, facts: store.facts.ofSession(session.key) }))
  const root = sessions.find(({ session }) => session.id === rootId)
  if (root === undefined) {
    return null
  }
  const sources = await collectSources(store, root, sessions, options.claudeConfigDir ?? null)
  const entries = sources.map((source) => entryOf(source, limits.textLength)).sort(byKindAndRef)
  if (entries.length === 0) {
    return null
  }
  const hash = contentHash(canonicalJson(entries))
  return store.transaction((transaction) => {
    const { status, seq } = transaction.rawRecords.insert({
      dedupe_key: DedupeKey.parse(`context:${run}:${hash}`),
      channel: 'context',
      runtime: null,
      stream: null,
      position: { kind: 'daemon' },
      hook: null,
      observed_at: at,
      source_ts: at,
      payload: canonicalJson({ content_hash: hash, entries }),
      parse_state: 'parsed',
    })
    if (status === 'inserted') {
      transaction.facts.insert(seq, daemonNormalizer, [contextFact(root.session.key, at, hash, entries)])
    }
    return { seq, content_hash: hash, entries }
  })
}

export const storedRunContext = (records: RawRecordReader, seq: RawSeq): RunContext | null => {
  const record = records.get(seq)
  return record?.channel === 'context' ? { seq, ...StoredContext.parse(JSON.parse(record.payload)) } : null
}
