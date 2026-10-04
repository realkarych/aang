import { readdirSync, readFileSync, statSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { spoolEnvKeys } from '@aang/contract'
import {
  createPlayer,
  leaseSpool,
  loadManifest,
  OtlpDeliveryError,
  PlaybackError,
  readSpool,
  type Profile,
} from '@aang/testkit'
import { describe, type TestContext, test } from 'vitest'
import { hookBinary } from './artifacts.js'
import { createFixture, sampleBytes } from './manifests.js'

const claudeHooks = [
  'SessionStart.startup',
  'UserPromptSubmit',
  'PreToolUse.Bash',
  'PermissionRequest.Bash',
  'PostToolUse.Bash',
  'Stop',
  'SessionEnd',
]

const claudeEnv: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(
    (
      JSON.parse(sampleBytes('claude-code-hooks/envelope.command.SessionStart.plugin.json').toString('utf8')) as {
        env: Record<string, string>
      }
    ).env,
  ).filter(([name]) => (spoolEnvKeys as readonly string[]).includes(name)),
)

interface SpooledEvent {
  readonly runtime: 'claude' | 'codex'
  readonly registration: 'plugin' | 'user'
  readonly env: Readonly<Record<string, string>>
  readonly payload: Buffer
}

const claudeEvent = (name: string): SpooledEvent => ({
  runtime: 'claude',
  registration: 'plugin',
  env: claudeEnv,
  payload: sampleBytes(`claude-code-hooks/${name}.json`),
})

const codexEvent = (name: string, env: Readonly<Record<string, string>>): SpooledEvent => ({
  runtime: 'codex',
  registration: 'user',
  env,
  payload: Buffer.from(
    JSON.stringify(
      (JSON.parse(sampleBytes(`codex-cli/hooks/${name}.json`).toString('utf8')) as { stdin: unknown }).stdin,
    ),
  ),
})

interface Received {
  readonly method: string | undefined
  readonly url: string | undefined
  readonly contentType: string | undefined
  readonly body: Buffer
  readonly at: number
}

interface Receiver {
  readonly endpoint: string
  readonly received: Received[]
}

const otelPath = '/otel/receiver-token/v1/logs'

const startReceiver = async (
  onTestFinished: TestContext['onTestFinished'],
  respond: (request: IncomingMessage, response: ServerResponse) => void = (_, response) => {
    response.writeHead(200).end()
  },
): Promise<Receiver> => {
  const received: Received[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      received.push({
        method: request.method,
        url: request.url,
        contentType: request.headers['content-type'],
        body: Buffer.concat(chunks),
        at: performance.now(),
      })
      respond(request, response)
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
  return { endpoint: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}${otelPath}`, received }
}

const hookTarget = (profile: Profile): { binary: string; spool: string; env: Profile['env'] } => ({
  binary: hookBinary,
  spool: profile.spool,
  env: profile.env,
})

describe.concurrent(
  'the player delivers hook events through the real aang-hook and OTLP requests to a receiver',
  () => {
    test('hook events of both runtimes reach a leased spool without a daemon, in their original order and with their headers', async ({
      expect,
      onTestFinished,
    }) => {
      const { profile, manifest } = await createFixture(onTestFinished)
      const codexEnv = { CODEX_HOME: profile.codex }
      const events = [
        ...claudeHooks.slice(0, 3).map(claudeEvent),
        codexEvent('PreToolUse.Bash', codexEnv),
        ...claudeHooks.slice(3).map(claudeEvent),
        codexEvent('PostToolUse.Bash', codexEnv),
      ]
      const file = await manifest('hooks', {
        sources: Object.fromEntries(events.map((event, index) => [`hooks/${String(index)}.json`, event.payload])),
        steps: events.map((event, index) => ({
          at: 0,
          kind: 'hook',
          runtime: event.runtime,
          registration: event.registration,
          env: event.env,
          source: `hooks/${String(index)}.json`,
        })),
      })
      await leaseSpool(profile.spool)

      await createPlayer(await loadManifest(file), { roots: profile, hook: hookTarget(profile), timeScale: 0 }).play()

      const spooled = await readSpool(profile.spool)
      expect(spooled.map(({ header, payload }) => ({ ...header, payload: payload.toString('utf8') }))).toEqual(
        events.map(({ runtime, registration, env, payload }) => ({
          runtime,
          registration,
          env,
          payload: payload.toString('utf8'),
        })),
      )
      expect(
        spooled.every((event, index) => index === 0 || event.receivedAt > (spooled[index - 1]?.receivedAt ?? 0n)),
      ).toBe(true)
      expect(await readdir(join(profile.spool, 'tmp'))).toEqual([])
    })

    test('a hook event registered twice gives two spool files with different tags and the same payload', async ({
      expect,
      onTestFinished,
    }) => {
      const { profile, manifest } = await createFixture(onTestFinished)
      const file = await manifest('double registration', {
        sources: { 'permission.json': sampleBytes('claude-code-hooks/PermissionRequest.Bash.json') },
        steps: [
          { at: 0, kind: 'hook', runtime: 'claude', registration: 'plugin', env: claudeEnv, source: 'permission.json' },
          { at: 0, kind: 'hook', runtime: 'claude', registration: 'user', env: claudeEnv, source: 'permission.json' },
        ],
      })
      await leaseSpool(profile.spool)

      await createPlayer(await loadManifest(file), { roots: profile, hook: hookTarget(profile) }).play()

      const spooled = await readSpool(profile.spool)
      expect(spooled.map((event) => event.header.registration)).toEqual(['plugin', 'user'])
      expect(new Set(spooled.map((event) => event.name)).size).toBe(2)
      expect(spooled.map((event) => event.payload)).toEqual([
        sampleBytes('claude-code-hooks/PermissionRequest.Bash.json'),
        sampleBytes('claude-code-hooks/PermissionRequest.Bash.json'),
      ])
    })

    test(
      'OTLP requests reach the receiver in order, with their recorded bodies and intervals',
      { concurrent: false },
      async ({ expect, onTestFinished }) => {
        const { profile, manifest } = await createFixture(onTestFinished)
        const receiver = await startReceiver(onTestFinished)
        const bodies = [
          sampleBytes('codex-otel/logs.envelope.tool_decision.approved-user.app-server.json'),
          Buffer.from('{"resourceLogs":[]}'),
          Buffer.from('{"resourceLogs":[{"scopeLogs":[]}]}'),
        ]
        const timeScale = 0.1
        const recorded = [0, 3_000, 6_000]
        const file = await manifest('otlp', {
          sources: Object.fromEntries(bodies.map((body, index) => [`otel/${String(index)}.json`, body])),
          steps: recorded.map((at, index) => ({ at, kind: 'otlp', source: `otel/${String(index)}.json` })),
        })
        const player = createPlayer(await loadManifest(file), { roots: profile, otlp: receiver.endpoint, timeScale })

        const startedAt = performance.now()
        await player.play()

        expect(
          receiver.received.map(({ method, url, contentType, body }) => ({ method, url, contentType, body })),
        ).toEqual(bodies.map((body) => ({ method: 'POST', url: otelPath, contentType: 'application/json', body })))
        receiver.received.forEach(({ at }, index) => {
          expect(at - startedAt).toBeGreaterThanOrEqual((recorded[index] ?? Infinity) * timeScale)
          expect(at - startedAt).toBeLessThan((recorded[index] ?? 0) * timeScale + 1_000)
        })
      },
    )

    test('at playback time the numeric epochs of rollout lines and OTLP requests move with the ISO timestamps', async ({
      expect,
      onTestFinished,
    }) => {
      const { profile, manifest } = await createFixture(onTestFinished)
      const receiver = await startReceiver(onTestFinished)
      const line = {
        timestamp: '2026-10-04T01:19:14.853Z',
        payload: {
          create_time: 1_791_076_754,
          started_at_ms: 1_791_076_754_873,
          completed_at_ms: 1_791_076_755_964,
          duration_ms: 1_091,
          exit_code: 0,
          call_number: 1_234_567_890_123,
        },
      }
      const logs = {
        resourceLogs: [
          {
            scopeLogs: [
              {
                logRecords: [
                  {
                    timeUnixNano: '0',
                    observedTimeUnixNano: '1791076755918590000',
                    attributes: [{ key: 'event.timestamp', value: { stringValue: '2026-10-04T01:19:15.918Z' } }],
                  },
                ],
              },
            ],
          },
        ],
      }
      const rollout = { root: 'codex', path: 'sessions/2026/10/04/rollout-epochs.jsonl' }
      const file = await manifest('epochs', {
        sources: { 'rollout.jsonl': `${JSON.stringify(line)}\n`, 'logs.json': JSON.stringify(logs) },
        steps: [
          { at: 0, kind: 'append', target: rollout, source: 'rollout.jsonl' },
          { at: 0, kind: 'otlp', source: 'logs.json' },
        ],
      })

      const before = Date.now()
      const player = createPlayer(await loadManifest(file), {
        roots: profile,
        otlp: receiver.endpoint,
        timeScale: 0,
        recordTime: 'playback',
      })
      await player.play()

      const written = JSON.parse(readFileSync(join(profile.codex, ...rollout.path.split('/')), 'utf8')) as typeof line
      const shift = Date.parse(written.timestamp) - Date.parse(line.timestamp)
      expect(Date.parse(written.timestamp)).toBeGreaterThanOrEqual(before)
      expect(written.payload).toEqual({
        create_time: line.payload.create_time + Math.trunc(shift / 1_000),
        started_at_ms: line.payload.started_at_ms + shift,
        completed_at_ms: line.payload.completed_at_ms + shift,
        duration_ms: line.payload.duration_ms,
        exit_code: 0,
        call_number: line.payload.call_number,
      })
      const [received] = receiver.received
      const sent = JSON.parse(received?.body.toString('utf8') ?? '{}') as typeof logs
      const record = sent.resourceLogs[0]?.scopeLogs[0]?.logRecords[0]
      expect(record?.timeUnixNano).toBe('0')
      expect(BigInt(record?.observedTimeUnixNano ?? '0')).toBe(
        BigInt(logs.resourceLogs[0]?.scopeLogs[0]?.logRecords[0]?.observedTimeUnixNano ?? '0') + BigInt(shift) * 1_000_000n,
      )
      expect(Date.parse(record?.attributes[0]?.value.stringValue ?? '')).toBe(Date.parse('2026-10-04T01:19:15.918Z') + shift)
    })

    test('a receiver that refuses a request stops playback at that step', async ({ expect, onTestFinished }) => {
      const { profile, manifest } = await createFixture(onTestFinished)
      const receiver = await startReceiver(onTestFinished, (request, response) => {
        response.writeHead(request.url === otelPath ? 503 : 200).end()
      })
      const file = await manifest('refused', {
        sources: { 'logs.json': '{"resourceLogs":[]}', 'line.jsonl': '{"n":1}\n' },
        steps: [
          { at: 0, kind: 'otlp', source: 'logs.json', label: 'decision' },
          { at: 0, kind: 'append', target: { root: 'home', path: 'after.jsonl' }, source: 'line.jsonl' },
        ],
      })
      const player = createPlayer(await loadManifest(file), { roots: profile, otlp: receiver.endpoint })

      const playing = player.play()

      await expect(playing).rejects.toThrow(PlaybackError)
      await expect(playing).rejects.toThrow('step 0 (otlp "decision") failed: the OTLP receiver at')
      await expect(playing).rejects.toSatisfy(
        (error: unknown) => error instanceof Error && error.cause instanceof OtlpDeliveryError,
      )
      expect(player.position()).toBe(0)
      expect(readdirSync(profile.home)).not.toContain('after.jsonl')
    })

    test('file writes, hook events and OTLP requests of one manifest follow one timeline', async ({
      expect,
      onTestFinished,
    }) => {
      const { profile, manifest } = await createFixture(onTestFinished)
      const transcript = { root: 'claude', path: 'projects/-tmp-p/s1.jsonl' }
      const transcriptPath = join(profile.claude, 'projects', '-tmp-p', 's1.jsonl')
      const firstLine = '{"uuid":"a"}\n'
      const seenByReceiver: { size: number; spooled: number }[] = []
      const receiver = await startReceiver(onTestFinished, (_, response) => {
        seenByReceiver.push({
          size: statSync(transcriptPath).size,
          spooled: readdirSync(join(profile.spool, 'new')).length,
        })
        response.writeHead(200).end()
      })
      const file = await manifest('timeline', {
        sources: {
          'transcript.jsonl': `${firstLine}{"uuid":"b"}\n`,
          'pre.json': sampleBytes('claude-code-hooks/PreToolUse.Bash.json'),
          'post.json': sampleBytes('claude-code-hooks/PostToolUse.Bash.json'),
          'logs.json': '{"resourceLogs":[]}',
        },
        steps: [
          { at: 0, kind: 'append', target: transcript, source: 'transcript.jsonl', lines: 1 },
          { at: 50, kind: 'hook', runtime: 'claude', registration: 'plugin', env: claudeEnv, source: 'pre.json' },
          { at: 100, kind: 'otlp', source: 'logs.json' },
          { at: 150, kind: 'append', target: transcript, source: 'transcript.jsonl' },
          { at: 200, kind: 'hook', runtime: 'claude', registration: 'plugin', env: claudeEnv, source: 'post.json' },
        ],
      })
      await leaseSpool(profile.spool)

      const played = await createPlayer(await loadManifest(file), {
        roots: profile,
        hook: hookTarget(profile),
        otlp: receiver.endpoint,
      }).play()

      expect(played.map((step) => step.index)).toEqual([0, 1, 2, 3, 4])
      expect(seenByReceiver).toEqual([{ size: Buffer.byteLength(firstLine), spooled: 1 }])
      expect((await readSpool(profile.spool)).map((event) => event.payload)).toEqual([
        sampleBytes('claude-code-hooks/PreToolUse.Bash.json'),
        sampleBytes('claude-code-hooks/PostToolUse.Bash.json'),
      ])
    })
  },
)
