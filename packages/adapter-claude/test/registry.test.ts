import { claudeAdapter } from '@aang/adapter-claude'
import { CollectedRecord, EpochNs, FactDraft, type JsonValue } from '@aang/contract'
import { describe, test } from 'vitest'
import {
  factsOf,
  type JsonObject,
  nestedArrays,
  observedAt,
  readJsonSample,
  sampleLines,
  snapshotRecord,
} from './samples.js'

const registry = '/home/user/.claude/sessions'
const mainSession = '86f93ed5-1acd-4c6e-8c60-f1c98335c2ef'

const parseEntry = (content: JsonValue, path = `${registry}/60263.json`) =>
  claudeAdapter.parse(snapshotRecord({ path, content: JSON.stringify(content), channel: 'registry' }))

const epochOfMilliseconds = (milliseconds: number): EpochNs => EpochNs.parse(BigInt(milliseconds) * 1_000_000n)

const registryEvents = new Set(['session_registry_new', 'session_registry_change'])

const registryContent = (fact: FactDraft | undefined) => {
  if (fact?.kind !== 'json_snapshot' || fact.payload.file !== 'registry') {
    throw new Error(`a registry snapshot is expected, got ${String(fact?.kind)}`)
  }
  return fact.payload.content
}

describe.concurrent('Claude session registry', () => {
  test('the entry written at start is a snapshot of the session with its process, entrypoint, cwd and version', async ({
    expect,
  }) => {
    const [snapshot, ...rest] = factsOf(parseEntry(await readJsonSample('claude-code-transcripts/sessions-registry-pid-at-start.json')))

    expect(rest).toEqual([])
    expect(snapshot).toEqual({
      kind: 'json_snapshot',
      entity_key: { kind: 'session', runtime: 'claude', session: mainSession },
      speaker: 'runtime',
      urgent: false,
      at: observedAt,
      runtime_ids: {
        session_id: mainSession,
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
      runtime_env: {
        cwd: '/tmp/aang-spike/cc-transcripts/run',
        version: '2.1.286',
        entrypoint: 'sdk-cli',
        originator: null,
        git_branch: null,
      },
      format_verified: true,
      redelivery_key: null,
      payload: {
        file: 'registry',
        path: `${registry}/60263.json`,
        removed: false,
        content: {
          pid: 60263,
          session_id: mainSession,
          kind: 'interactive',
          entrypoint: 'sdk-cli',
          status: null,
          waiting_for: null,
          cwd: '/tmp/aang-spike/cc-transcripts/run',
          version: '2.1.286',
          status_updated_at: null,
        },
      },
    })
    expect(FactDraft.parse(snapshot)).toEqual(snapshot)
  })

  test('the observed lifecycle of the registry gives the busy and idle statuses with their times', async ({ expect }) => {
    const events = (await sampleLines('claude-code-transcripts/sessions-registry-lifecycle-observed.jsonl'))
      .map((line) => JSON.parse(line) as JsonObject)
      .filter((event) => typeof event.event === 'string' && registryEvents.has(event.event))
    const snapshots = events.map((event) => {
      const file = typeof event.file === 'string' ? event.file : ''
      const entry = {
        pid: event.pid ?? null,
        sessionId: event.sessionId ?? null,
        kind: event.kind ?? null,
        entrypoint: event.entrypoint ?? null,
        status: event.status ?? null,
        statusUpdatedAt: event.statusUpdatedAt ?? null,
      }
      const [snapshot, ...rest] = factsOf(parseEntry(entry, `${registry}/${file}`))
      expect(rest).toEqual([])
      return snapshot
    })
    const statuses = snapshots.map((snapshot) => {
      const content = registryContent(snapshot)
      return [content?.status, content?.status_updated_at]
    })

    expect(snapshots).toHaveLength(23)
    expect(snapshots.every((snapshot) => snapshot?.format_verified === true)).toBe(true)
    expect(snapshots.map((snapshot) => snapshot?.entity_key.session)).toEqual(events.map((event) => event.sessionId))
    expect(new Set(statuses.map(([status]) => status))).toEqual(new Set([null, 'busy', 'idle']))
    expect(statuses.slice(0, 3)).toEqual([
      [null, null],
      ['busy', epochOfMilliseconds(1790855370942)],
      ['idle', epochOfMilliseconds(1790855378082)],
    ])
  })

  test('an observer session is marked by its entrypoint in the snapshot and in the environment of the fact', ({
    expect,
  }) => {
    const [snapshot] = factsOf(
      parseEntry({ pid: 7001, sessionId: 'observer-1', kind: 'interactive', entrypoint: 'aang-observer', cwd: '/tmp/aang-observer/empty' }),
    )

    expect(snapshot).toMatchObject({
      entity_key: { kind: 'session', session: 'observer-1' },
      runtime_env: { entrypoint: 'aang-observer', cwd: '/tmp/aang-observer/empty' },
      payload: { content: { entrypoint: 'aang-observer' } },
    })
  })

  test('a session waiting for the human names what it waits for', ({ expect }) => {
    const [snapshot] = factsOf(
      parseEntry({
        pid: 7002,
        sessionId: mainSession,
        status: 'waiting',
        waitingFor: 'permission prompt',
        statusUpdatedAt: 1790855370942,
        hostSessionId: 'local_1',
      }),
    )

    expect(snapshot).toMatchObject({
      format_verified: true,
      runtime_env: { cwd: null, version: null, entrypoint: null },
      payload: {
        content: {
          status: 'waiting',
          waiting_for: 'permission prompt',
          status_updated_at: epochOfMilliseconds(1790855370942),
          kind: null,
        },
      },
    })
  })

  test('a removed registry file names no session and gives no facts', ({ expect }) => {
    expect(
      claudeAdapter.parse(snapshotRecord({ path: `${registry}/60263.json`, channel: 'registry' })),
    ).toEqual({ parse_state: 'parsed', source_ts: null, facts: [] })
  })

  test('registry files are recognised on Windows paths, other files and positions of the registry stay unknown', async ({
    expect,
  }) => {
    const entry = await readJsonSample('claude-code-transcripts/sessions-registry-pid-at-start.json')
    const line = CollectedRecord.parse({
      channel: 'registry',
      runtime: 'claude',
      stream: null,
      position: { kind: 'line', path: `${registry}/60263.json`, offset: 0, line: 1 },
      hook: null,
      observed_at: observedAt,
      payload: JSON.stringify(entry),
    })

    expect(parseEntry(entry, 'C:\\Users\\user\\.claude\\sessions\\60263.json').parse_state).toBe('parsed')
    for (const path of [`${registry}/60263.abc.key`, `${registry}/latest.json`, '/home/user/.claude/projects/p/60263.json']) {
      expect(parseEntry(entry, path), path).toEqual({ parse_state: 'unknown', source_ts: null })
    }
    expect(claudeAdapter.parse(line)).toEqual({ parse_state: 'unknown', source_ts: null })
  })

  test('an entry that is not JSON or breaks its schema is invalid, one nested too deeply is unknown', ({ expect }) => {
    const notJson = claudeAdapter.parse(
      snapshotRecord({ path: `${registry}/1.json`, content: '{"pid": 1', channel: 'registry' }),
    )

    expect(notJson).toMatchObject({ parse_state: 'invalid', reason: /session registry entry/ })
    for (const entry of [{ pid: 1 }, { pid: 0, sessionId: mainSession }, { pid: 1, sessionId: mainSession, statusUpdatedAt: -5 }, []]) {
      expect(parseEntry(entry), JSON.stringify(entry)).toMatchObject({ parse_state: 'invalid', reason: /session registry entry/ })
    }
    expect(parseEntry({ pid: 1, sessionId: mainSession, extra: nestedArrays(5000) })).toEqual({
      parse_state: 'unknown',
      source_ts: null,
    })
  })
})
