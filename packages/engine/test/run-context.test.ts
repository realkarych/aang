import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  DedupeKey,
  EpochNs,
  type Fact,
  type GitSnapshotPayload,
  type JsonValue,
  NormalizerVersion,
  ObserverCallId,
  type ObserverInput,
  type ObserverNeed,
  type RawRecord,
  type RunContext,
  type RunContextEntry,
  type RunId,
  type Runtime,
  type SessionKey,
} from '@aang/contract'
import { objectId, runId } from '@aang/contract/ids'
import {
  applyChangeSet,
  applyObserverResponse,
  beginObserverCall,
  beginObserverFollowUp,
  createEngine,
  type Engine,
  failObserverCall,
  recordRunContext,
  type RunContextOptions,
  startObserverBatch,
  storedRunContext,
} from '@aang/engine'
import type { Store } from '@aang/store'
import { expect, test } from 'vitest'
import { type HookDelivery, hookBatch, jsonlFile } from './batches.js'
import { adapters, factsOf, recordsOf, sessionKey } from './harness.js'
import { createHome } from './home.js'
import { inputFor } from './observer-fixtures.js'
import { claudeHook, claudeTranscript, codexRollout } from './samples.js'
import { createRepository, git } from './workspace.js'

type Register = Parameters<typeof createHome>[0]

interface Source {
  readonly session: string
  readonly cwd: string
}

interface Workspace {
  readonly store: Store
  readonly engine: Engine
  readonly root: string
  readonly project: string
  readonly cwd: string
  readonly claudeHome: string
}

const recordedAt = EpochNs.parse(1_900_000_000_000_000_000n)

const setup = async (register: Register): Promise<Workspace> => {
  const home = await createHome(register)
  const root = join(home.path, '..', 'context')
  const project = join(root, 'project')
  const cwd = join(project, 'packages', 'app')
  const claudeHome = join(root, 'claude-home')
  await mkdir(cwd, { recursive: true })
  const store = home.open()
  const engine = createEngine({ store, adapters, watch: { all: true, roots: [] } })
  return { store, engine, root, project, cwd, claudeHome }
}

const write = async (path: string, text: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

const runOf = (runtime: Runtime, session: string): RunId => runId(sessionKey(runtime, session))

const optionsOf = (workspace: Workspace, run: RunId, changes: Partial<RunContextOptions> = {}): RunContextOptions => ({
  run,
  backend: 'claude',
  crossVendor: false,
  at: recordedAt,
  claudeConfigDir: workspace.claudeHome,
  ...changes,
})

const recorded = async (store: Store, options: RunContextOptions): Promise<RunContext> => {
  const context = await recordRunContext(store, options)
  if (context === null) {
    throw new Error(`run ${options.run} has no context`)
  }
  return context
}

const local = (workspace: Workspace, context: RunContext): RunContextEntry[] =>
  context.entries.filter(({ kind, ref }) => kind !== 'instructions' || ref.startsWith(workspace.root))

const ofKind = (context: RunContext, kind: RunContextEntry['kind']): RunContextEntry[] =>
  context.entries.filter((entry) => entry.kind === kind)

const contextRecords = (store: Store): RawRecord[] => recordsOf(store).filter(({ channel }) => channel === 'context')

const contextFacts = (store: Store) => factsOf(store).filter(({ kind }) => kind === 'context')

const entry = (kind: RunContextEntry['kind'], ref: string, text: string): RunContextEntry => ({
  kind,
  ref,
  text,
  truncated: null,
})

const byRef = (left: RunContextEntry, right: RunContextEntry): number =>
  left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0

const toplevel = async (directory: string): Promise<string> =>
  resolve(await git(directory, 'rev-parse', '--show-toplevel'))

const firstPrompt = [
  'Step 1: run `echo hi` with the Bash tool.',
  'Step 2: use the Agent tool with subagent_type "pinger" and prompt "ping".',
  'Step 3: reply with exactly: OK',
].join(' ')

const timestampAt = (second: number, millisecond = 0): string =>
  new Date(Date.UTC(2026, 9, 1, 12, 0, second, millisecond)).toISOString()

const transcriptLine = (
  source: Source,
  uuid: string,
  second: number,
  type: 'assistant' | 'user',
  message: JsonValue,
  extra: Record<string, JsonValue> = {},
): string =>
  JSON.stringify({
    type,
    sessionId: source.session,
    uuid,
    timestamp: timestampAt(second),
    cwd: source.cwd,
    message,
    ...extra,
  })

const attachmentLine = (source: Source, uuid: string, second: number, attachment: JsonValue): string =>
  JSON.stringify({
    type: 'attachment',
    sessionId: source.session,
    uuid,
    timestamp: timestampAt(second),
    cwd: source.cwd,
    attachment,
  })

const toolCall = (source: Source, call: string, second: number, name: string, input: JsonValue): string =>
  transcriptLine(source, `call-${call}`, second, 'assistant', {
    id: `message-${call}`,
    role: 'assistant',
    content: [{ type: 'tool_use', id: call, name, input }],
  })

const toolResult = (source: Source, call: string, second: number, content: string, failed = false): string =>
  transcriptLine(source, `result-${call}`, second, 'user', {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: call, content, is_error: failed }],
  })

const skillCall = (source: Source, call: string, second: number, skill: string, failed = false): string[] => [
  toolCall(source, call, second, 'Skill', { skill }),
  toolResult(source, call, second + 1, failed ? `Unknown skill: ${skill}` : `Launching skill: ${skill}`, failed),
]

const listedRef = (name: string, ...sources: readonly Source[]): string =>
  `${name} (sessions: ${sources
    .map(({ session }) => objectId(sessionKey('claude', session)))
    .sort()
    .join(', ')})`

const claudeFile = (workspace: Workspace, name: string, lines: readonly string[], ino: bigint) =>
  jsonlFile({ runtime: 'claude', path: join(workspace.project, `${name}.jsonl`), lines, ino })

const hook = (
  source: Source,
  sample: string,
  file: string,
  arrival: number,
  changes: Record<string, JsonValue>,
): HookDelivery => ({
  file: `${source.session}-${file}.evt`,
  payload: claudeHook(sample, source, changes),
  arrival,
})

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

const recordSnapshot = (store: Store, root: SessionKey, dedupe: string, payload: GitSnapshotPayload): void => {
  store.transaction((transaction) => {
    const { seq } = transaction.rawRecords.insert({
      dedupe_key: DedupeKey.parse(dedupe),
      channel: 'snapshot',
      runtime: null,
      stream: null,
      position: { kind: 'daemon' },
      hook: null,
      observed_at: recordedAt,
      source_ts: recordedAt,
      payload: JSON.stringify(payload),
      parse_state: 'parsed',
    })
    transaction.facts.insert(seq, NormalizerVersion.parse(1), [
      {
        kind: 'git_snapshot',
        entity_key: { kind: 'run', runtime: root.runtime, session: root.session },
        speaker: 'runtime',
        urgent: false,
        at: recordedAt,
        runtime_ids: noRuntimeIds,
        runtime_env: { cwd: payload.worktree, version: null, entrypoint: null, originator: null, git_branch: null },
        format_verified: true,
        redelivery_key: null,
        payload,
      },
    ])
  })
}

const taken = (
  worktree: string,
  masks: readonly string[],
  head: string | null,
  entries: GitSnapshotPayload['entries'],
  error: string | null = null,
): GitSnapshotPayload => ({
  worktree,
  trigger: 'check',
  masks: [...masks],
  head,
  entries,
  clean: head !== null && entries.length === 0,
  error,
})

test('a skill enters the run context only when the session invokes it', async ({ onTestFinished }) => {
  const workspace = await setup(onTestFinished)
  const { store, engine, project, cwd, claudeHome } = workspace
  await write(
    join(project, '.claude', 'skills', 'review', 'SKILL.md'),
    '---\nname: review\ndescription: "Review the diff before merging"\n---\nRead the diff.\n',
  )
  await write(
    join(cwd, '.claude', 'skills', 'review', 'SKILL.md'),
    '---\nname: review\ndescription: Nearest review of the package\n---\n',
  )
  await write(
    join(claudeHome, 'skills', 'release', 'SKILL.md'),
    '---\nname: release\ndescription: >-\n  Cut a release\n  and tag it\nallowed-tools: Bash\n---\n',
  )
  await write(
    join(claudeHome, 'skills', 'notes', 'SKILL.md'),
    '---\ndescription: |\n  First line\n\n  Second line\n---\n',
  )
  await write(join(claudeHome, 'skills', 'plain', 'SKILL.md'), '---\ndescription: Spans\n  two lines\n---\n')
  await write(join(claudeHome, 'skills', 'bare', 'SKILL.md'), '# No frontmatter\n')
  await write(join(project, '.claude', 'skills', 'deploy', 'SKILL.md'), '---\ndescription: Deploy to production\n---\n')
  await write(join(project, '.claude', 'skills', 'catalog-only', 'SKILL.md'), '---\ndescription: Listed only\n---\n')
  const source = { session: 'skill-session', cwd }
  const start = claudeTranscript(source).slice(0, 12)
  const invocations = [
    ...skillCall(source, 'skill-review', 10, 'review'),
    ...skillCall(source, 'skill-release', 12, 'release'),
    ...skillCall(source, 'skill-review-again', 14, 'review'),
    ...skillCall(source, 'skill-notes', 16, 'notes'),
    ...skillCall(source, 'skill-plain', 18, 'plain'),
    ...skillCall(source, 'skill-bare', 20, 'bare'),
    ...skillCall(source, 'skill-plugin', 22, 'tools:formatter'),
    ...skillCall(source, 'skill-deploy', 24, 'deploy', true),
    toolCall(source, 'skill-empty', 26, 'Skill', { skill: '' }),
    toolCall(source, 'skill-missing', 27, 'Skill', { command: 'catalog-only' }),
  ]
  const file = claudeFile(workspace, 'skills', [...start, ...invocations], 3n)
  const run = runOf('claude', source.session)

  await engine.ingest(file.batch(1, start.length))
  const listed = await recorded(store, optionsOf(workspace, run))
  expect(ofKind(listed, 'skill')).toEqual([])

  await engine.ingest(file.batch(start.length + 1, file.lines.length))
  const invoked = await recorded(store, optionsOf(workspace, run))
  const userSkill = (name: string): string => join(claudeHome, 'skills', name, 'SKILL.md')
  expect(ofKind(invoked, 'skill')).toEqual([
    entry('skill', userSkill('bare'), ''),
    entry('skill', userSkill('notes'), 'First line\n\nSecond line'),
    entry('skill', userSkill('plain'), 'Spans two lines'),
    entry('skill', userSkill('release'), 'Cut a release and tag it'),
    entry('skill', join(cwd, '.claude', 'skills', 'review', 'SKILL.md'), 'Nearest review of the package'),
    entry('skill', listedRef('tools:formatter', source), ''),
  ])
  expect(invoked.seq).not.toBe(listed.seq)
})

test('an unchanged context is recorded once and only a change records it again', async ({ onTestFinished }) => {
  const workspace = await setup(onTestFinished)
  const { store, engine, project, cwd } = workspace
  await write(join(project, 'CLAUDE.md'), 'Use pnpm.\n')
  const source = { session: 'repeat-session', cwd }
  const start = claudeTranscript(source).slice(0, 12)
  const later = [
    transcriptLine(
      source,
      'second-prompt',
      29,
      'user',
      { role: 'user', content: 'Also run the tests' },
      { promptSource: 'typed' },
    ),
    toolCall(source, 'bash-later', 30, 'Bash', { command: 'pnpm test' }),
    toolResult(source, 'bash-later', 31, 'ok'),
  ]
  const file = claudeFile(workspace, 'repeat', [...start, ...later], 5n)
  const run = runOf('claude', source.session)
  await engine.ingest(file.batch(1, start.length))

  const first = await recorded(store, optionsOf(workspace, run))
  expect(await recordRunContext(store, optionsOf(workspace, run, { at: EpochNs.parse(recordedAt + 1n) }))).toEqual(
    first,
  )
  await engine.ingest(file.batch(start.length + 1, file.lines.length))
  expect(await recordRunContext(store, optionsOf(workspace, run))).toEqual(first)
  expect(contextRecords(store).map(({ seq }) => seq)).toEqual([first.seq])
  expect(contextFacts(store)).toHaveLength(1)

  await write(join(project, 'CLAUDE.md'), 'Use pnpm and vitest.\n')
  const changed = await recorded(store, optionsOf(workspace, run))
  expect(changed.seq).not.toBe(first.seq)
  expect(changed.content_hash).not.toBe(first.content_hash)
  expect(ofKind(changed, 'instructions')).toContainEqual(
    entry('instructions', join(project, 'CLAUDE.md'), 'Use pnpm and vitest.\n'),
  )
  expect(await recordRunContext(store, optionsOf(workspace, run))).toEqual(changed)

  await write(join(project, 'CLAUDE.md'), 'Use pnpm.\n')
  expect(await recordRunContext(store, optionsOf(workspace, run))).toEqual(first)
  expect(contextRecords(store).map(({ seq }) => seq)).toEqual([first.seq, changed.seq])
  expect(contextFacts(store)).toHaveLength(2)
})

test('the context record can be cited and reproduced and is not an event of the session', async ({
  onTestFinished,
}) => {
  const workspace = await setup(onTestFinished)
  const { store, engine, project, cwd } = workspace
  await write(join(project, 'CLAUDE.md'), 'Project rules\n')
  await write(join(cwd, 'CLAUDE.md'), 'Package rules\n')
  await mkdir(join(project, 'packages', 'CLAUDE.md'), { recursive: true })
  const source = { session: 'cited-session', cwd }
  const start = claudeTranscript(source).slice(0, 12)
  const later = [toolCall(source, 'bash-after', 40, 'Bash', { command: 'ls' })]
  const file = claudeFile(workspace, 'cited', [...start, ...later], 7n)
  const run = runOf('claude', source.session)
  const session = objectId(sessionKey('claude', source.session))
  await engine.ingest(file.batch(1, start.length))

  const context = await recorded(store, optionsOf(workspace, run))
  expect(local(workspace, context)).toEqual([
    entry('task', expect.any(String) as string, firstPrompt),
    entry('instructions', join(project, 'CLAUDE.md'), 'Project rules\n'),
    entry('instructions', join(cwd, 'CLAUDE.md'), 'Package rules\n'),
    entry('git', cwd, 'branch: HEAD'),
  ])
  const [record] = contextRecords(store)
  expect(record).toMatchObject({
    seq: context.seq,
    channel: 'context',
    runtime: null,
    stream: null,
    position: { kind: 'daemon' },
    hook: null,
    observed_at: recordedAt,
    source_ts: recordedAt,
    parse_state: 'parsed',
  })
  expect(storedRunContext(store.rawRecords, context.seq)).toEqual(context)
  const [fact] = contextFacts(store)
  expect(fact).toMatchObject({
    seq: context.seq,
    entity_key: { kind: 'run', runtime: 'claude', session: source.session },
    speaker: 'runtime',
    urgent: false,
    at: recordedAt,
    payload: {
      content_hash: context.content_hash,
      sources: context.entries.map(({ kind, ref }) => ({ kind, ref })),
    },
  })
  const task = factsOf(store).find(({ kind }) => kind === 'prompt')
  expect(context.entries[0]?.ref).toBe(task?.id)
  const transcriptRecord = recordsOf(store).find(({ channel }) => channel === 'transcript')
  if (transcriptRecord === undefined) {
    throw new Error('the transcript must be recorded')
  }
  expect(storedRunContext(store.rawRecords, transcriptRecord.seq)).toBeNull()

  await engine.ingest(file.batch(start.length + 1, file.lines.length))
  const observed = store.observations.getSession(session)
  expect(observed?.last_event_at).toBeLessThan(recordedAt)
  expect(observed?.state).not.toBe('unknown')
})

test('instructions, subagent definitions and MCP servers come from the facts of the session', async ({
  onTestFinished,
}) => {
  const workspace = await setup(onTestFinished)
  const { store, engine, root, project, cwd, claudeHome } = workspace
  const rules = join(root, 'rules', 'extra.md')
  await write(join(project, 'CLAUDE.md'), 'Project rules\n')
  await write(join(cwd, 'CLAUDE.md'), 'Unloaded package rules\n')
  await write(rules, 'x'.repeat(1024 ** 2 + 10))
  await write(join(project, '.claude', 'agents', 'reviewer.md'), '---\nname: reviewer\n---\nReview.\n')
  await write(join(claudeHome, 'agents', 'tester.md'), '---\nname: tester\n---\nTest.\n')
  await write(join(claudeHome, 'agents', 'reviewer.md'), 'User reviewer\n')
  const source = { session: 'hooked-session', cwd }
  const longPrompt = `Implement the context. ${'detail '.repeat(20)}`
  const transcript = [
    transcriptLine(source, 'meta-prompt', 1, 'user', { role: 'user', content: 'Injected reminder' }, { isMeta: true }),
    transcriptLine(source, 'first-prompt', 2, 'user', { role: 'user', content: longPrompt }, { promptSource: 'typed' }),
    transcriptLine(
      source,
      'agent-prompt',
      3,
      'user',
      { role: 'user', content: 'Subagent task' },
      { agentId: 'agent-reviewer', isSidechain: true },
    ),
    toolCall(source, 'mcp-search', 4, 'mcp__docs__search', { query: 'context' }),
    toolCall(source, 'mcp-fetch', 5, 'mcp__docs__fetch', { url: 'https://example.com' }),
    toolCall(source, 'mcp-bare', 6, 'mcp__tracker', {}),
    toolCall(source, 'mcp-empty', 7, 'mcp__', {}),
  ]
  const file = claudeFile(workspace, 'hooked', transcript, 9n)
  const loaded = (path: string, arrival: number) =>
    hook(source, 'InstructionsLoaded.session_start.json', `instructions-${String(arrival)}`, arrival, {
      file_path: path,
    })
  const subagent = (agentId: string, agentType: string | null, arrival: number) =>
    hook(source, 'SubagentStart.json', `subagent-${agentId}`, arrival, { agent_id: agentId, agent_type: agentType })
  await engine.ingest(
    hookBatch(
      hook(source, 'SessionStart.startup.json', 'start', 0, {}),
      loaded(join(project, 'CLAUDE.md'), 1),
      loaded(rules, 2),
      loaded(join(root, 'rules', 'missing.md'), 3),
      loaded(join(root, 'rules'), 4),
      loaded('relative/CLAUDE.md', 5),
      subagent('agent-reviewer', 'reviewer', 6),
      subagent('agent-tester', 'tester', 7),
      subagent('agent-general', 'general-purpose', 8),
      subagent('agent-plugin', 'tools:linter', 9),
      subagent('agent-untyped', null, 10),
    ),
  )
  await engine.ingest(file.batch(1, transcript.length))
  const run = runOf('claude', source.session)

  const context = await recorded(store, optionsOf(workspace, run, { limits: { textLength: 40 } }))
  expect(local(workspace, context)).toEqual([
    {
      kind: 'task',
      ref: expect.any(String) as string,
      text: longPrompt.slice(0, 40),
      truncated: { path: 'text', length: longPrompt.length },
    },
    entry('instructions', join(project, 'CLAUDE.md'), 'Project rules\n'),
    { kind: 'instructions', ref: rules, text: 'x'.repeat(40), truncated: { path: 'text', length: 1024 ** 2 + 10 } },
    entry('agent_definition', join(claudeHome, 'agents', 'tester.md'), '---\nname: tester\n---\nTest.\n'),
    entry('agent_definition', join(project, '.claude', 'agents', 'reviewer.md'), '---\nname: reviewer\n---\nReview.\n'),
    entry('mcp_server', 'docs', 'fetch, search'),
    entry('mcp_server', 'tracker', ''),
  ])
})

const codexThread = '01a0f752-40a7-76b2-9df9-5b374f75f98f'

const codexTurn = '01a0f752-4102-7740-9432-0533263c2dc1'

const mcpToolCall = (ordinal: number, server: string, tool: string): string =>
  JSON.stringify({
    timestamp: '2026-10-01T11:56:30.000Z',
    ordinal,
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      thread_id: codexThread,
      turn_id: codexTurn,
      item: {
        type: 'McpToolCall',
        id: `call_${server}_${tool}`,
        server,
        tool,
        arguments: { url: 'https://example.com' },
        status: 'completed',
        result: { content: [{ type: 'text', text: 'ok' }], isError: false },
        duration: { secs: 1, nanos: 0 },
      },
      started_at_ms: 1_790_855_789_000,
      completed_at_ms: 1_790_855_790_000,
    },
  })

const codexLines = (cwd: string): string[] => [
  ...codexRollout({ thread: codexThread, cwd, sessionMeta: { git: { branch: 'main' } } }).slice(0, 20),
  mcpToolCall(20, 'browser', 'navigate'),
]

const codexTask = 'Run the shell command `echo hi` exactly once, then reply with just: OK'

const codexFile = (project: string, name: string, lines: readonly string[], ino: bigint) =>
  jsonlFile({ runtime: 'codex', path: join(project, `${name}.jsonl`), lines, ino })

test('a Codex run takes AGENTS.md along the working directory and its MCP calls', async ({ onTestFinished }) => {
  const workspace = await setup(onTestFinished)
  const { store, engine, project, cwd } = workspace
  await write(join(project, 'AGENTS.md'), 'Codex project rules\n')
  await write(join(project, 'CLAUDE.md'), 'Claude only\n')
  await write(join(project, '.claude', 'skills', 'review', 'SKILL.md'), '---\ndescription: Review\n---\n')
  const lines = codexLines(cwd)
  await engine.ingest(codexFile(project, 'rollout', lines, 11n).batch(1, lines.length))
  const run = runOf('codex', codexThread)

  const context = await recorded(store, optionsOf(workspace, run, { backend: 'codex' }))
  expect(local(workspace, context)).toEqual([
    entry('task', expect.any(String) as string, codexTask),
    entry('instructions', join(project, 'AGENTS.md'), 'Codex project rules\n'),
    entry('mcp_server', 'browser', 'navigate'),
    entry('git', cwd, 'branch: main'),
  ])
  expect(await recordRunContext(store, optionsOf(workspace, run, { backend: 'claude' }))).toBeNull()
  expect(await recordRunContext(store, optionsOf(workspace, run, { backend: 'claude', crossVendor: true }))).toEqual(
    context,
  )
  expect(contextRecords(store)).toHaveLength(1)
})

const attach = (store: Store, run: RunId, root: SessionKey, ...attached: readonly SessionKey[]): void => {
  const grounds = { basis: { kind: 'observed' } as const, evidence: [] }
  const member = (key: SessionKey) => ({ kind: 'session_membership', value: { session: objectId(key), run } }) as const
  store.transaction((transaction) => {
    applyChangeSet(transaction, {
      run,
      author: 'rule',
      at: EpochNs.parse(1n),
      changes: [
        {
          ...grounds,
          op: 'run.create',
          put: {
            kind: 'run',
            value: {
              id: run,
              runtime: root.runtime,
              root_session: objectId(root),
              goal: null,
              brief: null,
              start_pruned: false,
              created_at: EpochNs.parse(1n),
            },
          },
        },
        { ...grounds, op: 'run.create', put: member(root) },
        ...attached.map((key) => ({ ...grounds, op: 'session.move' as const, put: member(key) })),
      ],
    })
  })
}

test('sessions of another vendor enter the context only with crossVendor', async ({ onTestFinished }) => {
  const workspace = await setup(onTestFinished)
  const { store, engine, root, project, cwd } = workspace
  const codexCwd = join(root, 'codex-project')
  await write(join(project, 'CLAUDE.md'), 'Claude rules\n')
  await write(join(codexCwd, 'AGENTS.md'), 'Codex rules\n')
  await createRepository(project)
  await createRepository(codexCwd)
  const claudeTree = await toplevel(cwd)
  const codexTree = await toplevel(codexCwd)
  const source = { session: 'mixed-session', cwd }
  const run = runOf('claude', source.session)
  const rootKey = sessionKey('claude', source.session)
  attach(store, run, rootKey, sessionKey('codex', codexThread))
  const start = claudeTranscript(source).slice(0, 12)
  await engine.ingest(claudeFile(workspace, 'mixed', start, 13n).batch(1, start.length))
  const lines = codexLines(codexCwd)
  await engine.ingest(codexFile(project, 'mixed', lines, 15n).batch(1, lines.length))
  expect(store.observations.getSession(objectId(sessionKey('codex', codexThread)))?.run).toBe(run)
  recordSnapshot(store, rootKey, 'snapshot:claude', taken(claudeTree, ['src'], 'claude-commit', []))
  recordSnapshot(
    store,
    rootKey,
    'snapshot:codex',
    taken(codexTree, ['src'], 'codex-only-commit', [{ status: '??', path: 'codex-only.txt' }]),
  )
  const claudeGit = entry(
    'git',
    claudeTree,
    'branch: HEAD\nmasks: ["src"]\ncommit: claude-commit\nclean under masks: true',
  )

  const own = await recorded(store, optionsOf(workspace, run))
  expect(local(workspace, own)).toEqual([
    entry('task', expect.any(String) as string, firstPrompt),
    entry('instructions', join(project, 'CLAUDE.md'), 'Claude rules\n'),
    claudeGit,
  ])
  const shared = await recorded(store, optionsOf(workspace, run, { crossVendor: true }))
  expect(local(workspace, shared)).toEqual([
    entry('task', expect.any(String) as string, firstPrompt),
    entry('instructions', join(codexCwd, 'AGENTS.md'), 'Codex rules\n'),
    entry('instructions', join(project, 'CLAUDE.md'), 'Claude rules\n'),
    entry('mcp_server', 'browser', 'navigate'),
    ...[
      entry(
        'git',
        codexTree,
        'branch: main\nmasks: ["src"]\ncommit: codex-only-commit\nclean under masks: false\n?? codex-only.txt',
      ),
      claudeGit,
    ].sort(byRef),
  ])
  expect(await recordRunContext(store, optionsOf(workspace, run, { backend: 'codex' }))).toBeNull()
})

interface ObserverCalls {
  readonly input: (fact: Fact, context: RunContext) => ObserverInput
  readonly begin: (id: string, input: ObserverInput, crossVendor: boolean) => void
  readonly respond: (id: string, input: ObserverInput, needs: ObserverNeed[]) => string
  readonly followUp: (previous: string, id: string, crossVendor: boolean) => ObserverInput
}

const observerCalls = (store: Store, run: RunId): ObserverCalls => ({
  input: (fact, context) => ({ ...inputFor(store, [fact], run), context }),
  begin: (id, input, crossVendor) => {
    store.transaction((transaction) => {
      beginObserverCall(transaction, {
        id: ObserverCallId.parse(id),
        backend: 'claude',
        crossVendor,
        input,
        at: recordedAt,
      })
    })
  },
  respond: (id, input, needs) =>
    store.transaction(
      (transaction) =>
        applyObserverResponse(transaction, {
          call: ObserverCallId.parse(id),
          output: { base_version: input.model.version, ops: [], needs },
          at: recordedAt,
        }).status,
    ),
  followUp: (previous, id, crossVendor) =>
    store.transaction((transaction) =>
      beginObserverFollowUp(transaction, {
        previous: ObserverCallId.parse(previous),
        id: ObserverCallId.parse(id),
        at: recordedAt,
        crossVendor,
      }),
    ),
})

const materialsOf = ({ materials }: ObserverInput): string[] =>
  materials.map((material) => (material.kind === 'unavailable' ? material.reason : material.kind))

const runContextKinds: ReadonlySet<Fact['kind']> = new Set(['context', 'definition_listing'])

const sessionFacts = (store: Store, session: string): Fact[] =>
  factsOf(store).filter(({ kind, entity_key }) => !runContextKinds.has(kind) && entity_key.session === session)

test('a context assembled across vendors reaches only an observer with crossVendor', async ({ onTestFinished }) => {
  const workspace = await setup(onTestFinished)
  const { store, engine, root, project, cwd } = workspace
  const codexCwd = join(root, 'codex-project')
  const restricted = 'CODEX-ONLY-RESTRICTED-INSTRUCTIONS'
  await write(join(project, 'CLAUDE.md'), 'Claude rules\n')
  await write(join(codexCwd, 'AGENTS.md'), `${restricted}\n`)
  const source = { session: 'guarded-session', cwd }
  const run = runOf('claude', source.session)
  attach(store, run, sessionKey('claude', source.session), sessionKey('codex', codexThread))
  const start = claudeTranscript(source).slice(0, 12)
  await engine.ingest(claudeFile(workspace, 'guarded', start, 27n).batch(1, start.length))
  const lines = codexLines(codexCwd)
  await engine.ingest(codexFile(project, 'guarded', lines, 29n).batch(1, lines.length))
  const shared = await recorded(store, optionsOf(workspace, run, { crossVendor: true }))
  const own = await recorded(store, optionsOf(workspace, run))
  expect(JSON.stringify(shared.entries)).toContain(restricted)
  expect(JSON.stringify(own.entries)).not.toContain(restricted)
  const subjectsOf = (context: RunContext) => store.facts.ofRecord(context.seq).map(({ entity_key }) => entity_key)
  const runSubject = { kind: 'run', runtime: 'claude', session: source.session }
  expect(subjectsOf(shared)).toEqual([runSubject, sessionKey('codex', codexThread)])
  expect(subjectsOf(own)).toEqual([runSubject])
  const [guardedFact, directFact, openFact] = sessionFacts(store, source.session)
  if (guardedFact === undefined || directFact === undefined || openFact === undefined) {
    throw new Error('the transcript must produce facts of the root session')
  }
  const { input, begin, respond, followUp } = observerCalls(store, run)
  const needs: ObserverNeed[] = [
    { kind: 'raw_record', seq: shared.seq },
    { kind: 'raw_record', seq: own.seq },
  ]
  const blocked = `context record ${String(shared.seq)} comes from a vendor other than backend claude`

  const guarded = input(guardedFact, own)
  begin('guarded', guarded, false)
  expect(respond('guarded', guarded, needs)).toBe('needs_requested')
  const guardedMaterials = followUp('guarded', 'guarded-follow-up', false)
  expect(materialsOf(guardedMaterials)).toEqual(['cross_vendor', 'raw_record'])
  expect(JSON.stringify(guardedMaterials)).not.toContain(restricted)
  expect(respond('guarded-follow-up', guarded, [])).toBe('accepted')

  expect(() => {
    begin('direct', input(directFact, shared), false)
  }).toThrow(blocked)

  const open = input(openFact, shared)
  begin('open', open, true)
  expect(respond('open', open, needs)).toBe('needs_requested')
  expect(() => followUp('open', 'open-follow-up', false)).toThrow(blocked)
  const openMaterials = followUp('open', 'open-follow-up', true)
  expect(materialsOf(openMaterials)).toEqual(['raw_record', 'raw_record'])
  expect(JSON.stringify(openMaterials.materials[0])).toContain(restricted)
})

test('a context shared across vendors stays out of the queue and the batch of a session moved away', async ({
  onTestFinished,
}) => {
  const workspace = await setup(onTestFinished)
  const { store, engine, project, cwd } = workspace
  const restricted = 'CODEX-PRIVATE-MCP-SERVER'
  const lines = [...codexRollout({ thread: codexThread, cwd }).slice(0, 20), mcpToolCall(20, restricted, 'navigate')]
  await engine.ingest(codexFile(project, 'shared', lines, 31n).batch(1, lines.length))
  const source = { session: 'moving-session', cwd }
  const start = claudeTranscript(source).slice(0, 12)
  await engine.ingest(claudeFile(workspace, 'moving', start, 33n).batch(1, start.length))
  const [codexRun, claudeRun] = [runOf('codex', codexThread), runOf('claude', source.session)]
  const session = objectId(sessionKey('claude', source.session))
  await engine.bind({ kind: 'attach', session, run: codexRun })
  const shared = await recorded(store, optionsOf(workspace, codexRun, { backend: 'codex', crossVendor: true }))
  expect(ofKind(shared, 'mcp_server').map(({ ref }) => ref)).toEqual([restricted])
  const contexts = store.facts.ofRecord(shared.seq)
  const moved = contexts.find(({ entity_key: key }) => key.session === source.session)
  if (moved === undefined) {
    throw new Error('the attached session must get a context fact')
  }
  const queued = (run: RunId) => store.interpretations.ofRun(run).map(({ fact }) => fact)
  const contextIds = contexts.map(({ id }) => id)
  const queuedContexts = () => [...queued(codexRun), ...queued(claudeRun)].filter((id) => contextIds.includes(id))
  expect(queuedContexts()).toEqual([])

  await engine.bind({ kind: 'detach', session })
  expect(queuedContexts()).toEqual([])
  expect(queued(claudeRun)).toEqual(sessionFacts(store, source.session).map(({ id }) => id).sort())

  store.transaction((transaction) => {
    transaction.interpretations.queue(claudeRun, contextIds)
  })
  const input = store.transaction((transaction) =>
    startObserverBatch(transaction, {
      run: claudeRun,
      backend: 'claude',
      crossVendor: false,
      id: ObserverCallId.parse('moved-batch'),
      at: recordedAt,
      limits: { facts: 1_000, bytes: 10_000_000, textLength: 4_000, inputTokens: 10_000_000 },
    }),
  )
  expect(input?.batch.facts.map(({ kind }) => kind)).not.toContain('context')
  expect(JSON.stringify(input)).not.toContain(restricted)
  expect(queuedContexts()).toEqual([])
  store.transaction((transaction) => {
    failObserverCall(transaction, { call: ObserverCallId.parse('moved-batch'), outcome: 'failed', at: recordedAt })
  })

  for (const crossVendor of [false, true]) {
    expect(() => {
      store.transaction((transaction) => {
        beginObserverCall(transaction, {
          id: ObserverCallId.parse(`smuggled-${String(crossVendor)}`),
          backend: 'claude',
          crossVendor,
          input: inputFor(store, [moved], claudeRun),
          at: recordedAt,
        })
      })
    }).toThrow(`fact ${moved.id} is not in run ${claudeRun}`)
  }
})

test('a context of the same text assembled with another vendor stays apart from the own one', async ({
  onTestFinished,
}) => {
  const workspace = await setup(onTestFinished)
  const { store, engine, project, cwd } = workspace
  await write(join(project, 'CLAUDE.md'), 'Claude rules\n')
  const source = { session: 'twin-session', cwd }
  const run = runOf('claude', source.session)
  attach(store, run, sessionKey('claude', source.session), sessionKey('codex', codexThread))
  const start = claudeTranscript(source).slice(0, 12)
  await engine.ingest(claudeFile(workspace, 'twin', start, 31n).batch(1, start.length))
  const lines = codexRollout({ thread: codexThread, cwd: join('relative', 'codex') }).slice(0, 20)
  await engine.ingest(codexFile(project, 'twin', lines, 33n).batch(1, lines.length))
  expect(store.observations.getSession(objectId(sessionKey('codex', codexThread)))?.run).toBe(run)

  const shared = await recorded(store, optionsOf(workspace, run, { crossVendor: true }))
  const own = await recorded(store, optionsOf(workspace, run))
  expect(own.entries).toEqual(shared.entries)
  expect(own.seq).not.toBe(shared.seq)
  expect(await recordRunContext(store, optionsOf(workspace, run))).toEqual(own)
  expect(await recordRunContext(store, optionsOf(workspace, run, { crossVendor: true }))).toEqual(shared)
  expect(contextRecords(store)).toHaveLength(2)

  const [ownFact, sharedFact] = sessionFacts(store, source.session)
  if (ownFact === undefined || sharedFact === undefined) {
    throw new Error('the transcript must produce facts of the root session')
  }
  const { input, begin, respond } = observerCalls(store, run)
  const guarded = input(ownFact, own)
  begin('guarded', guarded, false)
  expect(respond('guarded', guarded, [])).toBe('accepted')
  expect(() => {
    begin('shared', input(sharedFact, shared), false)
  }).toThrow(`context record ${String(shared.seq)} comes from a vendor other than backend claude`)
})

test('a nested worktree does not admit the snapshot of an enclosing worktree of a skipped session', async ({
  onTestFinished,
}) => {
  const workspace = await setup(onTestFinished)
  const { store, engine, root, project } = workspace
  const parent = join(root, 'repository')
  const nested = join(parent, '.worktrees', 'claude')
  const helper = { session: 'parent-helper-session', cwd: join(parent, 'src') }
  await createRepository(parent)
  await mkdir(helper.cwd, { recursive: true })
  await git(parent, 'worktree', 'add', '--quiet', '-b', 'claude', nested)
  const parentTree = await toplevel(parent)
  const nestedTree = await toplevel(nested)
  expect(nestedTree).not.toBe(parentTree)
  const source = { session: 'nested-session', cwd: nested }
  const run = runOf('claude', source.session)
  const rootKey = sessionKey('claude', source.session)
  attach(store, run, rootKey, sessionKey('codex', codexThread), sessionKey('claude', helper.session))
  const start = claudeTranscript(source).slice(0, 12)
  await engine.ingest(claudeFile(workspace, 'nested-claude', start, 23n).batch(1, start.length))
  const lines = codexLines(parent)
  await engine.ingest(codexFile(project, 'nested-codex', lines, 25n).batch(1, lines.length))
  expect(store.observations.getSession(objectId(sessionKey('codex', codexThread)))?.run).toBe(run)
  recordSnapshot(
    store,
    rootKey,
    'snapshot:parent',
    taken(parentTree, ['src'], 'parent-commit', [{ status: ' M', path: 'src/codex-only.txt' }]),
  )
  recordSnapshot(store, rootKey, 'snapshot:nested', taken(nestedTree, ['src'], 'nested-commit', []))
  const parentState = 'masks: ["src"]\ncommit: parent-commit\nclean under masks: false\n M src/codex-only.txt'
  const nestedGit = entry(
    'git',
    nestedTree,
    'branch: HEAD\nmasks: ["src"]\ncommit: nested-commit\nclean under masks: true',
  )

  expect(ofKind(await recorded(store, optionsOf(workspace, run)), 'git')).toEqual([nestedGit])
  expect(ofKind(await recorded(store, optionsOf(workspace, run, { crossVendor: true })), 'git')).toEqual(
    [entry('git', parentTree, `branch: main\n${parentState}`), nestedGit].sort(byRef),
  )

  await engine.ingest(hookBatch(hook(helper, 'SessionStart.startup.json', 'start', 0, {})))
  expect(store.observations.getSession(objectId(sessionKey('claude', helper.session)))?.run).toBe(run)
  expect(ofKind(await recorded(store, optionsOf(workspace, run)), 'git')).toEqual(
    [entry('git', parentTree, parentState), nestedGit].sort(byRef),
  )
})

test('skills and subagent definitions of the same name stay apart across projects', async ({ onTestFinished }) => {
  const workspace = await setup(onTestFinished)
  const { store, engine, root, cwd } = workspace
  const other = join(root, 'other-project')
  const skillFile = (directory: string, name: string): string => join(directory, '.claude', 'skills', name, 'SKILL.md')
  const reviewerFile = join(other, '.claude', 'agents', 'reviewer.md')
  await write(skillFile(cwd, 'review'), '---\ndescription: Review project A\n---\n')
  await write(skillFile(other, 'review'), '---\ndescription: Review project B\n---\n')
  await write(skillFile(other, 'lint'), '---\ndescription: Lint project B\n---\n')
  await write(reviewerFile, 'Reviewer of project B\n')
  const first = { session: 'project-a-session', cwd }
  const second = { session: 'project-b-session', cwd: other }
  const run = runOf('claude', first.session)
  attach(store, run, sessionKey('claude', first.session), sessionKey('claude', second.session))
  const lines = (source: Source, offset: number): string[] => [
    transcriptLine(
      source,
      `${source.session}-prompt`,
      offset,
      'user',
      { role: 'user', content: `Work in ${source.cwd}` },
      { promptSource: 'typed' },
    ),
    ...skillCall(source, `${source.session}-review`, offset + 1, 'review'),
    ...skillCall(source, `${source.session}-lint`, offset + 3, 'lint'),
  ]
  const subagent = (source: Source, arrival: number) =>
    hook(source, 'SubagentStart.json', 'subagent', arrival, {
      agent_id: `${source.session}-agent`,
      agent_type: 'reviewer',
    })
  await engine.ingest(
    hookBatch(
      hook(first, 'SessionStart.startup.json', 'start', 0, {}),
      hook(second, 'SessionStart.startup.json', 'start', 1, {}),
      subagent(first, 2),
      subagent(second, 3),
    ),
  )
  const firstLines = lines(first, 10)
  const secondLines = lines(second, 20)
  await engine.ingest(claudeFile(workspace, 'project-a', firstLines, 19n).batch(1, firstLines.length))
  await engine.ingest(claudeFile(workspace, 'project-b', secondLines, 21n).batch(1, secondLines.length))
  expect(store.observations.getSession(objectId(sessionKey('claude', second.session)))?.run).toBe(run)

  const context = await recorded(store, optionsOf(workspace, run))
  expect(ofKind(context, 'skill')).toEqual([
    entry('skill', skillFile(other, 'lint'), 'Lint project B'),
    entry('skill', skillFile(other, 'review'), 'Review project B'),
    entry('skill', skillFile(cwd, 'review'), 'Review project A'),
    entry('skill', listedRef('lint', first), ''),
  ])
  expect(ofKind(context, 'agent_definition')).toEqual([
    entry('agent_definition', reviewerFile, 'Reviewer of project B\n'),
  ])
})

type Listed = Readonly<Record<string, string | null>>

interface DefinedSession {
  readonly source: Source
  readonly agents: Listed
  readonly skills: Listed
  readonly prompts?: Readonly<Record<string, readonly string[]>>
}

interface DefinedAgent {
  readonly id: string
  readonly type: string
  readonly prompt: string | null
  readonly order: number
}

const definedAgents = ({ source, agents, prompts = {} }: DefinedSession): DefinedAgent[] =>
  Object.keys(agents).flatMap((type) => {
    const given = prompts[type] ?? []
    return (given.length === 0 ? [null] : given).map((prompt, index) => ({
      id: `${source.session}-${type}-${String(index)}`,
      type,
      prompt,
      order: index,
    }))
  })

const listedLines = (listed: Listed): string[] =>
  Object.entries(listed).flatMap(([name, description]) => (description === null ? [] : [`- ${name}: ${description}`]))

const listedNames = (listed: Listed): string[] =>
  Object.entries(listed).flatMap(([name, description]) => (description === null ? [] : [name]))

const listings = ({ source, agents, skills }: DefinedSession, second: number): string[] => [
  ...(listedNames(agents).length === 0
    ? []
    : [
        attachmentLine(source, `${source.session}-agents`, second, {
          type: 'agent_listing_delta',
          addedTypes: listedNames(agents),
          addedLines: listedLines(agents),
        }),
      ]),
  ...(listedNames(skills).length === 0
    ? []
    : [
        attachmentLine(source, `${source.session}-skills`, second + 1, {
          type: 'skill_listing',
          content: listedLines(skills).join('\n'),
          names: listedNames(skills),
        }),
      ]),
]

const promptSnapshots = (defined: DefinedSession, second: number): string[] =>
  definedAgents(defined).flatMap(({ id, prompt, order }) =>
    prompt === null
      ? []
      : [
          JSON.stringify({
            type: 'attachment',
            sessionId: defined.source.session,
            agentId: id,
            isSidechain: true,
            uuid: `${id}-prompt`,
            timestamp: timestampAt(second, order),
            cwd: defined.source.cwd,
            attachment: { type: 'prompt_snapshot', systemPrompt: [prompt, 'Notes for every agent.'] },
          }),
        ],
  )

const definedRun = async (workspace: Workspace, sessions: readonly DefinedSession[]): Promise<RunContext> => {
  const { store, engine } = workspace
  const [root, ...attached] = sessions.map(({ source }) => sessionKey('claude', source.session))
  if (root === undefined) {
    throw new Error('a run needs a root session')
  }
  const run = runId(root)
  attach(store, run, root, ...attached)
  await engine.ingest(
    hookBatch(
      ...sessions.flatMap((defined, index) => [
        hook(defined.source, 'SessionStart.startup.json', 'start', index * 10, {}),
        ...definedAgents(defined).map(({ id, type }, offset) =>
          hook(defined.source, 'SubagentStart.json', `subagent-${id}`, index * 10 + offset + 1, {
            agent_id: id,
            agent_type: type,
          }),
        ),
      ]),
    ),
  )
  for (const [index, defined] of sessions.entries()) {
    const { source, skills } = defined
    const second = (index + 1) * 10
    const lines = [
      transcriptLine(
        source,
        `${source.session}-prompt`,
        second,
        'user',
        { role: 'user', content: `Check the notes in ${source.cwd}` },
        { promptSource: 'typed' },
      ),
      ...listings(defined, second + 1),
      ...promptSnapshots(defined, second + 2),
      ...Object.keys(skills).flatMap((skill, offset) =>
        skillCall(source, `${source.session}-skill-${String(offset)}`, second + 3 + offset * 2, skill),
      ),
    ]
    await engine.ingest(claudeFile(workspace, source.session, lines, BigInt(31 + index)).batch(1, lines.length))
  }
  for (const { source } of sessions) {
    expect(store.observations.getSession(objectId(sessionKey('claude', source.session)))?.run).toBe(run)
  }
  return recorded(store, optionsOf(workspace, run))
}

const checker = 'notes-checker'

const greeting = 'kit:greeting'

const checksNotes = 'Checks the notes. (Tools: Bash)'

const checksFlag = 'Checks the notes given for the run. (Tools: Read)'

test.for([
  ['one working directory', false],
  ['different working directories', true],
] as const)(
  'a subagent and a skill that sessions of one run list differently keep a definition per text with its sessions, in %s',
  async ([, apart], { onTestFinished }) => {
    const workspace = await setup(onTestFinished)
    const { root, cwd } = workspace
    const other = join(root, 'other-project')
    await mkdir(other, { recursive: true })
    const first = { session: 'listing-first-session', cwd }
    const second = { session: 'listing-second-session', cwd: apart ? other : cwd }
    const third = { session: 'listing-third-session', cwd }

    const context = await definedRun(workspace, [
      { source: first, agents: { [checker]: checksNotes }, skills: { [greeting]: 'Greets the reader.' } },
      { source: second, agents: { [checker]: checksFlag }, skills: { [greeting]: 'Greets the run.' } },
      { source: third, agents: { [checker]: checksNotes }, skills: { [greeting]: 'Greets the reader.' } },
    ])

    expect(ofKind(context, 'agent_definition')).toEqual(
      [
        entry('agent_definition', listedRef(checker, first, third), checksNotes),
        entry('agent_definition', listedRef(checker, second), checksFlag),
      ].sort(byRef),
    )
    expect(ofKind(context, 'skill')).toEqual(
      [
        entry('skill', listedRef(greeting, first, third), 'Greets the reader.'),
        entry('skill', listedRef(greeting, second), 'Greets the run.'),
      ].sort(byRef),
    )
  },
)

test('a session that does not list the subagent or the skill takes nothing from the listing of another session', async ({
  onTestFinished,
}) => {
  const workspace = await setup(onTestFinished)
  const listed = { session: 'listed-session', cwd: workspace.cwd }
  const unlisted = { session: 'unlisted-session', cwd: workspace.cwd }

  const context = await definedRun(workspace, [
    { source: listed, agents: { [checker]: checksNotes }, skills: { [greeting]: 'Greets the reader.' } },
    { source: unlisted, agents: { [checker]: null }, skills: { [greeting]: null } },
  ])

  expect(ofKind(context, 'agent_definition')).toEqual([
    entry('agent_definition', listedRef(checker, listed), checksNotes),
  ])
  expect(ofKind(context, 'skill')).toEqual(
    [
      entry('skill', listedRef(greeting, listed), 'Greets the reader.'),
      entry('skill', listedRef(greeting, unlisted), ''),
    ].sort(byRef),
  )
})

test('a file of the subagent type is its definition only when it gives the name, the listed line and the prompt the subagent ran with', async ({
  onTestFinished,
}) => {
  const workspace = await setup(onTestFinished)
  const { project, cwd, claudeHome } = workspace
  const reviewerFile = join(project, '.claude', 'agents', 'reviewer.md')
  const reviewer = '---\nname: reviewer\ndescription: Reviews the notes.\ntools: Bash, Read\n---\n\nReview the notes.\n'
  const checkFlag = 'Check the notes given for the run.'
  const scribe = 'Write the notes.'
  await write(
    join(cwd, '.claude', 'agents', 'reviewer.md'),
    '---\nname: reviewer\ndescription: Reviews the notes.\ntools: Bash, Read\n---\nReview the package.\n',
  )
  await write(
    join(cwd, '..', '.claude', 'agents', 'reviewer.md'),
    '---\nname: package-reviewer\ndescription: Reviews the notes.\ntools: Bash, Read\n---\nReview the notes.\n',
  )
  await write(reviewerFile, reviewer)
  await write(
    join(project, '.claude', 'agents', `${checker}.md`),
    `---\nname: ${checker}\ndescription: Checks the notes given for the run.\n---\n${checkFlag}\n`,
  )
  await write(
    join(claudeHome, 'agents', `${checker}.md`),
    `---\nname: ${checker}\ndescription: Checks the notes given for the run.\ntools:\n  - Read\n\n  - Bash\n---\n${checkFlag}\n`,
  )
  await write(
    join(project, '.claude', 'agents', 'linter.md'),
    '---\nname: linter\ndescription: Lints the notes.\ntools: Read\n---\nLint the notes.\n',
  )
  await write(join(project, '.claude', 'agents', 'scribe.md'), '---\nname: scribe\ndescription: Writes.\n---\nWrite.\n')
  const source = { session: 'file-session', cwd }

  const context = await definedRun(workspace, [
    {
      source,
      agents: {
        reviewer: 'Reviews the notes. (Tools: Bash, Read)',
        [checker]: checksFlag,
        linter: 'Lints the notes. (Tools: Read)',
        scribe: null,
      },
      skills: {},
      prompts: { reviewer: ['Review the notes.'], [checker]: [checkFlag], scribe: [scribe] },
    },
  ])

  expect(ofKind(context, 'agent_definition')).toEqual(
    [
      entry('agent_definition', reviewerFile, reviewer),
      entry('agent_definition', listedRef(checker, source), `${checksFlag}\n\n${checkFlag}`),
      entry('agent_definition', listedRef('linter', source), 'Lints the notes. (Tools: Read)'),
      entry('agent_definition', listedRef('scribe', source), scribe),
    ].sort(byRef),
  )
})

test.for([
  ['a file that gives one of them', true],
  ['no file', false],
] as const)(
  'subagents of one type that ran with different prompts in a session keep each prompt, with %s',
  async ([, filed], { onTestFinished }) => {
    const workspace = await setup(onTestFinished)
    const { project, cwd } = workspace
    const reviewerFile = join(project, '.claude', 'agents', 'reviewer.md')
    const reviewer = '---\nname: reviewer\ndescription: Reviews the code.\ntools: Bash, Read\n---\nReview the UI.\n'
    const listed = 'Reviews the code. (Tools: Bash, Read)'
    if (filed) {
      await write(reviewerFile, reviewer)
    }
    const source = { session: 'prompts-session', cwd }

    const context = await definedRun(workspace, [
      {
        source,
        agents: { reviewer: listed },
        skills: {},
        prompts: { reviewer: ['Review the API.', 'Review the UI.'] },
      },
    ])

    expect(ofKind(context, 'agent_definition')).toEqual(
      filed
        ? [
            entry('agent_definition', reviewerFile, reviewer),
            entry('agent_definition', listedRef('reviewer', source), `${listed}\n\nReview the API.`),
          ].sort(byRef)
        : [entry('agent_definition', listedRef('reviewer', source), `${listed}\n\nReview the API.\n\nReview the UI.`)],
    )
  },
)

test('a file stands for a listed subagent in each form of its tools and disallowed tools', async ({
  onTestFinished,
}) => {
  const workspace = await setup(onTestFinished)
  const { project, cwd } = workspace
  const forms = {
    'every-tool': ['', 'All tools'],
    'any-tool': ['tools: "*"\n', 'All tools'],
    'flow-tools': ['tools: [Read, "Grep", ]\n', 'Read, Grep'],
    'block-tools': ["tools:\n  - Read\n  - 'Bash(git log:*)'\n", 'Read, Bash(git log:*)'],
    'spaced-tools': ['tools:\n  - Read\n\n  - Grep\n', 'Read, Grep'],
    'tabbed-tools': ['tools:\n\t- Read\n\t- Grep\n', 'Read, Grep'],
    'denied-tools': ['disallowedTools: Write, Edit\n', 'All tools except Write, Edit'],
    'kept-tools': ['tools: Read Grep Write\ndisallowedTools: [Write]\n', 'Read, Grep'],
    'no-tool': ['tools: Write\ndisallowedTools:\n- Write\n', 'None'],
  } as const
  const files = Object.entries(forms).map(([type, [fields]]) => ({
    path: join(project, '.claude', 'agents', `${type}.md`),
    text: `---\nname: ${type}\ndescription: Works with ${type}.\n${fields}---\nWork.\n`,
  }))
  for (const { path, text } of files) {
    await write(path, text)
  }
  const listed = Object.fromEntries(
    Object.entries(forms).map(([type, [, tools]]) => [type, `Works with ${type}. (Tools: ${tools})`]),
  )
  const prompts = Object.fromEntries(Object.keys(forms).map((type) => [type, ['Work.']]))

  const context = await definedRun(workspace, [
    { source: { session: 'forms-session', cwd }, agents: listed, skills: {}, prompts },
  ])

  expect(ofKind(context, 'agent_definition')).toEqual(
    files.map(({ path, text }) => entry('agent_definition', path, text)).sort(byRef),
  )
})

test('git snapshots give the latest state of each worktree under each set of masks', async ({ onTestFinished }) => {
  const workspace = await setup(onTestFinished)
  const { store, engine, root, project, cwd } = workspace
  const tools = join(root, 'tools')
  const host = join(root, 'host')
  const library = join(host, 'library')
  const elsewhere = join(root, 'elsewhere')
  const scratch = join(root, 'scratch')
  for (const repository of [project, tools, host, library, elsewhere]) {
    await createRepository(repository)
  }
  await mkdir(join(tools, 'bin'), { recursive: true })
  await mkdir(scratch, { recursive: true })
  const [projectTree, toolsTree, hostTree, libraryTree, elsewhereTree] = await Promise.all([
    toplevel(project),
    toplevel(tools),
    toplevel(host),
    toplevel(library),
    toplevel(elsewhere),
  ])
  const source = { session: 'git-session', cwd }
  const start = claudeTranscript(source).slice(0, 12)
  const commandIn = (directory: string, call: string, second: number): string =>
    toolCall({ session: source.session, cwd: directory }, call, second, 'Bash', { command: 'make' })
  const later = [
    commandIn(join(tools, 'bin'), 'bash-tools', 40),
    commandIn(library, 'bash-library', 41),
    commandIn(scratch, 'bash-scratch', 42),
  ]
  await engine.ingest(claudeFile(workspace, 'git', [...start, ...later], 17n).batch(1, start.length + later.length))
  const key = sessionKey('claude', source.session)
  const run = runOf('claude', source.session)
  recordSnapshot(store, key, 'snapshot:old', taken(projectTree, ['src'], 'aaa111', []))
  recordSnapshot(
    store,
    key,
    'snapshot:new',
    taken(projectTree, ['src'], 'bbb222', [{ status: ' M', path: 'src/index.ts' }]),
  )
  recordSnapshot(store, key, 'snapshot:docs', taken(projectTree, ['docs'], 'bbb222', []))
  recordSnapshot(store, key, 'snapshot:pair', taken(projectTree, ['test', 'lib'], 'bbb222', []))
  recordSnapshot(store, key, 'snapshot:broken', taken(scratch, ['src'], null, [], 'not a git repository'))
  recordSnapshot(store, key, 'snapshot:tools', taken(toolsTree, ['.'], 'ccc333', []))
  recordSnapshot(store, key, 'snapshot:host', taken(hostTree, ['.'], 'ddd444', [{ status: '??', path: 'host.txt' }]))
  recordSnapshot(store, key, 'snapshot:library', taken(libraryTree, ['.'], 'eee555', []))
  recordSnapshot(store, key, 'snapshot:elsewhere', taken(elsewhereTree, ['.'], 'fff666', []))
  recordSnapshot(store, key, 'snapshot:relative', taken(join('relative', 'tree'), ['.'], 'aaa777', []))

  const context = await recorded(store, optionsOf(workspace, run))
  expect(ofKind(context, 'git')).toEqual(
    [
      entry(
        'git',
        projectTree,
        [
          'branch: HEAD',
          'masks: ["docs"]',
          'commit: bbb222',
          'clean under masks: true',
          'masks: ["lib","test"]',
          'commit: bbb222',
          'clean under masks: true',
          'masks: ["src"]',
          'commit: bbb222',
          'clean under masks: false',
          ' M src/index.ts',
        ].join('\n'),
      ),
      entry('git', scratch, 'masks: ["src"]\ncommit: unknown\nclean under masks: false\nerror: not a git repository'),
      entry('git', toolsTree, 'masks: ["."]\ncommit: ccc333\nclean under masks: true'),
      entry('git', libraryTree, 'masks: ["."]\ncommit: eee555\nclean under masks: true'),
    ].sort(byRef),
  )
  expect(store.observations.getSession(objectId(key))?.last_event_at).toBeLessThan(recordedAt)
})

test('a run without sources or without its root session has no context', async ({ onTestFinished }) => {
  const workspace = await setup(onTestFinished)
  const { store, engine } = workspace
  const session = 'silent-session'
  await engine.ingest(
    hookBatch({
      file: `${session}-start.evt`,
      payload: claudeHook('SessionStart.startup.json', { session, cwd: join('relative', 'project') }),
    }),
  )
  const run = runOf('claude', session)
  expect(store.observations.getSession(objectId(sessionKey('claude', session)))?.run).toBe(run)
  expect(await recordRunContext(store, optionsOf(workspace, run))).toBeNull()
  expect(await recordRunContext(store, optionsOf(workspace, runOf('claude', 'unknown-session')))).toBeNull()
  expect(contextRecords(store)).toEqual([])
})

const pruneRun = (engine: Engine, run: RunId) => engine.prune({ scope: 'run', run }, () => Promise.resolve(null))

const ingestSessions = async (workspace: Workspace, sessions: readonly Source[], ino: bigint): Promise<void> => {
  for (const [index, source] of sessions.entries()) {
    const lines = claudeTranscript(source).slice(0, 12)
    await workspace.engine.ingest(claudeFile(workspace, source.session, lines, ino + BigInt(index)).batch(1, lines.length))
  }
}

test('pruning a session that left the run keeps the context the run recorded with it and the call that cited it', async ({
  onTestFinished,
}) => {
  const workspace = await setup(onTestFinished)
  const { store, engine, project, cwd } = workspace
  await write(join(project, 'CLAUDE.md'), 'Project rules\n')
  const root = { session: 'kept-root', cwd }
  const participant = { session: 'pruned-participant', cwd }
  await ingestSessions(workspace, [root, participant], 41n)
  const run = runOf('claude', root.session)
  const participantRun = runOf('claude', participant.session)
  const participantKey = sessionKey('claude', participant.session)
  const { binding } = await engine.bind({ kind: 'attach', session: objectId(participantKey), run })
  const context = await recorded(store, optionsOf(workspace, run))
  const subjectsOf = () => store.facts.ofRecord(context.seq).map(({ entity_key }) => entity_key)
  const runSubject = { kind: 'run', runtime: 'claude', session: root.session }
  expect(subjectsOf()).toEqual([runSubject, participantKey])
  const [fact] = sessionFacts(store, root.session)
  if (fact === undefined) {
    throw new Error('the transcript must produce facts of the root session')
  }
  const { input, begin, respond } = observerCalls(store, run)
  const cited = input(fact, context)
  begin('cited', cited, false)
  expect(respond('cited', cited, [])).toBe('accepted')
  await engine.revokeBinding(binding.id)
  expect(store.observations.getSession(objectId(participantKey))?.run).toBe(participantRun)
  const call = store.observerCalls.get(ObserverCallId.parse('cited'))

  const pruned = await pruneRun(engine, participantRun)

  expect(pruned.runs).toEqual([participantRun])
  expect(store.observations.getSession(objectId(participantKey))).toBeNull()
  expect(store.facts.ofSession(participantKey)).toEqual([])
  expect(storedRunContext(store.rawRecords, context.seq)).toEqual(context)
  expect(subjectsOf()).toEqual([runSubject])
  expect(call?.input.context?.seq).toBe(context.seq)
  expect(store.observerCalls.get(ObserverCallId.parse('cited'))).toEqual(call)

  await pruneRun(engine, run)
  expect(contextRecords(store)).toEqual([])
  expect(contextFacts(store)).toEqual([])
  expect(store.observerCalls.get(ObserverCallId.parse('cited'))).toBeNull()
})

test('a run keeps its context and git snapshots when its root session moves to a run that is pruned, and loses them with its own prune', async ({
  onTestFinished,
}) => {
  const workspace = await setup(onTestFinished)
  const { store, engine, project, cwd } = workspace
  await write(join(project, 'CLAUDE.md'), 'Project rules\n')
  const root = { session: 'moved-root', cwd }
  const host = { session: 'pruned-host', cwd }
  await ingestSessions(workspace, [root, host], 51n)
  const run = runOf('claude', root.session)
  const rootKey = sessionKey('claude', root.session)
  const context = await recorded(store, optionsOf(workspace, run))
  recordSnapshot(store, rootKey, 'snapshot:moved-root', taken(cwd, ['.'], 'root-commit', []))
  const ofRun = () => recordsOf(store).filter(({ channel }) => channel === 'context' || channel === 'snapshot')
  const runFacts = () => factsOf(store).filter(({ entity_key }) => entity_key.kind === 'run')
  const [records, facts] = [ofRun(), runFacts()]
  expect(records.map(({ channel }) => channel).sort()).toEqual(['context', 'snapshot'])
  await engine.bind({ kind: 'attach', session: objectId(rootKey), run: runOf('claude', host.session) })

  await pruneRun(engine, runOf('claude', host.session))

  expect(store.observations.getSession(objectId(rootKey))).toBeNull()
  expect(factsOf(store).filter(({ entity_key }) => entity_key.kind !== 'run')).toEqual([])
  expect(ofRun()).toEqual(records)
  expect(runFacts()).toEqual(facts)
  expect(storedRunContext(store.rawRecords, context.seq)).toEqual(context)

  await pruneRun(engine, run)
  expect(ofRun()).toEqual([])
  expect(factsOf(store)).toEqual([])
})
