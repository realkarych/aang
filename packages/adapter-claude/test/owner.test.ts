import { claudeAdapter } from '@aang/adapter-claude'
import type { JsonValue, RecordOwner, SpoolEnv } from '@aang/contract'
import { describe, expect, test } from 'vitest'
import {
  field,
  hookRecord,
  type JsonObject,
  lineRecord,
  readJsonSample,
  readSample,
  sampleFiles,
  spoolEnv,
  transcriptRecords,
} from './samples.js'

interface HookSample {
  readonly name: string
  readonly payload: JsonObject
  readonly env: SpoolEnv
}

const hookSamples = async (): Promise<HookSample[]> => {
  const env = spoolEnv(
    field(await readJsonSample('claude-code-hooks/envelope.command.SessionStart.plugin.json'), 'env'),
  )
  const cli = await Promise.all(
    (await sampleFiles('claude-code-hooks/', /^[A-Z].*\.json$/)).map(async (name): Promise<HookSample> => ({
      name,
      payload: await readJsonSample(name),
      env,
    })),
  )
  const sdk = await Promise.all(
    (await sampleFiles('claude-agent-sdk/', /^hook-(?:command|callback)-.*\.json$/)).map(
      async (name): Promise<HookSample> => {
        const sample = await readJsonSample(name)
        return {
          name,
          payload: (sample.stdin ?? sample.input) as JsonObject,
          env: spoolEnv(sample.env_seen_by_hook_process),
        }
      },
    ),
  )
  return [...cli, ...sdk]
}

const ownerOfHook = (payload: JsonValue, env: SpoolEnv = {}): RecordOwner | null =>
  claudeAdapter.owner(hookRecord({ payload: JSON.stringify(payload), file: 'owner.hook', env }))

const text = (value: JsonValue | undefined): string | null => (typeof value === 'string' && value !== '' ? value : null)

const session = (id: string) => ({ kind: 'session', runtime: 'claude', session: id })

const mainSession = '86f93ed5-1acd-4c6e-8c60-f1c98335c2ef'
const forkSession = 'cdfb3544-67c1-4590-a4d9-280593b6ed55'

describe('the owner of a hook event', () => {
  test('of every sample names its session, thread and cwd; only a new root session is opened', async () => {
    const samples = await hookSamples()

    expect(samples.length).toBeGreaterThan(40)
    for (const { name, payload, env } of samples) {
      const root = text(payload.agent_id) === null
      const source = text(payload.source)
      expect(ownerOfHook(payload, env), name).toEqual({
        session: session(text(payload.session_id) ?? ''),
        thread: root ? 'root' : 'agent',
        cwd: text(payload.cwd),
        start: root && payload.hook_event_name === 'SessionStart' && (source === 'startup' || source === 'fork'),
        observer: false,
      })
    }
  })

  test('opens the session on a cleared start, but not on resume or compaction', async () => {
    const startup = await readJsonSample('claude-code-hooks/SessionStart.startup.json')

    expect(ownerOfHook({ ...startup, source: 'clear' })?.start).toBe(true)
    expect(ownerOfHook({ ...startup, source: null })?.start).toBe(false)
    expect(ownerOfHook(await readJsonSample('claude-code-hooks/SessionStart.resume.json'))?.start).toBe(false)
    expect(ownerOfHook(await readJsonSample('claude-code-hooks/SessionStart.compact.json'))?.start).toBe(false)
    expect(ownerOfHook({ ...startup, agent_id: 'a1' })).toMatchObject({ thread: 'agent', start: false })
  })

  test('carries the observer entrypoint of the spool envelope', async () => {
    const payload = await readJsonSample('claude-code-hooks/PreToolUse.Bash.json')

    expect(ownerOfHook(payload, { CLAUDE_CODE_ENTRYPOINT: 'aang-observer' })?.observer).toBe(true)
    expect(ownerOfHook(payload, { CLAUDE_CODE_ENTRYPOINT: 'cli' })?.observer).toBe(false)
  })

  test('is unknown when the payload names no session', async () => {
    const anonymous = Object.fromEntries(
      Object.entries(await readJsonSample('claude-code-hooks/PreToolUse.Bash.json')).filter(
        ([key]) => key !== 'session_id',
      ),
    )

    expect(ownerOfHook(anonymous)).toBeNull()
    expect(ownerOfHook([])).toBeNull()
    expect(claudeAdapter.owner(hookRecord({ payload: 'not json', file: 'broken.hook' }))).toBeNull()
  })
})

describe('the owner of a transcript line', () => {
  test.for([
    ['claude-code-transcripts/session-86f93ed5-main-full.jsonl', mainSession, 'root'],
    ['claude-code-transcripts/session-cdfb3544-fork-full.jsonl', forkSession, 'root'],
    ['claude-code-transcripts/subagent-agent-aad616394e806288d.jsonl', mainSession, 'agent'],
  ] as const)('of %s is its session and thread, with the cwd of the line', async ([path, id, thread]) => {
    const records = await transcriptRecords(path)

    const owners = records.map((record) => claudeAdapter.owner(record))

    expect(owners).toEqual(
      records.map((record) => {
        const line = JSON.parse(record.payload) as JsonObject
        return {
          session: session(id),
          thread,
          cwd: text(line.cwd),
          start: false,
          observer: false,
        }
      }),
    )
  })

  test('carries the observer entrypoint and is unknown without a session', async () => {
    const [first] = (await readSample('claude-code-transcripts/session-86f93ed5-main-full.jsonl')).split('\n')
    const line = JSON.parse(first ?? '{}') as JsonObject

    expect(
      claudeAdapter.owner(lineRecord({ payload: JSON.stringify({ ...line, entrypoint: 'aang-observer' }), line: 1 })),
    ).toMatchObject({ thread: 'root', observer: true })
    expect(claudeAdapter.owner(lineRecord({ payload: '{"type":"summary"}', line: 1 }))).toBeNull()
    expect(
      claudeAdapter.owner({
        ...lineRecord({ payload: JSON.stringify(line), line: 1 }),
        position: { kind: 'stream_lost', path: '/p/session.jsonl' },
      }),
    ).toBeNull()
  })
})
