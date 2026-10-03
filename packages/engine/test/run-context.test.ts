import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  DedupeKey,
  EpochNs,
  type GitSnapshotPayload,
  type JsonValue,
  NormalizerVersion,
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
  createEngine,
  type Engine,
  recordRunContext,
  type RunContextOptions,
  storedRunContext,
} from '@aang/engine'
import type { Store } from '@aang/store'
import { expect, test } from 'vitest'
import { type HookDelivery, hookBatch, jsonlFile } from './batches.js'
import { adapters, factsOf, recordsOf, sessionKey } from './harness.js'
import { createHome } from './home.js'
import { claudeHook, claudeTranscript, codexRollout } from './samples.js'

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

const firstPrompt = [
  'Step 1: run `echo hi` with the Bash tool.',
  'Step 2: use the Agent tool with subagent_type "pinger" and prompt "ping".',
  'Step 3: reply with exactly: OK',
].join(' ')

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
    timestamp: new Date(Date.UTC(2026, 9, 1, 12, 0, second)).toISOString(),
    cwd: source.cwd,
    message,
    ...extra,
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
  expect(ofKind(invoked, 'skill')).toEqual([
    entry('skill', 'bare', ''),
    entry('skill', 'notes', 'First line\n\nSecond line'),
    entry('skill', 'plain', 'Spans two lines'),
    entry('skill', 'release', 'Cut a release and tag it'),
    entry('skill', 'review', 'Nearest review of the package'),
    entry('skill', 'tools:formatter', ''),
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
    entry('agent_definition', 'reviewer', '---\nname: reviewer\n---\nReview.\n'),
    entry('agent_definition', 'tester', '---\nname: tester\n---\nTest.\n'),
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

const attach = (store: Store, run: RunId, root: SessionKey, attached: SessionKey): void => {
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
        { ...grounds, op: 'session.move', put: member(attached) },
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
  const source = { session: 'mixed-session', cwd }
  const run = runOf('claude', source.session)
  attach(store, run, sessionKey('claude', source.session), sessionKey('codex', codexThread))
  const start = claudeTranscript(source).slice(0, 12)
  await engine.ingest(claudeFile(workspace, 'mixed', start, 13n).batch(1, start.length))
  const lines = codexLines(codexCwd)
  await engine.ingest(codexFile(project, 'mixed', lines, 15n).batch(1, lines.length))
  expect(store.observations.getSession(objectId(sessionKey('codex', codexThread)))?.run).toBe(run)

  const own = await recorded(store, optionsOf(workspace, run))
  expect(local(workspace, own)).toEqual([
    entry('task', expect.any(String) as string, firstPrompt),
    entry('instructions', join(project, 'CLAUDE.md'), 'Claude rules\n'),
    entry('git', cwd, 'branch: HEAD'),
  ])
  const shared = await recorded(store, optionsOf(workspace, run, { crossVendor: true }))
  expect(local(workspace, shared)).toEqual([
    entry('task', expect.any(String) as string, firstPrompt),
    entry('instructions', join(codexCwd, 'AGENTS.md'), 'Codex rules\n'),
    entry('instructions', join(project, 'CLAUDE.md'), 'Claude rules\n'),
    entry('mcp_server', 'browser', 'navigate'),
    entry('git', codexCwd, 'branch: main'),
    entry('git', cwd, 'branch: HEAD'),
  ])
  expect(await recordRunContext(store, optionsOf(workspace, run, { backend: 'codex' }))).toBeNull()
})

test('git snapshots of the run add the commit and the state of the worktree', async ({ onTestFinished }) => {
  const workspace = await setup(onTestFinished)
  const { store, engine, project, cwd } = workspace
  const source = { session: 'git-session', cwd }
  const start = claudeTranscript(source).slice(0, 12)
  await engine.ingest(claudeFile(workspace, 'git', start, 17n).batch(1, start.length))
  const run = runOf('claude', source.session)
  const snapshot = (dedupe: string, payload: GitSnapshotPayload): void => {
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
          entity_key: { kind: 'run', runtime: 'claude', session: source.session },
          speaker: 'runtime',
          urgent: false,
          at: recordedAt,
          runtime_ids: {
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
          },
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
    head: string | null,
    entries: GitSnapshotPayload['entries'],
    error: string | null,
  ): GitSnapshotPayload => ({
    worktree,
    trigger: 'check',
    masks: ['.'],
    head,
    entries,
    clean: head !== null && entries.length === 0,
    error,
  })
  snapshot('snapshot:old', taken(project, 'aaa111', [], null))
  snapshot('snapshot:new', taken(project, 'bbb222', [{ status: ' M', path: 'src/index.ts' }], null))
  snapshot('snapshot:broken', taken(cwd, null, [], 'not a git repository'))

  const context = await recorded(store, optionsOf(workspace, run))
  expect(ofKind(context, 'git')).toEqual([
    entry('git', project, 'commit: bbb222\nclean: false\n M src/index.ts'),
    entry('git', cwd, 'branch: HEAD\ncommit: unknown\nclean: false\nerror: not a git repository'),
  ])
  expect(store.observations.getSession(objectId(sessionKey('claude', source.session)))?.last_event_at).toBeLessThan(
    recordedAt,
  )
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
