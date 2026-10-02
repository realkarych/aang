import { claudeAdapter } from '@aang/adapter-claude'
import { EpochNs, type FactDraft } from '@aang/contract'
import { describe, test } from 'vitest'
import { transcriptRecords } from './samples.js'

const mainSession = '86f93ed5-1acd-4c6e-8c60-f1c98335c2ef'
const forkSession = 'cdfb3544-67c1-4590-a4d9-280593b6ed55'

interface LineFact {
  readonly line: number
  readonly fact: FactDraft
}

interface Launch {
  readonly launch: LineFact
  readonly copied: readonly LineFact[]
  readonly own: readonly LineFact[]
}

const lineFacts = async (file: string): Promise<LineFact[]> =>
  (await transcriptRecords(`claude-code-transcripts/${file}`)).flatMap((record) => {
    const result = claudeAdapter.parse(record)
    const line = record.position.kind === 'line' ? record.position.line : 0
    return result.parse_state === 'parsed' ? result.facts.map((fact) => ({ line, fact })) : []
  })

const isQueued = ({ fact }: LineFact): boolean => fact.kind === 'queue_operation'

const isLaunch = ({ fact }: LineFact): boolean =>
  fact.kind === 'queue_operation' && fact.payload.operation === 'enqueue'

const launches = (facts: readonly LineFact[]): Launch[] =>
  facts.flatMap((launch, index) => {
    if (!isLaunch(launch)) {
      return []
    }
    const following = facts.slice(index + 1)
    const end = following.findIndex(isLaunch)
    const records = (end === -1 ? following : following.slice(0, end)).filter((entry) => !isQueued(entry))
    const firstOwn = records.findIndex(({ fact }) => fact.at >= launch.fact.at)
    return [{ launch, copied: records.slice(0, firstOwn), own: records.slice(firstOwn) }]
  })

const signature = ({ fact }: LineFact): string =>
  JSON.stringify([
    fact.kind,
    fact.entity_key.kind,
    fact.runtime_ids.record_uuid,
    fact.runtime_ids.parent_uuid,
    fact.runtime_ids.message_id,
    fact.runtime_ids.call_id,
    fact.at.toString(),
  ])

const epochOf = (iso: string): EpochNs => EpochNs.parse(BigInt(Date.parse(iso)) * 1_000_000n)

const messagesOf = (facts: readonly LineFact[]): (string | null)[] =>
  facts.filter(({ fact }) => fact.kind === 'usage').map(({ fact }) => fact.runtime_ids.message_id)

describe.concurrent('Claude fork: the copied block', () => {
  test('the fork file alone shows where the copied block ends: records older than the launch, then its own records', async ({
    expect,
  }) => {
    const [fork, ...rest] = launches(await lineFacts('session-cdfb3544-fork-full.jsonl'))

    expect(rest).toEqual([])
    expect(fork?.launch).toMatchObject({
      line: 3,
      fact: { kind: 'queue_operation', at: epochOf('2026-10-01T11:53:35.336Z'), payload: { operation: 'enqueue' } },
    })
    expect(fork?.copied[0]).toMatchObject({
      line: 5,
      fact: { kind: 'prompt', at: epochOf('2026-10-01T11:49:31.904Z') },
    })
    expect(fork?.copied.at(-1)?.line).toBe(38)
    expect(fork?.own[0]).toMatchObject({
      line: 39,
      fact: {
        kind: 'prompt',
        at: epochOf('2026-10-01T11:53:35.358Z'),
        runtime_ids: { record_uuid: '7e54895d-9a4b-41c4-b3f4-dca2168641c7' },
      },
    })
    expect(fork?.copied.every(({ fact }) => fact.runtime_ids.record_uuid !== null)).toBe(true)
    expect(messagesOf(fork?.copied ?? [])).toEqual([
      'msg_011CfbTzJhEoJe1pZ3Wdd3xK',
      'msg_011CfbTzTVpDLDBw4hapzNeq',
      'msg_011CfbTzh58ynVFVJQXmTEN8',
      'msg_011CfbU4zWVVUFTgtFWX4nfx',
      'msg_011CfbUBFGvUGjvWUw8ALhRs',
    ])
    expect(messagesOf(fork?.own ?? [])).toEqual(['msg_011CfbUJspJNWUmrMrqKz5DE'])
  })

  test('the copied facts carry the uuid, message id and time of the original records, the own facts are new', async ({
    expect,
  }) => {
    const main = await lineFacts('session-86f93ed5-main-full.jsonl')
    const [fork] = launches(await lineFacts('session-cdfb3544-fork-full.jsonl'))
    const original = new Set(main.map(signature))

    expect(fork?.copied).toHaveLength(16)
    for (const copy of fork?.copied ?? []) {
      expect(original.has(signature(copy)), `line ${String(copy.line)} ${copy.fact.kind}`).toBe(true)
    }
    const ownRecords = (fork?.own ?? []).filter(({ fact }) => fact.runtime_ids.record_uuid !== null)
    expect(ownRecords.map(({ fact }) => fact.kind)).toEqual(['prompt', 'message', 'usage'])
    for (const own of ownRecords) {
      expect(original.has(signature(own)), `line ${String(own.line)} ${own.fact.kind}`).toBe(false)
    }
  })

  test('every fact of the fork belongs to the fork session, keyed apart from the original', async ({ expect }) => {
    const fork = await lineFacts('session-cdfb3544-fork-full.jsonl')

    expect(fork.every(({ fact }) => fact.entity_key.session === forkSession)).toBe(true)
    expect(fork.every(({ fact }) => fact.runtime_ids.session_id === forkSession)).toBe(true)
  })

  test('a resume or continue of the original is not a fork: no record after its launch is older than the launch', async ({
    expect,
  }) => {
    const main = launches(await lineFacts('session-86f93ed5-main-full.jsonl'))

    expect(main.map(({ launch }) => launch.line)).toEqual([1, 35, 45, 53, 70])
    for (const { launch, copied, own } of main) {
      expect(copied, `launch at line ${String(launch.line)}`).toEqual([])
      expect(own.length, `launch at line ${String(launch.line)}`).toBeGreaterThan(0)
      expect(own[0]?.fact.entity_key.session).toBe(mainSession)
    }
  })

  test('the fork reports the cost state it inherited from the original as its own total', async ({ expect }) => {
    const fork = await lineFacts('session-cdfb3544-fork-full.jsonl')
    const costStates = fork.filter(({ fact }) => fact.kind === 'cost_state')

    expect(costStates).toMatchObject([
      {
        line: 49,
        fact: {
          entity_key: { kind: 'session', session: forkSession },
          payload: { total_cost_usd: 0.102586, total_duration_ms: 29021 },
        },
      },
    ])
  })
})
