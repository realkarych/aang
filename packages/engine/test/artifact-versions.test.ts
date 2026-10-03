import { createHash } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type ArtifactVersion,
  type ArtifactVersionId,
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

const openRun = (store: Store, source: Source): void => {
  const run = runOf(source)
  const root = objectId(keyOf(source))
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
            value: { id: run, runtime: 'claude', root_session: root, goal: null, brief: null, start_pruned: false, created_at: at(1) },
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

const linkOutputs = (store: Store, source: Source, versions: readonly ArtifactVersionId[], evidence: Fact, call: string): void => {
  const run = runOf(source)
  const id = ObserverCallId.parse(call)
  const input = inputFor(store, [evidence], run)
  store.transaction((transaction) => {
    beginObserverCall(transaction, { id, input, at: at(10) })
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

  openRun(store, source)
  linkOutputs(store, source, [version.id], start, 'report-call')
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
  openRun(store, source)
  linkOutputs(store, source, [version.id], startOf(store, 'toolu_write'), 'write-call')
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
  openRun(store, source)
  linkOutputs(store, source, [missing.id, directory.id], startOf(store, 'toolu_two'), 'missing-call')
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
  openRun(store, source)
  linkOutputs(store, source, versions.map(({ id }) => id), startOf(store, 'toolu_large'), 'large-call')
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

test('Codex patches, file changes and redirected commands produce versions', async ({ onTestFinished }) => {
  const { store, engine, project } = await setup(onTestFinished)
  const thread = '01a0f752-40a7-76b2-9df9-5b374f75f98f'
  const turn = '01a0f752-4102-7740-9432-0533263c2dc1'
  const startMs = 1_790_855_800_000
  const codexLine = (ordinal: number, type: string, payload: Record<string, JsonValue>): string =>
    JSON.stringify({ timestamp: new Date(startMs + ordinal * 1000).toISOString(), ordinal, type, payload })
  const passthrough = { turn_id: turn }
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
        cwd: `file://${join(project, 'service')}`,
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
