import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type AttentionItem,
  CheckContract,
  EpochNs,
  type FactId,
  type JsonValue,
  ModelVersion,
  type RunId,
  type SessionKey,
} from '@aang/contract'
import { objectId, runId } from '@aang/contract/ids'
import {
  applyChangeSet,
  applyObserverResponse,
  beginObserverCall,
  createEngine,
  type Engine,
  type ModelChangeDraft,
  type WatchedRoot,
} from '@aang/engine'
import type { Store } from '@aang/store'
import { expect, test } from 'vitest'
import { type HookDelivery, hookBatch, jsonlFile } from './batches.js'
import { adapters, factsOf, sessionKey } from './harness.js'
import { createHome } from './home.js'
import { callId, inputFor, response } from './observer-fixtures.js'
import { claudeHook, claudeTranscript, codexRollout } from './samples.js'

type Register = Parameters<typeof createHome>[0]

interface Source {
  readonly session: string
  readonly cwd: string
}

type Outcome = { readonly exit: number } | { readonly error: string } | 'pass' | 'interrupt'

const observed = { kind: 'observed' } as const

const testContract = CheckContract.parse({ name: 'test', command: '^pnpm test' })

const setup = async (register: Register, roots: (project: string) => readonly WatchedRoot[]) => {
  const home = await createHome(register)
  const project = join(home.path, '..', 'project')
  await mkdir(project, { recursive: true })
  const store = home.open()
  const engine: Engine = createEngine({ store, adapters, watch: { all: true, roots: roots(project) } })
  return { home, store, engine, project }
}

const watchingTests = (project: string): readonly WatchedRoot[] => [{ path: project, contracts: [testContract] }]

const runOf = (runtime: 'claude' | 'codex', session: string): RunId => runId(sessionKey(runtime, session))

const actionOf = (source: Source, call: string) =>
  objectId({ kind: 'action', runtime: 'claude', session: source.session, call })

const started = (source: Source): HookDelivery => ({
  file: `${source.session}-start.evt`,
  payload: claudeHook('SessionStart.startup.json', source),
})

const check = (
  source: Source,
  call: string,
  command: string,
  outcome: Outcome,
  arrival: number,
  input: Record<string, JsonValue> = {},
): HookDelivery[] => {
  const tool = { tool_use_id: call, tool_input: { command, description: 'Run the check', ...input } }
  const end =
    outcome === 'pass'
      ? claudeHook('PostToolUse.Bash.json', source, tool)
      : claudeHook('PostToolUseFailure.Bash.json', source, {
          ...tool,
          error:
            outcome === 'interrupt'
              ? 'Exit code 130\nInterrupted'
              : 'error' in outcome
                ? outcome.error
                : `Exit code ${String(outcome.exit)}\nchecks failed`,
          is_interrupt: outcome === 'interrupt',
        })
  return [
    { file: `${call}-pre.evt`, payload: claudeHook('PreToolUse.Bash.json', source, tool), arrival },
    { file: `${call}-post.evt`, payload: end, arrival: arrival + 1 },
  ]
}

const transcriptLine = (
  source: Source,
  uuid: string,
  timestamp: string,
  type: 'assistant' | 'user',
  message: JsonValue,
  extra: Record<string, JsonValue> = {},
): string =>
  JSON.stringify({ type, sessionId: source.session, uuid, timestamp, cwd: source.cwd, message, ...extra })

const bashCall = (source: Source, uuid: string, timestamp: string, id: string): string =>
  transcriptLine(source, uuid, timestamp, 'assistant', {
    id: `message-${uuid}`,
    role: 'assistant',
    content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'pnpm test' } }],
  })

const bashFailure = (source: Source, uuid: string, timestamp: string, id: string): string =>
  transcriptLine(source, uuid, timestamp, 'user', {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content: 'Exit code 1\nfailed', is_error: true }],
  })

const codexThread = '01a0f752-40a7-76b2-9df9-5b374f75f98f'

const codexTurn = '01a0f752-4102-7740-9432-0533263c2dc1'

const codexStartMs = 1_790_855_800_000

const zshTest = ['/bin/zsh', '-lc', 'pnpm test']

const codexLine = (ordinal: number, type: string, payload: Record<string, JsonValue>): string =>
  JSON.stringify({ timestamp: new Date(codexStartMs + ordinal * 1000).toISOString(), ordinal, type, payload })

const functionCall = (ordinal: number, call: string, name = 'exec_command', input: JsonValue = { cmd: 'pnpm test' }) =>
  codexLine(ordinal, 'response_item', {
    type: 'function_call',
    id: `fc_${call}`,
    name,
    arguments: JSON.stringify(input),
    call_id: call,
    internal_chat_message_metadata_passthrough: { turn_id: codexTurn },
  })

const functionOutput = (ordinal: number, call: string, output: string) =>
  codexLine(ordinal, 'response_item', {
    type: 'function_call_output',
    call_id: call,
    output,
    internal_chat_message_metadata_passthrough: { turn_id: codexTurn },
  })

const exited = (exit: number): string => `Process exited with code ${String(exit)}\nOutput:\ntests\n`

const commandItem = (
  project: string,
  ordinal: number,
  call: string,
  exit: number,
  command: readonly string[] = zshTest,
  started = ordinal,
) =>
  codexLine(ordinal, 'event_msg', {
    type: 'item_completed',
    thread_id: codexThread,
    turn_id: codexTurn,
    item: {
      type: 'CommandExecution',
      id: call,
      command: [...command],
      cwd: `file://${project}`,
      status: exit === 0 ? 'completed' : 'failed',
      aggregated_output: 'tests\n',
      exit_code: exit,
    },
    started_at_ms: codexStartMs + started * 1000,
    completed_at_ms: codexStartMs + ordinal * 1000,
  })

const codexAt = (ordinal: number): EpochNs => EpochNs.parse(BigInt(codexStartMs + ordinal * 1000) * 1_000_000n)

const codexAction = (call: string) => objectId({ kind: 'action', runtime: 'codex', session: codexThread, call })

const failedChecks = (store: Store, run: RunId): AttentionItem[] =>
  store.model
    .entities(run)
    .flatMap(({ kind, value }) => (kind === 'attention_item' && value.kind === 'failed_check' ? [value] : []))
    .sort((left, right) =>
      left.opened_at !== right.opened_at ? (left.opened_at < right.opened_at ? -1 : 1) : left.id < right.id ? -1 : 1,
    )

const callFacts = (store: Store, call: string) =>
  factsOf(store).filter((fact) => fact.entity_key.kind === 'action' && fact.entity_key.call === call)

const factIdsOf = (store: Store, ...calls: readonly string[]): FactId[] =>
  calls.flatMap((call) => callFacts(store, call).map(({ id }) => id)).sort()

const endedAt = (store: Store, call: string): EpochNs => {
  const end = callFacts(store, call).find((fact) => fact.kind === 'action_end')
  if (end === undefined) {
    throw new Error(`the action ${call} has no end`)
  }
  return end.at
}

const changesOf = (store: Store, run: RunId, item: AttentionItem) =>
  store.model.entityChanges(run, { kind: 'attention_item', id: item.id }, ModelVersion.parse(0))

const journalOf = (store: Store, run: RunId, item: AttentionItem) =>
  changesOf(store, run, item).map(({ op, author, basis, evidence }) => ({ op, author, basis, evidence }))

const versionsOf = (store: Store, run: RunId, item: AttentionItem): number[] =>
  changesOf(store, run, item).map(({ version }) => version - store.model.head(run))

const linkRun = (store: Store, run: RunId, root: SessionKey, attached: readonly SessionKey[] = []): void => {
  const member = (key: SessionKey) => ({ kind: 'session_membership', value: { session: objectId(key), run } }) as const
  store.transaction((transaction) => {
    applyChangeSet(transaction, {
      run,
      author: 'rule',
      at: EpochNs.parse(1n),
      changes: [
        {
          op: 'run.create',
          basis: observed,
          evidence: [],
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
        { op: 'run.create', basis: observed, evidence: [], put: member(root) },
        ...attached.map(
          (key): ModelChangeDraft => ({ op: 'session.move', basis: observed, evidence: [], put: member(key) }),
        ),
      ],
    })
    const session = transaction.observations.getSession(objectId(root))
    if (session !== null) {
      transaction.observations.save({ ...session, run })
    }
  })
}

test('a failed check opens an item in its ingest transaction and a successful repeat closes it', async ({
  onTestFinished,
}) => {
  const { home, store, engine, project } = await setup(onTestFinished, watchingTests)
  const source = { session: 'check-session', cwd: project }
  const run = runOf('claude', source.session)
  await engine.ingest(hookBatch(started(source), ...check(source, 'call-fail', 'pnpm test --run', { exit: 1 }, 10)))
  const [opened, ...others] = failedChecks(store, run)
  expect(others).toEqual([])
  expect(opened).toMatchObject({
    run,
    author: 'rule',
    text: 'Check "test" failed with exit code 1',
    stage: null,
    action: actionOf(source, 'call-fail'),
    basis: observed,
    evidence: factIdsOf(store, 'call-fail'),
    runtime_wait: 'none',
    resolution: 'open',
    opened_at: endedAt(store, 'call-fail'),
    closed_at: null,
  })
  const pass = hookBatch(...check(source, 'call-pass', 'pnpm test --run', 'pass', 20))
  await engine.ingest(pass)
  const [closed] = failedChecks(store, run)
  expect(closed).toMatchObject({
    id: opened?.id,
    action: actionOf(source, 'call-fail'),
    evidence: factIdsOf(store, 'call-fail'),
    resolution: 'answered',
    closed_at: endedAt(store, 'call-pass'),
  })
  if (opened === undefined || closed === undefined) {
    throw new Error('the failed check must have an attention item')
  }
  expect(journalOf(store, run, closed)).toEqual([
    { op: 'attention.open', author: 'rule', basis: observed, evidence: factIdsOf(store, 'call-fail') },
    { op: 'attention.close', author: 'rule', basis: observed, evidence: factIdsOf(store, 'call-pass') },
  ])
  expect(versionsOf(store, run, closed)).toEqual([-1, 0])
  const head = store.model.head(run)
  await engine.ingest(pass)
  expect(store.model.head(run)).toBe(head)
  store.close()
  const reopened = home.open()
  expect(failedChecks(reopened, run)).toEqual([closed])
  reopened.transaction((transaction) => {
    transaction.model.replay()
  })
  expect(failedChecks(reopened, run)).toEqual([closed])
})

test('a command that does not match the contract is neither a failed check nor its successful repeat', async ({
  onTestFinished,
}) => {
  const { store, engine, project } = await setup(onTestFinished, watchingTests)
  const source = { session: 'mismatch-session', cwd: project }
  const run = runOf('claude', source.session)
  await engine.ingest(hookBatch(started(source), ...check(source, 'call-lint', 'pnpm lint', { exit: 1 }, 10)))
  expect(failedChecks(store, run)).toEqual([])
  await engine.ingest(hookBatch(...check(source, 'call-test', 'pnpm test', { exit: 1 }, 20)))
  await engine.ingest(hookBatch(...check(source, 'call-build', 'pnpm build && pnpm test', 'pass', 30)))
  expect(failedChecks(store, run)).toMatchObject([{ action: actionOf(source, 'call-test'), resolution: 'open' }])
})

test('repeated failures keep one open item that cites every failure and names the latest one', async ({
  onTestFinished,
}) => {
  const { store, engine, project } = await setup(onTestFinished, watchingTests)
  const source = { session: 'repeat-session', cwd: project }
  const run = runOf('claude', source.session)
  await engine.ingest(hookBatch(started(source), ...check(source, 'call-1', 'pnpm test', { exit: 1 }, 10)))
  const [first] = failedChecks(store, run)
  await engine.ingest(hookBatch(...check(source, 'call-2', 'pnpm test', { exit: 2 }, 20)))
  expect(failedChecks(store, run)).toEqual([
    expect.objectContaining({
      id: first?.id,
      text: 'Check "test" failed with exit code 2',
      action: actionOf(source, 'call-2'),
      evidence: factIdsOf(store, 'call-1', 'call-2'),
      opened_at: endedAt(store, 'call-1'),
      resolution: 'open',
    }),
  ])
  await engine.ingest(hookBatch(...check(source, 'call-3', 'pnpm test', 'pass', 30)))
  await engine.ingest(hookBatch(...check(source, 'call-4', 'pnpm test', { exit: 3 }, 40)))
  expect(failedChecks(store, run)).toMatchObject([
    { id: first?.id, resolution: 'answered', closed_at: endedAt(store, 'call-3') },
    { action: actionOf(source, 'call-4'), resolution: 'open', opened_at: endedAt(store, 'call-4') },
  ])
})

test('exit codes decide a check through the success codes of its contract, and an error without one fails it', async ({
  onTestFinished,
}) => {
  const lint = CheckContract.parse({ name: 'lint', command: 'eslint', successExitCodes: [0, 1] })
  const { store, engine, project } = await setup(onTestFinished, (project) => [{ path: project, contracts: [lint] }])
  const source = { session: 'codes-session', cwd: project }
  const run = runOf('claude', source.session)
  await engine.ingest(hookBatch(started(source), ...check(source, 'call-warn', 'npx eslint .', { exit: 1 }, 10)))
  expect(failedChecks(store, run)).toEqual([])
  await engine.ingest(hookBatch(...check(source, 'call-timeout', 'npx eslint .', { error: 'Command timed out' }, 20)))
  expect(failedChecks(store, run)).toMatchObject([{ text: 'Check "lint" failed', resolution: 'open' }])
  await engine.ingest(hookBatch(...check(source, 'call-crash', 'npx eslint .', { exit: 2 }, 30)))
  await engine.ingest(hookBatch(...check(source, 'call-again', 'npx eslint .', { exit: 1 }, 40)))
  expect(failedChecks(store, run)).toMatchObject([
    {
      text: 'Check "lint" failed with exit code 2',
      evidence: factIdsOf(store, 'call-timeout', 'call-crash'),
      resolution: 'answered',
      closed_at: endedAt(store, 'call-again'),
    },
  ])
})

test('an interrupted check, a check left running in the background and its polling give no result', async ({
  onTestFinished,
}) => {
  const { store, engine, project } = await setup(onTestFinished, watchingTests)
  const source = { session: 'pending-session', cwd: project }
  const run = runOf('claude', source.session)
  await engine.ingest(hookBatch(started(source), ...check(source, 'call-stopped', 'pnpm test', 'interrupt', 10)))
  expect(failedChecks(store, run)).toEqual([])
  await engine.ingest(hookBatch(...check(source, 'call-fail', 'pnpm test', { exit: 1 }, 20)))
  const before = failedChecks(store, run)
  const poll = (name: string) =>
    claudeHook(name, source, {
      tool_name: 'BashOutput',
      tool_use_id: 'call-poll',
      tool_input: { bash_id: 'pnpm test' },
    })
  await engine.ingest(
    hookBatch(...check(source, 'call-background', 'pnpm test', 'pass', 30, { run_in_background: true })),
  )
  await engine.ingest(
    hookBatch(
      { file: 'poll-pre.evt', payload: poll('PreToolUse.Bash.json'), arrival: 35 },
      { file: 'poll-post.evt', payload: poll('PostToolUse.Bash.json'), arrival: 36 },
    ),
  )
  await engine.ingest(hookBatch(...check(source, 'call-stopped-again', 'pnpm test', 'interrupt', 40)))
  expect(failedChecks(store, run)).toEqual(before)
  expect(before).toMatchObject([{ action: actionOf(source, 'call-fail'), resolution: 'open' }])
})

test('a transcript read at once keeps a failure that was fixed later as a closed item in history', async ({
  onTestFinished,
}) => {
  const { store, engine, project } = await setup(onTestFinished, watchingTests)
  const source = { session: 'transcript-session', cwd: project }
  const run = runOf('claude', source.session)
  const second = (value: number) => `2026-10-01T12:00:0${String(value)}.000Z`
  const lines = [
    ...claudeTranscript(source).slice(0, 5),
    bashCall(source, 'call-a', second(1), 'tool-fail'),
    bashFailure(source, 'result-a', second(2), 'tool-fail'),
    bashCall(source, 'call-b', second(3), 'tool-pass'),
    transcriptLine(
      source,
      'result-b',
      second(4),
      'user',
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-pass', content: 'ok', is_error: false }] },
      { toolUseResult: { stdout: 'ok', stderr: '', interrupted: false, isImage: false } },
    ),
  ]
  const file = jsonlFile({ runtime: 'claude', path: join(project, 'transcript.jsonl'), lines, ino: 7n })
  await engine.ingest(file.batch(1, lines.length))
  const [item] = failedChecks(store, run)
  if (item === undefined) {
    throw new Error('the fixed failure must stay in history')
  }
  expect(item).toMatchObject({
    action: objectId({ kind: 'action', runtime: 'claude', session: source.session, call: 'tool-fail' }),
    text: 'Check "test" failed with exit code 1',
    resolution: 'answered',
    closed_at: endedAt(store, 'tool-pass'),
  })
  expect(journalOf(store, run, item).map(({ op }) => op)).toEqual(['attention.open', 'attention.close'])
  expect(versionsOf(store, run, item)).toEqual([0, 0])
})

test('a late earlier failure joins the open item and a late success splits it at its time', async ({
  onTestFinished,
}) => {
  const { store, engine, project } = await setup(onTestFinished, watchingTests)
  const source = { session: 'late-session', cwd: project }
  const run = runOf('claude', source.session)
  await engine.ingest(hookBatch(started(source), ...check(source, 'call-later', 'pnpm test', { exit: 2 }, 30)))
  const [item] = failedChecks(store, run)
  await engine.ingest(hookBatch(...check(source, 'call-earlier', 'pnpm test', { exit: 1 }, 10)))
  expect(failedChecks(store, run)).toMatchObject([
    {
      id: item?.id,
      action: actionOf(source, 'call-later'),
      evidence: factIdsOf(store, 'call-earlier', 'call-later'),
      opened_at: endedAt(store, 'call-earlier'),
      resolution: 'open',
    },
  ])
  await engine.ingest(hookBatch(...check(source, 'call-between', 'pnpm test', 'pass', 20)))
  expect(failedChecks(store, run)).toMatchObject([
    {
      action: actionOf(source, 'call-earlier'),
      evidence: factIdsOf(store, 'call-earlier'),
      resolution: 'answered',
      closed_at: endedAt(store, 'call-between'),
    },
    {
      id: item?.id,
      action: actionOf(source, 'call-later'),
      evidence: factIdsOf(store, 'call-later'),
      resolution: 'open',
    },
  ])
})

test('a refined end time that merges two streaks closes the open item by the success it now precedes', async ({
  onTestFinished,
}) => {
  const { home, store, engine, project } = await setup(onTestFinished, watchingTests)
  const source = { session: 'merge-session', cwd: project }
  const run = runOf('claude', source.session)
  const second = 1_000_000_000
  await engine.ingest(hookBatch(started(source), ...check(source, 'call-a', 'pnpm test', { exit: 1 }, second)))
  await engine.ingest(hookBatch(...check(source, 'call-b', 'pnpm test', 'pass', 3 * second)))
  await engine.ingest(hookBatch(...check(source, 'call-c', 'pnpm test', { exit: 1 }, 5 * second)))
  const [first, open] = failedChecks(store, run)
  if (first === undefined || open === undefined) {
    throw new Error('both streaks must have an attention item')
  }
  expect([first, open]).toMatchObject([
    { action: actionOf(source, 'call-a'), resolution: 'answered', closed_at: endedAt(store, 'call-b') },
    { action: actionOf(source, 'call-c'), resolution: 'open' },
  ])
  const refinedMs = Number(endedAt(store, 'call-a') / 1_000_000n) + 500
  const refined = EpochNs.parse(BigInt(refinedMs) * 1_000_000n)
  const lines = [
    bashCall(source, 'transcript-call-c', new Date(refinedMs - 100).toISOString(), 'call-c'),
    bashFailure(source, 'transcript-result-c', new Date(refinedMs).toISOString(), 'call-c'),
  ]
  const transcript = jsonlFile({ runtime: 'claude', path: join(project, 'merge.jsonl'), lines, ino: 15n })
  await engine.ingest(transcript.batch(1, lines.length))
  const cited = callFacts(store, 'call-c').filter((fact) => fact.kind === 'action_start' || fact.at === refined)
  const items = new Map(failedChecks(store, run).map((item) => [item.id, item]))
  expect([...items.keys()].sort()).toEqual([first.id, open.id].sort())
  expect(items.get(first.id)).toEqual(first)
  expect(items.get(open.id)).toMatchObject({
    action: actionOf(source, 'call-c'),
    evidence: [...factIdsOf(store, 'call-a'), ...cited.map(({ id }) => id)].sort(),
    opened_at: endedAt(store, 'call-a'),
    resolution: 'answered',
    closed_at: endedAt(store, 'call-b'),
  })
  expect(journalOf(store, run, open)).toEqual([
    { op: 'attention.open', author: 'rule', basis: observed, evidence: open.evidence },
    { op: 'attention.close', author: 'rule', basis: observed, evidence: factIdsOf(store, 'call-b') },
  ])
  const head = store.model.head(run)
  await engine.ingest(hookBatch(...check(source, 'call-d', 'pnpm test', 'pass', 7 * second)))
  expect(store.model.head(run)).toBe(head)
  const after = failedChecks(store, run)
  store.close()
  const reopened = home.open()
  reopened.transaction((transaction) => {
    transaction.model.replay()
  })
  expect(failedChecks(reopened, run)).toEqual(after)
})

test('contracts apply to runs whose root directory lies in their root, the deepest root first', async ({
  onTestFinished,
}) => {
  const outer = (project: string): readonly WatchedRoot[] => [
    { path: project, contracts: [CheckContract.parse({ name: 'test', command: '^make check' })] },
    { path: join(project, 'packages', 'app'), contracts: [testContract] },
  ]
  const { store, engine, project } = await setup(onTestFinished, outer)
  const inner = { session: 'inner-session', cwd: join(project, 'packages', 'app', 'src') }
  const top = { session: 'outer-session', cwd: project }
  const elsewhere = { session: 'elsewhere-session', cwd: join(project, '..', 'scratch') }
  await engine.ingest(
    hookBatch(
      started(inner),
      started(top),
      started(elsewhere),
      ...check(inner, 'inner-make', 'make check', { exit: 1 }, 10),
      ...check(inner, 'inner-pnpm', 'pnpm test', { exit: 1 }, 20),
      ...check(top, 'top-make', 'make check', { exit: 1 }, 30),
      ...check(top, 'top-pnpm', 'pnpm test', { exit: 1 }, 40),
      ...check(elsewhere, 'elsewhere-pnpm', 'pnpm test', { exit: 1 }, 50),
    ),
  )
  expect(failedChecks(store, runOf('claude', inner.session)).map(({ action }) => action)).toEqual([
    actionOf(inner, 'inner-pnpm'),
  ])
  expect(failedChecks(store, runOf('claude', top.session)).map(({ action }) => action)).toEqual([
    actionOf(top, 'top-make'),
  ])
  expect(failedChecks(store, runOf('claude', elsewhere.session))).toEqual([])
})

test('a successful repeat in another session of the run closes the item of its root session', async ({
  onTestFinished,
}) => {
  const { store, engine, project } = await setup(onTestFinished, watchingTests)
  const root = { session: 'root-session', cwd: project }
  const attached = { session: 'attached-session', cwd: join(project, '..', 'elsewhere') }
  const run = runOf('claude', root.session)
  linkRun(store, run, sessionKey('claude', root.session), [sessionKey('claude', attached.session)])
  await engine.ingest(hookBatch(started(root), ...check(root, 'root-fail', 'pnpm test', { exit: 1 }, 10)))
  await engine.ingest(
    hookBatch(
      started(attached),
      ...check(root, 'root-build', 'pnpm build', 'pass', 15),
      ...check(attached, 'attached-pass', 'pnpm test', 'pass', 20),
    ),
  )
  expect(failedChecks(store, run)).toMatchObject([
    { action: actionOf(root, 'root-fail'), resolution: 'answered', closed_at: endedAt(store, 'attached-pass') },
  ])
  expect(store.model.head(runOf('claude', attached.session))).toBe(0)
})

test('a Codex check is decided by the exit code of its command item, with or without a function call', async ({
  onTestFinished,
}) => {
  const { store, engine, project } = await setup(onTestFinished, watchingTests)
  const run = runOf('codex', codexThread)
  const lines = [
    codexRollout({ thread: codexThread, cwd: project })[0] ?? '',
    functionCall(1, 'call_fail'),
    commandItem(project, 2, 'call_fail', 1),
    functionOutput(3, 'call_fail', exited(1)),
    functionCall(4, 'call_unreported'),
    functionOutput(5, 'call_unreported', exited(0)),
    commandItem(project, 6, 'exec-6f1c2d6e-0f8b-4c58-9a7e-3b1f2a4c5d6e', 0),
  ]
  const file = jsonlFile({ runtime: 'codex', path: join(project, 'rollout.jsonl'), lines, ino: 9n })
  await engine.ingest(file.batch(1, 6))
  expect(failedChecks(store, run)).toMatchObject([
    {
      action: codexAction('call_fail'),
      text: 'Check "test" failed with exit code 1',
      resolution: 'open',
    },
  ])
  await engine.ingest(file.batch(7, lines.length))
  expect(failedChecks(store, run)).toMatchObject([
    { resolution: 'answered', closed_at: endedAt(store, 'exec-6f1c2d6e-0f8b-4c58-9a7e-3b1f2a4c5d6e') },
  ])
})

test.for(['at once', 'line by line'] as const)(
  'a Codex check still running after its interim output is ordered by its final result, read %s',
  async (reading, { onTestFinished }) => {
    const { store, engine, project } = await setup(onTestFinished, watchingTests)
    const run = runOf('codex', codexThread)
    const running = 'Chunk ID: 5c1f0a\nWall time: 10.0 seconds\nProcess running with session ID 4821\nOutput:\n'
    const lines = [
      codexRollout({ thread: codexThread, cwd: project })[0] ?? '',
      functionCall(1, 'call_slow'),
      functionOutput(2, 'call_slow', running),
      functionCall(3, 'call_quick'),
      commandItem(project, 4, 'call_quick', 0),
      functionOutput(5, 'call_quick', exited(0)),
      functionCall(6, 'call_poll', 'write_stdin', { session_id: 4821, chars: '' }),
      functionOutput(7, 'call_poll', exited(1)),
      commandItem(project, 8, 'call_slow', 1, zshTest, 1),
    ]
    const file = jsonlFile({ runtime: 'codex', path: join(project, 'rollout.jsonl'), lines, ino: 11n })
    const portions = reading === 'at once' ? [[1, lines.length]] : lines.map((_, index) => [index + 1, index + 1])
    for (const [from = 1, to = from] of portions) {
      await engine.ingest(file.batch(from, to))
    }
    expect(failedChecks(store, run)).toMatchObject([
      {
        action: codexAction('call_slow'),
        text: 'Check "test" failed with exit code 1',
        resolution: 'open',
        opened_at: codexAt(8),
        closed_at: null,
      },
    ])
  },
)

test('a Codex check run through PowerShell or cmd without a function call opens and closes its item', async ({
  onTestFinished,
}) => {
  const { store, engine, project } = await setup(onTestFinished, watchingTests)
  const run = runOf('codex', codexThread)
  const pwsh = ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', '-NoProfile', '-Command', 'pnpm test']
  const powershell = ['C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', '-Command', 'pnpm test']
  const cmd = ['C:\\WINDOWS\\system32\\cmd.exe', '/c', 'pnpm test --run']
  const lint = ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', '-NoProfile', '-Command', 'pnpm lint']
  const lines = [
    codexRollout({ thread: codexThread, cwd: project })[0] ?? '',
    commandItem(project, 1, 'exec-pwsh', 1, pwsh),
    commandItem(project, 2, 'exec-lint', 0, lint),
    commandItem(project, 3, 'exec-cmd', 0, cmd),
    commandItem(project, 4, 'exec-powershell', 2, powershell),
  ]
  const file = jsonlFile({ runtime: 'codex', path: join(project, 'rollout.jsonl'), lines, ino: 13n })
  await engine.ingest(file.batch(1, 3))
  expect(failedChecks(store, run)).toMatchObject([
    { action: codexAction('exec-pwsh'), text: 'Check "test" failed with exit code 1', resolution: 'open' },
  ])
  await engine.ingest(file.batch(4, 4))
  expect(failedChecks(store, run)).toMatchObject([
    { action: codexAction('exec-pwsh'), resolution: 'answered', closed_at: endedAt(store, 'exec-cmd') },
  ])
  await engine.ingest(file.batch(5, lines.length))
  expect(failedChecks(store, run)).toMatchObject([
    { action: codexAction('exec-pwsh'), resolution: 'answered' },
    { action: codexAction('exec-powershell'), text: 'Check "test" failed with exit code 2', resolution: 'open' },
  ])
})

test('a rule update of a failed check keeps the priority and likely resolution set by the observer', async ({
  onTestFinished,
}) => {
  const { store, engine, project } = await setup(onTestFinished, watchingTests)
  const source = { session: 'observed-session', cwd: project }
  const key = sessionKey('claude', source.session)
  const run = runId(key)
  await engine.ingest(hookBatch(started(source), ...check(source, 'call-1', 'pnpm test', { exit: 1 }, 10)))
  linkRun(store, run, key)
  const [item] = failedChecks(store, run)
  const [failure] = callFacts(store, 'call-1').filter((fact) => fact.kind === 'action_end')
  if (item === undefined || failure === undefined) {
    throw new Error('the failed check must have an attention item')
  }
  const input = inputFor(store, [failure], run)
  store.transaction((transaction) => {
    beginObserverCall(transaction, { id: callId, backend: 'claude', crossVendor: false, input, at: failure.at })
  })
  const grounds = { evidence: [failure.id], rationale: 'The solver is fixing the failing test' }
  const result = store.transaction((transaction) =>
    applyObserverResponse(transaction, {
      call: callId,
      at: failure.at,
      output: response(
        [
          { ...grounds, op: 'attention.priority', item: { kind: 'existing', id: item.id }, priority: 'high' },
          { ...grounds, op: 'attention.likely_resolved', item: item.id },
        ],
        input.model.version,
      ),
    }),
  )
  expect(result.status).toBe('accepted')
  const marked = { priority: { value: 'high', call: callId }, likely_resolved: expect.anything() as unknown }
  await engine.ingest(hookBatch(...check(source, 'call-2', 'pnpm test', { exit: 2 }, 20)))
  expect(failedChecks(store, run)).toMatchObject([
    { ...marked, action: actionOf(source, 'call-2'), resolution: 'open' },
  ])
  await engine.ingest(hookBatch(...check(source, 'call-3', 'pnpm test', 'pass', 30)))
  expect(failedChecks(store, run)).toMatchObject([{ ...marked, resolution: 'answered' }])
})
