import type { ScopeDecision } from '@aang/contract'
import { describe, expect, test } from 'vitest'
import { hookBatch, joinBatches, jsonlFile } from './batches.js'
import {
  noObservationRows,
  observationRows,
  recordsOf,
  sessionKey,
  startEngine,
  streamOf,
  type WatchSettings,
} from './harness.js'
import { createHome } from './home.js'
import { claudeHook, claudeHookEnv, claudeSubagentTranscript, claudeTranscript, codexRollout } from './samples.js'
import { createWorkspace, type Workspace } from './workspace.js'

interface ScopeCase {
  readonly name: string
  readonly watch: (workspace: Workspace) => WatchSettings
  readonly cwd: (workspace: Workspace) => string
  readonly scope: ScopeDecision
}

const scopeCases: readonly ScopeCase[] = [
  {
    name: 'the watched root itself is watched',
    watch: ({ repository }) => ({ roots: [repository] }),
    cwd: ({ repository }) => repository,
    scope: 'watched',
  },
  {
    name: 'a directory inside the watched root is watched',
    watch: ({ repository }) => ({ roots: [repository] }),
    cwd: ({ nested }) => nested,
    scope: 'watched',
  },
  {
    name: 'a git worktree of the watched repository outside the root is watched',
    watch: ({ repository }) => ({ roots: [repository] }),
    cwd: ({ worktree }) => worktree,
    scope: 'watched',
  },
  {
    name: 'the repository of a watched subdirectory is watched by its common git directory',
    watch: ({ nested }) => ({ roots: [nested] }),
    cwd: ({ repository }) => repository,
    scope: 'watched',
  },
  {
    name: 'a worktree is watched when the root is a subdirectory of its repository',
    watch: ({ nested }) => ({ roots: [nested] }),
    cwd: ({ worktree }) => worktree,
    scope: 'watched',
  },
  {
    name: 'another repository is external',
    watch: ({ repository }) => ({ roots: [repository] }),
    cwd: ({ otherRepository }) => otherRepository,
    scope: 'external',
  },
  {
    name: 'a directory outside any repository is external',
    watch: ({ repository }) => ({ roots: [repository] }),
    cwd: ({ outside }) => outside,
    scope: 'external',
  },
  {
    name: 'a directory that no longer exists is external',
    watch: ({ repository }) => ({ roots: [repository] }),
    cwd: ({ missing }) => missing,
    scope: 'external',
  },
  {
    name: 'nothing is watched without roots',
    watch: () => ({}),
    cwd: ({ repository }) => repository,
    scope: 'external',
  },
  {
    name: 'every session is watched when all sessions are watched',
    watch: () => ({ all: true }),
    cwd: ({ outside }) => outside,
    scope: 'watched',
  },
]

describe('the first cwd of a root session', () => {
  test.for(scopeCases)('$name', async ({ watch, cwd, scope }, { onTestFinished }) => {
    const workspace = await createWorkspace(onTestFinished)
    const home = await createHome(onTestFinished)
    const store = home.open()
    const lines = claudeTranscript({ session: 's-case', cwd: cwd(workspace) })
    const file = jsonlFile({ runtime: 'claude', path: '/p/s-case.jsonl', lines, ino: 1n })

    await startEngine(store, watch(workspace)).ingest(file.batch(1, lines.length))

    expect(store.scopes.ofSession(sessionKey('claude', 's-case'))?.scope).toBe(scope)
    expect(store.scopes.get(streamOf('claude', lines))?.scope).toBe(scope)
    expect(recordsOf(store)).toHaveLength(scope === 'watched' ? lines.length : 0)
  })
})

describe('a session outside the watched roots', () => {
  test('leaves no observation rows, also for lines appended after a restart', async ({ onTestFinished }) => {
    const workspace = await createWorkspace(onTestFinished)
    const home = await createHome(onTestFinished)
    const store = home.open()
    const claudeLines = claudeTranscript({ session: 's-outside', cwd: workspace.outside })
    const codexLines = codexRollout({ thread: 't-outside', cwd: workspace.otherRepository })
    const claude = jsonlFile({ runtime: 'claude', path: '/p/s-outside.jsonl', lines: claudeLines, ino: 1n })
    const codex = jsonlFile({ runtime: 'codex', path: '/p/rollout-t-outside.jsonl', lines: codexLines, ino: 2n })
    const outside = { session: 's-outside', cwd: workspace.outside }
    const hooks = hookBatch(
      { file: 'h-pre.evt', payload: claudeHook('PreToolUse.Bash.json', outside), env: claudeHookEnv },
      { file: 'h-post.evt', payload: claudeHook('PostToolUse.Bash.json', outside), env: claudeHookEnv },
      { file: 'h-permission.evt', payload: claudeHook('PermissionRequest.Bash.json', outside), env: claudeHookEnv },
    )

    const first = await startEngine(store, { roots: [workspace.repository] }).ingest(
      joinBatches(hooks, claude.batch(1, 40), codex.batch(1, 20)),
    )
    store.close()
    const reopened = home.open()
    const appended = await startEngine(reopened, { roots: [workspace.repository] }).ingest(
      joinBatches(
        claude.batch(41, claudeLines.length, streamOf('claude', claudeLines)),
        codex.batch(21, codexLines.length, streamOf('codex', codexLines)),
      ),
    )

    expect(first).toEqual({ head: 0, inserted: 0, duplicates: 0, discarded: 63, waiting: 0 })
    expect(appended).toMatchObject({ head: 0, inserted: 0, discarded: claudeLines.length + codexLines.length - 60 })
    expect(observationRows(home.database())).toEqual(noObservationRows)
    expect(reopened.changes.head()).toBe(0)
    expect(reopened.scopes.ofSession(sessionKey('claude', 's-outside'))?.scope).toBe('external')
    expect(reopened.scopes.ofSession(sessionKey('codex', 't-outside'))?.scope).toBe('external')
    expect(reopened.cursors.list().map(({ path, line }) => [path, line])).toEqual([
      ['/p/rollout-t-outside.jsonl', codexLines.length],
      ['/p/s-outside.jsonl', claudeLines.length],
    ])
  })
})

interface ObserverCase {
  readonly name: string
  readonly runtime: 'claude' | 'codex'
  readonly lines: (cwd: string) => string[]
}

const observerCases: readonly ObserverCase[] = [
  {
    name: 'a Claude session with the aang-observer entrypoint',
    runtime: 'claude',
    lines: (cwd) => claudeTranscript({ session: 's-observer', cwd, entrypoint: 'aang-observer' }),
  },
  {
    name: 'a Codex session with the aang_observer originator',
    runtime: 'codex',
    lines: (cwd) => codexRollout({ thread: 's-observer', cwd, sessionMeta: { originator: 'aang_observer' } }),
  },
  {
    name: 'a Codex session with the aang-observer thread source',
    runtime: 'codex',
    lines: (cwd) => codexRollout({ thread: 's-observer', cwd, sessionMeta: { thread_source: 'aang-observer' } }),
  },
]

describe('an observer session', () => {
  test.for(observerCases)(
    '$name is discarded inside a watched root',
    async ({ runtime, lines: linesIn }, { onTestFinished }) => {
      const workspace = await createWorkspace(onTestFinished)
      const home = await createHome(onTestFinished)
      const store = home.open()
      const lines = linesIn(workspace.repository)
      const file = jsonlFile({ runtime, path: '/p/s-observer.jsonl', lines, ino: 1n })

      const result = await startEngine(store, { roots: [workspace.repository], all: true }).ingest(
        file.batch(1, lines.length),
      )

      expect(result).toMatchObject({ inserted: 0, discarded: lines.length })
      expect(observationRows(home.database())).toEqual(noObservationRows)
      expect(store.scopes.ofSession(sessionKey(runtime, 's-observer'))?.scope).toBe('observer')
    },
  )
})

describe('the scope of a root session', () => {
  test('is decided once and later cwd changes do not alter it', async ({ onTestFinished }) => {
    const workspace = await createWorkspace(onTestFinished)
    const home = await createHome(onTestFinished)
    const store = home.open()
    const engine = startEngine(store, { roots: [workspace.repository] })
    const inside = { session: 's-moved', cwd: workspace.repository }
    const lines = claudeTranscript(inside)
    const file = jsonlFile({ runtime: 'claude', path: '/p/s-moved.jsonl', lines, ino: 1n })

    await engine.ingest(
      hookBatch({
        file: 'h-first.evt',
        payload: claudeHook('PreToolUse.Bash.json', { session: 's-moved', cwd: workspace.outside }),
        env: claudeHookEnv,
      }),
    )
    const later = await engine.ingest(
      joinBatches(
        hookBatch({ file: 'h-later.evt', payload: claudeHook('PostToolUse.Bash.json', inside), env: claudeHookEnv }),
        file.batch(1, lines.length),
      ),
    )

    expect(later).toMatchObject({ inserted: 0, discarded: lines.length + 1 })
    expect(observationRows(home.database())).toEqual(noObservationRows)
    expect(store.scopes.ofSession(sessionKey('claude', 's-moved'))?.scope).toBe('external')
    expect(store.scopes.get(streamOf('claude', lines))?.scope).toBe('external')
  })

  test('is inherited by a subagent stream whose cwd lies outside the roots', async ({ onTestFinished }) => {
    const workspace = await createWorkspace(onTestFinished)
    const home = await createHome(onTestFinished)
    const store = home.open()
    const engine = startEngine(store, { roots: [workspace.repository] })
    const mainLines = claudeTranscript({ session: 's-parent', cwd: workspace.repository })
    const subagentLines = claudeSubagentTranscript({ session: 's-parent', cwd: workspace.outside })
    const main = jsonlFile({ runtime: 'claude', path: '/p/s-parent.jsonl', lines: mainLines, ino: 1n })
    const subagent = jsonlFile({
      runtime: 'claude',
      path: '/p/s-parent/subagents/agent-a.jsonl',
      lines: subagentLines,
      ino: 2n,
    })

    await engine.ingest(main.batch(1, mainLines.length))
    await engine.ingest(subagent.batch(1, subagentLines.length))

    const subagentStream = streamOf('claude', subagentLines)
    expect(subagentStream).not.toBe(streamOf('claude', mainLines))
    expect(store.scopes.get(subagentStream)?.scope).toBe('watched')
    expect(recordsOf(store).filter((record) => record.stream === subagentStream)).toHaveLength(subagentLines.length)
  })

  test('is taken from the earliest cwd seen in the batch', async ({ onTestFinished }) => {
    const workspace = await createWorkspace(onTestFinished)
    const home = await createHome(onTestFinished)
    const store = home.open()
    const engine = startEngine(store, { roots: [workspace.repository] })
    const lines = claudeTranscript({ session: 's-early', cwd: workspace.repository })
    const file = jsonlFile({ runtime: 'claude', path: '/p/s-early.jsonl', lines, ino: 1n })

    const result = await engine.ingest(
      joinBatches(
        hookBatch({
          file: 'h-late.evt',
          payload: claudeHook('PreToolUse.Bash.json', { session: 's-early', cwd: workspace.outside }),
          env: claudeHookEnv,
          arrival: 10_000_000_000_000,
        }),
        file.batch(1, lines.length),
      ),
    )

    expect(result).toMatchObject({ inserted: lines.length + 1, discarded: 0 })
    expect(store.scopes.ofSession(sessionKey('claude', 's-early'))?.scope).toBe('watched')
  })
})
