import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ScopeDecision, StreamKey } from '@aang/contract'
import type { Store } from '@aang/store'
import { describe, expect, test, vi } from 'vitest'
import { factsOf, gapsOf, noObservationRows, observationRows, recordsOf, sessionKey, startEngine, streamOf } from './harness.js'
import { createHome } from './home.js'
import {
  appendLines,
  createLiveRoots,
  deliverHook,
  type LiveRoots,
  denyReading,
  runLive,
  spoolLeft,
  writeLines,
} from './live.js'
import {
  claudeHook,
  claudeHookEnv,
  claudeSubagentTranscript,
  claudeTranscript,
  claudeWorkflowJournal,
  codexRollout,
  recordedWorkflowJournal,
} from './samples.js'
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
      readRetry: { pauseMs: 20, gapAfterMs: 200 },
    })
    await vi.waitFor(() => {
      expect(store.cursors.list()[0]?.line).toBe(50)
    }, settleTimeout)
    const head = store.changes.head()

    const release = await denyReading(onTestFinished, path)
    await appendLines(path, lines.slice(50))
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
      expect(gapsOf(store).filter(({ kind }) => kind === 'read_failed').map((gap) => [gap.key.gap, gap.key.subject, gap.stream, gap.closed_at === null])).toEqual([
        ['read_failed', path, streamOf('claude', lines), false],
      ])
      expect(recordsOf(store)).toHaveLength(lines.length)
    }
  })
})

describe('a rollout that the real collector reads again after it is rewritten in place', () => {
  test.for(['', '\n', '\n\r\n'])(
    'with leading whitespace %j yields the records of the new thread',
    async (prefix, { onTestFinished }) => {
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

      await writeFile(path, `${prefix}${newLines.join('\n')}\n`)
      const newStream = streamOf('codex', newLines)
      await vi.waitFor(() => {
        expect(recordsOf(store).filter((record) => record.stream === newStream)).toHaveLength(newLines.length)
      }, settleTimeout)
      await live.stop()

      expect(store.scopes.ofSession(sessionKey('codex', 't-new'))?.scope).toBe('watched')
      expect(store.cursors.list().map(({ stream, line }) => [stream, line])).toEqual([
        [newStream, newLines.length + prefix.split('\n').length - 1],
      ])
    },
  )
})

describe('metadata arriving after a transcript exceeds its holding budget', () => {
  test.for(['file', 'total', 'unnamed'] as const)(
    'still decides the scope and requests a reread when limited by %s',
    async (limit, { onTestFinished }) => {
      const workspace = await createWorkspace(onTestFinished)
      const home = await createHome(onTestFinished)
      const roots = await createLiveRoots(onTestFinished)
      const store = home.open()
      const transcript = claudeTranscript({ session: 's-full', cwd: workspace.repository })
      const lines = limit === 'unnamed' ? ['{}', '{}', ...transcript] : transcript
      const path = claudeFile(roots, 's-full.jsonl')
      const firstBytes = Buffer.byteLength(lines[0] ?? '')
      const other = claudeTranscript({ session: 's-other', cwd: workspace.repository }).slice(0, 2)
      const otherBytes = other.reduce((total, line) => total + Buffer.byteLength(line), 0)
      const engine = startEngine(store, {
        all: true,
        holding: limit === 'total' ? { totalBytes: otherBytes + firstBytes } : { fileBytes: firstBytes },
      })
      const live = runLive(onTestFinished, roots, store, engine)
      if (limit === 'total') {
        await writeLines(claudeFile(roots, 's-other.jsonl'), other)
        await vi.waitFor(() => {
          expect(live.results().at(-1)?.waiting).toBe(2)
        }, settleTimeout)
      }
      await writeLines(path, lines.slice(0, 2))
      await vi.waitFor(() => {
        expect(live.results().at(-1)).toMatchObject({ waiting: limit === 'total' ? 3 : 1, deferred: 1 })
      }, settleTimeout)
      await appendLines(path, lines.slice(2))
      const stream = streamOf('claude', transcript)
      await vi.waitFor(() => {
        expect(live.results().flatMap((result) => result.rescan)).toEqual([stream])
      }, settleTimeout)
      await live.stop()
      expect(store.scopes.ofSession(sessionKey('claude', 's-full'))?.scope).toBe('watched')
      expect(store.cursors.list()).toEqual([])
      const reread = runLive(onTestFinished, roots, store, engine)
      await vi.waitFor(() => {
        expect(store.cursors.list()[0]?.line).toBe(lines.length)
      }, settleTimeout)
      await reread.stop()
      expect(recordsOf(store)).toHaveLength(lines.length)
    },
  )
})

describe('a Claude workflow journal read by the real collector', () => {
  const journalOf = (store: Store, stream: StreamKey) => {
    const records = recordsOf(store).filter((record) => record.stream === stream)
    const seqs = new Set(records.map(({ seq }) => seq))
    return {
      lines: records.map(({ payload, parse_state }) => [payload, parse_state]),
      facts: factsOf(store)
        .filter(({ seq }) => seqs.has(seq))
        .map(({ kind, entity_key, format_verified }) => [
          kind,
          entity_key.kind === 'agent' && entity_key.agent.kind === 'subagent' ? entity_key.agent.agent_id : null,
          format_verified,
        ]),
    }
  }

  const layoutGaps = (store: Store) => gapsOf(store).filter(({ key }) => key.gap === 'unknown_stream_layout')

  test('keeps its launched, started and result lines across a restart, and the workflow agents start and end', async ({
    onTestFinished,
  }) => {
    const workspace = await createWorkspace(onTestFinished)
    const home = await createHome(onTestFinished)
    const roots = await createLiveRoots(onTestFinished)
    const store = home.open()
    const { run, appends } = recordedWorkflowJournal()
    const [launched = [], started = [], whileStopped = [], afterRestart = []] = appends
    const path = claudeFile(roots, 's-flow', 'subagents', 'workflows', run, 'journal.jsonl')
    const stream = streamOf('claude', [], path)
    const cursorLine = () => store.cursors.list().find((cursor) => cursor.path === path)?.line
    await writeLines(claudeFile(roots, 's-flow.jsonl'), claudeTranscript({ session: 's-flow', cwd: workspace.repository }))
    await writeLines(path, [...launched, ...started])

    const first = runLive(onTestFinished, roots, store, startEngine(store, { roots: [workspace.repository] }))
    await vi.waitFor(() => {
      expect(cursorLine()).toBe(launched.length + started.length)
    }, settleTimeout)
    await first.stop()
    await appendLines(path, whileStopped)
    const restarted = runLive(onTestFinished, roots, store, startEngine(store, { roots: [workspace.repository] }))
    await vi.waitFor(() => {
      expect(cursorLine()).toBe(launched.length + started.length + whileStopped.length)
    }, settleTimeout)
    await appendLines(path, afterRestart)
    await vi.waitFor(() => {
      expect(cursorLine()).toBe(appends.flat().length)
    }, settleTimeout)
    await restarted.stop()

    const reread = restarted.batches().flatMap(({ records }) =>
      records.flatMap(({ position }) => (position.kind === 'line' && position.path === path ? [position.line] : [])),
    )
    expect(reread).toEqual([4, 5, 6, 7])
    expect(store.cursors.list().find((cursor) => cursor.path === path)?.stream).toBe(stream)
    expect(store.scopes.get(stream)?.scope).toBe('watched')
    expect(journalOf(store, stream)).toEqual({
      lines: appends.flat().map((line) => [line, 'parsed']),
      facts: [
        ['agent_start', 'acc569b1b4e757f67', true],
        ['agent_start', 'a3ec0bfb65b074891', true],
        ['agent_end', 'acc569b1b4e757f67', true],
        ['agent_end', 'a3ec0bfb65b074891', true],
        ['agent_start', 'adbe167606b9275e1', true],
        ['agent_end', 'adbe167606b9275e1', true],
      ],
    })
    const [session] = store.observations.sessions()
    const subagents = Object.fromEntries(
      (session === undefined ? [] : store.observations.agents(session.id)).flatMap(({ key, description, execution }) =>
        key.agent.kind === 'subagent' ? [[key.agent.agent_id, [description, execution.state]]] : [],
      ),
    )
    expect(subagents).toMatchObject({
      acc569b1b4e757f67: ['left', 'done'],
      a3ec0bfb65b074891: ['right', 'done'],
      adbe167606b9275e1: ['report', 'done'],
    })
    expect(layoutGaps(store)).toEqual([])
  })

  test('of eight agents arrives before its main transcript, waits for the scope of its session and is taken in whole', async ({
    onTestFinished,
  }) => {
    const workspace = await createWorkspace(onTestFinished)
    const home = await createHome(onTestFinished)
    const roots = await createLiveRoots(onTestFinished)
    const store = home.open()
    const agents = Array.from({ length: 8 }, (_, index) => `a${String(index)}c0820ae7496641`)
    const lines = claudeWorkflowJournal(agents)
    const path = claudeFile(roots, 's-wide', 'subagents', 'workflows', 'wf_0b5c2a51-7f4', 'journal.jsonl')
    const stream = streamOf('claude', [], path)
    await writeLines(path, lines)

    const live = runLive(onTestFinished, roots, store, startEngine(store, { roots: [workspace.repository] }))
    await vi.waitFor(() => {
      expect(live.results().at(-1)?.waiting).toBe(lines.length)
    }, settleTimeout)
    await writeLines(claudeFile(roots, 's-wide.jsonl'), claudeTranscript({ session: 's-wide', cwd: workspace.repository }))
    await vi.waitFor(() => {
      expect(store.cursors.list().find((cursor) => cursor.path === path)?.line).toBe(lines.length)
    }, settleTimeout)
    await live.stop()

    expect(store.scopes.get(stream)?.scope).toBe('watched')
    expect(journalOf(store, stream)).toEqual({
      lines: lines.map((line) => [line, 'parsed']),
      facts: [
        ...agents.map((agent) => ['agent_start', agent, true]),
        ...agents.map((agent) => ['agent_end', agent, true]),
      ],
    })
    expect(layoutGaps(store)).toEqual([])
  })
})
