import { join, resolve } from 'node:path'
import { type LoadedManifest, loadManifest } from '@aang/testkit'
import { describe, expect, onTestFinished, test } from 'vitest'
import { type Played, playRecording, readRecordingManifest, recordedTimes, removeRoots, takeSnapshot } from '../dist/index.js'
import { hookBinary } from './fixtures.js'

interface Snapshot {
  readonly facts: readonly { readonly kind: string; readonly payload: Readonly<Record<string, unknown>> }[]
}

const escaped = (text: string): string => JSON.stringify(text).slice(1, -1)

const withLines = (manifest: LoadedManifest, edit: (text: string) => string): LoadedManifest => ({
  ...manifest,
  sources: new Map(
    [...manifest.sources].map(([source, bytes]) => [source, source.endsWith('.jsonl') ? Buffer.from(edit(bytes.toString('utf8'))) : bytes]),
  ),
})

const play = async (name: string, edit: (text: string) => string): Promise<Played> => {
  const reference = resolve('fixtures/sessions', name)
  const manifest = withLines(await loadManifest(join(reference, 'playback.json')), edit)
  const played = await playRecording(manifest, { hookBinary, recorded: recordedTimes(await readRecordingManifest(reference)) })
  onTestFinished(async () => {
    played.store.close()
    await removeRoots(played.roots)
  })
  return played
}

const payloadsOf = (snapshot: unknown, kind: string): Readonly<Record<string, unknown>>[] =>
  (snapshot as Snapshot).facts.filter((fact) => fact.kind === kind).map(({ payload }) => payload)

describe('the contract snapshot of a recording played on the playback clock', () => {
  test('a workflow result that the Claude adapter turns into JSON text keeps its recorded date in the final message', async () => {
    const result = JSON.stringify({ report: 'done', finishedAt: '2026-10-05T22:14:30.000Z' })
    const { store, roots, shift } = await play('claude/2.1.289/claude_cli/macos/workflow', (text) =>
      text.replaceAll('"result":"report"', `"result":${result}`),
    )

    const finalMessages = (snapshot: unknown): unknown[] => payloadsOf(snapshot, 'agent_end').map(({ final_message }) => final_message)
    expect(finalMessages(takeSnapshot(store, roots.base))).not.toContain(result)
    expect(finalMessages(takeSnapshot(store, roots.base, shift))).toContain(result)
  }, 120_000)

  test('Codex call arguments that the adapter parses out of JSON text keep their recorded date in the action input', async () => {
    const recordedInput = { cmd: 'echo hi', since: '2026-10-04T04:19:00.000Z' }
    const { store, roots, shift } = await play('codex/0.160.0/codex_exec/macos/tools', (text) =>
      text.replaceAll(escaped('{"cmd":"echo hi"}'), escaped(JSON.stringify(recordedInput))),
    )

    const inputs = (snapshot: unknown): unknown[] =>
      payloadsOf(snapshot, 'action_start').flatMap(({ tool, input }) => (tool === 'exec_command' ? [input] : []))
    expect(inputs(takeSnapshot(store, roots.base))).not.toContainEqual(recordedInput)
    expect(inputs(takeSnapshot(store, roots.base, shift))).toEqual([recordedInput])
  }, 120_000)
})
