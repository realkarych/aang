import { dirname, isAbsolute, join, resolve } from 'node:path'
import {
  type Action,
  type Agent,
  type ContentHash,
  ContextSourceKind,
  DedupeKey,
  type DefinitionCatalog,
  type EpochNs,
  type Fact,
  type FactDraftOf,
  type FactEntityKey,
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
  type SessionId,
  type SessionKey,
} from '@aang/contract'
import { canonicalJson, contentHash, objectId } from '@aang/contract/ids'
import type { RawRecordReader, Store } from '@aang/store'
import { parse as parseToml } from 'smol-toml'
import { agentKey, compareText } from '../observations/evidence.js'
import {
  agentFileOf,
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
  readonly codexHome?: string | null
  readonly limits?: Partial<ContextLimits>
}

interface Homes {
  readonly claude: string | null
  readonly codex: string | null
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

const ofRuntime = (sessions: readonly SessionFacts[], runtime: Runtime): SessionFacts[] =>
  sessions.filter(({ session }) => session.key.runtime === runtime)

const listedDefinitions = (facts: readonly Fact[], catalog: DefinitionCatalog): ReadonlyMap<string, string> =>
  new Map(
    facts
      .filter(
        (fact): fact is FactOf<'definition_listing'> =>
          fact.kind === 'definition_listing' && fact.format_verified && fact.payload.catalog === catalog,
      )
      .sort(byFactTime)
      .flatMap((fact) => fact.payload.definitions.map(({ name, description }) => [name, description] as const)),
  )

interface Used {
  readonly name: string
  readonly session: SessionId
  readonly cwd: string | null
  readonly listed: string | null
}

interface Resolved {
  readonly source: Source
  readonly session: SessionId | null
}

interface Attributed {
  readonly source: Source
  readonly sessions: Set<SessionId>
}

const usedIn = ({ id, cwd }: Session, names: readonly string[], listed: ReadonlyMap<string, string>): Used[] =>
  unique(names).map((name) => ({ name, session: id, cwd: directoryOf(cwd), listed: listed.get(name) ?? null }))

interface UsedAgent extends Used {
  readonly prompts: readonly string[]
}

const agentPrompts = (agents: readonly Agent[], facts: readonly Fact[]): ReadonlyMap<string, readonly string[]> => {
  const types = new Map(
    agents.flatMap(({ id, role, agent_type: type }) =>
      role === 'subagent' && type !== null ? [[id, type] as const] : [],
    ),
  )
  const prompts = new Map<string, readonly string[]>()
  const given = facts
    .filter((fact): fact is FactOf<'agent_prompt'> => fact.kind === 'agent_prompt' && fact.format_verified)
    .sort(byFactTime)
  for (const fact of given) {
    const type = types.get(objectId(agentKey(fact)))
    if (type !== undefined) {
      prompts.set(type, unique([...(prompts.get(type) ?? []), fact.payload.text]))
    }
  }
  return prompts
}

const onDisk = (source: Source): Resolved => ({ source, session: null })

const inSession = (session: SessionId, source: Source): Resolved => ({ source, session })

const attributed = (resolved: readonly Resolved[]): Source[] => {
  const merged = new Map<string, Attributed>()
  for (const { source, session } of resolved) {
    const key = canonicalJson([source.kind, source.ref, session === null ? null : source.text])
    const entry = merged.get(key) ?? { source, sessions: new Set<SessionId>() }
    merged.set(key, entry)
    if (session !== null) {
      entry.sessions.add(session)
    }
  }
  return [...merged.values()].map(({ source, sessions }) =>
    sessions.size === 0
      ? source
      : { ...source, ref: `${source.ref} (sessions: ${[...sessions].sort(compareText).join(', ')})` },
  )
}

const definesAgent = ({ name, listed, prompts }: UsedAgent, file: FileText): boolean => {
  if (listed === null && prompts.length === 0) {
    return true
  }
  const { type, listedLine, prompt } = agentFileOf(file.text)
  return type === name && prompts.includes(prompt) && (listed === null || listed === listedLine)
}

const sessionDefinition = ({ listed, prompts }: UsedAgent): string =>
  [...(listed === null ? [] : [listed]), ...prompts].join('\n\n')

const agentDefinitionSources = async (
  reader: ContextReader,
  sessions: readonly SessionFacts[],
  home: string | null,
): Promise<Source[]> => {
  const used = ofRuntime(sessions, 'claude').flatMap(({ session, facts }) => {
    const agents = reader.observations.agents(session.id)
    const prompts = agentPrompts(agents, facts)
    return usedIn(
      session,
      agents.flatMap((agent) =>
        (agent.role === 'subagent' || agent.role === 'teammate') && agent.agent_type !== null ? [agent.agent_type] : [],
      ),
      listedDefinitions(facts, 'agents'),
    ).map((agent): UsedAgent => ({ ...agent, prompts: prompts.get(agent.name) ?? [] }))
  })
  const definitions = await Promise.all(
    used.map(async (agent): Promise<Resolved[]> => {
      const file = safeName(agent.name)
        ? await firstText(definitionPaths(agent.cwd, home, ['agents', `${agent.name}.md`]), (found) =>
            definesAgent(agent, found),
          )
        : null
      if (file !== null) {
        return [onDisk(fromFile('agent_definition', file.path, file))]
      }
      const text = sessionDefinition(agent)
      return text === '' ? [] : [inSession(agent.session, plain('agent_definition', agent.name, text))]
    }),
  )
  return attributed(definitions.flat())
}

type TomlTable = Readonly<Record<string, unknown>>

const isTable = (value: unknown): value is TomlTable =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)

const readToml = async (path: string): Promise<TomlTable | null> => {
  const file = await readText(path)
  if (file === null || file.length > file.text.length) {
    return null
  }
  try {
    return parseToml(file.text)
  } catch {
    return null
  }
}

const textField = (table: TomlTable | null, field: string): string | null => {
  const value = table?.[field]
  return typeof value === 'string' ? value : null
}

const roleText = async (config: string, declared: TomlTable): Promise<string> => {
  const description = textField(declared, 'description')
  const configFile = textField(declared, 'config_file')
  const layer = configFile === null ? null : await readToml(resolve(dirname(config), configFile))
  const instructions = textField(layer, 'developer_instructions')
  return [
    ...(description === null ? [] : [`description: ${description}`]),
    ...(instructions === null ? [] : [`developer_instructions: ${instructions}`]),
  ].join('\n')
}

const codexRoleSources = async (
  reader: ContextReader,
  sessions: readonly SessionFacts[],
  codexHome: string | null,
): Promise<Source[]> => {
  const roles = unique(
    ofRuntime(sessions, 'codex').flatMap(({ session }) =>
      reader.observations
        .agents(session.id)
        .flatMap((agent) => (agent.role === 'subagent' && agent.agent_role !== null ? [agent.agent_role] : [])),
    ),
  )
  if (codexHome === null || roles.length === 0) {
    return []
  }
  const config = join(codexHome, 'config.toml')
  const agents = (await readToml(config))?.['agents']
  const definitions = await Promise.all(
    roles.map(async (role) => {
      const declared = isTable(agents) ? agents[role] : undefined
      const text = isTable(declared) ? await roleText(config, declared) : ''
      return text === '' ? [] : [plain('agent_definition', `${config} [agents.${role}]`, text)]
    }),
  )
  return definitions.flat()
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
  const used = ofRuntime(sessions, 'claude').flatMap(({ session, facts }) =>
    usedIn(
      session,
      reader.observations.actions(session.id).flatMap((action) => {
        const name = invokedSkill(reader, action)
        return name === null ? [] : [name]
      }),
      listedDefinitions(facts, 'skills'),
    ),
  )
  const resolved = await Promise.all(
    used.map(async ({ name, session, cwd, listed }) => {
      const file = safeName(name) ? await firstText(definitionPaths(cwd, home, ['skills', name, 'SKILL.md'])) : null
      return file === null
        ? inSession(session, plain('skill', name, listed ?? ''))
        : onDisk(plain('skill', file.path, frontmatterDescription(file.text) ?? ''))
    }),
  )
  return attributed(resolved)
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

const hookSources = (sessions: readonly SessionFacts[]): Source[] => {
  const hooks = new Map<string, Set<string>>()
  for (const fact of sessions.flatMap(({ facts }) => facts)) {
    if (fact.kind === 'hook_run' && fact.format_verified && fact.payload.name !== null) {
      const { name, trigger, event } = fact.payload
      hooks.set(name, new Set([...(hooks.get(name) ?? []), trigger ?? event]))
    }
  }
  return [...hooks].map(([hook, triggers]) => plain('hook', hook, [...triggers].sort(compareText).join(', ')))
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
  homes: Homes,
): Promise<Source[]> => {
  const [instructions, definitions, roles, skills, git] = await Promise.all([
    instructionSources(sessions),
    agentDefinitionSources(reader, sessions, homes.claude),
    codexRoleSources(reader, sessions, homes.codex),
    skillSources(reader, sessions, homes.claude),
    gitSources(reader, root.session.key, sessions),
  ])
  return [
    ...taskSources(root),
    ...instructions,
    ...definitions,
    ...roles,
    ...skills,
    ...mcpSources(reader, sessions),
    ...hookSources(sessions),
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
  subject: FactEntityKey,
  at: EpochNs,
  hash: ContentHash,
  entries: readonly RunContextEntry[],
): FactDraftOf<'context'> => ({
  kind: 'context',
  entity_key: subject,
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
  const sources = await collectSources(store, root, sessions, {
    claude: options.claudeConfigDir ?? null,
    codex: options.codexHome ?? null,
  })
  const entries = sources.map((source) => entryOf(source, limits.textLength)).sort(byKindAndRef)
  if (entries.length === 0) {
    return null
  }
  const hash = contentHash(canonicalJson(entries))
  const readSessions = sessions.map(({ session }) => session.id).sort(compareText)
  const { key } = root.session
  const subjects: FactEntityKey[] = [
    { kind: 'run', runtime: key.runtime, session: key.session },
    ...sessions.flatMap(({ session }) => (session.id === root.session.id ? [] : [session.key])),
  ]
  return store.transaction((transaction) => {
    const { status, seq } = transaction.rawRecords.insert({
      dedupe_key: DedupeKey.parse(`context:${run}:${contentHash(canonicalJson([hash, readSessions]))}`),
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
      transaction.facts.insert(
        seq,
        daemonNormalizer,
        subjects.map((subject) => contextFact(subject, at, hash, entries)),
      )
    }
    return { seq, content_hash: hash, entries }
  })
}

export const storedRunContext = (records: RawRecordReader, seq: RawSeq): RunContext | null => {
  const record = records.get(seq)
  return record?.channel === 'context' ? { seq, ...StoredContext.parse(JSON.parse(record.payload)) } : null
}
