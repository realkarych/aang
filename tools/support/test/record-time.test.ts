import { join, resolve } from 'node:path'
import { type LoadedManifest, loadManifest, playbackShift, shifted } from '@aang/testkit'
import { describe, expect, onTestFinished, test } from 'vitest'
import { type Played, playRecording, type RecordedTimes, readRecordingManifest, recordedTimes, removeRoots, takeSnapshot } from '../dist/index.js'
import { hookBinary } from './fixtures.js'

interface Snapshot {
  readonly facts: readonly { readonly kind: string; readonly payload: Readonly<Record<string, unknown>> }[]
}

interface Reference {
  readonly manifest: LoadedManifest
  readonly recorded: RecordedTimes
}

const secondMs = 1_000
const hourMs = 60 * 60 * secondMs
const dayMs = 24 * hourMs
const nanosecondsPerMs = 1_000_000n

const codexTools = 'codex/0.160.0/codex_exec/macos/tools'

const escaped = (text: string): string => JSON.stringify(text).slice(1, -1)

const reference = async (name: string): Promise<Reference> => {
  const directory = resolve('fixtures/sessions', name)
  return { manifest: await loadManifest(join(directory, 'playback.json')), recorded: recordedTimes(await readRecordingManifest(directory)) }
}

const recordedAt = ({ manifest, recorded }: Reference, at: number): Reference => {
  const moved = playbackShift(manifest.sources.values(), at)
  return {
    manifest: { ...manifest, sources: new Map([...manifest.sources].map(([source, bytes]) => [source, shifted(bytes, moved)])) },
    recorded: {
      startedAt: recorded.startedAt + moved.ms,
      mtimes: new Map([...recorded.mtimes].map(([source, mtime]) => [source, mtime + BigInt(moved.ms) * nanosecondsPerMs])),
    },
  }
}

const withLines = (manifest: LoadedManifest, edit: (text: string) => string): LoadedManifest => ({
  ...manifest,
  sources: new Map(
    [...manifest.sources].map(([source, bytes]) => [source, source.endsWith('.jsonl') ? Buffer.from(edit(bytes.toString('utf8'))) : bytes]),
  ),
})

const play = async ({ manifest, recorded }: Reference, edit: (text: string) => string, startsAt = Date.now()): Promise<Played> => {
  const played = await playRecording(withLines(manifest, edit), { hookBinary, recorded, startsAt })
  onTestFinished(async () => {
    played.store.close()
    await removeRoots(played.roots)
  })
  return played
}

const recordedSnapshot = (played: Played): unknown => takeSnapshot(played.store, played.roots.base, played)

const payloadsOf = (snapshot: unknown, kind: string): Readonly<Record<string, unknown>>[] =>
  (snapshot as Snapshot).facts.filter((fact) => fact.kind === kind).map(({ payload }) => payload)

const commandInputs = (snapshot: unknown): unknown[] =>
  payloadsOf(snapshot, 'action_start').flatMap(({ tool, input }) => (tool === 'exec_command' ? [input] : []))

const withArguments =
  (input: unknown, space?: number): ((text: string) => string) =>
  (text) =>
    text.replaceAll(escaped('{"cmd":"echo hi"}'), escaped(JSON.stringify(input, null, space)))

describe('the contract snapshot of a recording played on the playback clock', () => {
  test('a workflow result that the Claude adapter turns into JSON text keeps its recorded date in the final message', async () => {
    const result = JSON.stringify({ report: 'done', finishedAt: '2026-10-05T22:14:30.000Z' })
    const played = await play(await reference('claude/2.1.289/claude_cli/macos/workflow'), (text) =>
      text.replaceAll('"result":"report"', `"result":${result}`),
    )

    const finalMessages = (snapshot: unknown): unknown[] => payloadsOf(snapshot, 'agent_end').map(({ final_message }) => final_message)
    expect(finalMessages(takeSnapshot(played.store, played.roots.base))).not.toContain(result)
    expect(finalMessages(recordedSnapshot(played))).toContain(result)
  }, 120_000)

  test('Codex call arguments that the adapter parses out of JSON text keep their recorded date in the action input', async () => {
    const recordedInput = { cmd: 'echo hi', since: '2026-10-04T04:19:00.000Z' }
    const played = await play(await reference(codexTools), withArguments(recordedInput))

    expect(commandInputs(takeSnapshot(played.store, played.roots.base))).not.toContainEqual(recordedInput)
    expect(commandInputs(recordedSnapshot(played))).toEqual([recordedInput])
  }, 120_000)

  test('an epoch time in pretty-printed Codex call arguments keeps its recorded value, so a replay soon after the recording and a later one give one snapshot', async () => {
    const recordingStart = Date.now() - 3 * hourMs
    const recordedInput = { cmd: 'echo hi', since: String(Math.floor(recordingStart / secondMs)) }
    const recent = recordedAt(await reference(codexTools), recordingStart)

    const soon = await play(recent, withArguments(recordedInput, 2), recordingStart + hourMs)
    const later = await play(recent, withArguments(recordedInput, 2), recordingStart + 3 * hourMs)

    expect([soon.shift.ms, later.shift.ms]).toEqual([hourMs, 3 * hourMs])
    expect(commandInputs(recordedSnapshot(soon))).toEqual([recordedInput])
    expect(recordedSnapshot(later)).toEqual(recordedSnapshot(soon))
  }, 240_000)

  test('epoch times in and days after the recorded timeline keep their recorded values, also when the replay would move the first onto the second', async () => {
    const recordingStart = Date.now() - 3 * dayMs
    const recent = recordedAt(await reference(codexTools), recordingStart)
    const collidingAt = recordingStart + 2.5 * dayMs
    const since = Math.floor(recordingStart / secondMs)
    const recordedInput = { cmd: 'echo hi', since, until: since + playbackShift(recent.manifest.sources.values(), collidingAt).ms / secondMs }

    const colliding = await play(recent, withArguments(recordedInput), collidingAt)
    const later = await play(recent, withArguments(recordedInput))

    expect(commandInputs(recordedSnapshot(colliding))).toEqual([recordedInput])
    expect(recordedSnapshot(later)).toEqual(recordedSnapshot(colliding))
  }, 240_000)
})
