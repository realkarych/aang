import { readdir, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, relative } from 'node:path'
import {
  createPlayer,
  loadManifest,
  type LoadedManifest,
  type PlayerStep,
  type Profile,
  type SampleScenario,
  sampleScenarioManifest,
  sampleScenarios,
} from '@aang/testkit'
import { describe, type TestContext, test } from 'vitest'
import { createFixture, linesOf, sampleBytes } from './manifests.js'

type Json = Readonly<Record<string, unknown>>

interface SampleFile {
  readonly path: string
  readonly sample: string
}

const project = 'projects/-tmp-aang-spike-cc-transcripts-run'
const subagents = `${project}/86f93ed5-1acd-4c6e-8c60-f1c98335c2ef/subagents`

const main: SampleFile = {
  path: `${project}/86f93ed5-1acd-4c6e-8c60-f1c98335c2ef.jsonl`,
  sample: 'claude-code-transcripts/session-86f93ed5-main-full.jsonl',
}
const subagent: SampleFile = {
  path: `${subagents}/agent-aad616394e806288d.jsonl`,
  sample: 'claude-code-transcripts/subagent-agent-aad616394e806288d.jsonl',
}
const subagentMeta: SampleFile = {
  path: `${subagents}/agent-aad616394e806288d.meta.json`,
  sample: 'claude-code-transcripts/subagent-agent-aad616394e806288d.meta.json',
}
const fork: SampleFile = {
  path: `${project}/cdfb3544-67c1-4590-a4d9-280593b6ed55.jsonl`,
  sample: 'claude-code-transcripts/session-cdfb3544-fork-full.jsonl',
}
const rollout: SampleFile = {
  path: 'sessions/2026/10/01/rollout-2026-10-01T11-55-58-01a0f752-40a7-76b2-9df9-5b374f75f98f.jsonl',
  sample: 'codex-cli/rollout/rollout-real-exec-then-resume-with-compaction.jsonl',
}

const transcriptOf: Readonly<Record<string, SampleFile>> = { main, subagent, fork }

const jsonLines = (sample: string): Json[] =>
  linesOf(sampleBytes(sample)).map((line) => JSON.parse(line.toString('utf8')) as Json)

const whole = ({ sample }: SampleFile): Buffer => sampleBytes(sample)

const head = ({ sample }: SampleFile, lines: number): Buffer =>
  Buffer.concat(linesOf(sampleBytes(sample)).slice(0, lines))

const loadScenario = (scenario: SampleScenario): Promise<LoadedManifest> =>
  loadManifest(sampleScenarioManifest(scenario))

const byName = (left: string, right: string): number => left.localeCompare(right)

const filesUnder = async (root: string): Promise<Record<string, Buffer>> => {
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry): Promise<[string, Buffer]> => {
        const path = join(entry.parentPath, entry.name)
        return [relative(root, path).replaceAll('\\', '/'), await readFile(path)]
      }),
  )
  return Object.fromEntries(files.sort(([left], [right]) => byName(left, right)))
}

const claudeFiles = (profile: Profile): Promise<Record<string, Buffer>> => filesUnder(profile.claude)

const codexFiles = (profile: Profile): Promise<Record<string, Buffer>> => filesUnder(profile.codex)

const recordedClaudeWrites = (): ReadonlyMap<string, readonly number[]> => {
  const starts = new Map(
    jsonLines('claude-code-transcripts/sessions-registry-lifecycle-observed.jsonl')
      .filter((event) => event['event'] === 'run_start')
      .map((event) => [String(event['label']), Number(event['wall_ms'])]),
  )
  const writes = new Map<string, number[]>()
  for (const event of jsonLines('claude-code-transcripts/write-timeline-watch.jsonl')) {
    const at = Number(starts.get(String(event['run']))) + Number(event['t_ms_since_run_start'])
    const file =
      event['event'] === 'line'
        ? transcriptOf[String(event['file'])]?.path
        : event['event'] === 'file_new' && event['path'] === subagentMeta.path
          ? subagentMeta.path
          : undefined
    if (file !== undefined) {
      writes.set(file, [...(writes.get(file) ?? []), at])
    }
  }
  return writes
}

const recordedCodexWrites = (): ReadonlyMap<string, readonly number[]> =>
  new Map([[rollout.path, jsonLines(rollout.sample).map((line) => Date.parse(String(line['timestamp'])))]])

const writesOf = (step: PlayerStep): number =>
  step.kind === 'append' ? (step.lines ?? 0) : step.kind === 'write' ? 1 : 0

const recordedTimesOf = (
  steps: readonly PlayerStep[],
  recorded: ReadonlyMap<string, readonly number[]>,
): readonly (readonly number[])[] => {
  const written = new Map<string, number>()
  return steps.map((step) => {
    if (step.kind !== 'append' && step.kind !== 'write') {
      return []
    }
    const from = written.get(step.target.path) ?? 0
    written.set(step.target.path, from + writesOf(step))
    return (recorded.get(step.target.path) ?? []).slice(from, from + writesOf(step))
  })
}

describe.concurrent('the sample scenarios replay what the spike recorded', () => {
  test.for(sampleScenarios.filter((scenario) => scenario !== 'codex-otel'))(
    '%s writes each line at the time the spike saw it written, keeping the recorded intervals',
    async (scenario, { expect }) => {
      const { steps } = await loadScenario(scenario)
      const recorded = scenario.startsWith('codex') ? recordedCodexWrites() : recordedClaudeWrites()
      const times = recordedTimesOf(steps, recorded)
      const start = times[0]?.[0] ?? Number.NaN

      expect(steps[0]?.at).toBe(0)
      steps.forEach((step, index) => {
        const stepTimes = times[index] ?? []
        expect(writesOf(step)).toBeGreaterThan(0)
        expect(stepTimes.map((time) => time - start)).toEqual(Array.from({ length: writesOf(step) }, () => step.at))
      })
    },
  )

  test('the Claude subagent scenario writes the subagent meta file, the subagent, and then its result in the parent', async ({
    expect,
    onTestFinished,
  }) => {
    const { profile } = await createFixture(onTestFinished)
    const player = createPlayer(await loadScenario('claude-subagent'), { roots: profile, timeScale: 0 })

    await player.play({ until: 'subagent' })
    expect(await claudeFiles(profile)).toEqual({ [main.path]: head(main, 27) })

    await player.play({ until: 'subagent-result' })
    expect(await claudeFiles(profile)).toEqual({
      [main.path]: head(main, 28),
      [subagent.path]: whole(subagent),
      [subagentMeta.path]: whole(subagentMeta),
    })

    await player.play()
    expect(player.finished()).toBe(true)
    expect(await claudeFiles(profile)).toEqual({
      [main.path]: head(main, 34),
      [subagent.path]: whole(subagent),
      [subagentMeta.path]: whole(subagentMeta),
    })
    expect(await codexFiles(profile)).toEqual({})
  })

  test('the Claude fork scenario copies the history into a new session after the original was resumed and continued', async ({
    expect,
    onTestFinished,
  }) => {
    const { profile } = await createFixture(onTestFinished)
    const player = createPlayer(await loadScenario('claude-fork'), { roots: profile, timeScale: 0 })

    await player.play({ until: 'resume' })
    expect((await claudeFiles(profile))[main.path]).toEqual(head(main, 34))
    await player.play({ until: 'continue' })
    expect((await claudeFiles(profile))[main.path]).toEqual(head(main, 44))
    await player.play({ until: 'fork' })
    expect(Object.keys(await claudeFiles(profile))).not.toContain(fork.path)
    expect((await claudeFiles(profile))[main.path]).toEqual(head(main, 52))

    await player.play()
    expect(await claudeFiles(profile)).toEqual({
      [fork.path]: whole(fork),
      [main.path]: head(main, 52),
      [subagent.path]: whole(subagent),
      [subagentMeta.path]: whole(subagentMeta),
    })
  })

  test('the Claude compaction scenario writes the compaction block and ends with the whole main transcript of the spike', async ({
    expect,
    onTestFinished,
  }) => {
    const { profile } = await createFixture(onTestFinished)
    const player = createPlayer(await loadScenario('claude-compaction'), { roots: profile, timeScale: 0 })

    await player.play({ until: 'compaction' })
    expect((await claudeFiles(profile))[main.path]).toEqual(head(main, 52))
    await player.play({ until: 'compact-boundary' })
    expect((await claudeFiles(profile))[main.path]).toEqual(head(main, 54))
    await player.play({ until: 'post-compaction' })
    expect((await claudeFiles(profile))[main.path]).toEqual(head(main, 69))
    expect(jsonLines(main.sample).slice(54, 69).map((line) => line['subtype'])).toContain('compact_boundary')

    await player.play()
    expect(await claudeFiles(profile)).toEqual({
      [main.path]: whole(main),
      [subagent.path]: whole(subagent),
      [subagentMeta.path]: whole(subagentMeta),
    })
    expect(await codexFiles(profile)).toEqual({})
  })

  test('the Codex scenario appends the exec turn and then the resumed turn with its compaction to one rollout', async ({
    expect,
    onTestFinished,
  }) => {
    const { profile } = await createFixture(onTestFinished)
    const player = createPlayer(await loadScenario('codex-resume-compaction'), { roots: profile, timeScale: 0 })

    await player.play({ until: 'resume' })
    expect(await codexFiles(profile)).toEqual({ [rollout.path]: head(rollout, 20) })
    await player.play({ until: 'compaction' })
    expect(await codexFiles(profile)).toEqual({ [rollout.path]: head(rollout, 24) })
    expect(jsonLines(rollout.sample)[24]?.['type']).toBe('compacted')

    await player.play()
    expect(await codexFiles(profile)).toEqual({ [rollout.path]: whole(rollout) })
    expect(await claudeFiles(profile)).toEqual({})
  })
})

interface Attribute {
  readonly key: string
  readonly value: Json
}

interface OtlpLogs {
  readonly resourceLogs: readonly {
    readonly resource: { readonly attributes: readonly Attribute[] }
    readonly scopeLogs: readonly { readonly scope: Json; readonly logRecords: readonly Json[] }[]
  }[]
}

const startReceiver = async (onTestFinished: TestContext['onTestFinished']) => {
  const bodies: OtlpLogs[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as OtlpLogs)
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  onTestFinished(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
        server.closeAllConnections()
      }),
  )
  return { endpoint: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/v1/logs`, bodies }
}

const attributeOf = (record: Json, key: string): unknown =>
  (record['attributes'] as readonly Attribute[]).find((entry) => entry.key === key)?.value['stringValue']

const observedAt = (record: Json): bigint => BigInt(String(record['observedTimeUnixNano']))

interface Exported {
  readonly record: Json
  readonly service: string
}

const inObservedOrder = (left: Exported, right: Exported): number =>
  Number(observedAt(left.record) - observedAt(right.record))

test('the Codex OTel scenario exports each log record of the spike once, in observed order, under the resource of its service', async ({
  expect,
  onTestFinished,
}) => {
  const { profile } = await createFixture(onTestFinished)
  const receiver = await startReceiver(onTestFinished)
  const manifest = await loadScenario('codex-otel')
  const decisions = jsonLines('codex-otel/logs.tool_decision.variants.jsonl').flatMap((line): Exported[] =>
    'logRecord' in line ? [{ record: line['logRecord'] as Json, service: String(line['_service.name']) }] : [],
  )
  const serviceOf = new Map(decisions.map(({ record, service }) => [attributeOf(record, 'originator'), service]))
  const others = jsonLines('codex-otel/logs.other-events.jsonl').map((line): Exported => {
    const record = line['logRecord'] as Json
    return { record, service: serviceOf.get(attributeOf(record, 'originator')) ?? '' }
  })
  const expected = [...decisions, ...others].sort(inObservedOrder)
  const resources = JSON.parse(sampleBytes('codex-otel/resource-attributes.by-service.json').toString('utf8')) as Record<
    string,
    { readonly '/v1/logs': { readonly resource: Json } }
  >
  const envelope = JSON.parse(
    sampleBytes('codex-otel/logs.envelope.tool_decision.approved-user.app-server.json').toString('utf8'),
  ) as OtlpLogs
  const origin = observedAt(expected[0]?.record ?? {})

  await createPlayer(manifest, { roots: profile, otlp: receiver.endpoint, timeScale: 0 }).play()

  expect(
    receiver.bodies.map(({ resourceLogs }) =>
      resourceLogs.map(({ resource, scopeLogs }) => ({
        resource: Object.fromEntries(resource.attributes.map(({ key, value }) => [key, value['stringValue']])),
        scopes: scopeLogs.map(({ scope, logRecords }) => ({ scope, logRecords })),
      })),
    ),
  ).toEqual(
    expected.map(({ record, service }) => [
      {
        resource: resources[service]?.['/v1/logs'].resource,
        scopes: [{ scope: envelope.resourceLogs[0]?.scopeLogs[0]?.scope, logRecords: [record] }],
      },
    ]),
  )
  expect(manifest.steps.map((step) => step.at)).toEqual(
    expected.map(({ record }) => Number((observedAt(record) - origin) / 1_000_000n)),
  )
  expect(receiver.bodies).toContainEqual({ resourceLogs: envelope.resourceLogs })
})
