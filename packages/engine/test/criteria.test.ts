import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CheckContract,
  type Criterion,
  type FactId,
  type FactOf,
  type GitSnapshot,
  type JsonValue,
  ModelVersion,
  type RunId,
  type SnapshotTrigger,
} from '@aang/contract'
import { runId } from '@aang/contract/ids'
import { createEngine, type Engine } from '@aang/engine'
import type { Store } from '@aang/store'
import { expect, test, vi } from 'vitest'
import { hookBatch, type JsonlFile, jsonlFile } from './batches.js'
import {
  failedTool,
  passed,
  postTool,
  preTool,
  reporting,
  type Source,
  started,
  stopped,
  testContract,
  verifiedCheck,
  verifyCommand,
} from './check-hooks.js'
import { adapters, factsOf, sessionKey } from './harness.js'
import { createHome, type Home } from './home.js'
import { createRepository, git, type Register, type Repository, writeFiles } from './repository.js'
import { claudeTranscript } from './samples.js'

interface SetupOptions {
  readonly commitPattern?: string | null
  readonly fsWatch?: boolean
  readonly masks?: readonly string[]
}

const committed = {
  'src/app.ts': 'export const app = 1\n',
  'src/util.ts': 'export const util = 2\n',
  'README.md': '# Project\n',
  '.gitignore': '*.log\n',
}

const observed = { kind: 'observed' } as const

const setup = async (register: Register, { commitPattern = reporting, fsWatch = false, masks = ['src'] }: SetupOptions = {}) => {
  const home = await createHome(register)
  const repository = await createRepository(register, committed)
  const contract = testContract(masks, commitPattern)
  const start = (store: Store): Engine => {
    const engine = createEngine({
      store,
      adapters,
      watch: { all: true, roots: [{ path: repository.path, contracts: [contract] }] },
      fsWatch,
    })
    register(() => engine.close())
    return engine
  }
  const store = home.open()
  return { home, store, engine: start(store), repository, start }
}

const isolatedCheckout = async (repository: Repository, name = 'verify'): Promise<string> => {
  const path = join(dirname(repository.path), name)
  await git(repository.path, 'worktree', 'add', '--quiet', '--detach', path, 'HEAD')
  return git(path, 'rev-parse', 'HEAD')
}

const transcriptOf = (source: Source, repository: Repository, call: string, output: string, minute = '00'): JsonlFile => {
  const line = (uuid: string, second: number, type: 'assistant' | 'user', message: JsonValue, extra: Record<string, JsonValue> = {}) =>
    JSON.stringify({ type, sessionId: source.session, uuid, timestamp: `2026-10-01T12:${minute}:0${String(second)}.000Z`, cwd: source.cwd, message, ...extra })
  const lines = [
    ...claudeTranscript(source).slice(0, 5),
    line('call', 1, 'assistant', {
      id: 'message-call',
      role: 'assistant',
      content: [{ type: 'tool_use', id: call, name: 'Bash', input: { command: verifyCommand } }],
    }),
    line(
      'result',
      2,
      'user',
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: call, content: output, is_error: false }] },
      { toolUseResult: { stdout: output, stderr: '', interrupted: false, isImage: false } },
    ),
  ]
  return jsonlFile({ runtime: 'claude', path: join(repository.path, '..', 'transcript.jsonl'), lines, ino: 41n })
}

const runOf = (source: Source): RunId => runId(sessionKey('claude', source.session))

const criteriaOf = (store: Store, source: Source): Criterion[] =>
  store.model.entities(runOf(source)).flatMap(({ kind, value }) => (kind === 'criterion' ? [value] : []))

const criterionOf = (store: Store, source: Source): Criterion => {
  const [criterion, ...others] = criteriaOf(store, source)
  if (criterion === undefined || others.length > 0) {
    throw new Error('the run must have exactly one contract criterion')
  }
  return criterion
}

const callFacts = (store: Store, ...calls: readonly string[]): FactId[] =>
  factsOf(store)
    .filter(({ entity_key }) => entity_key.kind === 'action' && calls.includes(entity_key.call))
    .map(({ id }) => id)
    .sort()

const snapshotsOf = (store: Store, source: Source): GitSnapshot[] => store.artifacts.snapshots(runOf(source))

const snapshotFact = (store: Store, source: Source, trigger: SnapshotTrigger): FactId => {
  const snapshot = snapshotsOf(store, source).findLast((candidate) => candidate.trigger === trigger)
  if (snapshot === undefined) {
    throw new Error(`no ${trigger} snapshot`)
  }
  return snapshot.fact
}

const journalOf = (store: Store, source: Source) =>
  store.model
    .entityChanges(runOf(source), { kind: 'criterion', id: criterionOf(store, source).id }, ModelVersion.parse(0))
    .map(({ op, author, after }) => ({ op, author, status: after?.kind === 'criterion' ? after.value.status.value : null }))

const confirm = async (
  engine: Engine,
  store: Store,
  repository: Repository,
  source: Source,
  call = 'call-verify',
): Promise<string> => {
  const commit = await isolatedCheckout(repository, `verify-${call}`)
  await engine.ingest(hookBatch(started(source), preTool(source, call, 10), postTool(source, call, passed(commit), 11)))
  expect(criterionOf(store, source)).toMatchObject({ status: { value: 'confirmed' }, checked_commit: commit })
  return commit
}

const reopen = async (home: Home, store: Store, engine: Engine): Promise<Store> => {
  await engine.close()
  store.close()
  return home.open()
}

test('a commit reported by a check in an isolated worktree confirms the contract criterion on that commit', async ({
  onTestFinished,
}) => {
  const { store, engine, repository } = await setup(onTestFinished)
  const source = { session: 'confirm-session', cwd: repository.path }
  const commit = await isolatedCheckout(repository)
  await engine.ingest(hookBatch(started(source), preTool(source, 'call-verify', 10), postTool(source, 'call-verify', passed(commit), 11)))
  expect(commit).toBe(repository.head)
  const criterion = criterionOf(store, source)
  expect(criterion).toEqual({
    id: criterion.id,
    run: runOf(source),
    stage: null,
    text: 'Check "test" passes',
    source: 'contract',
    contract: 'test',
    status: { value: 'confirmed', basis: observed, evidence: callFacts(store, 'call-verify') },
    checked_commit: commit,
    clean_tree_commit: null,
  })
  expect(journalOf(store, source)).toEqual([{ op: 'criterion.status', author: 'rule', status: 'confirmed' }])
})

test('a check read by backfill confirms the commit it reports by an abbreviated name', async ({ onTestFinished }) => {
  const { store, engine, repository } = await setup(onTestFinished)
  const source = { session: 'backfill-session', cwd: repository.path }
  const commit = await isolatedCheckout(repository)
  const transcript = transcriptOf(source, repository, 'tool-verify', passed(commit.slice(0, 12)))
  await engine.ingest(transcript.batch(1, transcript.lines.length))
  expect(criterionOf(store, source)).toMatchObject({
    status: { value: 'confirmed', basis: observed, evidence: callFacts(store, 'tool-verify') },
    checked_commit: commit,
  })
})

test.for([
  {
    scenario: 'a commit missing from the repository',
    output: () => Promise.resolve(passed('0123456789abcdef0123456789abcdef01234567')),
  },
  {
    scenario: 'two different commits',
    output: async (repository: Repository) => {
      await writeFiles(repository.path, { 'README.md': '# Second\n' })
      await git(repository.path, 'commit', '--quiet', '--all', '--message=second')
      return `${passed(repository.head ?? '')}${passed(await git(repository.path, 'rev-parse', 'HEAD'))}`
    },
  },
  {
    scenario: 'a tree instead of a commit',
    output: async (repository: Repository) => passed(await git(repository.path, 'rev-parse', 'HEAD^{tree}')),
  },
  { scenario: 'no commit at all', output: () => Promise.resolve('Tests passed\n') },
])('a passing check that reports $scenario stays passed_unversioned', async ({ output }, { onTestFinished }) => {
  const { store, engine, repository } = await setup(onTestFinished)
  const source = { session: 'unversioned-session', cwd: repository.path }
  const stdout = await output(repository)
  await engine.ingest(hookBatch(started(source), preTool(source, 'call-verify', 10), postTool(source, 'call-verify', stdout, 11)))
  expect(criterionOf(store, source)).toMatchObject({
    status: { value: 'passed_unversioned', basis: observed, evidence: callFacts(store, 'call-verify') },
    checked_commit: null,
    clean_tree_commit: null,
  })
})

test('a contract without a reported commit notes a tree that was clean on one HEAD before and after the check', async ({
  onTestFinished,
}) => {
  const { store, engine, repository } = await setup(onTestFinished, { commitPattern: null })
  const source = { session: 'note-session', cwd: repository.path }
  await engine.ingest(hookBatch(started(source), preTool(source, 'call-test', 10, 'pnpm test')))
  await engine.ingest(hookBatch(postTool(source, 'call-test', passed(repository.head ?? ''), 11, 'pnpm test')))
  const snapshots = snapshotsOf(store, source)
  expect(snapshots.map(({ clean, head }) => ({ clean, head }))).toEqual([
    { clean: true, head: repository.head },
    { clean: true, head: repository.head },
  ])
  expect(criterionOf(store, source)).toMatchObject({
    status: {
      value: 'passed_unversioned',
      basis: observed,
      evidence: [...callFacts(store, 'call-test'), ...snapshots.map(({ fact }) => fact)].sort(),
    },
    checked_commit: null,
    clean_tree_commit: repository.head,
  })
})

test('an input changed after the first snapshot and restored before the second gives no confirmation', async ({
  onTestFinished,
}) => {
  const { store, engine, repository } = await setup(onTestFinished)
  const source = { session: 'restored-session', cwd: repository.path }
  await engine.ingest(hookBatch(started(source), preTool(source, 'call-test', 10, 'pnpm test')))
  await writeFiles(repository.path, { 'src/app.ts': 'export const app = 7\n' })
  await writeFiles(repository.path, { 'src/app.ts': committed['src/app.ts'] })
  await engine.ingest(hookBatch(postTool(source, 'call-test', 'Tests passed\n', 11, 'pnpm test')))
  expect(criterionOf(store, source)).toMatchObject({
    status: { value: 'passed_unversioned' },
    checked_commit: null,
    clean_tree_commit: repository.head,
  })
})

test.for([
  { scenario: 'an ignored file', files: { 'src/debug.log': 'trace\n' } },
  { scenario: 'an uncommitted change', files: { 'src/app.ts': 'export const app = 8\n' } },
  { scenario: 'an untracked file', files: { 'src/new.ts': 'export {}\n' } },
])('$scenario under a mask leaves a passing check passed_unversioned without a note', async ({ files }, { onTestFinished }) => {
  const { store, engine, repository } = await setup(onTestFinished, { commitPattern: null })
  const source = { session: 'dirty-session', cwd: repository.path }
  await writeFiles(repository.path, files)
  await engine.ingest(hookBatch(started(source), preTool(source, 'call-test', 10, 'pnpm test')))
  await engine.ingest(hookBatch(postTool(source, 'call-test', 'Tests passed\n', 11, 'pnpm test')))
  expect(snapshotsOf(store, source).map(({ clean }) => clean)).toEqual([false, false])
  expect(criterionOf(store, source)).toMatchObject({
    status: { value: 'passed_unversioned', evidence: callFacts(store, 'call-test') },
    checked_commit: null,
    clean_tree_commit: null,
  })
})

test('a check outside a git repository cannot confirm the commit it reports', async ({ onTestFinished }) => {
  const home = await createHome(onTestFinished)
  const project = join(home.path, '..', 'plain')
  await mkdir(join(project, 'src'), { recursive: true })
  const store = home.open()
  const contract = CheckContract.parse({ name: 'test', command: 'pnpm test', commitPattern: reporting })
  const engine = createEngine({ store, adapters, watch: { all: true, roots: [{ path: project, contracts: [contract] }] }, fsWatch: false })
  onTestFinished(() => engine.close())
  const source = { session: 'plain-session', cwd: project }
  await engine.ingest(hookBatch(started(source), preTool(source, 'call-test', 10, 'pnpm test')))
  await engine.ingest(
    hookBatch(postTool(source, 'call-test', passed('0123456789abcdef0123456789abcdef01234567'), 11, 'pnpm test')),
  )
  expect(criterionOf(store, source)).toMatchObject({ status: { value: 'passed_unversioned' }, checked_commit: null, clean_tree_commit: null })
})

test('after confirmation an edit that fs watch does not report is caught as stale by the snapshot at the end of the turn', async ({
  onTestFinished,
}) => {
  const { store, engine, repository } = await setup(onTestFinished)
  const source = { session: 'turn-session', cwd: repository.path }
  const commit = await confirm(engine, store, repository, source)
  await writeFiles(repository.path, { 'src/app.ts': 'export const app = 9\n' })
  expect(criterionOf(store, source)).toMatchObject({ status: { value: 'confirmed' } })

  await engine.ingest(hookBatch(stopped(source, 1, 20)))
  expect(criterionOf(store, source)).toMatchObject({
    status: {
      value: 'stale',
      basis: observed,
      evidence: [...callFacts(store, 'call-verify'), snapshotFact(store, source, 'turn_end')].sort(),
    },
    checked_commit: commit,
    clean_tree_commit: null,
  })
  const stale = criterionOf(store, source)

  await engine.ingest(hookBatch(stopped(source, 2, 30)))
  expect(snapshotsOf(store, source).map(({ trigger, clean }) => ({ trigger, clean }))).toEqual([
    { trigger: 'check', clean: true },
    { trigger: 'turn_end', clean: false },
    { trigger: 'turn_end', clean: false },
  ])
  expect(criterionOf(store, source)).toEqual(stale)

  await writeFiles(repository.path, { 'src/app.ts': committed['src/app.ts'] })
  await engine.ingest(hookBatch(stopped(source, 3, 40)))
  expect(criterionOf(store, source)).toMatchObject({ status: { value: 'confirmed' }, checked_commit: commit })
  expect(journalOf(store, source).map(({ status }) => status)).toEqual(['confirmed', 'stale', 'confirmed'])
})

test('fs watch reports an edit under a mask and the confirmed criteria of runs in that tree become stale without new events', async ({
  onTestFinished,
}) => {
  const { store, engine, repository } = await setup(onTestFinished, { fsWatch: true })
  const first = { session: 'watch-session', cwd: repository.path }
  const second = { session: 'other-watch-session', cwd: repository.path }
  const commit = await confirm(engine, store, repository, first)
  await confirm(engine, store, repository, second, 'call-other')
  await writeFiles(repository.path, { 'src/app.ts': 'export const app = 10\n' })
  await vi.waitFor(
    () => {
      expect([first, second].map((source) => criterionOf(store, source).status.value)).toEqual(['stale', 'stale'])
    },
    { timeout: 15_000, interval: 50 },
  )
  expect(criterionOf(store, first)).toMatchObject({
    status: { evidence: [...callFacts(store, 'call-verify'), snapshotFact(store, first, 'fs_watch')].sort() },
    checked_commit: commit,
  })
  expect(criterionOf(store, second)).toMatchObject({
    status: { evidence: [...callFacts(store, 'call-other'), snapshotFact(store, second, 'fs_watch')].sort() },
    checked_commit: commit,
  })
})

test('fs watch follows a file mask through its directory and stops watching a criterion that is no longer confirmed', async ({
  onTestFinished,
}) => {
  const { store, engine, repository } = await setup(onTestFinished, { fsWatch: true, masks: ['src', 'README.md'] })
  const source = { session: 'file-mask-session', cwd: repository.path }
  const statusOf = (): string => criterionOf(store, source).status.value
  const watched = (): number => snapshotsOf(store, source).filter(({ trigger }) => trigger === 'fs_watch').length
  await confirm(engine, store, repository, source)
  await writeFiles(repository.path, { 'notes.txt': 'outside the masks\n', 'README.md': '# Edited\n' })
  await vi.waitFor(() => {
    expect(statusOf()).toBe('stale')
  }, { timeout: 15_000, interval: 50 })
  await writeFiles(repository.path, { 'README.md': committed['README.md'] })
  await vi.waitFor(() => {
    expect(statusOf()).toBe('confirmed')
  }, { timeout: 15_000, interval: 50 })

  await engine.ingest(hookBatch(preTool(source, 'call-broken', 20), failedTool(source, 'call-broken', 21)))
  expect(statusOf()).toBe('failed')
  const before = watched()
  await writeFiles(repository.path, { 'src/app.ts': 'export const app = 11\n', 'README.md': '# Ignored now\n' })
  await new Promise((resolve) => setTimeout(resolve, 500))
  await engine.refreshFreshness()
  expect(watched()).toBe(before)
})

test('closing the engine drops a change that fs watch reported but has not settled yet', async ({ onTestFinished }) => {
  const { store, engine, repository } = await setup(onTestFinished, { fsWatch: true })
  const source = { session: 'closing-session', cwd: repository.path }
  await confirm(engine, store, repository, source)
  const snapshots = snapshotsOf(store, source).length
  await writeFiles(repository.path, { 'src/app.ts': 'export const app = 12\n' })
  await new Promise((resolve) => setTimeout(resolve, 20))
  await engine.close()
  await new Promise((resolve) => setTimeout(resolve, 300))
  expect(snapshotsOf(store, source)).toHaveLength(snapshots)
  expect(criterionOf(store, source).status.value).toBe('confirmed')
})

test('after a restart the snapshot of a confirmed criterion finds a different HEAD and marks it stale', async ({
  onTestFinished,
}) => {
  const { home, store, engine, repository, start } = await setup(onTestFinished)
  const source = { session: 'restart-session', cwd: repository.path }
  const commit = await confirm(engine, store, repository, source)
  const reopened = await reopen(home, store, engine)
  await writeFiles(repository.path, { 'README.md': '# Moved on\n' })
  await git(repository.path, 'commit', '--quiet', '--all', '--message=later')

  const restarted = start(reopened)
  await restarted.refreshCriteria()
  const [restart] = reopened.artifacts.snapshots(runOf(source)).filter(({ trigger }) => trigger === 'restart')
  expect(restart).toMatchObject({ clean: true, head: await git(repository.path, 'rev-parse', 'HEAD') })
  expect(criterionOf(reopened, source)).toMatchObject({
    status: { value: 'stale', evidence: [...callFacts(reopened, 'call-verify'), restart?.fact].sort() },
    checked_commit: commit,
  })
})

test('a failing latest check fails the criterion and a passing repeat that reports a commit confirms it again', async ({
  onTestFinished,
}) => {
  const { store, engine, repository } = await setup(onTestFinished)
  const source = { session: 'repeat-session', cwd: repository.path }
  const commit = await confirm(engine, store, repository, source)
  await engine.ingest(hookBatch(preTool(source, 'call-broken', 20), failedTool(source, 'call-broken', 21)))
  expect(criterionOf(store, source)).toMatchObject({
    status: { value: 'failed', basis: observed, evidence: callFacts(store, 'call-broken') },
    checked_commit: null,
  })
  await engine.ingest(hookBatch(preTool(source, 'call-fixed', 30), postTool(source, 'call-fixed', passed(commit), 31)))
  expect(criterionOf(store, source)).toMatchObject({
    status: { value: 'confirmed', evidence: callFacts(store, 'call-fixed') },
    checked_commit: commit,
  })
  expect(journalOf(store, source).map(({ status }) => status)).toEqual(['confirmed', 'failed', 'confirmed'])
})

const crashScript = fileURLToPath(new URL('./criteria-process.ts', import.meta.url))

test('a criterion committed with its check survives a crash at the first git command after the commit and a redelivery', async ({
  onTestFinished,
}) => {
  const home = await createHome(onTestFinished)
  const repository = await createRepository(onTestFinished, committed)
  const source = { session: 'crash-session', cwd: repository.path }
  const commit = await isolatedCheckout(repository)
  const child = spawn(process.execPath, [crashScript, home.path, repository.path, source.session, commit], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    output += chunk
  })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    output += chunk
  })
  const [code] = (await once(child, 'exit')) as [number | null]
  expect({ code: code === 0 ? 0 : 'killed', output }).toEqual({ code: 'killed', output: '' })

  const store = home.open()
  const criterion = criterionOf(store, source)
  expect(criterion).toMatchObject({
    status: { value: 'confirmed', basis: observed, evidence: callFacts(store, 'call-verify') },
    checked_commit: commit,
  })
  expect(snapshotsOf(store, source)).toEqual([])
  const engine = createEngine({
    store,
    adapters,
    watch: { all: true, roots: [{ path: repository.path, contracts: [testContract(['src'])] }] },
    fsWatch: false,
  })
  onTestFinished(() => engine.close())
  expect(await engine.ingest(hookBatch(...verifiedCheck(source, commit)))).toMatchObject({ inserted: 0, duplicates: 3 })
  await engine.refreshCriteria()
  expect(snapshotsOf(store, source).map(({ trigger, clean }) => ({ trigger, clean }))).toEqual([{ trigger: 'restart', clean: true }])
  expect(criterionOf(store, source)).toEqual(criterion)
  expect(journalOf(store, source)).toEqual([{ op: 'criterion.status', author: 'rule', status: 'confirmed' }])
})

test('a check run from a subdirectory turns stale when that directory is deleted, at the end of the turn and after a restart', async ({
  onTestFinished,
}) => {
  const { home, store, engine, repository, start } = await setup(onTestFinished)
  const source = { session: 'subdirectory-session', cwd: repository.path }
  const inside = { ...source, cwd: join(repository.path, 'src') }
  const commit = await isolatedCheckout(repository)
  await engine.ingest(
    hookBatch(started(source), preTool(inside, 'call-verify', 10), postTool(inside, 'call-verify', passed(commit), 11)),
  )
  expect(criterionOf(store, source)).toMatchObject({ status: { value: 'confirmed' }, checked_commit: commit })

  await rm(inside.cwd, { recursive: true, force: true })
  await engine.ingest(hookBatch(stopped(source, 1, 20)))
  expect(snapshotsOf(store, source).at(-1)).toMatchObject({ trigger: 'turn_end', worktree: inside.cwd, clean: false })
  const stale = criterionOf(store, source)
  expect(stale).toMatchObject({
    status: { value: 'stale', evidence: [...callFacts(store, 'call-verify'), snapshotFact(store, source, 'turn_end')].sort() },
    checked_commit: commit,
  })

  const reopened = await reopen(home, store, engine)
  await start(reopened).refreshCriteria()
  expect(snapshotsOf(reopened, source).at(-1)).toMatchObject({ trigger: 'restart', worktree: inside.cwd, clean: false })
  expect(criterionOf(reopened, source)).toEqual(stale)
})

test.for([
  { scenario: 'an edit of a file', mask: 'src/*.ts', files: { 'src/app.ts': 'export const app = 13\n' } },
  { scenario: 'a new file', mask: 'src/*.ts', files: { 'src/created.ts': 'export const created = 1\n' } },
  { scenario: 'an edit under a wildcard directory', mask: '*/util.ts', files: { 'src/util.ts': 'export const util = 14\n' } },
])('fs watch reports $scenario matched by the glob mask $mask and the confirmed criterion becomes stale', async (
  { mask, files },
  { onTestFinished },
) => {
  const { store, engine, repository } = await setup(onTestFinished, { fsWatch: true, masks: [mask] })
  const source = { session: 'glob-session', cwd: repository.path }
  await confirm(engine, store, repository, source)
  await writeFiles(repository.path, files)
  await vi.waitFor(() => {
    expect(criterionOf(store, source).status.value).toBe('stale')
  }, { timeout: 15_000, interval: 50 })
  expect(snapshotsOf(store, source).at(-1)).toMatchObject({ trigger: 'fs_watch', clean: false })
})

test('a confirmation cites the transcript result that reported the commit after a hook result without it', async ({
  onTestFinished,
}) => {
  const { store, engine, repository } = await setup(onTestFinished)
  const source = { session: 'merged-session', cwd: repository.path }
  const commit = await isolatedCheckout(repository)
  await engine.ingest(
    hookBatch(started(source), preTool(source, 'tool-verify', 10), postTool(source, 'tool-verify', 'Tests passed\n', 11)),
  )
  expect(criterionOf(store, source)).toMatchObject({ status: { value: 'passed_unversioned' }, checked_commit: null })

  const transcript = transcriptOf(source, repository, 'tool-verify', passed(commit), '30')
  await engine.ingest(transcript.batch(1, transcript.lines.length))
  const ends = factsOf(store).filter((fact): fact is FactOf<'action_end'> => fact.kind === 'action_end')
  expect(ends.map(({ payload }) => payload.output)).toEqual(['Tests passed\n', passed(commit)])
  expect(ends[0]?.at).toBeLessThan(ends[1]?.at ?? 0n)
  const criterion = criterionOf(store, source)
  expect(criterion).toMatchObject({
    status: { value: 'confirmed', evidence: callFacts(store, 'tool-verify') },
    checked_commit: commit,
  })
  expect(criterion.status.evidence).toContain(ends[1]?.id)
  const [, confirmation] = store.model.entityChanges(runOf(source), { kind: 'criterion', id: criterion.id }, ModelVersion.parse(0))
  expect(confirmation?.evidence).toEqual(criterion.status.evidence)
})
