import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  ApiError,
  type CallUsage,
  ChangeSeq,
  EpochNs,
  type Fact,
  FactId,
  JsonValue,
  ObserverCallId,
  type ObserverInput,
  type ObserverOp,
  type RunId,
  type RunSnapshot,
  TempId,
  endpoints,
} from '@aang/contract'
import { objectId, runId } from '@aang/contract/ids'
import { applyObserverResponse, beginObserverCall } from '@aang/engine'
import { openStore, type Store } from '@aang/store'
import { describe, test } from 'vitest'
import type { z } from 'zod'
import { bearer, createHome, type Home, startDaemon, testVersion } from './daemon.js'
import {
  claudeHook,
  claudeSession,
  claudeTranscript,
  hookEvent,
  transcriptLines,
  waitUntil,
  watchedHome,
} from './sessions.js'

interface Api {
  readonly get: <S extends z.ZodType>(path: string, schema: S) => Promise<z.output<S>>
  readonly until: <S extends z.ZodType>(
    path: string,
    schema: S,
    accept: (value: z.output<S>) => boolean,
  ) => Promise<z.output<S>>
  readonly refused: (path: string, headers?: Record<string, string>) => Promise<{ status: number; error: ApiError }>
}

const apiOf = (base: string, home: Home): Api => {
  const request = (path: string, headers: Record<string, string>) => fetch(`${base}${path}`, { headers })
  const answer = async <S extends z.ZodType>(path: string, schema: S): Promise<z.output<S> | null> => {
    const response = await request(path, bearer(home.token))
    const body: unknown = await response.json()
    if (response.status === 404) {
      return null
    }
    if (response.status !== 200) {
      throw new Error(`GET ${path} answered ${String(response.status)}: ${JSON.stringify(body)}`)
    }
    if (response.headers.get('content-type') !== 'application/json; charset=utf-8') {
      throw new Error(`GET ${path} answered ${String(response.headers.get('content-type'))}`)
    }
    return schema.parse(body)
  }
  return {
    get: async (path, schema) => {
      const found = await answer(path, schema)
      if (found === null) {
        throw new Error(`GET ${path} was not found`)
      }
      return found
    },
    until: async (path, schema, accept) => {
      const seen: { last: z.output<typeof schema> | null } = { last: null }
      await waitUntil(async () => {
        seen.last = await answer(path, schema)
        return seen.last !== null && accept(seen.last)
      })
      if (seen.last === null) {
        throw new Error(`GET ${path} was not found`)
      }
      return seen.last
    },
    refused: async (path, headers = bearer(home.token)) => {
      const response = await request(path, headers)
      return { status: response.status, error: ApiError.parse(await response.json()) }
    },
  }
}

const runPath = (run: RunId): string => `/api/runs/${run}`

const schemaVersionOf = (path: string): number => {
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    return (database.prepare('PRAGMA user_version').get() as { readonly user_version: number }).user_version
  } finally {
    database.close()
  }
}

const lastValueOf = <T>(values: readonly T[]): T => {
  const value = values.at(-1)
  if (value === undefined) {
    throw new Error('a value is required')
  }
  return value
}

const inputOf = (store: Store, run: RunId, facts: readonly Fact[]): ObserverInput => ({
  run: { id: run, runtime: 'claude', goal: null, brief: null, sessions: [], agents: [] },
  context: null,
  model: { version: store.model.head(run), stages: [], criteria: [], attention: [] },
  batch: {
    facts: facts.map((fact) => ({
      id: fact.id,
      seq: fact.seq,
      kind: fact.kind,
      speaker: fact.speaker,
      at: new Date(Number(fact.at / 1_000_000n)).toISOString(),
      urgent: fact.urgent,
      session: objectId({ kind: 'session', runtime: fact.entity_key.runtime, session: fact.entity_key.session }),
      agent: null,
      action: null,
      payload: JsonValue.parse(
        JSON.parse(
          JSON.stringify(fact.payload, (_key, value: unknown) => (typeof value === 'bigint' ? String(value) : value)),
        ),
      ),
      truncated: [],
    })),
    collapsed: [],
    backlog: null,
    artifact_versions: [],
  },
  materials: [],
  previous_attempt: null,
})

const interpret = (home: Home, run: RunId, snapshot: RunSnapshot, call: ObserverCallId) => {
  const store = openStore({ home: home.paths.home })
  try {
    const facts = store.facts.ofRun(run, ChangeSeq.parse(0)).map(({ fact }) => fact)
    const answer = facts.find(({ kind, speaker }) => kind === 'message' && speaker === 'solver')
    if (answer === undefined) {
      throw new Error('the transcript must contain an answer of the solver')
    }
    const mainAgent = snapshot.objects.agents.find(({ role }) => role === 'main')
    if (mainAgent === undefined) {
      throw new Error('the run must have its main agent')
    }
    const stage = { kind: 'new', temp_id: TempId.parse('survey') } as const
    const grounds = { evidence: [answer.id], rationale: 'The solver surveyed the repository' }
    const ops: ObserverOp[] = [
      {
        ...grounds,
        op: 'stage.create',
        temp_id: TempId.parse('survey'),
        title: 'Survey the repository',
        expected_result: null,
        summary: null,
        parent: null,
        origin: 'inferred',
      },
      { ...grounds, op: 'actions.assign', actions: snapshot.objects.actions.map(({ id }) => id), stage },
      { ...grounds, op: 'agents.participate', agents: [mainAgent.id], stage },
      {
        ...grounds,
        op: 'criterion.add',
        temp_id: TempId.parse('mapped'),
        stage,
        text: 'The repository layout is described',
        source: 'task',
      },
    ]
    const at = lastValueOf(facts).at
    const result = store.transaction((transaction) => {
      const input = inputOf(store, run, facts)
      beginObserverCall(transaction, { id: call, backend: 'claude', crossVendor: false, input, at })
      return applyObserverResponse(transaction, {
        call,
        output: { base_version: snapshot.summary.version, ops, needs: [] },
        at,
      })
    })
    if (result.status !== 'accepted') {
      throw new Error(`the observer response must be accepted: ${JSON.stringify(result)}`)
    }
    return { answer, facts, version: result.version }
  } finally {
    store.close()
  }
}

const batchCall = ObserverCallId.parse('u1-batch')

const callUsage = (cost: number, input: number, output: number): CallUsage => ({
  model: 'claude-opus-5-5',
  tokens: {
    uncached_input_tokens: input,
    cache_read_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: null,
  },
  cost_usd: cost,
})

const batchUsage = callUsage(0.25, 100, 40)
const probeUsage = callUsage(0.0625, 10, 5)
const chatUsage = callUsage(0.125, 30, 20)

const spend = (home: Home, run: RunId): EpochNs => {
  const store = openStore({ home: home.paths.home })
  try {
    const facts = store.facts.ofRun(run, ChangeSeq.parse(0)).map(({ fact }) => fact)
    const start = lastValueOf(facts).at
    const after = (seconds: number): EpochNs => EpochNs.parse(start + BigInt(seconds) * 1_000_000_000n)
    store.transaction((transaction) => {
      const input = inputOf(store, run, facts)
      beginObserverCall(transaction, { id: batchCall, backend: 'claude', crossVendor: false, input, at: after(1) })
      applyObserverResponse(transaction, {
        call: batchCall,
        output: { base_version: input.model.version, ops: [], needs: [] },
        at: after(7),
        usage: batchUsage,
      })
      transaction.observerCalls.check({
        id: ObserverCallId.parse('u1-probe'),
        kind: 'probe',
        backend: 'claude',
        input: null,
        output: null,
        verdict: 'accepted',
        error: null,
        usage: probeUsage,
        started_at: after(8),
        finished_at: after(9),
      })
      const version = transaction.model.head(run)
      transaction.observerCalls.chat({
        id: ObserverCallId.parse('u1-chat'),
        run,
        backend: 'claude',
        base_version: version,
        previous: null,
        input: {
          question: 'What is left?',
          history: [],
          run: input.run,
          model: { ...input.model, version },
          focus: { kind: 'run', attention: [], recent_changes: [] },
          materials: [],
        },
        output: { answer: 'Nothing is left.' },
        verdict: 'accepted',
        error: null,
        usage: chatUsage,
        started_at: after(10),
        finished_at: after(14),
      })
    })
    return after(14)
  } finally {
    store.close()
  }
}

describe.concurrent('the daemon answers read queries with the DTOs of the contract', () => {
  test('a collected run is listed, snapshotted and traced from its attention item to its fact and raw record', async ({
    expect,
    onTestFinished,
  }) => {
    const { home, workspace } = await watchedHome(onTestFinished)
    const daemon = await startDaemon(home, onTestFinished)
    const api = apiOf(daemon.base, home)
    const empty = await api.get('/api/runs', endpoints.runs.response)
    expect(empty.runs).toEqual([])

    const session = 'g4-collected-run'
    const run = runId(claudeSession(session))
    await claudeTranscript(home, '-work', session, transcriptLines(session, workspace, 22))
    await hookEvent(home, claudeHook('PermissionRequest.Bash', session, workspace))

    await api.until(
      runPath(run),
      endpoints.run.response,
      ({ objects }) =>
        objects.questions.length === 1 &&
        objects.actions.length === 1 &&
        objects.sessions.every(({ support_mode: mode }) => mode === 'full'),
    )
    const listed = await api.get('/api/runs', endpoints.runs.response)
    expect(listed.runs.map(({ id }) => id)).toEqual([run])
    expect(listed.runs[0]).toMatchObject({
      runtime: 'claude',
      root_session: objectId(claudeSession(session)),
      sessions: 1,
      attention: { open: 1, waiting_for_human: 1 },
      observer: { state: { state: 'disabled', reason: 'cli_missing' }, isolation_unverified: false },
    })
    expect(listed.change_seq).toBeGreaterThan(empty.change_seq)

    const snapshot = await api.get(runPath(run), endpoints.run.response)
    expect(snapshot.run.id).toBe(run)
    expect(snapshot.summary).toEqual(listed.runs[0])
    expect(snapshot.change_seq).toBe(listed.change_seq)
    expect(snapshot.objects.sessions.map(({ id }) => id)).toEqual([objectId(claudeSession(session))])
    expect(snapshot.objects.questions.map(({ kind }) => kind)).toEqual(['permission'])
    const [item] = snapshot.attention.items
    expect(item).toMatchObject({ kind: 'permission', author: 'rule', resolution: 'open', runtime_wait: 'active' })

    const evidence = lastValueOf(item?.evidence ?? [])
    const { fact } = await api.get(`/api/facts/${evidence}`, endpoints.fact.response)
    expect(fact).toMatchObject({ id: evidence, entity_key: { session } })
    const { raw } = await api.get(`/api/raw/${String(fact.seq)}`, endpoints.raw.response)
    expect(raw).toMatchObject({ seq: fact.seq, channel: 'hook', runtime: 'claude', parse_state: 'parsed' })
    expect(raw.payload).toContain('"hook_event_name":"PermissionRequest"')

    const changes = await api.get(`${runPath(run)}/changes?version=0&seq=0`, endpoints.changes.response)
    expect(changes.from).toEqual({ version: 0, change_seq: 0 })
    expect(changes.to).toEqual({ version: snapshot.summary.version, change_seq: snapshot.change_seq })
    expect(changes.attention.opened.map(({ id }) => id)).toEqual([item?.id])
    expect(await api.get(`${runPath(run)}/observer-calls`, endpoints.observerCalls.response)).toEqual({ calls: [] })

    const ahead = await api.refused(`${runPath(run)}/changes?version=${String(snapshot.summary.version + 1)}&seq=0`)
    expect(ahead).toMatchObject({ status: 400, error: { error: { code: 'invalid_request' } } })
  })

  test('an interpreted stage is inspected, and its observer call and the changes since a view position are read', async ({
    expect,
    onTestFinished,
  }) => {
    const { home, workspace } = await watchedHome(onTestFinished)
    const session = 'g4-interpreted-stage'
    const run = runId(claudeSession(session))
    const call = ObserverCallId.parse('g4-call')
    const collecting = await startDaemon(home, onTestFinished)
    await claudeTranscript(home, '-work', session, transcriptLines(session, workspace, 32))
    const viewed = await apiOf(collecting.base, home).until(
      runPath(run),
      endpoints.run.response,
      ({ objects }) => objects.actions.length === 2 && objects.actions.every(({ ended_at: ended }) => ended !== null),
    )
    collecting.abort()
    await collecting.stopped

    const interpreted = interpret(home, run, viewed, call)

    const daemon = await startDaemon(home, onTestFinished)
    const api = apiOf(daemon.base, home)
    const snapshot = await api.get(runPath(run), endpoints.run.response)
    expect(snapshot.summary.version).toBe(interpreted.version)
    expect(snapshot.model.stages.map(({ title }) => title)).toEqual(['Survey the repository'])
    const stage = lastValueOf(snapshot.model.stages)

    const inspector = await api.get(`${runPath(run)}/stages/${stage.id}`, endpoints.stage.response)
    expect(inspector).toMatchObject({ run, stage: { id: stage.id }, change_seq: snapshot.change_seq })
    expect(inspector.actions.map(({ id }) => id).sort()).toEqual(viewed.objects.actions.map(({ id }) => id).sort())
    expect(inspector.agents.map(({ role }) => role)).toEqual(['main'])
    expect(inspector.criteria.map(({ criterion }) => criterion.text)).toEqual(['The repository layout is described'])
    expect(inspector.evidence.map(({ id }) => id)).toContain(interpreted.answer.id)
    expect(inspector.observer_calls.map(({ id, outcome }) => ({ id, outcome }))).toEqual([
      { id: call, outcome: 'accepted' },
    ])
    expect(inspector.history.length).toBeGreaterThan(0)

    const { calls } = await api.get(`${runPath(run)}/observer-calls`, endpoints.observerCalls.response)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      id: call,
      run,
      kind: 'batch',
      outcome: 'accepted',
      base_version: viewed.summary.version,
      result_version: interpreted.version,
    })
    expect(calls[0]?.facts.toSorted()).toEqual(interpreted.facts.map(({ id }) => id).toSorted())

    const since = `version=${String(viewed.summary.version)}&seq=${String(viewed.change_seq)}`
    const changes = await api.get(`${runPath(run)}/changes?${since}`, endpoints.changes.response)
    expect(changes.to).toEqual({ version: interpreted.version, change_seq: snapshot.change_seq })
    expect(changes.stages.map(({ before, after }) => ({ before, after: after.id }))).toEqual([
      { before: null, after: stage.id },
    ])
    expect(changes.criteria.map(({ after }) => after.text)).toEqual(['The repository layout is described'])

    const { fact } = await api.get(`/api/facts/${interpreted.answer.id}`, endpoints.fact.response)
    expect(fact).toEqual(interpreted.answer)
    const { raw } = await api.get(`/api/raw/${String(fact.seq)}`, endpoints.raw.response)
    expect(raw).toMatchObject({ seq: fact.seq, channel: 'transcript', runtime: 'claude' })
    expect(JSON.parse(raw.payload)).toMatchObject({ type: 'assistant', sessionId: session })
  })

  test('the usage report keeps the solver, observer and chat journals apart, without the sessions of the observer', async ({
    expect,
    onTestFinished,
  }) => {
    const { home, workspace } = await watchedHome(onTestFinished)
    const session = 'u1-usage'
    const run = runId(claudeSession(session))
    const collecting = await startDaemon(home, onTestFinished)
    const observerLines = transcriptLines('u1-observer', workspace, 32).map((line) =>
      JSON.stringify({ ...(JSON.parse(line) as object), entrypoint: 'aang-observer' }),
    )
    await claudeTranscript(home, '-work', 'u1-observer', observerLines)
    await claudeTranscript(home, '-work', session, transcriptLines(session, workspace, 32))
    const collected = await apiOf(collecting.base, home).until(
      runPath(run),
      endpoints.run.response,
      ({ objects }) => objects.actions.length === 2 && objects.actions.every(({ ended_at: ended }) => ended !== null),
    )
    collecting.abort()
    await collecting.stopped
    const spentAt = spend(home, run)

    const daemon = await startDaemon(home, onTestFinished)
    const api = apiOf(daemon.base, home)
    const ofRun = await api.get(`/api/admin/usage?run=${run}`, endpoints.usage.response)
    const all = await api.get('/api/admin/usage', endpoints.usage.response)
    const later = await api.get(`/api/admin/usage?from=${String(spentAt + 60_000_000_000n)}`, endpoints.usage.response)

    const records = collected.objects.usage_records.filter(({ inherited, synthetic }) => !inherited && !synthetic)
    const solverTokens = (field: 'uncached_input_tokens' | 'cache_read_input_tokens' | 'output_tokens') =>
      records.reduce((sum, { tokens }) => sum + tokens[field], 0)
    expect(records.length).toBeGreaterThan(0)
    expect(ofRun.runs.map(({ run: reported }) => reported)).toEqual([run])
    const [usage] = ofRun.runs
    expect(usage?.solver.totals).toMatchObject({
      records: records.length,
      tokens: {
        uncached_input_tokens: solverTokens('uncached_input_tokens'),
        cache_read_input_tokens: solverTokens('cache_read_input_tokens'),
        output_tokens: solverTokens('output_tokens'),
      },
      cost_usd: null,
    })
    expect(usage?.solver.sessions.map(({ session: id }) => id)).toEqual([objectId(claudeSession(session))])
    expect(usage?.observer).toMatchObject({
      calls: 1,
      totals: { tokens: batchUsage.tokens, records: 1, cost_usd: batchUsage.cost_usd },
      latency_ms: { p50: 6_000, p95: 6_000, max: 6_000 },
    })
    expect(usage?.observer.lag_ms?.p50).toBe(usage?.observer.lag_ms?.max)
    expect(usage?.chat).toEqual({
      calls: 1,
      totals: { tokens: chatUsage.tokens, records: 1, output_lower_bound: false, cost_usd: chatUsage.cost_usd },
      latency_ms: { p50: 4_000, p95: 4_000, max: 4_000 },
    })
    expect(usage?.active_hours).toBeGreaterThan(0)
    expect(ofRun).toMatchObject({ probes: null, totals: { observer: usage?.observer.totals, chat: usage?.chat.totals } })
    expect(ofRun.per_active_hour?.solver.records).toBe(records.length / ofRun.active_hours)

    expect(all.runs.map(({ run: reported }) => reported)).toEqual([run])
    expect(all.probes).toMatchObject({ calls: 1, totals: { tokens: probeUsage.tokens, records: 1 } })
    expect(all.totals.observer).toMatchObject({
      records: 2,
      tokens: { uncached_input_tokens: 110, output_tokens: 45 },
      cost_usd: 0.3125,
    })
    expect(later).toMatchObject({ runs: [], active_hours: 0, per_active_hour: null })

    const { calls } = await api.get(`${runPath(run)}/observer-calls`, endpoints.observerCalls.response)
    expect(calls.map(({ id, usage: spent }) => ({ id, spent }))).toEqual([{ id: batchCall, spent: batchUsage }])
  })

  test('the status shows the daemon, the database, the runtimes, the watched roots, the sessions and the spool', async ({
    expect,
    onTestFinished,
  }) => {
    const { home, workspace } = await watchedHome(onTestFinished)
    const launched = BigInt(Date.now()) * 1_000_000n
    const daemon = await startDaemon(home, onTestFinished)
    const api = apiOf(daemon.base, home)

    const initial = await api.get('/api/status', endpoints.status.response)
    expect(initial.daemon).toMatchObject({
      version: testVersion,
      pid: process.pid,
      api: daemon.ready.api,
      otel: daemon.ready.otel,
    })
    expect(initial.daemon.started_at).toBeGreaterThanOrEqual(launched)
    expect(initial.daemon.started_at).toBeLessThanOrEqual(BigInt(Date.now()) * 1_000_000n)
    expect(initial.database).toMatchObject({
      path: join(home.paths.home, 'aang.db'),
      schema_version: schemaVersionOf(join(home.paths.home, 'aang.db')),
    })
    expect(initial.database.size_bytes).toBeGreaterThan(0)
    expect(initial.runtimes).toEqual([
      {
        runtime: 'claude',
        root: join(home.root, '.claude'),
        root_exists: false,
        hooks: 'unknown',
        hooks_inactive_sessions: [],
        double_registration_sessions: [],
      },
      {
        runtime: 'codex',
        root: join(home.root, '.codex'),
        root_exists: false,
        hooks: 'unknown',
        hooks_inactive_sessions: [],
        double_registration_sessions: [],
      },
    ])
    expect(initial.watch).toEqual({ all: false, lookback_days: 7, roots: [workspace] })
    expect(initial.spool).toMatchObject({
      files: 0,
      bytes: 0,
      stopped: false,
      threshold_bytes: 1024 ** 3,
      over_threshold: false,
      growth_since_threshold_bytes: null,
    })
    expect(initial.spool.lease_expires_at).toBeGreaterThan(initial.daemon.started_at)
    expect(initial).toMatchObject({
      observer: { cross_vendor: false },
      versions: [],
      unknown_records: 0,
      gaps: [],
      not_observable: ['claude_cowork', 'claude_cloud', 'codex_cloud', 'work_cloud'],
    })

    const admitted = await api.until('/api/status', endpoints.status.response, ({ observer }) =>
      observer.backends.every(({ state }) => state.state === 'disabled' && state.reason === 'cli_missing'),
    )
    expect(admitted.observer.backends).toEqual(
      (['claude', 'codex'] as const).map((vendor) => ({
        vendor,
        state: { state: 'disabled', reason: 'cli_missing' },
        cli_path: null,
        cli_version: null,
        model: vendor === 'claude' ? 'claude-opus-5-5' : 'gpt-6.1-sol',
        effort: null,
        admission: null,
      })),
    )

    const session = 'g4-status'
    const unrecognized = JSON.stringify({ type: 'g4-future-record', sessionId: session, cwd: workspace })
    const transcript = await claudeTranscript(home, '-work', session, [
      ...transcriptLines(session, workspace, 32),
      unrecognized,
    ])
    const run = runId(claudeSession(session))
    const snapshot = await api.until(
      runPath(run),
      endpoints.run.response,
      ({ objects }) => objects.actions.length === 2 && objects.sessions.some(({ unknown_records: unknown }) => unknown > 0),
    )
    const status = await api.get('/api/status', endpoints.status.response)
    expect(status.runtimes.map(({ runtime, root_exists: exists }) => ({ runtime, exists }))).toEqual([
      { runtime: 'claude', exists: true },
      { runtime: 'codex', exists: false },
    ])
    expect(snapshot.objects.sessions.map(({ freshness }) => freshness)).toEqual(['hooks_inactive'])
    expect(status.runtimes[0]?.hooks_inactive_sessions).toEqual([objectId(claudeSession(session))])
    expect(status.runtimes[0]?.double_registration_sessions).toEqual([])
    expect(status.unknown_records).toBe(snapshot.objects.sessions[0]?.unknown_records)
    expect(status.unknown_records).toBe(1)
    expect(status.database.change_seq).toBeGreaterThanOrEqual(snapshot.change_seq)

    await unlink(transcript)
    const lost = await api.until(runPath(run), endpoints.run.response, ({ objects }) =>
      objects.sessions.every(({ freshness }) => freshness === 'lost'),
    )
    expect(lost.objects.sessions.map(({ support_mode: mode }) => mode)).toEqual(['files_only'])
    const whileLost = await api.get('/api/status', endpoints.status.response)
    expect(whileLost.runtimes[0]?.hooks_inactive_sessions).toEqual([objectId(claudeSession(session))])

    await hookEvent(home, claudeHook('UserPromptSubmit', session, workspace))
    await api.until(runPath(run), endpoints.run.response, ({ objects }) =>
      objects.sessions.every(({ support_mode: mode }) => mode === 'full'),
    )
    const hooked = await api.get('/api/status', endpoints.status.response)
    expect(hooked.runtimes[0]?.hooks_inactive_sessions).toEqual([])
  })

  test('the status shows the spool over its threshold with the growth since and the gap of the queue', async ({
    expect,
    onTestFinished,
  }) => {
    const home = await createHome(onTestFinished, { spool: { thresholdBytes: 1_000, checkIntervalMs: 50 } })
    const daemon = await startDaemon(home, onTestFinished)
    const api = apiOf(daemon.base, home)
    await mkdir(home.paths.spoolReady, { recursive: true })
    const first = join(home.paths.spoolReady, 'first.evt')
    await writeFile(first, 'x'.repeat(1_500))

    const over = await api.until('/api/status', endpoints.status.response, ({ spool }) => spool.over_threshold)
    expect(over.spool).toMatchObject({ files: 1, bytes: 1_500, lease_expires_at: null, growth_since_threshold_bytes: 0 })
    expect(over.gaps.map(({ kind }) => kind)).toContain('spool_over_threshold')
    const attributed = over.gaps.filter(({ run, session }) => run !== null || session !== null)
    expect(attributed).toEqual([])
    expect(over.gaps.map(({ closed_at: closed }) => closed).filter((closed) => closed !== null)).toEqual([])

    const second = join(home.paths.spoolReady, 'second.evt')
    await writeFile(second, 'x'.repeat(300))
    const grown = await api.until('/api/status', endpoints.status.response, ({ spool }) => spool.files === 2)
    expect(grown.spool).toMatchObject({ bytes: 1_800, over_threshold: true, growth_since_threshold_bytes: 300 })

    await unlink(first)
    await unlink(second)
    const drained = await api.until(
      '/api/status',
      endpoints.status.response,
      ({ spool }) => !spool.over_threshold && spool.lease_expires_at !== null,
    )
    expect(drained.spool).toMatchObject({ files: 0, bytes: 0, growth_since_threshold_bytes: null })
    expect(drained.gaps.map(({ kind }) => kind)).not.toContain('spool_over_threshold')
  })

  test('read requests are refused without the token, and unknown and malformed resources are told apart', async ({
    expect,
    onTestFinished,
  }) => {
    const home = await createHome(onTestFinished)
    const daemon = await startDaemon(home, onTestFinished)
    const api = apiOf(daemon.base, home)
    const run = runId(claudeSession('g4-unknown'))
    const fact = FactId.parse('0'.repeat(32))
    const paths = [
      '/api/status',
      '/api/runs',
      runPath(run),
      `${runPath(run)}/stages/stage-1`,
      `${runPath(run)}/changes?version=0&seq=0`,
      `${runPath(run)}/observer-calls`,
      `/api/facts/${fact}`,
      '/api/raw/1',
    ]
    const usage = `/api/admin/usage?run=${run}`

    for (const path of [...paths, usage]) {
      for (const headers of [{}, bearer('not-the-ui-token')]) {
        expect(await api.refused(path, headers)).toMatchObject({ status: 401, error: { error: { code: 'unauthorized' } } })
      }
    }

    for (const path of paths.slice(2)) {
      expect(await api.refused(path)).toEqual({
        status: 404,
        error: { error: { code: 'not_found', message: `${path.split('?')[0] ?? ''} was not found` } },
      })
    }
    expect(await api.refused(usage)).toEqual({ status: 404, error: { error: { code: 'not_found', message: `no run ${run}` } } })

    for (const path of [
      '/api/runs/not-a-run',
      `${runPath(run)}/changes`,
      `${runPath(run)}/changes?version=0`,
      `${runPath(run)}/changes?version=0&seq=-1`,
      `${runPath(run)}/changes?version=0&seq=0&seq=1`,
      `${runPath(run)}/changes?version=0&seq=0&limit=5`,
      `/api/facts/${fact}0`,
      '/api/raw/0',
      '/api/raw/one',
      '/api/runs/%E0%A4%A',
      '/api/admin/usage?run=not-a-run',
      '/api/admin/usage?from=yesterday',
      '/api/admin/usage?from=5&to=5',
    ]) {
      expect(await api.refused(path)).toMatchObject({ status: 400, error: { error: { code: 'invalid_request' } } })
    }

    for (const path of ['/api/runs/', '/api/run', `${runPath(run)}/stages`, '/api']) {
      expect(await api.refused(path)).toMatchObject({ status: 404, error: { error: { code: 'not_found' } } })
    }
    const posted = await fetch(`${daemon.base}/api/runs`, { method: 'POST', headers: bearer(home.token) })
    expect(posted.status).toBe(404)
    expect(ApiError.parse(await posted.json()).error.message).toBe('no route for POST /api/runs')
  })
})
