import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type AgentId,
  type AttentionItemId,
  type CriterionId,
  type Fact,
  type FactId,
  type JsonValue,
  ObserverCallId,
  type ObserverInput,
  type ObserverNeed,
  type RunContext,
  type RunId,
  type SessionId,
  type StageId,
} from '@aang/contract'
import { objectId, runId } from '@aang/contract/ids'
import {
  applyObserverResponse,
  beginObserverFollowUp,
  type BatchLimits,
  factSession,
  observerInputTokens,
  recordRunContext,
  startObserverBatch,
} from '@aang/engine'
import type { Store } from '@aang/store'
import { assert, expect, onTestFinished, test } from 'vitest'
import { hookBatch } from './batches.js'
import { factsOf, gapsOf, recordsOf, sessionKey, startEngine } from './harness.js'
import { createHome } from './home.js'
import { at } from './model.js'
import { claudeHook } from './samples.js'

type JsonObject = { readonly [key: string]: JsonValue }

const generous: BatchLimits = { facts: 100, bytes: 10_000_000, textLength: 4_000, inputTokens: 1_000_000 }

const subagent = { agent_id: 'a0885622b68c3d0f1', agent_type: 'echoer' }

const longText = (label: string, length: number): string => `${label} `.repeat(length).slice(0, length)

const setup = async () => {
  const home = await createHome(onTestFinished)
  const store = home.open()
  const engine = startEngine(store, { all: true })
  let delivered = 0
  const session = (name: string, cwd = '/watched') => {
    const hook = (event: string, changes: JsonObject = {}): string =>
      claudeHook(event, { session: name, cwd }, changes)
    const tool = (call: string, tool: string, input: JsonValue, response: JsonValue, agent: JsonObject = {}): string[] => [
      hook('PreToolUse.Bash.json', { tool_name: tool, tool_input: input, tool_use_id: call, ...agent }),
      hook('PostToolUse.Bash.json', { tool_name: tool, tool_input: input, tool_response: response, tool_use_id: call, ...agent }),
    ]
    const read = (call: string, agent: JsonObject = {}) =>
      tool(call, 'Read', { file_path: `/watched/${call}.ts` }, { type: 'text', file: { filePath: `/watched/${call}.ts`, content: 'export {}' } }, agent)
    const grep = (call: string) => tool(call, 'Grep', { pattern: call }, { mode: 'files_with_matches', filenames: [`/watched/${call}.ts`] })
    const bash = (call: string, stdout = 'done') =>
      tool(call, 'Bash', { command: `run ${call}`, description: call }, { stdout, stderr: '', interrupted: false, isImage: false })
    const deliver = async (payloads: readonly string[]): Promise<void> => {
      await engine.ingest(
        hookBatch(
          ...payloads.map((payload) => {
            delivered += 1
            return { file: `${String(delivered).padStart(6, '0')}.evt`, payload, arrival: delivered }
          }),
        ),
      )
    }
    return {
      run: runId(sessionKey('claude', name)),
      hook,
      read,
      grep,
      bash,
      deliver,
      start: () => deliver([hook('SessionStart.startup.json'), hook('UserPromptSubmit.json', { prompt: `Task of ${name}` })]),
    }
  }
  return { home, store, session }
}

const begin = (
  store: Store,
  run: RunId,
  id: string,
  limits: BatchLimits = generous,
  context: RunContext | null = null,
): ObserverInput | null =>
  store.transaction((transaction) =>
    startObserverBatch(transaction, {
      run,
      backend: 'claude',
      crossVendor: false,
      id: ObserverCallId.parse(id),
      at: at(10),
      limits,
      context,
    }),
  )

const answer = (
  store: Store,
  id: string,
  input: ObserverInput,
  ops: readonly object[] = [],
  needs: readonly ObserverNeed[] = [],
  second = 11,
) =>
  store.transaction((transaction) =>
    applyObserverResponse(transaction, {
      call: ObserverCallId.parse(id),
      output: { base_version: input.model.version, ops, needs },
      at: at(second),
    }),
  )

const factsOfCall = (store: Store, call: string): FactId[] =>
  factsOf(store)
    .filter(({ entity_key: key }) => key.kind === 'action' && key.call === call)
    .map(({ id }) => id)

const missingIds = (store: Store, run: RunId, input: ObserverInput): string[] => {
  const missing: string[] = []
  const inRun = (session: SessionId | undefined): boolean =>
    session !== undefined && store.observations.getSession(session)?.run === run
  const check = (label: string, present: boolean): void => {
    if (!present) {
      missing.push(label)
    }
  }
  const fact = (id: FactId): Fact | null => {
    const stored = store.facts.get(id)
    check(`fact ${id}`, stored !== null && inRun(factSession(stored)))
    return stored
  }
  const agent = (id: AgentId | null): void => {
    if (id !== null) {
      check(`agent ${id}`, inRun(store.observations.getAgent(id)?.session))
    }
  }
  const stage = (id: StageId | null): void => {
    if (id !== null) {
      check(`stage ${id}`, store.model.entity(run, { kind: 'stage', id }) !== null)
    }
  }
  const criterion = (id: CriterionId): void => {
    check(`criterion ${id}`, store.model.entity(run, { kind: 'criterion', id }) !== null)
  }
  const attention = (id: AttentionItemId): void => {
    check(`attention item ${id}`, store.model.entity(run, { kind: 'attention_item', id }) !== null)
  }
  check(`run ${input.run.id}`, input.run.id === run)
  for (const session of input.run.sessions) {
    check(`session ${session.id}`, inRun(session.id))
  }
  for (const value of input.run.agents) {
    agent(value.id)
    agent(value.parent)
    check(`session ${value.session}`, inRun(value.session))
  }
  if (input.context !== null) {
    check(`context ${String(input.context.seq)}`, store.rawRecords.get(input.context.seq)?.channel === 'context')
  }
  for (const value of input.model.stages) {
    stage(value.id)
    stage(value.parent)
  }
  for (const value of input.model.criteria) {
    criterion(value.id)
    stage(value.stage)
  }
  for (const value of input.model.attention) {
    attention(value.id)
    stage(value.stage)
  }
  for (const value of input.batch.facts) {
    check(`fact seq ${String(value.seq)}`, fact(value.id)?.seq === value.seq)
    check(`session ${value.session}`, inRun(value.session))
    agent(value.agent)
    if (value.action !== null) {
      check(`action ${value.action}`, inRun(store.observations.getAction(value.action)?.session))
    }
  }
  for (const counter of input.batch.collapsed) {
    counter.facts.forEach(fact)
    agent(counter.agent)
  }
  return missing
}

const pending = (store: Store, run: RunId): FactId[] => store.interpretations.pending(run).map(({ fact }) => fact)

test('series of routine reads and searches of one agent fold into counters that the observer can cite', async () => {
  const { store, session } = await setup()
  const solver = session('collapse')
  await solver.start()
  await solver.deliver([
    ...[0, 1, 2].flatMap((index) => {
      const [main = '', mainEnd = ''] = solver.read(`main-read-${String(index)}`)
      const [sub = '', subEnd = ''] = solver.read(`sub-read-${String(index)}`, subagent)
      return [main, sub, mainEnd, subEnd]
    }),
    ...solver.bash('build'),
    ...solver.read('late-read-0'),
    ...solver.read('late-read-1'),
    ...solver.grep('grep-0'),
    ...solver.grep('grep-1'),
    solver.hook('PreToolUse.Bash.json', { tool_name: 'Grep', tool_input: { pattern: 'grep-2' }, tool_use_id: 'grep-2' }),
    solver.hook('PostToolUseFailure.Bash.json', { tool_name: 'Grep', tool_use_id: 'grep-2', error: 'ripgrep failed' }),
  ])

  const input = begin(store, solver.run, 'collapse-call')
  assert(input !== null)
  const calls = (prefix: string, count: number) =>
    Array.from({ length: count }, (_, index) => factsOfCall(store, `${prefix}-${String(index)}`)).flat()
  const failedGrep = factsOfCall(store, 'grep-2')
  expect(input.batch.collapsed.map(({ tool, action_kind: kind, facts }) => [tool, kind, facts])).toEqual([
    ['Read', 'file_read', calls('main-read', 3)],
    ['Read', 'file_read', calls('sub-read', 3)],
    ['Grep', 'search', [...calls('grep', 2), failedGrep[0]]],
  ])
  const [main, sub] = input.batch.collapsed
  expect(main?.agent).not.toBe(sub?.agent)
  expect(input.batch.collapsed.every(({ from, to }) => from <= to)).toBe(true)
  const folded = new Set(input.batch.collapsed.flatMap(({ facts }) => facts))
  expect(input.batch.facts.filter(({ id }) => folded.has(id))).toEqual([])
  const individual = input.batch.facts.map(({ id }) => id)
  for (const id of [...factsOfCall(store, 'build'), ...calls('late-read', 2), failedGrep[1]]) {
    expect(individual).toContain(id)
  }
  expect(input.batch.facts.map(({ kind }) => kind)).toContain('session_start')
  expect(missingIds(store, solver.run, input)).toEqual([])

  const cited = calls('main-read', 3)[3]
  assert(cited !== undefined)
  expect(
    answer(store, 'collapse-call', input, [
      {
        op: 'stage.create',
        temp_id: 'explore',
        title: 'Explore the code',
        expected_result: null,
        summary: null,
        parent: null,
        origin: 'inferred',
        evidence: [cited],
        rationale: 'Reads',
      },
    ]),
  ).toMatchObject({ status: 'accepted' })
  expect(new Set(store.interpretations.ofRun(solver.run).map(({ status }) => status))).toEqual(new Set(['interpreted']))
})

test('the input stays within its token limit: texts are cut first, and later facts wait for the next batch', async () => {
  const { store, session } = await setup()
  const output = longText('output', 6_000)
  const roomy = session('roomy')
  const tight = session('tight')
  for (const solver of [roomy, tight]) {
    await solver.start()
    await solver.deliver(Array.from({ length: 10 }, (_, index) => solver.bash(`${solver.run}-${String(index)}`, output)).flat())
  }

  const all = pending(store, roomy.run)
  const whole = begin(store, roomy.run, 'roomy-call', { ...generous, inputTokens: 12_000 })
  assert(whole !== null)
  expect(observerInputTokens(whole)).toBeLessThanOrEqual(12_000)
  expect(whole.batch.facts.map(({ id }) => id)).toEqual(all)
  expect(pending(store, roomy.run)).toEqual([])
  const ends = whole.batch.facts.filter(({ kind }) => kind === 'action_end')
  expect(ends).toHaveLength(10)
  for (const end of ends) {
    expect(end.truncated).toEqual(
      expect.arrayContaining([
        { path: 'payload.output', length: 6_000 },
        { path: 'payload.result.stdout', length: 6_000 },
      ]),
    )
    const text = end.payload !== null && typeof end.payload === 'object' && !Array.isArray(end.payload) ? end.payload['output'] : null
    expect(typeof text === 'string' && text.length >= 256 && text.length < 4_000).toBe(true)
  }
  expect(missingIds(store, roomy.run, whole)).toEqual([])

  const queue = pending(store, tight.run)
  const narrow = { ...generous, inputTokens: 2_000 }
  const first = begin(store, tight.run, 'tight-first', narrow)
  assert(first !== null)
  expect(observerInputTokens(first)).toBeLessThanOrEqual(2_000)
  const sent = first.batch.facts.map(({ id }) => id)
  expect(sent.length).toBeGreaterThan(0)
  expect(sent.length).toBeLessThan(queue.length)
  expect(sent).toEqual(queue.slice(0, sent.length))
  expect(pending(store, tight.run)).toEqual(queue.slice(sent.length))
  expect(missingIds(store, tight.run, first)).toEqual([])
  expect(answer(store, 'tight-first', first)).toMatchObject({ status: 'accepted' })

  const second = begin(store, tight.run, 'tight-second', narrow)
  assert(second !== null)
  expect(observerInputTokens(second)).toBeLessThanOrEqual(2_000)
  expect(second.batch.facts[0]?.id).toBe(queue[sent.length])
})

test('a snapshot over the limit is shortened after the batch texts, and an input that cannot fit leaves its facts not interpreted', async () => {
  const { store, session } = await setup()
  const solver = session('snapshot')
  await solver.start()
  const opening = begin(store, solver.run, 'snapshot-first')
  assert(opening !== null)
  const evidence = [opening.batch.facts[0]?.id]
  expect(
    answer(
      store,
      'snapshot-first',
      opening,
      Array.from({ length: 8 }, (_, index) => ({
        op: 'stage.create',
        temp_id: `stage-${String(index)}`,
        title: `Stage ${String(index)}`,
        expected_result: longText('result', 2_000),
        summary: longText('summary', 16_000),
        parent: null,
        origin: 'inferred',
        evidence,
        rationale: 'Long summaries',
      })),
    ),
  ).toMatchObject({ status: 'accepted' })
  await solver.deliver([...solver.bash('after-0'), ...solver.bash('after-1')])
  const queue = pending(store, solver.run)
  const stages = store.model.entities(solver.run).flatMap((entity) => (entity.kind === 'stage' ? [entity.value.id] : []))

  const input = begin(store, solver.run, 'snapshot-second', { ...generous, inputTokens: 12_000 })
  assert(input !== null)
  expect(observerInputTokens(input)).toBeLessThanOrEqual(12_000)
  expect(input.batch.facts.map(({ id }) => id)).toEqual(queue)
  expect(input.model.stages.map(({ id }) => id).toSorted()).toEqual(stages.toSorted())
  for (const stage of input.model.stages) {
    expect(stage.summary?.endsWith('…')).toBe(true)
    expect(stage.summary?.length).toBeLessThan(16_000)
    expect(stage.summary?.length).toBeGreaterThan(64)
  }
  expect(missingIds(store, solver.run, input)).toEqual([])
  expect(answer(store, 'snapshot-second', input)).toMatchObject({ status: 'accepted' })

  await solver.deliver(solver.bash('unfit'))
  const unfit = pending(store, solver.run)
  expect(begin(store, solver.run, 'snapshot-third', { ...generous, inputTokens: 100 })).toBeNull()
  expect(store.observerCalls.get(ObserverCallId.parse('snapshot-third'))).toBeNull()
  expect(
    store.interpretations
      .ofRun(solver.run)
      .filter(({ fact }) => unfit.includes(fact))
      .map(({ status }) => status),
  ).toEqual(unfit.map(() => 'not_interpreted'))
  const gaps = gapsOf(store).filter(({ run, key }) => run === solver.run && key.gap === 'not_interpreted')
  expect(gaps).toHaveLength(1)
  expect(gaps[0]?.details).toContain('exceeds 100 tokens')
  expect(gaps[0]?.closed_at).toBeNull()
})

test('the run context enters the input in scope and is cut with the batch texts', async () => {
  const { home, store, session } = await setup()
  await writeFile(join(home.path, 'CLAUDE.md'), longText('Project rule', 3_000))
  const solver = session('context', home.path)
  const other = session('context-other', home.path)
  for (const value of [solver, other]) {
    await value.start()
    await value.deliver(value.bash(`${value.run}-step`, longText('step', 3_000)))
  }
  const context = await recordRunContext(store, { run: solver.run, backend: 'claude', crossVendor: false, at: at(5) })
  const foreign = await recordRunContext(store, { run: other.run, backend: 'claude', crossVendor: false, at: at(5) })
  assert(context !== null && foreign !== null)
  const instructions = context.entries.find(({ kind }) => kind === 'instructions')
  expect(instructions?.text).toHaveLength(3_000)

  const misplaced = begin(store, other.run, 'context-misplaced', generous, context)
  expect(misplaced?.context).toBeNull()

  const input = begin(store, solver.run, 'context-call', { ...generous, inputTokens: 2_000 }, context)
  assert(input !== null)
  expect(observerInputTokens(input)).toBeLessThanOrEqual(2_000)
  expect(input.context).toMatchObject({ seq: context.seq, content_hash: context.content_hash })
  const sent = input.context?.entries.find(({ kind }) => kind === 'instructions')
  expect(sent?.text.length).toBeLessThan(3_000)
  expect(sent?.truncated).toEqual({ path: 'text', length: 3_000 })
  expect(missingIds(store, solver.run, input)).toEqual([])

  const step = recordsOf(store).find(({ payload }) => payload.includes(`${solver.run}-step`))
  assert(step !== undefined)
  expect(
    answer(store, 'context-call', input, [], [
      { kind: 'context', seq: context.seq },
      { kind: 'context', seq: step.seq },
      { kind: 'context', seq: foreign.seq },
    ]),
  ).toMatchObject({ status: 'needs_requested' })
  const followUp = store.transaction((transaction) =>
    beginObserverFollowUp(transaction, {
      previous: ObserverCallId.parse('context-call'),
      id: ObserverCallId.parse('context-follow-up'),
      at: at(12),
      crossVendor: false,
      inputTokens: 1_000_000,
    }),
  )
  expect(followUp.materials).toEqual([
    { kind: 'context', context },
    { kind: 'unavailable', request: { kind: 'context', seq: step.seq }, reason: 'not_found' },
    { kind: 'unavailable', request: { kind: 'context', seq: foreign.seq }, reason: 'out_of_scope' },
  ])
})

test('materials of a follow-up fit the limit of the first call and are dropped from the end only when cutting is not enough', async () => {
  const { store, session } = await setup()
  const output = longText('output', 6_000)
  const solver = session('follow-up')
  await solver.start()
  await solver.deliver(Array.from({ length: 10 }, (_, index) => solver.bash(`follow-${String(index)}`, output)).flat())
  const actions = (count: number): ObserverNeed[] =>
    Array.from({ length: count }, (_, index) => ({
      kind: 'action',
      action: objectId({ kind: 'action', runtime: 'claude', session: 'follow-up', call: `follow-${String(index)}` }),
    }))

  const run = (tokens: number, id: string): ObserverInput => {
    const input = begin(store, solver.run, id, { ...generous, inputTokens: tokens })
    assert(input !== null)
    expect(answer(store, id, input, [], actions(8))).toMatchObject({ status: 'needs_requested' })
    const followUp = store.transaction((transaction) =>
      beginObserverFollowUp(transaction, {
        previous: ObserverCallId.parse(id),
        id: ObserverCallId.parse(`${id}-follow-up`),
        at: at(12),
        crossVendor: false,
        inputTokens: tokens,
      }),
    )
    expect(observerInputTokens(followUp)).toBeLessThanOrEqual(tokens)
    expect(followUp.batch.facts.map(({ id: fact }) => fact)).toEqual(input.batch.facts.map(({ id: fact }) => fact))
    expect(answer(store, `${id}-follow-up`, followUp, [], [], 13)).toMatchObject({ status: 'accepted' })
    return followUp
  }

  const roomy = run(12_000, 'roomy-needs')
  expect(roomy.materials.map((material) => material.kind)).toEqual(Array.from({ length: 8 }, () => 'action'))
  await solver.deliver(Array.from({ length: 10 }, (_, index) => solver.bash(`again-${String(index)}`, output)).flat())
  const tight = run(4_000, 'tight-needs')
  expect(tight.materials.length).toBeGreaterThan(0)
  expect(tight.materials.length).toBeLessThan(8)
  const requested = (material: ObserverInput['materials'][number] | ObserverNeed) =>
    material.kind === 'action' ? material.action : null
  expect(tight.materials.map(requested)).toEqual(actions(tight.materials.length).map(requested))
})

test('a follow-up refuses an input limit that is not a positive integer', async () => {
  const { store, session } = await setup()
  const solver = session('invalid-limit')
  await solver.start()
  const input = begin(store, solver.run, 'invalid-limit-call')
  assert(input !== null)
  const [first] = input.batch.facts
  assert(first !== undefined)
  answer(store, 'invalid-limit-call', input, [], [{ kind: 'raw_record', seq: first.seq }])
  expect(() =>
    store.transaction((transaction) =>
      beginObserverFollowUp(transaction, {
        previous: ObserverCallId.parse('invalid-limit-call'),
        id: ObserverCallId.parse('invalid-limit-follow-up'),
        at: at(12),
        crossVendor: false,
        inputTokens: 0,
      }),
    ),
  ).toThrow(RangeError)
})
