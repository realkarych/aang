import { createHash } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  type ArtifactVersion,
  type ArtifactVersionId,
  EpochNs,
  type Fact,
  type JsonValue,
  ObserverCallId,
  type RunId,
  type SessionKey,
} from '@aang/contract'
import { contentHash, objectId, runId } from '@aang/contract/ids'
import { applyChangeSet, applyObserverResponse, beginObserverCall, createEngine, type Engine } from '@aang/engine'
import type { Store } from '@aang/store'
import { expect, test } from 'vitest'
import { hookBatch, jsonlFile } from './batches.js'
import { adapters, factsOf, sessionKey } from './harness.js'
import { createHome, type Home } from './home.js'
import { at } from './model.js'
import { createStage, inputFor, response, temporary } from './observer-fixtures.js'
import { type Register, writeFiles } from './repository.js'
import { claudeHook, codexHook, codexRollout } from './samples.js'

interface Source {
  readonly session: string
  readonly cwd: string
}

type Call = readonly [id: string, tool: string, input: JsonValue, result: Result]

type Result = 'ok' | 'error' | 'denied'

const readAt = at(500)

const observed = { kind: 'observed' } as const

const setup = async (register: Register, maxBlobBytes?: number) => {
  const home = await createHome(register)
  const project = join(home.path, '..', 'project')
  await writeFiles(project, {})
  const store = home.open()
  const engine = startEngine(store, maxBlobBytes)
  return { home, store, engine, project }
}

const startEngine = (store: Store, maxBlobBytes?: number): Engine =>
  createEngine({
    store,
    adapters,
    watch: { all: true, roots: [] },
    now: () => readAt,
    ...(maxBlobBytes === undefined ? {} : { maxBlobBytes }),
  })

const line = (source: Source, uuid: string, second: number, type: 'assistant' | 'user', message: JsonValue, extra = {}) =>
  JSON.stringify({
    type,
    sessionId: source.session,
    uuid,
    timestamp: new Date(Date.UTC(2026, 9, 1, 10, 0, second)).toISOString(),
    cwd: source.cwd,
    message,
    ...extra,
  })

const callLines = (source: Source, [id, tool, input, result]: Call, second: number): string[] => [
  line(source, `use-${id}`, second, 'assistant', {
    id: `message-${id}`,
    role: 'assistant',
    content: [{ type: 'tool_use', id, name: tool, input }],
  }),
  line(
    source,
    `result-${id}`,
    second + 1,
    'user',
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: id, content: result === 'ok' ? 'done' : 'Exit code 1\nfailed', is_error: result !== 'ok' },
      ],
    },
    result === 'denied' ? { toolDenialKind: 'user' } : {},
  ),
]

const ingestCalls = async (engine: Engine, source: Source, calls: readonly Call[], ino = 7n): Promise<void> => {
  const lines = calls.flatMap((call, index) => callLines(source, call, index * 2))
  const file = jsonlFile({ runtime: 'claude', path: join(source.cwd, `${source.session}.jsonl`), lines, ino })
  await engine.ingest(file.batch(1, lines.length))
}

const bash = (id: string, command: string, result: Result = 'ok'): Call => [id, 'Bash', { command, description: 'Run' }, result]

const write = (id: string, file_path: string, content: string, result: Result = 'ok'): Call => [
  id,
  'Write',
  { file_path, content },
  result,
]

const keyOf = (source: Source): SessionKey => sessionKey('claude', source.session)

const runOf = (source: Source): RunId => runId(keyOf(source))

const versionAt = (store: Store, source: Source, path: string): ArtifactVersion => {
  const version = store.artifacts.versions(runOf(source)).find(({ ref }) => ref.kind === 'file' && ref.path === path)
  if (version === undefined) {
    throw new Error(`no version of ${path}`)
  }
  return version
}

const pathsOf = (store: Store, source: Source): string[] =>
  store.artifacts
    .versions(runOf(source))
    .flatMap(({ ref }) => (ref.kind === 'file' ? [ref.path] : []))
    .sort()

const startOf = (store: Store, call: string): Fact => {
  const start = factsOf(store).find(
    (fact) => fact.kind === 'action_start' && fact.entity_key.kind === 'action' && fact.entity_key.call === call,
  )
  if (start === undefined) {
    throw new Error(`no start of ${call}`)
  }
  return start
}

const openRun = (store: Store, key: SessionKey): void => {
  const run = runId(key)
  const root = objectId(key)
  store.transaction((transaction) => {
    applyChangeSet(transaction, {
      run,
      author: 'rule',
      at: at(1),
      changes: [
        {
          op: 'run.create',
          basis: observed,
          evidence: [],
          put: {
            kind: 'run',
            value: { id: run, runtime: key.runtime, root_session: root, goal: null, brief: null, start_pruned: false, created_at: at(1) },
          },
        },
        { op: 'run.create', basis: observed, evidence: [], put: { kind: 'session_membership', value: { session: root, run } } },
      ],
    })
    const session = transaction.observations.getSession(root)
    if (session === null) {
      throw new Error('the transcript must create the session')
    }
    transaction.observations.save({ ...session, run })
  })
}

const linkOutputs = (store: Store, key: SessionKey, versions: readonly ArtifactVersionId[], evidence: Fact, call: string): void => {
  const run = runId(key)
  const id = ObserverCallId.parse(call)
  const input = inputFor(store, [evidence], run)
  store.transaction((transaction) => {
    beginObserverCall(transaction, { id, backend: key.runtime, crossVendor: false, input, at: at(10) })
  })
  const stage = temporary(`${call}-stage`)
  const result = store.transaction((transaction) =>
    applyObserverResponse(transaction, {
      call: id,
      at: at(11),
      output: response(
        [
          { ...createStage([evidence.id], `${call}-stage`) },
          ...versions.map((version) => ({
            op: 'artifact.link' as const,
            stage,
            version,
            direction: 'output' as const,
            evidence: [evidence.id],
            rationale: 'The stage produced the report',
          })),
        ],
        input.model.version,
      ),
    }),
  )
  expect(result.status).toBe('accepted')
}

const blobText = (store: Store, version: ArtifactVersion): string | null => {
  const { retention } = version
  if (retention.kind !== 'action_payload' && retention.kind !== 'file_read') {
    return null
  }
  const blob = store.artifacts.blob(retention.blob)
  return blob === null ? null : Buffer.from(blob).toString('utf8')
}

const reopen = (home: Home, store: Store): Store => {
  store.close()
  return home.open()
}

test('a report created through Bash and linked as a stage output is read from the file and survives deletion and restart', async ({ onTestFinished }) => {
  const { home, store, engine, project } = await setup(onTestFinished)
  const source = { session: 'report-session', cwd: project }
  const report = join(project, 'reports', 'summary.md')
  const content = '# Summary\n\n14 tests passed\n'
  await writeFiles(project, { 'reports/summary.md': content })
  await ingestCalls(engine, source, [bash('toolu_report', 'node scripts/report.js > reports/summary.md')])
  const start = startOf(store, 'toolu_report')
  const action = objectId({ kind: 'action', runtime: 'claude', session: source.session, call: 'toolu_report' })
  const version = versionAt(store, source, report)
  expect(version).toMatchObject({
    run: runOf(source),
    key: { identity: { kind: 'reference', fact: start.id } },
    ref: { kind: 'file', path: report },
    retention: { kind: 'reference' },
    produced_by: action,
  })
  expect(await engine.retainBases()).toEqual([])
  const hook = claudeHook('PostToolUse.Bash.json', source, {
    tool_use_id: 'toolu_report',
    tool_input: { command: 'node scripts/report.js > reports/summary.md', description: 'Run' },
  })
  await engine.ingest(hookBatch({ file: 'report-post.evt', payload: hook, arrival: 1_000_000_000_000 }))
  expect(store.artifacts.versions(runOf(source))).toEqual([version])

  openRun(store, keyOf(source))
  linkOutputs(store, keyOf(source), [version.id], start, 'report-call')
  const [retained, ...others] = await engine.retainBases()
  expect(others).toEqual([])
  expect(retained).toMatchObject({
    id: version.id,
    retention: { kind: 'file_read', blob: contentHash(content), read_at: readAt },
    produced_by: action,
  })
  expect(retained === undefined ? null : blobText(store, retained)).toBe(content)
  expect(retained === undefined ? 0 : retained.change_seq).toBeGreaterThan(version.change_seq)

  await writeFiles(project, { 'reports/summary.md': '# Rewritten\n' })
  await rm(report)
  expect(await engine.retainBases()).toEqual([])
  const reopened = reopen(home, store)
  const restored = reopened.artifacts.getVersion(version.id)
  expect(restored).toEqual(retained)
  expect(restored === null ? null : blobText(reopened, restored)).toBe(content)
  expect(await startEngine(reopened).retainBases()).toEqual([])
})

test('a version from a Write payload is retained from the payload as the version of the action', async ({ onTestFinished }) => {
  const { store, engine, project } = await setup(onTestFinished)
  const source = { session: 'write-session', cwd: project }
  const plan = join(project, 'docs', 'plan.md')
  const payload = '# Plan\n\n1. Ship\n'
  await writeFiles(project, { 'docs/plan.md': '# Edited later by hand\n' })
  await ingestCalls(engine, source, [write('toolu_write', plan, payload)])
  const version = versionAt(store, source, plan)
  const action = objectId({ kind: 'action', runtime: 'claude', session: source.session, call: 'toolu_write' })
  expect(version).toMatchObject({
    key: { identity: { kind: 'content', hash: contentHash(payload) } },
    produced_by: action,
    retention: { kind: 'reference' },
  })
  openRun(store, keyOf(source))
  linkOutputs(store, keyOf(source), [version.id], startOf(store, 'toolu_write'), 'write-call')
  const [retained] = await engine.retainBases()
  expect(retained).toMatchObject({ retention: { kind: 'action_payload', blob: contentHash(payload), action } })
  expect(retained === undefined ? null : blobText(store, retained)).toBe(payload)
  expect(await readFile(plan, 'utf8')).toBe('# Edited later by hand\n')
})

test('only bases are retained, and a basis without a readable file stays known only by reference until it is read', async ({ onTestFinished }) => {
  const { store, engine, project } = await setup(onTestFinished)
  const source = { session: 'missing-session', cwd: project }
  await writeFiles(project, { 'kept.txt': 'not a basis\n', 'dist/index.js': 'export {}\n' })
  await ingestCalls(engine, source, [bash('toolu_two', 'pnpm build > kept.txt && pnpm pack > missing.txt; ls > dist')])
  const kept = versionAt(store, source, join(project, 'kept.txt'))
  const missing = versionAt(store, source, join(project, 'missing.txt'))
  const directory = versionAt(store, source, join(project, 'dist'))
  openRun(store, keyOf(source))
  linkOutputs(store, keyOf(source), [missing.id, directory.id], startOf(store, 'toolu_two'), 'missing-call')
  expect(await engine.retainBases()).toEqual([])
  expect(store.artifacts.getVersion(missing.id)?.retention).toEqual({ kind: 'reference' })
  expect(store.artifacts.getVersion(directory.id)?.retention).toEqual({ kind: 'reference' })
  expect(store.artifacts.getVersion(kept.id)?.retention).toEqual({ kind: 'reference' })

  await writeFiles(project, { 'missing.txt': 'packed later\n' })
  expect(await engine.retainBases([runId(sessionKey('claude', 'another-session'))])).toEqual([])
  expect(await engine.retainBases([runOf(source)])).toEqual([
    expect.objectContaining({ id: missing.id, retention: { kind: 'file_read', blob: contentHash('packed later\n'), read_at: readAt } }),
  ])
  expect(store.artifacts.getVersion(kept.id)?.retention).toEqual({ kind: 'reference' })
})

test('contents larger than the blob limit keep only their hash and size', async ({ onTestFinished }) => {
  const { store, engine, project } = await setup(onTestFinished, 16)
  const source = { session: 'large-session', cwd: project }
  const large = 'x'.repeat(40_000)
  const payload = 'payload larger than sixteen bytes\n'
  await writeFiles(project, { 'large.log': large, 'small.txt': 'tiny\n' })
  await ingestCalls(engine, source, [
    bash('toolu_large', 'pnpm test 2>&1 | tee large.log', 'error'),
    bash('toolu_small', 'echo tiny > small.txt'),
    write('toolu_payload', join(project, 'payload.md'), payload),
  ])
  const versions = ['large.log', 'small.txt', 'payload.md'].map((name) => versionAt(store, source, join(project, name)))
  openRun(store, keyOf(source))
  linkOutputs(store, keyOf(source), versions.map(({ id }) => id), startOf(store, 'toolu_large'), 'large-call')
  await engine.retainBases()
  const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')
  expect(versions.map(({ id }) => store.artifacts.getVersion(id)?.retention)).toEqual([
    { kind: 'hash_only', content_hash: sha256(large), size_bytes: large.length },
    { kind: 'file_read', blob: sha256('tiny\n'), read_at: readAt },
    { kind: 'hash_only', content_hash: sha256(payload), size_bytes: payload.length },
  ])
  expect(store.artifacts.blob(contentHash(large))).toBeNull()
})

test('failed and denied writes produce no version, while a failing command still names the file it wrote', async ({ onTestFinished }) => {
  const { store, engine, project } = await setup(onTestFinished)
  const source = { session: 'outcome-session', cwd: project }
  await ingestCalls(engine, source, [
    write('toolu_failed', join(project, 'failed.md'), 'never written', 'error'),
    write('toolu_denied', join(project, 'denied.md'), 'never written', 'denied'),
    bash('toolu_refused', 'pnpm test > refused.txt', 'denied'),
    bash('toolu_red', 'pnpm test > red.txt', 'error'),
    write('toolu_relative', 'docs/relative.md', 'written'),
  ])
  expect(pathsOf(store, source)).toEqual([join(project, 'docs', 'relative.md'), join(project, 'red.txt')].sort())
})

test.for([
  { command: 'pnpm test > report.txt', files: ['report.txt'] },
  { command: 'pnpm test 2>&1 | tee -a logs/test.log', files: ['logs/test.log'] },
  { command: "cat > notes.md <<'EOF'\nline > not-a-file.txt\nEOF\necho done >> notes.md", files: ['notes.md'] },
  { command: 'echo "a > b" > quoted.txt 2> errors.log', files: ['errors.log', 'quoted.txt'] },
  { command: 'make &> both.log; make >| forced.log', files: ['both.log', 'forced.log'] },
  { command: 'if (( count > 1 )); then echo ok > done.txt; fi', files: ['done.txt'] },
  { command: '[[ a > b ]] && echo yes > yes.txt', files: ['yes.txt'] },
  { command: 'LOG=1 tee first.txt second.txt < input.txt', files: ['first.txt', 'second.txt'] },
  { command: 'diff <(sort a) <(sort b) > diff.txt # > comment.txt', files: ['diff.txt'] },
  { command: 'cd sub && make > build.log', files: [] },
  { command: 'ls > /dev/null; echo $X > "$OUT"; echo hi > *.txt', files: [] },
  { command: 'echo 1 >&2 && echo 2 2>&1 | tee -', files: [] },
  { command: 'grep x <<< "$DATA" > found.txt || echo none > none.txt', files: ['found.txt', 'none.txt'] },
  { command: 'exec 3<> rw.txt; cat <&3 |& tee piped.txt', files: ['piped.txt'] },
  { command: 'cat << EOF > spaced.txt\nbody > no.txt\nEOF', files: ['spaced.txt'] },
  { command: 'cat <<-END > tabbed.txt\n\tbody > no.txt\n\tEND\necho after > after.txt', files: ['after.txt', 'tabbed.txt'] },
  { command: 'echo $(echo $(date)) > nested.txt; echo `date` > tick.txt', files: ['nested.txt', 'tick.txt'] },
  { command: 'echo "say \\"hi\\"" > my\\ notes.txt', files: ['my notes.txt'] },
  { command: 'pnpm test \\\n  > continued.txt', files: ['continued.txt'] },
  { command: "echo $(unclosed > a.txt; echo 'unclosed > b.txt", files: [] },
  { command: 'echo `unclosed > c.txt', files: [] },
])('the files written by `$command` are $files', async ({ command, files }, { onTestFinished }) => {
  const { store, engine, project } = await setup(onTestFinished)
  const source = { session: 'shell-session', cwd: project }
  await ingestCalls(engine, source, [bash('toolu_shell', command)])
  expect(pathsOf(store, source)).toEqual(files.map((file) => join(project, file)).sort())
})

const codexThread = '01a0f752-40a7-76b2-9df9-5b374f75f98f'

const codexTurn = '01a0f752-4102-7740-9432-0533263c2dc1'

const codexStartMs = 1_790_855_800_000

const passthrough = { turn_id: codexTurn }

const codexKey = sessionKey('codex', codexThread)

const codexLine = (ordinal: number, type: string, payload: Record<string, JsonValue>): string =>
  JSON.stringify({ timestamp: new Date(codexStartMs + ordinal * 1000).toISOString(), ordinal, type, payload })

const codexItem = (ordinal: number, item: Record<string, JsonValue>): string =>
  codexLine(ordinal, 'event_msg', {
    type: 'item_completed',
    thread_id: codexThread,
    turn_id: codexTurn,
    item,
    started_at_ms: codexStartMs + ordinal * 1000 - 500,
    completed_at_ms: codexStartMs + ordinal * 1000,
  })

const codexPatchCall = (ordinal: number, call: string, patch: string): string[] => [
  codexLine(ordinal, 'response_item', {
    type: 'custom_tool_call',
    id: `ctc_${call}`,
    status: 'completed',
    call_id: call,
    name: 'apply_patch',
    input: patch,
    internal_chat_message_metadata_passthrough: passthrough,
  }),
  codexItem(ordinal + 1, { type: 'FileChange', id: call, changes: {}, status: 'completed', stdout: 'Success.\n', stderr: '' }),
]

const codexExec = (ordinal: number, call: string, input: Record<string, JsonValue>): string =>
  codexLine(ordinal, 'response_item', {
    type: 'function_call',
    id: `fc_${call}`,
    name: 'exec_command',
    arguments: JSON.stringify(input),
    call_id: call,
    internal_chat_message_metadata_passthrough: passthrough,
  })

const codexCommand = (ordinal: number, id: string, command: readonly string[], cwd: string): string =>
  codexItem(ordinal, {
    type: 'CommandExecution',
    id,
    command: [...command],
    cwd: pathToFileURL(cwd).href,
    status: 'completed',
    aggregated_output: '',
    exit_code: 0,
  })

const ingestCodex = async (engine: Engine, project: string, lines: readonly string[], ino = 21n): Promise<void> => {
  const all = [codexRollout({ thread: codexThread, cwd: project })[0] ?? '', ...lines]
  await engine.ingest(jsonlFile({ runtime: 'codex', path: join(project, 'rollout.jsonl'), lines: all, ino }).batch(1, all.length))
}

test('Codex patches, file changes and redirected commands produce versions', async ({ onTestFinished }) => {
  const { store, engine, project } = await setup(onTestFinished)
  const thread = codexThread
  const turn = codexTurn
  const startMs = codexStartMs
  const patch = '*** Begin Patch\n*** Add File: added.txt\n+hello\n*** Update File: old.txt\n*** Move to: moved.txt\n@@\n-a\n+b\n*** Delete File: gone.txt\n*** End Patch\n'
  const lines = [
    codexRollout({ thread, cwd: project })[0] ?? '',
    codexLine(1, 'response_item', {
      type: 'custom_tool_call',
      id: 'ctc_patch',
      status: 'completed',
      call_id: 'call_patch',
      name: 'apply_patch',
      input: patch,
      internal_chat_message_metadata_passthrough: passthrough,
    }),
    codexLine(2, 'event_msg', {
      type: 'item_completed',
      thread_id: thread,
      turn_id: turn,
      item: {
        type: 'FileChange',
        id: 'call_patch',
        changes: {
          [join(project, 'added.txt')]: { type: 'add', content: 'hello\n' },
          [join(project, 'old.txt')]: { type: 'update', unified_diff: '@@\n-a\n+b\n', move_path: join(project, 'moved.txt') },
          [join(project, 'gone.txt')]: { type: 'delete', content: 'bye\n' },
        },
        status: 'completed',
        stdout: 'Success.\n',
        stderr: '',
      },
      started_at_ms: startMs + 1000,
      completed_at_ms: startMs + 2000,
    }),
    codexLine(3, 'response_item', {
      type: 'function_call',
      id: 'fc_exec',
      name: 'exec_command',
      arguments: JSON.stringify({ cmd: 'pytest > results.txt', workdir: join(project, 'service') }),
      call_id: 'call_exec',
      internal_chat_message_metadata_passthrough: passthrough,
    }),
    codexLine(4, 'event_msg', {
      type: 'item_completed',
      thread_id: thread,
      turn_id: turn,
      item: {
        type: 'CommandExecution',
        id: 'call_exec',
        command: ['/bin/zsh', '-lc', 'pytest > results.txt'],
        cwd: pathToFileURL(join(project, 'service')).href,
        status: 'failed',
        aggregated_output: 'failed\n',
        exit_code: 1,
      },
      started_at_ms: startMs + 3000,
      completed_at_ms: startMs + 4000,
    }),
  ]
  const file = jsonlFile({ runtime: 'codex', path: join(project, 'rollout.jsonl'), lines, ino: 21n })
  await engine.ingest(file.batch(1, lines.length))
  const run = runId({ kind: 'session', runtime: 'codex', session: thread })
  const versions = store.artifacts.versions(run).map(({ ref, key }) => [ref.kind === 'file' ? ref.path : null, key.identity.kind])
  expect(versions.sort()).toEqual(
    [
      [join(project, 'added.txt'), 'content'],
      [join(project, 'moved.txt'), 'reference'],
      [join(project, 'service', 'results.txt'), 'reference'],
    ].sort(),
  )
  const added = store.artifacts.versions(run).find(({ ref }) => ref.kind === 'file' && ref.path === join(project, 'added.txt'))
  expect(added?.key.identity).toEqual({ kind: 'content', hash: contentHash('hello\n') })
})


test('a Codex patch from hooks alone has no known outcome and gives a version once its completion is read', async ({ onTestFinished }) => {
  const { store, engine, project } = await setup(onTestFinished)
  const thread = '01a0f75b-f1ae-7202-88d4-4759d4563cf9'
  const session = { session: thread, cwd: project }
  const patch = { command: '*** Begin Patch\n*** Add File: notes/added.txt\n+first\n+second\n*** End Patch\n' }
  const call = { tool_use_id: 'call_hook_patch', tool_input: patch }
  await engine.ingest(
    hookBatch(
      { file: 'codex-start.evt', payload: codexHook('SessionStart.startup.json', session), runtime: 'codex' },
      { file: 'codex-pre.evt', payload: codexHook('PreToolUse.apply_patch.json', session, call), runtime: 'codex', arrival: 1 },
      { file: 'codex-post.evt', payload: codexHook('PostToolUse.apply_patch.json', session, call), runtime: 'codex', arrival: 2 },
    ),
  )
  const run = runId({ kind: 'session', runtime: 'codex', session: thread })
  expect(store.artifacts.versions(run)).toEqual([])
  const completed = JSON.stringify({
    timestamp: '2026-10-01T12:06:33.277Z',
    ordinal: 1,
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      thread_id: thread,
      turn_id: '01a0f75b-f1d3-79c3-b636-6dd8e8e711d0',
      item: { type: 'FileChange', id: 'call_hook_patch', changes: {}, status: 'completed', stdout: 'Success.\n', stderr: '' },
      started_at_ms: 1_790_856_393_259,
      completed_at_ms: 1_790_856_393_277,
    },
  })
  const lines = [codexRollout({ thread, cwd: project })[0] ?? '', completed]
  await engine.ingest(jsonlFile({ runtime: 'codex', path: join(project, 'rollout.jsonl'), lines, ino: 23n }).batch(1, 2))
  expect(store.artifacts.versions(run)).toEqual([
    expect.objectContaining({
      ref: { kind: 'file', path: join(project, 'notes', 'added.txt') },
      key: expect.objectContaining({ identity: { kind: 'content', hash: contentHash('first\nsecond\n') } }) as unknown,
    }),
  ])
})

const transcriptOf = (source: Source, calls: readonly Call[]) => {
  const lines = calls.flatMap((call, index) => callLines(source, call, index * 2))
  return jsonlFile({ runtime: 'claude', path: join(source.cwd, `${source.session}.jsonl`), lines, ino: 7n })
}

const edit = (id: string, file_path: string, old_string: string, new_string: string): Call => [
  id,
  'Edit',
  { file_path, old_string, new_string },
  'ok',
]

const retainedAs = (store: Store, id: ArtifactVersionId) => {
  const version = store.artifacts.getVersion(id)
  return version === null ? null : { kind: version.retention.kind, text: blobText(store, version) }
}

test('Codex commands and patches without a workdir resolve relative paths where they ran, also when retained', async ({ onTestFinished }) => {
  const { store, engine, project } = await setup(onTestFinished)
  await writeFiles(project, { 'default.txt': 'hello\n' })
  await ingestCodex(engine, project, [
    codexExec(1, 'call_plain', { cmd: 'echo hello > default.txt' }),
    codexCommand(2, 'call_plain', ['/bin/zsh', '-lc', 'echo hello > default.txt'], project),
    codexCommand(3, 'exec-nested', ['/bin/zsh', '-lc', 'echo nested > nested.txt'], join(project, 'nested')),
    codexExec(4, 'call_session', { cmd: 'echo session > session.txt' }),
    codexLine(5, 'response_item', { type: 'function_call_output', call_id: 'call_session', output: 'done' }),
    ...codexPatchCall(6, 'call_relative', '*** Begin Patch\n*** Add File: notes/relative.txt\n+relative\n*** End Patch\n'),
    codexItem(8, {
      type: 'CommandExecution',
      id: 'exec-malformed',
      command: ['/bin/zsh', '-lc', 'echo malformed > malformed.txt'],
      cwd: 'file:///elsewhere%2Fdir',
      status: 'completed',
      aggregated_output: '',
      exit_code: 0,
    }),
  ])
  const run = runId(codexKey)
  const versions = store.artifacts.versions(run)
  expect(versions.map(({ ref, key }) => [ref.kind === 'file' ? ref.path : null, key.identity.kind]).sort()).toEqual(
    [
      [join(project, 'default.txt'), 'reference'],
      [join(project, 'malformed.txt'), 'reference'],
      [join(project, 'nested', 'nested.txt'), 'reference'],
      [join(project, 'notes', 'relative.txt'), 'content'],
      [join(project, 'session.txt'), 'reference'],
    ].sort(),
  )
  const report = versions.find(({ ref }) => ref.kind === 'file' && ref.path === join(project, 'default.txt'))
  const notes = versions.find(({ ref }) => ref.kind === 'file' && ref.path === join(project, 'notes', 'relative.txt'))
  if (report === undefined || notes === undefined) {
    throw new Error('the Codex versions must exist')
  }
  openRun(store, codexKey)
  linkOutputs(store, codexKey, [report.id, notes.id], startOf(store, 'call_plain'), 'codex-call')
  await engine.retainBases()
  expect(retainedAs(store, report.id)).toEqual({ kind: 'file_read', text: 'hello\n' })
  expect(retainedAs(store, notes.id)).toEqual({ kind: 'action_payload', text: 'relative\n' })
})

type Shell = 'Bash' | 'PowerShell' | 'cmd' | 'exec_command'

const runShell = async (engine: Engine, project: string, shell: Shell, command: string): Promise<RunId> => {
  if (shell === 'Bash' || shell === 'PowerShell') {
    const source = { session: 'dialect-session', cwd: project }
    await ingestCalls(engine, source, [['toolu_dialect', shell, { command, description: 'Run' }, 'ok']])
    return runOf(source)
  }
  await ingestCodex(
    engine,
    project,
    shell === 'cmd'
      ? [codexCommand(1, 'exec-dialect', ['C:\\Windows\\System32\\cmd.exe', '/c', command], project)]
      : [
          codexExec(1, 'call_dialect', { cmd: command, shell: 'pwsh.exe' }),
          codexLine(2, 'response_item', { type: 'function_call_output', call_id: 'call_dialect', output: 'done' }),
        ],
  )
  return runId(codexKey)
}

test.for<{ name: string; shell: Shell; command: (project: string) => string; files: readonly (readonly string[])[] }>([
  {
    name: 'Bash keeps a backslash in double quotes before an ordinary letter',
    shell: 'Bash',
    command: () => 'printf result > "a\\b.txt"; echo x > "cost\\$5.txt"; echo y > back\\slash.txt',
    files: [['a\\b.txt'], ['cost$5.txt'], ['backslash.txt']],
  },
  {
    name: 'PowerShell keeps native paths and backslashes',
    shell: 'PowerShell',
    command: (project) =>
      `Get-Date > '${join(project, 'ps', 'single.txt')}'; Get-Date >> ${join(project, 'ps', 'bare.txt')}; ` +
      `Get-Date *> .${sep}ps${sep}relative.txt; echo 1 > win\\path.txt`,
    files: [['ps', 'single.txt'], ['ps', 'bare.txt'], ['ps', 'relative.txt'], ['win\\path.txt']],
  },
  {
    name: 'PowerShell escapes, expansions, devices, comments and here-strings',
    shell: 'PowerShell',
    command: () =>
      'echo 1 > tick`$name.txt; echo 2 > "$env:TEMP\\x.txt"; echo 3 > $null; echo 4 > nul 2>&1 # > c.txt\n' +
      "<# > d.txt #>\n$s = @'\n> e.txt\n'@\necho 5 > \"say \"\"hi\"\".txt\"; echo 6 > \"q`\"uote.txt\"; echo 7 > $(Get-Date).txt",
    files: [['tick$name.txt'], ['say "hi".txt'], ['q"uote.txt']],
  },
  { name: 'PowerShell changing location', shell: 'PowerShell', command: () => 'Set-Location sub; echo 1 > moved.txt', files: [] },
  {
    name: 'cmd keeps native paths and backslashes and skips devices, variables and remarks',
    shell: 'cmd',
    command: (project) =>
      `dir > ${join(project, 'cmd', 'out.txt')} 2>&1 & echo ^> not.txt & echo x > "quoted name.txt" & echo y > nul & ` +
      'echo z > %TEMP%\\z.txt & echo w > cmd\\rel.txt\nrem > skipped.txt\n:: > label.txt',
    files: [['cmd', 'out.txt'], ['quoted name.txt'], ['cmd\\rel.txt']],
  },
  { name: 'cmd changing directory', shell: 'cmd', command: () => 'cd /d sub && echo 1 > moved.txt', files: [] },
  { name: 'cmd changing drive', shell: 'cmd', command: () => 'D: & echo 1 > drive.txt', files: [] },
  {
    name: 'a Codex command string run by the shell it names',
    shell: 'exec_command',
    command: () => 'echo 1 > codex\\shell.txt',
    files: [['codex\\shell.txt']],
  },
])('$name', async ({ shell, command, files }, { onTestFinished }) => {
  const { store, engine, project } = await setup(onTestFinished)
  const run = await runShell(engine, project, shell, command(project))
  const paths = store.artifacts.versions(run).flatMap(({ ref }) => (ref.kind === 'file' ? [ref.path] : []))
  expect(paths.sort()).toEqual(files.map((parts) => join(project, ...parts)).sort())
})

test('identical writes keep the earliest producer and their retention whatever order the evidence arrives in', async ({ onTestFinished }) => {
  const content = '# Same\n'
  type Step = 'transcript' | 'hooks-a' | 'hooks-b' | 'retain'
  const play = async (steps: readonly Step[]) => {
    const { store, engine, project } = await setup(onTestFinished)
    const source = { session: 'same-session', cwd: project }
    const path = join(project, 'docs', 'same.md')
    const transcript = transcriptOf(source, [write('toolu_a', path, content), write('toolu_b', path, content)])
    const tool = (id: string) => ({ tool_name: 'Write', tool_use_id: id, tool_input: { file_path: path, content } })
    const hooks = (id: string, arrival: number) =>
      hookBatch(
        { file: 'same-start.evt', payload: claudeHook('SessionStart.startup.json', source) },
        { file: `${id}-pre.evt`, payload: claudeHook('PreToolUse.Bash.json', source, tool(id)), arrival },
        {
          file: `${id}-post.evt`,
          payload: claudeHook('PostToolUse.Bash.json', source, { ...tool(id), tool_response: { type: 'create', filePath: path, content } }),
          arrival: arrival + 1,
        },
      )
    const batches = { transcript: transcript.batch(1, 4), 'hooks-a': hooks('toolu_a', 10), 'hooks-b': hooks('toolu_b', 20) }
    const states: (ArtifactVersion | undefined)[] = []
    for (const step of steps) {
      if (step === 'retain') {
        const [version] = store.artifacts.versions(runOf(source))
        const evidence = factsOf(store).find(({ kind }) => kind === 'action_start')
        if (version === undefined || evidence === undefined) {
          throw new Error('a version must exist before it is retained')
        }
        openRun(store, keyOf(source))
        linkOutputs(store, keyOf(source), [version.id], evidence, 'same-call')
        await engine.retainBases()
      } else {
        await engine.ingest(batches[step])
      }
      states.push(store.artifacts.versions(runOf(source))[0])
    }
    return states
  }
  const action = (call: string) => objectId({ kind: 'action', runtime: 'claude', session: 'same-session', call })
  const settled = {
    produced_by: action('toolu_a'),
    observed_at: EpochNs.parse(BigInt(Date.UTC(2026, 9, 1, 10, 0, 1)) * 1_000_000n),
    retention: { kind: 'action_payload', blob: contentHash(content), action: action('toolu_a') },
  }
  const transcriptFirst = await play(['transcript', 'retain', 'hooks-b', 'hooks-a'])
  expect(transcriptFirst.slice(1)).toEqual([transcriptFirst[1], transcriptFirst[1], transcriptFirst[1]])
  expect(transcriptFirst.at(-1)).toMatchObject(settled)
  const hooksFirst = await play(['hooks-b', 'retain', 'hooks-a', 'transcript'])
  expect(hooksFirst.map((state) => state?.produced_by)).toEqual([action('toolu_b'), action('toolu_b'), action('toolu_a'), action('toolu_a')])
  expect(hooksFirst[1]?.retention).toMatchObject({ kind: 'action_payload', action: action('toolu_b') })
  expect(hooksFirst.at(-1)).toMatchObject(settled)
})

test('an edit of a retained version is rebuilt from its patch and retained as the version of the edit', async ({ onTestFinished }) => {
  const { store, engine, project } = await setup(onTestFinished)
  const source = { session: 'edit-session', cwd: project }
  const plan = join(project, 'plan.md')
  const transcript = transcriptOf(source, [
    write('toolu_base', plan, 'alpha\nbeta\n'),
    edit('toolu_edit', plan, 'beta', 'gamma'),
    [
      'toolu_multi',
      'MultiEdit',
      { file_path: plan, edits: [{ old_string: 'alpha', new_string: 'one' }, { old_string: 'gamma', new_string: 'two' }] },
      'ok',
    ],
  ])
  await engine.ingest(transcript.batch(1, 2))
  const base = versionAt(store, source, plan)
  openRun(store, keyOf(source))
  linkOutputs(store, keyOf(source), [base.id], startOf(store, 'toolu_base'), 'base-call')
  await engine.retainBases()
  expect(retainedAs(store, base.id)).toEqual({ kind: 'action_payload', text: 'alpha\nbeta\n' })

  await engine.ingest(transcript.batch(3, 6))
  const editedBy = (call: string): ArtifactVersion => {
    const found = store.artifacts.versions(runOf(source)).find(({ key }) => key.identity.kind === 'reference' && key.identity.fact === startOf(store, call).id)
    if (found === undefined) {
      throw new Error(`no version of ${call}`)
    }
    return found
  }
  const multi = editedBy('toolu_multi')
  const single = editedBy('toolu_edit')
  linkOutputs(store, keyOf(source), [multi.id, single.id], startOf(store, 'toolu_multi'), 'multi-call')
  await rm(plan, { force: true })
  const action = (call: string) => objectId({ kind: 'action', runtime: 'claude', session: source.session, call })
  expect(await engine.retainBases()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: multi.id, retention: { kind: 'action_payload', blob: contentHash('one\ntwo\n'), action: action('toolu_multi') } }),
      expect.objectContaining({ id: single.id, retention: { kind: 'action_payload', blob: contentHash('alpha\ngamma\n'), action: action('toolu_edit') } }),
    ]),
  )
  expect(retainedAs(store, multi.id)).toEqual({ kind: 'action_payload', text: 'one\ntwo\n' })
  expect(retainedAs(store, single.id)).toEqual({ kind: 'action_payload', text: 'alpha\ngamma\n' })
})

test('an edit without an unambiguous known base is read from the file', async ({ onTestFinished }) => {
  const { store, engine, project } = await setup(onTestFinished)
  const source = { session: 'ambiguous-session', cwd: project }
  const file = (name: string) => join(project, name)
  await ingestCalls(engine, source, [
    write('toolu_x', file('x.md'), 'one\n'),
    bash('toolu_x_shell', 'echo other > x.md'),
    edit('toolu_x_edit', file('x.md'), 'other', 'changed'),
    edit('toolu_y_edit', file('y.md'), 'old', 'new'),
    write('toolu_z', file('z.md'), 'a\n'),
    edit('toolu_z_edit', file('z.md'), 'missing', 'b'),
    write('toolu_w', file('w.md'), 'x x\n'),
    edit('toolu_w_edit', file('w.md'), 'x', 'y'),
  ])
  await writeFiles(project, { 'x.md': 'changed\n', 'y.md': 'new\n', 'z.md': 'on disk\n', 'w.md': 'y x\n' })
  const edits = ['toolu_x_edit', 'toolu_y_edit', 'toolu_z_edit', 'toolu_w_edit'].map((call) => {
    const found = store.artifacts.versions(runOf(source)).find(({ key }) => key.identity.kind === 'reference' && key.identity.fact === startOf(store, call).id)
    if (found === undefined) {
      throw new Error(`no version of ${call}`)
    }
    return found.id
  })
  openRun(store, keyOf(source))
  linkOutputs(store, keyOf(source), edits, startOf(store, 'toolu_x_edit'), 'ambiguous-call')
  await engine.retainBases()
  expect(edits.map((id) => retainedAs(store, id))).toEqual([
    { kind: 'file_read', text: 'changed\n' },
    { kind: 'file_read', text: 'new\n' },
    { kind: 'file_read', text: 'on disk\n' },
    { kind: 'file_read', text: 'y x\n' },
  ])
})

test('a Codex patch to an added file is rebuilt from the patch, including a move', async ({ onTestFinished }) => {
  const { store, engine, project } = await setup(onTestFinished)
  await ingestCodex(engine, project, [
    ...codexPatchCall(1, 'call_add', '*** Begin Patch\n*** Add File: src/a.txt\n+one\n+two\n+three\n*** End Patch\n'),
    ...codexPatchCall(
      3,
      'call_update',
      '*** Begin Patch\n*** Update File: src/a.txt\n*** Move to: src/b.txt\n@@ one\n-two\n+zwei\n three\n*** End of File\n*** End Patch\n',
    ),
  ])
  const run = runId(codexKey)
  const moved = store.artifacts.versions(run).find(({ ref }) => ref.kind === 'file' && ref.path === join(project, 'src', 'b.txt'))
  if (moved === undefined) {
    throw new Error('the moved file must have a version')
  }
  expect(moved.key.identity.kind).toBe('reference')
  openRun(store, codexKey)
  linkOutputs(store, codexKey, [moved.id], startOf(store, 'call_update'), 'patch-call')
  await engine.retainBases()
  expect(retainedAs(store, moved.id)).toEqual({ kind: 'action_payload', text: 'one\nzwei\nthree\n' })
})

const versionOfCall = (store: Store, run: RunId, call: string): ArtifactVersion => {
  const start = startOf(store, call)
  const found = store.artifacts.versions(run).find(({ key }) => key.identity.kind === 'reference' && key.identity.fact === start.id)
  if (found === undefined) {
    throw new Error(`no version of ${call}`)
  }
  return found
}

test.for<{ name: string; base: string; patch: JsonValue; text: string | null }>([
  { name: 'replace_all replaces every occurrence', base: 'a b a\n', patch: { old_string: 'a', new_string: 'c', replace_all: true }, text: 'c b c\n' },
  { name: 'a deletion that includes its newline', base: 'keep\ndrop\n', patch: { old_string: 'drop\n', new_string: '' }, text: 'keep\n' },
  { name: 'a deletion that may take the following newline', base: 'keep\ndrop\n', patch: { old_string: 'drop', new_string: '' }, text: null },
  { name: 'an empty old_string', base: 'keep\n', patch: { old_string: '', new_string: 'x' }, text: null },
  {
    name: 'a MultiEdit whose second edit misses',
    base: 'one\ntwo\n',
    patch: { edits: [{ old_string: 'one', new_string: '1' }, { old_string: 'three', new_string: '3' }] },
    text: null,
  },
])('a Claude edit: $name', async ({ base, patch, text }, { onTestFinished }) => {
  const { store, engine, project } = await setup(onTestFinished)
  const source = { session: 'claude-patch-session', cwd: project }
  const path = join(project, 'file.txt')
  const tool = 'edits' in (patch as Record<string, JsonValue>) ? 'MultiEdit' : 'Edit'
  await ingestCalls(engine, source, [
    write('toolu_base', path, base),
    ['toolu_read', 'Read', { file_path: path }, 'ok'],
    ['toolu_patch', tool, { file_path: path, ...(patch as Record<string, JsonValue>) }, 'ok'],
  ])
  await writeFiles(project, { 'file.txt': 'on disk\n' })
  const version = versionOfCall(store, runOf(source), 'toolu_patch')
  openRun(store, keyOf(source))
  linkOutputs(store, keyOf(source), [version.id], startOf(store, 'toolu_patch'), 'claude-patch-call')
  await engine.retainBases()
  expect(retainedAs(store, version.id)).toEqual(text === null ? { kind: 'file_read', text: 'on disk\n' } : { kind: 'action_payload', text })
})

test('an edit sent in the same message as the write of its base is read from the file', async ({ onTestFinished }) => {
  const { store, engine, project } = await setup(onTestFinished)
  const source = { session: 'parallel-session', cwd: project }
  const path = join(project, 'file.txt')
  const uses = [
    { type: 'tool_use', id: 'toolu_base', name: 'Write', input: { file_path: path, content: 'one\n' } },
    { type: 'tool_use', id: 'toolu_patch', name: 'Edit', input: { file_path: path, old_string: 'one', new_string: 'two' } },
  ]
  const results = ['toolu_base', 'toolu_patch'].map((id) => ({ type: 'tool_result', tool_use_id: id, content: 'done', is_error: false }))
  const lines = [
    line(source, 'use-parallel', 0, 'assistant', { id: 'message-parallel', role: 'assistant', content: uses }),
    line(source, 'result-parallel', 1, 'user', { role: 'user', content: results }),
  ]
  await engine.ingest(jsonlFile({ runtime: 'claude', path: join(project, 'parallel.jsonl'), lines, ino: 9n }).batch(1, 2))
  await writeFiles(project, { 'file.txt': 'two\n' })
  const version = versionOfCall(store, runOf(source), 'toolu_patch')
  openRun(store, keyOf(source))
  linkOutputs(store, keyOf(source), [version.id], startOf(store, 'toolu_patch'), 'parallel-call')
  await engine.retainBases()
  expect(retainedAs(store, version.id)).toEqual({ kind: 'file_read', text: 'two\n' })
})

test.for<{ name: string; added: string; update: string; text: string | null }>([
  { name: 'a pure addition appends to the end', added: '+one\n+two\n', update: '@@\n+four\n', text: 'one\ntwo\nfour\n' },
  { name: 'a first hunk without a header', added: '+one\n+two\n', update: '-two\n+zwei\n', text: 'one\nzwei\n' },
  {
    name: 'a trailing empty context line that the file lacks',
    added: '+one\n+two\n',
    update: '@@\n-two\n+zwei\n\n',
    text: 'one\nzwei\n',
  },
  {
    name: 'hunks anchored at the end of the file',
    added: '+one\n+two\n+one\n',
    update: '@@\n-one\n+uno\n@@\n-one\n+eins\n*** End of File\n',
    text: 'uno\ntwo\neins\n',
  },
  { name: 'an empty context line matches at the cursor', added: '+one\n', update: '@@\n \n+x\n', text: '\nx\none\n' },
  { name: 'a missing context line', added: '+one\n+two\n', update: '@@ missing\n-two\n+zwei\n', text: null },
  { name: 'lines that are not in the file', added: '+one\n+two\n', update: '@@\n-three\n+drei\n', text: null },
  { name: 'more lines than the file has', added: '+one\n', update: '@@\n-one\n-two\n+x\n', text: null },
  { name: 'a line that is not a diff line', added: '+one\n', update: '@@\n-one\ngarbage\n', text: null },
  { name: 'an added file with a line that is not an addition', added: '+one\nplain\n', update: '@@\n-one\n+uno\n', text: null },
])('a Codex patch: $name', async ({ added, update, text }, { onTestFinished }) => {
  const { store, engine, project } = await setup(onTestFinished)
  await ingestCodex(engine, project, [
    ...codexPatchCall(1, 'call_add', `*** Begin Patch\n*** Add File: patched.txt\n${added}*** End Patch\n`),
    ...codexPatchCall(3, 'call_update', `*** Begin Patch\n*** Update File: patched.txt\n${update}*** End Patch\n`),
  ])
  await writeFiles(project, { 'patched.txt': 'on disk\n' })
  const run = runId(codexKey)
  const version = versionOfCall(store, run, 'call_update')
  openRun(store, codexKey)
  linkOutputs(store, codexKey, [version.id], startOf(store, 'call_update'), 'codex-patch-call')
  await engine.retainBases()
  expect(retainedAs(store, version.id)).toEqual(text === null ? { kind: 'file_read', text: 'on disk\n' } : { kind: 'action_payload', text })
})
