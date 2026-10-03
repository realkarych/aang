import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ApiError,
  type ApiErrorCode,
  endpoints,
  type Fact,
  FactDraft,
  NormalizerVersion,
  type RawSeq,
  ReparseResponse,
  type RunId,
  type RunSnapshot,
  type SessionKey,
  type SseEvent,
} from '@aang/contract'
import { runId } from '@aang/contract/ids'
import { openStore, type Store } from '@aang/store'
import { describe, test } from 'vitest'
import { bearer, createHome, type Home, type RunningDaemon, startDaemon } from './daemon.js'
import { watchedHome } from './sessions.js'
import { endsWithRun, openKnownRun, openStream } from './stream-client.js'

const otherNormalizer = NormalizerVersion.parse(2)

const storedOnly: ReadonlySet<string> = new Set(['id', 'seq', 'normalizer_version'])

const draftOf = (fact: Fact): FactDraft =>
  FactDraft.parse(Object.fromEntries(Object.entries(fact).filter(([field]) => !storedOnly.has(field))))

interface Transcript {
  readonly key: SessionKey
  readonly run: RunId
  readonly append: (lines: readonly string[]) => Promise<void>
  readonly call: (call: string, tool?: string, input?: Record<string, unknown>) => string[]
  readonly plan: (call: string, items: readonly string[]) => string[]
}

const transcriptOf = async (home: Home, workspace: string, session: string): Promise<Transcript> => {
  const project = join(home.root, '.claude', 'projects', '-work')
  await mkdir(project, { recursive: true })
  const file = join(project, `${session}.jsonl`)
  await writeFile(file, '')
  const line = (record: Record<string, unknown>): string =>
    JSON.stringify({ sessionId: session, cwd: workspace, timestamp: new Date().toISOString(), ...record })
  const call = (id: string, tool = 'Bash', input: Record<string, unknown> = { command: `echo ${id}` }): string[] => [
    line({
      type: 'assistant',
      uuid: `${id}-use`,
      message: { id: `${id}-message`, role: 'assistant', content: [{ type: 'tool_use', id, name: tool, input }] },
    }),
    line({
      type: 'user',
      uuid: `${id}-result`,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', is_error: false }] },
    }),
  ]
  const key: SessionKey = { kind: 'session', runtime: 'claude', session }
  return {
    key,
    run: runId(key),
    append: (lines) => appendFile(file, lines.map((entry) => `${entry}\n`).join('')),
    call,
    plan: (id, items) => call(id, 'TodoWrite', { todos: items.map((content) => ({ content, status: 'pending' })) }),
  }
}

const ended =
  (call: string) =>
  (events: readonly SseEvent[]): boolean =>
    events.some(
      (event) =>
        event.event === 'facts' &&
        event.data.objects.actions.some(({ key, ended_at: endedAt }) => key.call === call && endedAt !== null),
    ) && endsWithRun(events)

const reset = (events: readonly SseEvent[]): boolean => events.at(-1)?.event === 'reset'

const reparsed = { event: 'reset', id: null, data: { reason: 'reparsed' } }

const stopped = async (daemon: RunningDaemon): Promise<void> => {
  daemon.abort()
  await daemon.stopped
}

const snapshotOf = async (daemon: RunningDaemon, home: Home, run: RunId): Promise<RunSnapshot> => {
  const response = await fetch(new URL(`/api/runs/${run}`, daemon.base), { headers: bearer(home.token) })
  if (response.status !== 200) {
    throw new Error(`the snapshot answered ${String(response.status)}: ${await response.text()}`)
  }
  return endpoints.run.response.parse(await response.json())
}

const postReparse = (daemon: RunningDaemon, home: Home, body = '{}', token: string | null = home.token) =>
  fetch(new URL('/api/admin/reparse', daemon.base), {
    method: 'POST',
    headers: { ...(token === null ? {} : bearer(token)), 'content-type': 'application/json' },
    body,
  })

const reparse = async (daemon: RunningDaemon, home: Home): Promise<ReparseResponse> => {
  const response = await postReparse(daemon, home)
  if (response.status !== 200) {
    throw new Error(`reparse answered ${String(response.status)}: ${await response.text()}`)
  }
  return ReparseResponse.parse(await response.json())
}

interface Stored {
  readonly records: readonly RawSeq[]
  readonly withoutFacts: number
  readonly facts: readonly Fact[]
  readonly plan: Fact
}

const storeAnotherNormalizer = (home: Home, transcript: Transcript, misread: string): Stored => {
  const store: Store = openStore({ home: home.paths.home })
  try {
    const plan = store.facts.ofSession(transcript.key).find(({ kind }) => kind === 'plan_update')
    const stream = plan === undefined ? null : store.rawRecords.get(plan.seq)?.stream
    if (plan === undefined || stream === undefined || stream === null) {
      throw new Error('the transcript must have a plan fact of its stream')
    }
    const records = store.rawRecords.ofStream(stream, null, 1_000)
    const misreadRecord = records.find(({ payload }) => payload.includes(`"uuid":"${misread}"`))
    if (misreadRecord === undefined) {
      throw new Error(`no record ${misread}`)
    }
    const stored = records.map(({ seq }) => store.facts.ofRecord(seq))
    store.transaction((transaction) => {
      for (const { seq } of records) {
        const drafts = transaction.facts
          .ofRecord(seq)
          .filter(({ id }) => id !== plan.id)
          .map(draftOf)
        transaction.facts.replace(seq, otherNormalizer, seq === misreadRecord.seq ? [...drafts, draftOf(plan)] : drafts)
      }
    })
    return {
      records: records.map(({ seq }) => seq),
      withoutFacts: stored.filter((facts) => facts.length === 0).length,
      facts: stored.flat(),
      plan,
    }
  } finally {
    store.close()
  }
}

const factsOfRecords = (home: Home, records: readonly RawSeq[]): Fact[] => {
  const store = openStore({ home: home.paths.home })
  try {
    return records.flatMap((seq) => store.facts.ofRecord(seq))
  } finally {
    store.close()
  }
}

describe.concurrent('reparse runs through the admin API', () => {
  test('reparse puts back the facts another normalizer stored under their ids, resets every stream that holds a position before it, also after a restart, and a repeated call changes nothing', async ({
    expect,
    onTestFinished,
  }) => {
    const { home, workspace } = await watchedHome(onTestFinished)
    const daemon = await startDaemon(home, onTestFinished)
    const transcript = await transcriptOf(home, workspace, 'g11-reparse')
    const { run } = transcript
    await transcript.append([...transcript.plan('toolu_g11_plan', ['read', 'write']), ...transcript.call('toolu_g11_call')])
    const ingesting = await openKnownRun(daemon.base, home.token, { run, lastEventId: '0' })
    await ingesting.until(ended('toolu_g11_call'))
    await ingesting.close()
    await stopped(daemon)
    const stored = storeAnotherNormalizer(home, transcript, 'toolu_g11_call-use')

    const reparsing = await startDaemon(home, onTestFinished)
    const stale = await snapshotOf(reparsing, home, run)
    const held = await openStream(reparsing.base, home.token, { run, lastEventId: String(stale.change_seq) })
    await held.until(endsWithRun)
    const first = await reparse(reparsing, home)
    await held.until(reset)
    await held.ended
    const late = await openStream(reparsing.base, home.token, { run, lastEventId: String(stale.change_seq) })
    await late.until(reset)
    const fresh = await snapshotOf(reparsing, home, run)
    const current = await openStream(reparsing.base, home.token, { run, lastEventId: String(fresh.change_seq) })
    await current.until(endsWithRun)
    const second = await reparse(reparsing, home)
    const again = await snapshotOf(reparsing, home, run)
    await transcript.append(transcript.call('toolu_g11_after'))
    await current.until(ended('toolu_g11_after'))
    await current.close()
    await stopped(reparsing)
    const facts = factsOfRecords(home, stored.records)

    const restarted = await startDaemon(home, onTestFinished)
    const afterRestart = await openStream(restarted.base, home.token, { run, lastEventId: String(stale.change_seq) })
    await afterRestart.until(reset)
    const resumed = await openStream(restarted.base, home.token, { run, lastEventId: String(fresh.change_seq) })
    await resumed.until(ended('toolu_g11_after'))
    await resumed.close()

    expect(first).toEqual({
      records: stored.records.length,
      facts_added: 1,
      facts_kept: stored.facts.length - 1,
      facts_missing: 1,
    })
    expect(second).toEqual({ records: stored.withoutFacts, facts_added: 0, facts_kept: 0, facts_missing: 0 })
    expect(stale.plan_facts).toHaveLength(1)
    expect(stale.plan_facts.map(({ id }) => id)).not.toContain(stored.plan.id)
    expect(fresh.plan_facts.map(({ id }) => id)).toEqual([stored.plan.id])
    expect(fresh.objects.actions.map(({ key }) => key.call).sort()).toEqual(['toolu_g11_call', 'toolu_g11_plan'])
    expect(again).toEqual(fresh)
    expect(new Set(facts.map(({ id }) => id))).toEqual(new Set(stored.facts.map(({ id }) => id)))
    expect(held.events.at(-1)).toEqual(reparsed)
    expect(late.events).toEqual([reparsed])
    expect(afterRestart.events).toEqual([reparsed])
    expect(current.events.some(({ event }) => event === 'reset')).toBe(false)
    expect(resumed.events.some(({ event }) => event === 'reset')).toBe(false)
  })

  test('reparse refuses a request without the token or with a body other than an empty object', async ({
    expect,
    onTestFinished,
  }) => {
    const home = await createHome(onTestFinished)
    const daemon = await startDaemon(home, onTestFinished)
    const refusal = async (response: Response): Promise<[number, ApiErrorCode]> => [
      response.status,
      ApiError.parse(await response.json()).error.code,
    ]

    expect(await refusal(await postReparse(daemon, home, '{}', null))).toEqual([401, 'unauthorized'])
    expect(await refusal(await postReparse(daemon, home, '{"all":true}'))).toEqual([400, 'invalid_request'])
    expect(await refusal(await postReparse(daemon, home, 'not json'))).toEqual([400, 'invalid_request'])
    expect(await reparse(daemon, home)).toEqual({ records: 0, facts_added: 0, facts_kept: 0, facts_missing: 0 })
  })
})
