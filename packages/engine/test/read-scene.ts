import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type ArtifactVersion,
  CheckContract,
  type CollectorBatch,
  type Fact,
  type JsonValue,
  ObserverCallId,
  type ObserverOp,
  type RunId,
  type RunSnapshot,
  SseEvent,
} from '@aang/contract'
import { objectId, runId } from '@aang/contract/ids'
import {
  applyObserverResponse,
  beginObserverCall,
  createEngine,
  createReadQueries,
  type ObserverResponseResult,
  type ReadQueries,
} from '@aang/engine'
import type { Store } from '@aang/store'
import { applyFeed } from '@aang/testkit'
import { expect, type TestContext } from 'vitest'
import { type HookDelivery, hookBatch, jsonlFile, snapshotBatch } from './batches.js'
import { adapters, factsOf, sessionKey } from './harness.js'
import { createHome, type Home } from './home.js'
import { at } from './model.js'
import { inputFor, response } from './observer-fixtures.js'
import { claudeHook } from './samples.js'

export interface Source {
  readonly session: string
  readonly cwd: string
}

export interface ObserverCallOptions {
  readonly at: number
  readonly base?: number
}

export interface Scene {
  readonly home: Home
  readonly store: Store
  readonly reads: ReadQueries
  readonly project: string
  readonly projects: string
  readonly ingest: (batch: CollectorBatch) => Promise<void>
  readonly source: (session: string) => Source
  readonly runOf: (session: string) => RunId
  readonly transcript: (source: Source, lines: readonly string[]) => Promise<void>
  readonly hooks: (...deliveries: readonly HookDelivery[]) => Promise<void>
  readonly retainBases: () => Promise<readonly ArtifactVersion[]>
  readonly teammateMeta: (source: Source, agent: string, name: string, team: string) => Promise<void>
  readonly factsOf: (source: Source, kind?: Fact['kind']) => Fact[]
  readonly retain: () => Promise<readonly ArtifactVersion[]>
  readonly begin: (run: RunId, id: string, facts: readonly Fact[], at: number) => ObserverCallId
  readonly answer: (
    call: ObserverCallId,
    ops: readonly ObserverOp[],
    options: ObserverCallOptions,
  ) => ObserverResponseResult
  readonly observe: (
    run: RunId,
    id: string,
    facts: readonly Fact[],
    ops: readonly ObserverOp[],
    options: ObserverCallOptions,
  ) => ObserverResponseResult
}

const testContract = CheckContract.parse({ name: 'test', command: '^pnpm test' })

export const openScene = async (register: TestContext['onTestFinished']): Promise<Scene> => {
  const home = await createHome(register)
  const project = join(home.path, '..', 'project')
  await mkdir(project, { recursive: true })
  const store = home.open()
  const engine = createEngine({
    store,
    adapters,
    watch: { all: true, roots: [{ path: project, contracts: [testContract] }] },
  })
  const reads = createReadQueries({ store, observer: () => ({ state: { state: 'ok' }, isolation_unverified: false }) })
  const projects = join(home.path, 'projects')
  const files = new Map<string, { readonly ino: bigint; readonly lines: string[] }>()
  const begin = (run: RunId, id: string, facts: readonly Fact[], start: number): ObserverCallId => {
    const call = ObserverCallId.parse(id)
    const input = inputFor(store, [...facts], run)
    store.transaction((transaction) => {
      beginObserverCall(transaction, { id: call, backend: 'claude', crossVendor: false, input, at: at(start) })
    })
    return call
  }
  const answer = (call: ObserverCallId, ops: readonly ObserverOp[], options: ObserverCallOptions) => {
    const base = options.base ?? store.observerCalls.get(call)?.base_version ?? 0
    return store.transaction((transaction) =>
      applyObserverResponse(transaction, { call, output: response([...ops], base), at: at(options.at) }),
    )
  }
  return {
    home,
    store,
    reads,
    project,
    projects,
    ingest: async (batch) => {
      await engine.ingest(batch)
    },
    source: (session) => ({ session, cwd: project }),
    runOf: (session) => runId(sessionKey('claude', session)),
    transcript: async ({ session }, lines) => {
      const known = files.get(session) ?? { ino: BigInt(files.size + 1), lines: [] }
      const all = [...known.lines, ...lines]
      files.set(session, { ino: known.ino, lines: all })
      const file = jsonlFile({
        runtime: 'claude',
        path: join(projects, `${session}.jsonl`),
        lines: all,
        ino: known.ino,
      })
      await engine.ingest(file.batch(known.lines.length + 1, all.length))
    },
    hooks: async (...deliveries) => {
      await engine.ingest(hookBatch(...deliveries))
    },
    retainBases: () => engine.retainBases(),
    teammateMeta: async ({ session }, agent, name, team) => {
      await engine.ingest(
        snapshotBatch({
          path: join(projects, session, 'subagents', `agent-${agent}.meta.json`),
          content: { agentType: 'researcher', name, teamName: team, taskKind: 'in_process_teammate' },
        }),
      )
    },
    factsOf: ({ session }, kind) =>
      factsOf(store).filter(
        (fact) => fact.entity_key.session === session && (kind === undefined || fact.kind === kind),
      ),
    retain: () => engine.retainBases(),
    begin,
    answer,
    observe: (run, id, facts, ops, options) => answer(begin(run, id, facts, options.at - 1), ops, options),
  }
}

export const hook = (
  source: Source,
  file: string,
  name: string,
  changes: Record<string, JsonValue> = {},
): HookDelivery => ({
  file,
  payload: claudeHook(name, source, changes),
})

const line = (source: Source, record: Record<string, JsonValue>): string =>
  JSON.stringify({ sessionId: source.session, cwd: source.cwd, ...record })

export const toolUse = (
  source: Source,
  call: string,
  timestamp: string,
  tool: string,
  input: Record<string, JsonValue>,
): string =>
  line(source, {
    type: 'assistant',
    uuid: `${call}-use`,
    timestamp,
    message: { id: `${call}-message`, role: 'assistant', content: [{ type: 'tool_use', id: call, name: tool, input }] },
  })

export const toolResult = (source: Source, call: string, timestamp: string, content: string, error = false): string =>
  line(source, {
    type: 'user',
    uuid: `${call}-result`,
    timestamp,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: call, content, is_error: error }] },
  })

export const testRun = (source: Source, call: string, timestamp: string, ended: string, passed: boolean): string[] => [
  toolUse(source, call, timestamp, 'Bash', { command: 'pnpm test', description: 'Run the tests' }),
  toolResult(source, call, ended, passed ? 'tests passed' : 'Exit code 1\ntests failed', !passed),
]

export const actionOf = (source: Source, call: string) =>
  objectId({ kind: 'action', runtime: 'claude', session: source.session, call })

export const mainAgentOf = (source: Source) =>
  objectId({ kind: 'agent', runtime: 'claude', session: source.session, agent: { kind: 'main' } })

export const expectFeedReproduces = (reads: ReadQueries, run: RunId, previous: RunSnapshot): RunSnapshot => {
  const feed = reads.feed(run, previous.change_seq)
  const next = reads.snapshot(run)
  if (feed === null || next === null) {
    throw new Error(`run ${run} must exist`)
  }
  const ids = feed.events.map(({ id }) => id)
  expect(feed.position).toBe(next.change_seq)
  expect(new Set(ids).size).toBe(ids.length)
  expect(ids).toEqual(ids.toSorted((left, right) => left - right))
  expect(ids.every((id) => id > previous.change_seq && id <= feed.position)).toBe(true)
  for (const event of feed.events) {
    expect(SseEvent.safeParse(event).error).toBeUndefined()
  }
  expect(SseEvent.safeParse({ event: 'run', id: feed.position, data: feed.run }).error).toBeUndefined()
  expect(applyFeed(previous, feed)).toEqual(next)
  expect(reads.feed(run, next.change_seq)?.events).toEqual([])
  return next
}
