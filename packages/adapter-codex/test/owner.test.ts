import { readdirSync, readFileSync } from 'node:fs'
import { codexAdapter } from '@aang/adapter-codex'
import { CollectedRecord, EpochNs, type JsonValue, type RecordOwner, type SpoolEnv } from '@aang/contract'
import { describe, expect, test } from 'vitest'
import { realRollout, record, rolloutLines, sampleLine, streamFrom, threadStream } from './rollout-records.js'

const cliHooks = new URL('../../../docs/research/samples/codex-cli/hooks/', import.meta.url)
const hookConfig = 'hooks.json.logger-config.json'

type JsonObject = { readonly [key: string]: JsonValue }

const stdinOf = (name: string): JsonObject =>
  (JSON.parse(readFileSync(new URL(name, cliHooks), 'utf8')) as { readonly stdin: JsonObject }).stdin

const hookSampleNames = (): string[] =>
  readdirSync(cliHooks)
    .filter((name) => name.endsWith('.json') && name !== hookConfig)
    .sort()

const hookRecord = (payload: string, env: SpoolEnv = {}): CollectedRecord =>
  CollectedRecord.parse({
    channel: 'hook',
    runtime: 'codex',
    stream: null,
    position: { kind: 'spool', file: 'owner.spool' },
    hook: { registration: 'user', env },
    observed_at: EpochNs.parse(1_790_856_592_228_739_000n),
    payload,
  })

const ownerOfHook = (payload: JsonObject, env?: SpoolEnv): RecordOwner | null =>
  codexAdapter.owner(hookRecord(JSON.stringify(payload), env))

const session = (id: string) => ({ kind: 'session', runtime: 'codex', session: id })

const without = (payload: JsonObject, key: string): JsonObject =>
  Object.fromEntries(Object.entries(payload).filter(([name]) => name !== key))

const realRoot = '01a0f752-40a7-76b2-9df9-5b374f75f98f'
const spawnRoot = '01a0f75c-465e-7a01-876f-c7df6fc989a0'
const spawnChild = '01a0f75c-46d2-7430-92a2-c3b0cd5d85b6'
const guardianRoot = '01a0f75b-8043-70d2-95ed-39bd0831b81a'

describe('the owner of a rollout line', () => {
  test('is the root session; session_meta of the root opens it with its cwd, turn_context states the cwd', () => {
    const lines = rolloutLines(realRollout)
    const stream = streamFrom(lines[0] ?? '')

    const owners = lines.map((line) => codexAdapter.owner(record(line, stream)))

    expect(owners.every((owner) => owner?.thread === 'root')).toBe(true)
    expect(owners.every((owner) => owner?.observer === false)).toBe(true)
    expect(new Set(owners.map((owner) => JSON.stringify(owner?.session)))).toEqual(
      new Set([JSON.stringify(session(realRoot))]),
    )
    expect(owners.flatMap((owner, index) => (owner?.cwd === null ? [] : [[index, owner?.cwd, owner?.start]]))).toEqual([
      [0, '/tmp/aang-spike/codex-cli/run1', true],
      [7, '/tmp/aang-spike/codex-cli/run1', false],
      [33, '/tmp/aang-spike/codex-cli/run1', false],
    ])
  })

  test.for([
    ['session_meta.subagent.thread_spawn.mock.json', spawnRoot, '/tmp/aang-spike/codex-cli/m_spawn'],
    ['session_meta.guardian.mock.json', guardianRoot, '/tmp/aang-spike/codex-cli/m_escalate3'],
  ])('of a child thread %s belongs to its root session and does not open it', ([name, root, cwd]) => {
    const line = sampleLine(name ?? '')

    expect(codexAdapter.owner(record(line, streamFrom(line)))).toEqual({
      session: session(root ?? ''),
      thread: 'agent',
      cwd,
      start: false,
      observer: false,
    })
  })

  test.for([
    ['session_meta.exec.thread_source-aang-observer.mock.json', {}],
    ['session_meta.exec.real.json', { originator: 'aang_observer' }],
  ] as const)('carries the observer marker of %s', ([name, changes]) => {
    const sample = JSON.parse(sampleLine(name)) as { readonly payload: JsonObject }
    const line = JSON.stringify({ ...sample, payload: { ...sample.payload, ...changes } })

    expect(codexAdapter.owner(record(line, streamFrom(line)))).toMatchObject({ thread: 'root', observer: true })
  })

  test('of a line without the rollout envelope belongs to its thread and states nothing', () => {
    expect(codexAdapter.owner(record('{"type":"future"}', threadStream(spawnRoot, spawnChild)))).toEqual({
      session: session(spawnRoot),
      thread: 'agent',
      cwd: null,
      start: false,
      observer: false,
    })
    expect(codexAdapter.owner(record('not json', threadStream(realRoot)))).toMatchObject({ thread: 'root', cwd: null })
  })

  test('of a session_meta line of an unexpected shape still opens the root session', () => {
    const sample = JSON.parse(sampleLine('session_meta.exec.real.json')) as { readonly payload: JsonObject }
    const line = JSON.stringify({ ...sample, payload: { ...sample.payload, cwd: 42 } })

    expect(codexAdapter.owner(record(line, threadStream(realRoot)))).toEqual({
      session: session(realRoot),
      thread: 'root',
      cwd: null,
      start: true,
      observer: false,
    })
  })

  test('is unknown without a thread stream or outside a rollout line', () => {
    const line = sampleLine('turn_context.real.json')

    expect(codexAdapter.owner(record(line, null))).toBeNull()
    expect(
      codexAdapter.owner(
        record(line, threadStream(realRoot), {
          channel: 'otel',
          position: { kind: 'otel' },
        }),
      ),
    ).toBeNull()
  })
})

describe('the owner of a hook event', () => {
  test.for(hookSampleNames())('%s names its session, thread and cwd', (name) => {
    const stdin = stdinOf(name)
    const agent = stdin['agent_id']
    const source = stdin['source']

    expect(ownerOfHook(stdin)).toEqual({
      session: session(typeof stdin['session_id'] === 'string' ? stdin['session_id'] : ''),
      thread: agent === undefined ? 'root' : 'agent',
      cwd: stdin['cwd'],
      start: stdin['hook_event_name'] === 'SessionStart' && (source === 'startup' || source === 'fork'),
      observer: false,
    })
  })

  test('opens the session on a cleared start and carries the observer originator', () => {
    const cleared = { ...stdinOf('SessionStart.startup.json'), source: 'clear' }

    expect(ownerOfHook(cleared, { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'aang_observer' })).toMatchObject({
      start: true,
      observer: true,
    })
  })

  test('opens nothing on a SessionStart without a source', () => {
    expect(ownerOfHook(without(stdinOf('SessionStart.startup.json'), 'source'))).toMatchObject({
      thread: 'root',
      start: false,
    })
  })

  test('of a child thread never opens the root session', () => {
    expect(ownerOfHook({ ...stdinOf('SessionStart.startup.json'), agent_id: spawnChild })).toMatchObject({
      thread: 'agent',
      start: false,
    })
  })

  test('without a cwd states none, and without a session is unknown', () => {
    const withoutCwd = without(stdinOf('PreToolUse.Bash.json'), 'cwd')
    const withoutSession = without(stdinOf('PreToolUse.Bash.json'), 'session_id')

    expect(ownerOfHook(withoutCwd)?.cwd).toBeNull()
    expect(ownerOfHook({ ...withoutCwd, cwd: '' })?.cwd).toBeNull()
    expect(ownerOfHook(withoutSession)).toBeNull()
    expect(codexAdapter.owner(hookRecord('not json'))).toBeNull()
  })
})
