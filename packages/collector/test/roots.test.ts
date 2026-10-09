import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { CollectedRecord } from '@aang/contract'
import { expect, test, vi } from 'vitest'
import { createSandbox, runCollector, type Running, sleep } from './sandbox.js'

const watchStartMs = 300

const pathOf = ({ position }: CollectedRecord): string | null =>
  position.kind === 'line' || position.kind === 'file' ? position.path : null

const arrival = async (running: Running, path: string): Promise<number> => {
  const arrivedAt = (): number | undefined => running.arrivalOf((record) => pathOf(record) === path)
  await vi.waitFor(
    () => {
      expect(arrivedAt()).toBeDefined()
    },
    { timeout: 10_000, interval: 5 },
  )
  return arrivedAt() ?? Infinity
}

const put = async (path: string, content: string): Promise<number> => {
  await mkdir(dirname(path), { recursive: true })
  const writtenAt = performance.now()
  await writeFile(path, content)
  return writtenAt
}

test('files under runtime roots created after the start are collected within seconds while the roots scan waits a minute', async ({
  onTestFinished,
}) => {
  const sandbox = await createSandbox(onTestFinished)
  const team = join(sandbox.claude, 'teams', 'alpha', 'config.json')
  const transcript = join(sandbox.claude, 'projects', '-work-proj', 'session-1.jsonl')
  const registry = join(sandbox.claude, 'sessions', '4242.json')
  const rollout = join(sandbox.codex, 'sessions', '2026', '10', '01', 'rollout-1.jsonl')
  const laterTranscript = join(sandbox.claude, 'projects', '-work-other', 'session-2.jsonl')
  const content: Readonly<Record<string, string>> = {
    [team]: JSON.stringify({ members: [] }),
    [transcript]: JSON.stringify({ uuid: 'u-1', text: 'first' }),
    [registry]: JSON.stringify({ pid: 4242, sessionId: 'session-1' }),
    [rollout]: JSON.stringify({ ordinal: 0, type: 'session_meta' }),
    [laterTranscript]: JSON.stringify({ uuid: 'u-2', text: 'second' }),
  }
  await put(team, content[team] ?? '')
  const running = runCollector(sandbox)
  await arrival(running, team)
  await sleep(watchStartMs)
  const lags: Record<string, number> = {}
  const created = async (path: string, ending = ''): Promise<void> => {
    const writtenAt = await put(path, `${content[path] ?? ''}${ending}`)
    lags[path] = (await arrival(running, path)) - writtenAt
  }

  await created(transcript, '\n')
  await created(registry)
  await mkdir(sandbox.codex)
  await sleep(watchStartMs)
  await created(rollout, '\n')
  await sleep(watchStartMs)
  await created(laterTranscript, '\n')

  expect(Object.values(lags).every((lag) => lag <= 5_000), JSON.stringify(lags)).toBe(true)
  expect(running.payloads().sort()).toEqual(Object.values(content).sort())
  expect(running.cursor(rollout)).toMatchObject({ line: 1, last_ordinal: 0 })
})
