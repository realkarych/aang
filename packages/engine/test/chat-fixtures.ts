import { join } from 'node:path'
import {
  type ActionId,
  type ArtifactVersion,
  EpochNs,
  type Fact,
  type JsonValue,
  ObserverCallId,
  type ObserverOp,
  type RunId,
  type StageId,
  TempId,
} from '@aang/contract'
import { objectId, runId } from '@aang/contract/ids'
import { applyObserverResponse, beginObserverCall, createEngine, startChat, type ChatLimits } from '@aang/engine'
import type { Store } from '@aang/store'
import type { TestContext } from 'vitest'
import { jsonlFile } from './batches.js'
import { adapters, factsOf, sessionKey } from './harness.js'
import { createHome } from './home.js'
import { at } from './model.js'
import { inputFor } from './observer-fixtures.js'
import { writeFiles } from './repository.js'

export const chatSession = 'chat-session'

export const chatRun: RunId = runId(sessionKey('claude', chatSession))

export const otherSession = 'other-session'

export const otherRun: RunId = runId(sessionKey('claude', otherSession))

const factWhereIn = (facts: readonly Fact[], predicate: (fact: Fact) => boolean): Fact => {
  const found = facts.find(predicate)
  if (found === undefined) {
    throw new Error('the session must contain the fact')
  }
  return found
}

export const reportText = '# Report\n\nThe parser handles nested lists.\n'

const lineAt = (
  cwd: string,
  uuid: string,
  second: number,
  type: 'assistant' | 'user',
  message: JsonValue,
  session = chatSession,
) =>
  JSON.stringify({
    type,
    sessionId: session,
    uuid,
    timestamp: new Date(Date.UTC(2026, 9, 1, 10, 0, second)).toISOString(),
    cwd,
    message,
  })

const toolCall = (cwd: string, id: string, second: number, name: string, input: JsonValue): string[] => [
  lineAt(cwd, `use-${id}`, second, 'assistant', {
    id: `message-${id}`,
    role: 'assistant',
    content: [{ type: 'tool_use', id, name, input }],
  }),
  lineAt(cwd, `result-${id}`, second + 1, 'user', {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content: 'done', is_error: false }],
  }),
]

const chatLines = (cwd: string, report: string): string[] => [
  lineAt(cwd, 'prompt', 0, 'user', { role: 'user', content: 'Write the parser report and run the tests' }),
  ...toolCall(cwd, 'toolu_report', 2, 'Write', { file_path: report, content: reportText }),
  ...toolCall(cwd, 'toolu_tests', 4, 'Bash', { command: 'pnpm test', description: 'Run the tests' }),
  lineAt(cwd, 'final', 6, 'assistant', {
    id: 'message-final',
    role: 'assistant',
    content: [{ type: 'text', text: 'The report is written and the tests pass.' }],
    stop_reason: 'end_turn',
  }),
]

const actionOf = (call: string): ActionId => objectId({ kind: 'action', runtime: 'claude', session: chatSession, call })

export const reportAction = actionOf('toolu_report')

export const testsAction = actionOf('toolu_tests')

const temp = (id: string) => ({ kind: 'new', temp_id: TempId.parse(id) }) as const

const existing = (id: StageId) => ({ kind: 'existing', id }) as const

export const observe = (
  store: Store,
  call: string,
  evidence: readonly Fact[],
  ops: (ids: readonly Fact['id'][]) => ObserverOp[],
  second: number,
  run = chatRun,
): void => {
  const id = ObserverCallId.parse(call)
  const input = inputFor(store, [...evidence], run)
  store.transaction((transaction) => {
    beginObserverCall(transaction, { id, backend: 'claude', crossVendor: false, input, at: at(second) })
  })
  const result = store.transaction((transaction) =>
    applyObserverResponse(transaction, {
      call: id,
      at: at(second + 1),
      output: { base_version: input.model.version, ops: ops(evidence.map(({ id: fact }) => fact)), needs: [] },
    }),
  )
  if (result.status !== 'accepted') {
    throw new Error(`the observer response must be accepted: ${JSON.stringify(result)}`)
  }
}

export const stageTitled = (store: Store, title: string): StageId => {
  const stage = store.model
    .entities(chatRun)
    .flatMap((entity) => (entity.kind === 'stage' && entity.value.title === title ? [entity.value.id] : []))
    .at(0)
  if (stage === undefined) {
    throw new Error(`no stage ${title}`)
  }
  return stage
}

export const setupChat = async ({ onTestFinished }: Pick<TestContext, 'onTestFinished'>) => {
  const home = await createHome(onTestFinished)
  const project = join(home.path, '..', 'project')
  await writeFiles(project, {})
  const store = home.open()
  const engine = createEngine({ store, adapters, watch: { all: true, roots: [] }, now: () => at(500) })
  const report = join(project, 'report.md')
  const lines = chatLines(project, report)
  await engine.ingest(jsonlFile({ runtime: 'claude', path: join(project, `${chatSession}.jsonl`), lines, ino: 5n }).batch(1, lines.length))
  const facts = factsOf(store).filter(({ entity_key: { session } }) => session === chatSession)
  const factWhere = (predicate: (fact: Fact) => boolean): Fact => factWhereIn(facts, predicate)
  const prompt = factWhere(({ kind, speaker }) => kind === 'prompt' && speaker === 'human')
  const final = factWhere(({ kind, speaker }) => kind === 'message' && speaker === 'solver')
  const starts = (action: ActionId): Fact =>
    factWhere((fact) => fact.kind === 'action_start' && objectId(fact.entity_key) === action)
  const version: ArtifactVersion | undefined = store.artifacts
    .versions(chatRun)
    .find(({ ref }) => ref.kind === 'file' && ref.path === report)
  if (version === undefined) {
    throw new Error('the Write call must produce an artifact version')
  }
  observe(
    store,
    'call-stages',
    [prompt, starts(reportAction), starts(testsAction)],
    (evidence) => [
      {
        op: 'stage.create',
        temp_id: TempId.parse('report'),
        title: 'Write the report',
        expected_result: 'A report of the parser',
        summary: null,
        parent: null,
        origin: 'inferred',
        evidence: [prompt.id],
        rationale: 'The task asks for a report',
      },
      {
        op: 'stage.create',
        temp_id: TempId.parse('tests'),
        title: 'Run the tests',
        expected_result: null,
        summary: null,
        parent: null,
        origin: 'inferred',
        evidence: [prompt.id],
        rationale: 'The task asks to run the tests',
      },
      { op: 'actions.assign', actions: [reportAction], stage: temp('report'), evidence: [...evidence], rationale: 'Writes the report' },
      { op: 'actions.assign', actions: [testsAction], stage: temp('tests'), evidence: [...evidence], rationale: 'Runs the tests' },
      {
        op: 'artifact.link',
        stage: temp('report'),
        version: version.id,
        direction: 'output',
        evidence: [...evidence],
        rationale: 'The report is the output',
      },
    ],
    20,
  )
  const reportStage = stageTitled(store, 'Write the report')
  const testsStage = stageTitled(store, 'Run the tests')
  await engine.retainBases()
  observe(
    store,
    'call-summary',
    [final],
    (evidence) => [
      {
        op: 'stage.update',
        stage: existing(reportStage),
        title: null,
        expected_result: null,
        summary: 'The report is written',
        evidence: [...evidence],
        rationale: 'The agent says so',
      },
      {
        op: 'attention.add',
        temp_id: TempId.parse('review'),
        kind: 'review_request',
        text: 'Review the report',
        stage: existing(reportStage),
        evidence: [...evidence],
        rationale: 'The report waits for a review',
      },
    ],
    30,
  )
  const otherLines = [lineAt(project, 'other-prompt', 0, 'user', { role: 'user', content: 'Another task' }, otherSession)]
  await engine.ingest(
    jsonlFile({ runtime: 'claude', path: join(project, `${otherSession}.jsonl`), lines: otherLines, ino: 6n }).batch(1, 1),
  )
  const foreign = factWhereIn(factsOf(store), ({ entity_key: { session } }) => session === otherSession)
  const ask = (question: string, stage: StageId | null = null, limits?: ChatLimits, second = 40) =>
    store.transaction((transaction) =>
      startChat(transaction, {
        run: chatRun,
        stage,
        question,
        backend: 'claude',
        crossVendor: false,
        at: EpochNs.parse(at(second)),
        ...(limits === undefined ? {} : { limits }),
      }),
    )
  return { home, project, store, engine, facts, prompt, final, foreign, report, version, reportStage, testsStage, starts, ask }
}
