import {
  type Fact,
  JsonValue,
  ModelVersion,
  ObserverCallId,
  type ObserverInput,
  type ObserverOp,
  type ObserverOutput,
  StageId,
  TempId,
} from '@aang/contract'
import { objectId } from '@aang/contract/ids'
import { applyChangeSet, beginObserverCall } from '@aang/engine'
import type { Store } from '@aang/store'
import type { TestContext } from 'vitest'
import { jsonlFile } from './batches.js'
import { factsOf, startEngine } from './harness.js'
import { createHome } from './home.js'
import { at, drafts, observed, put, runA, runB, sessionA, sessionB, stages } from './model.js'
import { claudeTranscript } from './samples.js'

export const callId = ObserverCallId.parse('validation-call')
export const existing = (id: string) => ({ kind: 'existing', id: StageId.parse(id) }) as const
export const temporary = (id: string) => ({ kind: 'new', temp_id: TempId.parse(id) }) as const
export const version = (value: number) => ModelVersion.parse(value)

export const createStage = (evidence: Fact['id'][], id = 'new-stage'): ObserverOp => ({
  op: 'stage.create',
  temp_id: TempId.parse(id),
  title: 'Validate operations',
  expected_result: null,
  summary: null,
  parent: null,
  origin: 'inferred',
  evidence,
  rationale: 'Runtime evidence',
})

export const response = (ops: ObserverOp[], base = 1): ObserverOutput => ({
  base_version: version(base),
  ops,
  needs: [],
})

export const inputFor = (store: Store, facts: Fact[], run = runA): ObserverInput => ({
  run: { id: run, runtime: 'claude', goal: 'Validate operations', brief: null, sessions: [], agents: [] },
  context: null,
  model: { version: store.model.head(run), stages: [], criteria: [], attention: [] },
  batch: {
    facts: facts.map((fact) => ({
      id: fact.id,
      seq: fact.seq,
      kind: fact.kind,
      speaker: fact.speaker,
      at: '2026-10-01T00:00:00.000Z',
      urgent: fact.urgent,
      session: objectId({
        kind: 'session',
        runtime: fact.entity_key.runtime,
        session: fact.entity_key.session,
      }),
      agent: null,
      action: null,
      payload: JsonValue.parse(
        JSON.parse(
          JSON.stringify(fact.payload, (_key, value: unknown) =>
            typeof value === 'bigint' ? value.toString() : value,
          ),
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

export const setupObserver = async (onTestFinished: TestContext['onTestFinished']) => {
  const home = await createHome(onTestFinished)
  const store = home.open()
  const engine = startEngine(store, { all: true })
  for (const session of ['session-a', 'session-b']) {
    const lines = claudeTranscript({ session, cwd: home.path })
    const file = jsonlFile({ runtime: 'claude', path: `${home.path}/${session}.jsonl`, lines, ino: 10n })
    await engine.ingest(file.batch(1, lines.length))
  }
  const facts = factsOf(store).filter((fact) => fact.entity_key.session === 'session-a')
  const foreignFacts = factsOf(store).filter((fact) => fact.entity_key.session === 'session-b')
  const solver = facts.find((fact) => fact.kind === 'message' && fact.speaker === 'solver')
  const human = facts.find((fact) => fact.speaker === 'human')
  const tool = facts.find((fact) => fact.speaker === 'tool')
  if (solver === undefined || human === undefined || tool === undefined) {
    throw new Error('the transcript must contain solver, human and tool facts')
  }
  store.transaction((transaction) => {
    for (const [run, session, draft] of [
      [runA, sessionA, drafts.runA],
      [runB, sessionB, drafts.runB],
    ] as const) {
      applyChangeSet(transaction, {
        run,
        author: 'rule',
        at: at(1),
        changes: [
          put('run.create', { kind: 'run', value: draft }, observed, []),
          put('run.create', { kind: 'session_membership', value: { run, session } }, observed, []),
        ],
      })
    }
    applyChangeSet(transaction, {
      run: runA,
      author: 'rule',
      at: at(2),
      changes: [
        put('stage.create', { kind: 'stage', value: drafts.build }, observed, []),
        put('stage.create', { kind: 'stage', value: drafts.testing }, observed, []),
        put('criterion.add', { kind: 'criterion', value: drafts.testsPass }, observed, []),
        put('attention.open', { kind: 'attention_item', value: drafts.permission }, observed, []),
        put('attention.add', { kind: 'attention_item', value: drafts.review }, observed, []),
      ],
    })
    applyChangeSet(transaction, {
      run: runB,
      author: 'rule',
      at: at(2),
      changes: [put('stage.create', { kind: 'stage', value: { ...drafts.verify, run: runB } }, observed, [])],
    })
  })
  const begin = (batch = [solver, human, tool], id = callId) => {
    const input = inputFor(store, batch)
    store.transaction((transaction) => {
      beginObserverCall(transaction, { id, input, at: at(10) })
    })
    return input
  }
  const stage = (id = stages.build) => store.model.entity(runA, { kind: 'stage', id })
  return { home, store, facts, foreignFacts, solver, human, tool, begin, stage }
}
