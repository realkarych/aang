import { readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CheckContract, EpochNs, type GitSnapshot, type RunId } from '@aang/contract'
import { objectId, runId } from '@aang/contract/ids'
import { createEngine, type Engine } from '@aang/engine'
import type { Store } from '@aang/store'
import { expect, test } from 'vitest'
import { type HookDelivery, hookBatch, jsonlFile } from './batches.js'
import { adapters, factsOf, sessionKey } from './harness.js'
import { createHome } from './home.js'
import { createRepository, git, initRepository, type Register, writeFiles } from './repository.js'
import { claudeHook, codexRollout } from './samples.js'

interface Source {
  readonly session: string
  readonly cwd: string
}

const committed = {
  'src/app.ts': 'export const app = 1\n',
  'src/util.ts': 'export const util = 2\n',
  'README.md': '# Project\n',
  '.gitignore': '*.log\n',
}

interface SetupOptions {
  readonly masks?: readonly string[]
  readonly now?: () => EpochNs
  readonly commit?: boolean
}

const setup = async (register: Register, options: SetupOptions = {}) => {
  const home = await createHome(register)
  const repository = await createRepository(register, committed, options.commit)
  const store = home.open()
  const contract = CheckContract.parse({ name: 'test', command: '^pnpm test', inputMasks: options.masks ?? ['src'] })
  const engine: Engine = createEngine({
    store,
    adapters,
    watch: { all: true, roots: [{ path: repository.path, contracts: [contract] }] },
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  return { home, store, engine, repository }
}

const started = (source: Source): HookDelivery => ({
  file: `${source.session}-start.evt`,
  payload: claudeHook('SessionStart.startup.json', source),
})

const tool = (call: string, command: string) => ({ tool_use_id: call, tool_input: { command, description: 'Run' } })

const preTool = (source: Source, call: string, command: string, arrival: number): HookDelivery => ({
  file: `${call}-pre.evt`,
  payload: claudeHook('PreToolUse.Bash.json', source, tool(call, command)),
  arrival,
})

const postTool = (source: Source, call: string, command: string, arrival: number): HookDelivery => ({
  file: `${call}-post.evt`,
  payload: claudeHook('PostToolUse.Bash.json', source, tool(call, command)),
  arrival,
})

const runOf = (source: Source): RunId => runId(sessionKey('claude', source.session))

const snapshotsOf = (store: Store, source: Source): GitSnapshot[] => store.artifacts.snapshots(runOf(source))

const runCheck = async (engine: Engine, source: Source, call = `call-${source.session}`, command = 'pnpm test'): Promise<void> => {
  await engine.ingest(hookBatch(started(source), preTool(source, call, command, 10), postTool(source, call, command, 11)))
}

const changed = (files: Readonly<Record<string, string>>, staged = false) => async (path: string): Promise<void> => {
  await writeFiles(path, files)
  if (staged) {
    await git(path, 'add', '--all')
  }
}

test.for([
  { scenario: 'a committed tree', prepare: changed({}), clean: true, entries: [] },
  {
    scenario: 'an uncommitted change of a tracked file under the mask',
    prepare: changed({ 'src/app.ts': 'export const app = 3\n' }),
    clean: false,
    entries: [{ status: ' M', path: 'src/app.ts' }],
  },
  {
    scenario: 'a staged but uncommitted change under the mask',
    prepare: changed({ 'src/util.ts': 'export const util = 4\n' }, true),
    clean: false,
    entries: [{ status: 'M ', path: 'src/util.ts' }],
  },
  {
    scenario: 'a staged rename under the mask',
    prepare: async (path: string) => {
      await git(path, 'mv', 'src/util.ts', 'src/renamed.ts')
    },
    clean: false,
    entries: [{ status: 'R ', path: 'src/renamed.ts' }],
  },
  {
    scenario: 'an untracked file under the mask',
    prepare: changed({ 'src/new.ts': 'export {}\n' }),
    clean: false,
    entries: [{ status: '??', path: 'src/new.ts' }],
  },
  {
    scenario: 'an ignored file under the mask',
    prepare: changed({ 'src/debug.log': 'trace\n' }),
    clean: false,
    entries: [{ status: '!!', path: 'src/debug.log' }],
  },
  {
    scenario: 'changes outside the mask only',
    prepare: changed({ 'README.md': '# Changed\n', 'notes.txt': 'draft\n', 'build.log': 'ignored\n' }),
    clean: true,
    entries: [],
  },
])('a check snapshot of $scenario is clean: $clean', async ({ prepare, clean, entries }, { onTestFinished }) => {
  const { store, engine, repository } = await setup(onTestFinished)
  await prepare(repository.path)
  const source = { session: 'snapshot-session', cwd: repository.path }
  await runCheck(engine, source)
  const [snapshot, ...others] = snapshotsOf(store, source)
  expect(others).toEqual([])
  expect(snapshot).toMatchObject({
    run: runOf(source),
    worktree: repository.path,
    trigger: 'check',
    masks: [join(repository.path, 'src')],
    head: repository.head,
    clean,
  })
  const fact = factsOf(store).find(({ id }) => id === snapshot?.fact)
  expect(fact).toMatchObject({
    kind: 'git_snapshot',
    entity_key: { kind: 'run', runtime: 'claude', session: source.session },
    speaker: 'runtime',
    payload: { worktree: repository.path, head: repository.head, entries, clean, error: null },
  })
})

test('a repository without commits gives an unclean snapshot without a head', async ({ onTestFinished }) => {
  const { store, engine, repository } = await setup(onTestFinished, { commit: false })
  const source = { session: 'unborn-session', cwd: repository.path }
  await runCheck(engine, source)
  expect(snapshotsOf(store, source)).toEqual([expect.objectContaining({ head: null, clean: false })])
  const fact = factsOf(store).find(({ kind }) => kind === 'git_snapshot')
  expect(fact?.payload).toMatchObject({ error: null, entries: [{ status: '??', path: 'src/' }] })
})

test('masks outside the worktree and actions that are not checks take no snapshot', async ({ onTestFinished }) => {
  const { store, engine, repository } = await setup(onTestFinished, { masks: ['../elsewhere'] })
  const source = { session: 'outside-session', cwd: repository.path }
  await runCheck(engine, source)
  const write = { tool_name: 'Write', tool_use_id: 'call-write', tool_input: { file_path: join(repository.path, 'src', 'a.ts'), content: 'a' } }
  await engine.ingest(
    hookBatch({ file: 'call-write-pre.evt', payload: claudeHook('PreToolUse.Bash.json', source, write), arrival: 20 }),
  )
  expect(snapshotsOf(store, source)).toEqual([])
  expect(factsOf(store).filter(({ kind }) => kind === 'git_snapshot')).toEqual([])
})

test('masks are resolved against the watched root, so a check from a nested directory sees the whole mask', async ({ onTestFinished }) => {
  const { store, engine, repository } = await setup(onTestFinished, { masks: ['src', 'README.md'] })
  await writeFiles(repository.path, { 'packages/app/index.ts': 'export {}\n' })
  await git(repository.path, 'add', '--all')
  await git(repository.path, 'commit', '--quiet', '--message=nested')
  const head = await git(repository.path, 'rev-parse', 'HEAD')
  await writeFiles(repository.path, { 'src/new.ts': 'export {}\n', 'packages/app/scratch.ts': 'export {}\n' })
  const source = { session: 'nested-session', cwd: join(repository.path, 'packages', 'app') }
  await runCheck(engine, source)
  expect(snapshotsOf(store, source)).toEqual([
    expect.objectContaining({ head, clean: false, masks: [join(repository.path, 'src'), join(repository.path, 'README.md')] }),
  ])
  const fact = factsOf(store).find(({ kind }) => kind === 'git_snapshot')
  expect(fact?.payload).toMatchObject({ entries: [{ status: '??', path: 'src/new.ts' }] })
})

test('a snapshot is taken when the start and the end of a check are observed', async ({ onTestFinished }) => {
  const { store, engine, repository } = await setup(onTestFinished)
  const source = { session: 'around-session', cwd: repository.path }
  await engine.ingest(hookBatch(started(source), preTool(source, 'call-around', 'pnpm test --run', 10)))
  await writeFiles(repository.path, { 'src/app.ts': 'export const app = 5\n' })
  await engine.ingest(hookBatch(postTool(source, 'call-around', 'pnpm test --run', 11)))
  await engine.ingest(hookBatch(preTool(source, 'call-other', 'pnpm lint', 12), postTool(source, 'call-other', 'pnpm lint', 13)))
  const snapshots = snapshotsOf(store, source)
  expect(snapshots.map(({ clean, head }) => ({ clean, head }))).toEqual([
    { clean: true, head: repository.head },
    { clean: false, head: repository.head },
  ])
  const [before, after] = snapshots
  expect(before !== undefined && after !== undefined && before.taken_at <= after.taken_at).toBe(true)
})

test('a check outside a git repository gives an unclean snapshot with the error', async ({ onTestFinished }) => {
  const home = await createHome(onTestFinished)
  const project = join(home.path, '..', 'plain')
  await writeFiles(project, { 'src/app.ts': 'export {}\n' })
  const store = home.open()
  const engine = createEngine({
    store,
    adapters,
    watch: { all: true, roots: [{ path: project, contracts: [CheckContract.parse({ name: 'test', command: '^pnpm test' })] }] },
  })
  const source = { session: 'plain-session', cwd: project }
  await runCheck(engine, source)
  const [snapshot] = snapshotsOf(store, source)
  expect(snapshot).toMatchObject({ head: null, clean: false, worktree: project })
  const fact = factsOf(store).find(({ id }) => id === snapshot?.fact)
  expect(fact?.kind === 'git_snapshot' ? fact.payload.error : null).toEqual(expect.any(String))
})

test('a snapshot is a daemon record that neither counts as session activity nor joins the observer queue', async ({
  onTestFinished,
}) => {
  const later = EpochNs.parse(4_102_444_800_000_000_000n)
  const { store, engine, repository } = await setup(onTestFinished, { now: () => later })
  const source = { session: 'daemon-session', cwd: repository.path }
  await runCheck(engine, source)
  const [snapshot] = snapshotsOf(store, source)
  const fact = factsOf(store).find(({ id }) => id === snapshot?.fact)
  expect(snapshot?.taken_at).toBe(later)
  expect(fact === undefined ? null : store.rawRecords.get(fact.seq)).toMatchObject({
    channel: 'snapshot',
    runtime: null,
    stream: null,
    position: { kind: 'daemon' },
    observed_at: later,
    parse_state: 'parsed',
  })
  const hookTimes = factsOf(store).filter(({ kind }) => kind !== 'git_snapshot').map(({ at }) => at)
  const session = store.observations.getSession(objectId(sessionKey('claude', source.session)))
  expect(session?.last_event_at).toBe(hookTimes.reduce((latest, time) => (time > latest ? time : latest)))
  const queued = store.interpretations.pending(runOf(source)).map(({ fact }) => fact)
  expect(queued).not.toContain(snapshot?.fact)
  expect(queued.toSorted()).toEqual(
    factsOf(store)
      .filter(({ kind }) => kind !== 'git_snapshot')
      .map(({ id }) => id)
      .toSorted(),
  )
})

test('snapshots read a stale index without rewriting it or touching a held index.lock', async ({ onTestFinished }) => {
  const { store, engine, repository } = await setup(onTestFinished)
  const index = join(repository.path, '.git', 'index')
  const lock = `${index}.lock`
  const future = new Date(Date.now() + 3_600_000)
  await utimes(join(repository.path, 'src', 'app.ts'), future, future)
  const before = await readFile(index)
  const modified = (await stat(index)).mtimeMs
  const first = { session: 'stale-session', cwd: repository.path }
  await runCheck(engine, first)
  expect(snapshotsOf(store, first)).toEqual([expect.objectContaining({ clean: true, head: repository.head })])
  expect(await readFile(index)).toEqual(before)
  expect((await stat(index)).mtimeMs).toBe(modified)
  await expect(stat(lock)).rejects.toThrow()

  await writeFile(lock, 'held by another git process')
  await writeFiles(repository.path, { 'src/new.ts': 'export {}\n' })
  const second = { session: 'locked-session', cwd: repository.path }
  await runCheck(engine, second)
  expect(snapshotsOf(store, second)).toEqual([expect.objectContaining({ clean: false, head: repository.head })])
  expect(await readFile(lock, 'utf8')).toBe('held by another git process')
  expect(await readFile(index)).toEqual(before)

  await rm(lock)
  await git(repository.path, 'status', '--porcelain')
  expect(await readFile(index)).not.toEqual(before)
})

test('a check snapshot is taken in the repository the check ran in, not where its session started', async ({ onTestFinished }) => {
  const home = await createHome(onTestFinished)
  const origin = await createRepository(onTestFinished, committed)
  const workspace = dirname(origin.path)
  const other = await initRepository(join(workspace, 'other'), committed)
  await writeFiles(other.path, { 'src/app.ts': 'export const app = 6\n' })
  const store = home.open()
  const engine = createEngine({
    store,
    adapters,
    watch: { all: true, roots: [{ path: workspace, contracts: [CheckContract.parse({ name: 'test', command: '^pnpm test' })] }] },
  })
  const thread = '01a0f752-40a7-76b2-9df9-5b374f75f98f'
  const startMs = 1_790_855_800_000
  const line = (ordinal: number, type: string, payload: Record<string, unknown>): string =>
    JSON.stringify({ timestamp: new Date(startMs + ordinal * 1000).toISOString(), ordinal, type, payload })
  const exec = (ordinal: number, call: string, input: Record<string, string>): string =>
    line(ordinal, 'response_item', { type: 'function_call', id: `fc_${call}`, name: 'exec_command', arguments: JSON.stringify(input), call_id: call })
  const lines = [
    codexRollout({ thread, cwd: origin.path })[0] ?? '',
    exec(1, 'call_other', { cmd: 'pnpm test', workdir: other.path }),
    line(2, 'event_msg', {
      type: 'item_completed',
      thread_id: thread,
      item: {
        type: 'CommandExecution',
        id: 'call_other',
        command: ['/bin/zsh', '-lc', 'pnpm test'],
        cwd: pathToFileURL(other.path).href,
        status: 'failed',
        aggregated_output: 'failed\n',
        exit_code: 1,
      },
      started_at_ms: startMs + 1500,
      completed_at_ms: startMs + 2000,
    }),
    exec(3, 'call_started', { cmd: 'pnpm test' }),
    line(4, 'response_item', { type: 'function_call_output', call_id: 'call_started', output: 'passed' }),
  ]
  const rollout = jsonlFile({ runtime: 'codex', path: join(workspace, 'rollout.jsonl'), lines, ino: 31n })
  await engine.ingest(rollout.batch(1, 3))
  await engine.ingest(rollout.batch(4, 5))
  const snapshots = store.artifacts.snapshots(runId(sessionKey('codex', thread)))
  expect(snapshots.map(({ worktree, head, clean, masks }) => ({ worktree, head, clean, masks }))).toEqual([
    { worktree: other.path, head: other.head, clean: false, masks: [workspace] },
    { worktree: origin.path, head: origin.head, clean: true, masks: [workspace] },
  ])
  const facts = factsOf(store).filter(({ kind }) => kind === 'git_snapshot')
  expect(facts[0]?.payload).toMatchObject({ entries: [{ status: ' M', path: 'src/app.ts' }] })
})
