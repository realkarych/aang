import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ScopeDecision } from '@aang/contract'
import { describe, expect, test, vi } from 'vitest'
import { gapsOf, noObservationRows, observationRows, recordsOf, sessionKey, startEngine, streamOf } from './harness.js'
import { createHome } from './home.js'
import {
  appendLines,
  createLiveRoots,
  deliverHook,
  type LiveRoots,
  lockFile,
  runLive,
  spoolLeft,
  writeLines,
} from './live.js'
import { claudeHook, claudeHookEnv, claudeSubagentTranscript, claudeTranscript, codexRollout } from './samples.js'
import { createWorkspace } from './workspace.js'

const settleTimeout = { timeout: 15_000, interval: 25 }

type Place = 'repository' | 'outside'

interface OrderCase {
  readonly name: string
  readonly start: Place
  readonly later: Place
  readonly scope: ScopeDecision
}

const orderCases: readonly OrderCase[] = [
  { name: 'a start inside the root is watched', start: 'repository', later: 'outside', scope: 'watched' },
  { name: 'a start outside the root is external', start: 'outside', later: 'repository', scope: 'external' },
]

const claudeFile = (roots: LiveRoots, ...parts: readonly string[]): string =>
  join(roots.claude, 'projects', '-work', ...parts)

describe('the real collector delivers the spool before the transcripts, and the first cwd still decides', () => {
  test.for(orderCases)('$name', async ({ start, later, scope }, { onTestFinished }) => {
    const workspace = await createWorkspace(onTestFinished)
    const home = await createHome(onTestFinished)
    const roots = await createLiveRoots(onTestFinished)
    const store = home.open()
    const lines = claudeTranscript({ session: 's-live', cwd: workspace[start] })
    await writeLines(claudeFile(roots, 's-live.jsonl'), lines)
    await deliverHook(roots, 'hook-1.evt', {
      payload: claudeHook('PreToolUse.Bash.json', { session: 's-live', cwd: workspace[later] }),
      env: claudeHookEnv,
    })

    const live = runLive(onTestFinished, roots, store, startEngine(store, { roots: [workspace.repository] }))

    await vi.waitFor(async () => {
      expect(store.cursors.list()).toHaveLength(1)
      expect(await spoolLeft(roots)).toEqual([])
    }, settleTimeout)
    await live.stop()
    expect(live.batches()[0]?.records.map((record) => record.channel)).toEqual(['hook'])
    expect(store.scopes.ofSession(sessionKey('claude', 's-live'))?.scope).toBe(scope)
    expect(recordsOf(store)).toHaveLength(scope === 'watched' ? lines.length + 1 : 0)
    expect((observationRows(home.database()).facts ?? 0) > 0).toBe(scope === 'watched')
  })
})

describe('the real collector delivers a subagent transcript before its main transcript', () => {
  test.for(orderCases)('$name', async ({ start, later, scope }, { onTestFinished }) => {
    const workspace = await createWorkspace(onTestFinished)
    const home = await createHome(onTestFinished)
    const roots = await createLiveRoots(onTestFinished)
    const store = home.open()
    const mainLines = claudeTranscript({ session: 's-parent', cwd: workspace[start] })
    const subagentLines = claudeSubagentTranscript({ session: 's-parent', cwd: workspace[later] })
    await writeLines(claudeFile(roots, 's-parent', 'subagents', 'agent-a.jsonl'), subagentLines)

    const live = runLive(onTestFinished, roots, store, startEngine(store, { roots: [workspace.repository] }))

    await vi.waitFor(() => {
      expect(live.results().at(-1)?.waiting).toBe(subagentLines.length)
    }, settleTimeout)
    await writeLines(claudeFile(roots, 's-parent.jsonl'), mainLines)
    await vi.waitFor(() => {
      expect(store.cursors.list()).toHaveLength(2)
    }, settleTimeout)
    await live.stop()
    expect(store.scopes.ofSession(sessionKey('claude', 's-parent'))?.scope).toBe(scope)
    expect(store.scopes.get(streamOf('claude', subagentLines))?.scope).toBe(scope)
    expect(recordsOf(store)).toHaveLength(scope === 'watched' ? mainLines.length + subagentLines.length : 0)
  })
})

describe('a read failure reported by the real collector after the scope is decided', () => {
  test.for([
    ['outside', 'external'],
    ['repository', 'watched'],
  ] as const)('of a file in %s is kept only for a watched stream', async ([place, scope], { onTestFinished }) => {
    const workspace = await createWorkspace(onTestFinished)
    const home = await createHome(onTestFinished)
    const roots = await createLiveRoots(onTestFinished)
    const store = home.open()
    const lines = claudeTranscript({ session: 's-locked', cwd: workspace[place] })
    const path = claudeFile(roots, 's-locked.jsonl')
    await writeLines(path, lines.slice(0, 50))
    const live = runLive(onTestFinished, roots, store, startEngine(store, { roots: [workspace.repository] }), {
      pauseMs: 20,
      gapAfterMs: 200,
    })
    await vi.waitFor(() => {
      expect(store.cursors.list()[0]?.line).toBe(50)
    }, settleTimeout)
    const head = store.changes.head()

    await appendLines(path, lines.slice(50))
    const release = await lockFile(onTestFinished, path)
    await vi.waitFor(() => {
      expect(live.batches().some((batch) => batch.gaps.length > 0)).toBe(true)
    }, settleTimeout)
    await release()
    await vi.waitFor(() => {
      expect(store.cursors.list()[0]?.line).toBe(lines.length)
    }, settleTimeout)
    await live.stop()

    expect(store.scopes.ofSession(sessionKey('claude', 's-locked'))?.scope).toBe(scope)
    if (scope === 'external') {
      expect(store.changes.head()).toBe(head)
      expect(observationRows(home.database())).toEqual(noObservationRows)
    } else {
      expect(gapsOf(store).map((gap) => [gap.key.gap, gap.key.subject, gap.stream, gap.closed_at === null])).toEqual([
        ['read_failed', path, streamOf('claude', lines), false],
      ])
      expect(recordsOf(store)).toHaveLength(lines.length)
    }
  })
})

describe('a rollout that the real collector reads again after it is rewritten in place', () => {
  test('with another thread yields the records of the new thread', async ({ onTestFinished }) => {
    const workspace = await createWorkspace(onTestFinished)
    const home = await createHome(onTestFinished)
    const roots = await createLiveRoots(onTestFinished)
    const store = home.open()
    const path = join(roots.codex, 'sessions', '2026', '10', '01', 'rollout-2026-10-01T14-55-58-t.jsonl')
    const oldLines = codexRollout({ thread: 't-old', cwd: workspace.repository })
    const newLines = codexRollout({ thread: 't-new', cwd: workspace.repository }).slice(0, 20)
    await writeLines(path, oldLines)
    const live = runLive(onTestFinished, roots, store, startEngine(store, { roots: [workspace.repository] }))
    await vi.waitFor(() => {
      expect(recordsOf(store)).toHaveLength(oldLines.length)
    }, settleTimeout)

    await writeFile(path, `${newLines.join('\n')}\n`)
    const newStream = streamOf('codex', newLines)
    await vi.waitFor(() => {
      expect(recordsOf(store).filter((record) => record.stream === newStream)).toHaveLength(newLines.length)
    }, settleTimeout)
    await live.stop()

    expect(store.scopes.ofSession(sessionKey('codex', 't-new'))?.scope).toBe('watched')
    expect(store.cursors.list().map(({ stream, line }) => [stream, line])).toEqual([[newStream, newLines.length]])
  })
})
