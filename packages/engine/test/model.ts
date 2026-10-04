import {
  AttentionItemId,
  type Basis,
  type Binding,
  BindingId,
  type Card,
  CardId,
  type Criterion,
  CriterionId,
  EpochNs,
  type Evidence,
  FactId,
  type Link,
  LinkId,
  type ModelEntityRef,
  type ModelOperation,
  ModelVersion,
  ObserverCallId,
  type RunId,
  type SessionId,
  StageId,
} from '@aang/contract'
import { objectId, runId } from '@aang/contract/ids'
import type {
  AttentionItemDraft,
  ChangeSet,
  ModelChangeDraft,
  ModelEntityDraft,
  RunDraft,
  StageDraft,
} from '@aang/engine'

const sessionKey = (session: string) => ({ kind: 'session', runtime: 'claude', session }) as const

export const at = (second: number): EpochNs =>
  EpochNs.parse(1_759_370_000_000_000_000n + BigInt(second) * 1_000_000_000n)

export const fact = (index: number): FactId => FactId.parse(index.toString(16).padStart(32, '0'))

export const runA = runId(sessionKey('session-a'))
export const runB = runId(sessionKey('session-b'))
export const sessionA = objectId(sessionKey('session-a'))
export const sessionB = objectId(sessionKey('session-b'))
export const sessionC = objectId(sessionKey('session-c'))

const mainAgentA = objectId({ kind: 'agent', runtime: 'claude', session: 'session-a', agent: { kind: 'main' } })

export const firstCall = ObserverCallId.parse('call-1')
export const secondCall = ObserverCallId.parse('call-2')

export const observerCalls = [
  { id: firstCall, run: runA, base_version: 1 },
  { id: secondCall, run: runA, base_version: 3 },
]

export const observed: Basis = { kind: 'observed' }
export const claimed: Basis = { kind: 'claimed' }
export const byRule = (rule: string): Basis => ({ kind: 'interpreted', interpreter: { kind: 'rule', rule } })
export const byObserver = (call: ObserverCallId): Basis => ({
  kind: 'interpreted',
  interpreter: { kind: 'llm', call },
})

export const put = (
  op: ModelOperation,
  entity: ModelEntityDraft,
  basis: Basis,
  evidence: Evidence,
): ModelChangeDraft => ({
  op,
  put: entity,
  basis,
  evidence,
})

export const remove = (
  op: ModelOperation,
  target: ModelEntityRef,
  basis: Basis,
  evidence: Evidence,
): ModelChangeDraft => ({ op, remove: target, basis, evidence })

const runDraft = (id: RunId, root: SessionId, goal: FactId, created: EpochNs): RunDraft => ({
  id,
  runtime: 'claude',
  root_session: root,
  goal: { text: 'Ship the parser', fact: goal },
  brief: null,
  start_pruned: false,
  created_at: created,
})

const stageDraft = (id: StageId, title: string, call: ObserverCallId, evidence: Evidence): StageDraft => ({
  id,
  run: runA,
  title,
  expected_result: null,
  summary: null,
  parent: null,
  origin: 'inferred',
  lifecycle: { state: 'active' },
  execution: { value: { state: 'planned' }, basis: byObserver(call), evidence },
  execution_claim: null,
  decision: { value: 'none', basis: byObserver(call), evidence },
  session_moved: false,
  basis: byObserver(call),
  evidence,
})

export const stages = {
  build: StageId.parse('stage-build'),
  test: StageId.parse('stage-test'),
  verify: StageId.parse('stage-verify'),
}

const runADraft = runDraft(runA, sessionA, fact(1), at(1))
const runBDraft = runDraft(runB, sessionB, fact(20), at(25))

const permission: AttentionItemDraft = {
  id: AttentionItemId.parse('attention-permission'),
  run: runA,
  kind: 'permission',
  author: 'rule',
  text: 'Allow Bash: pnpm test',
  stage: null,
  question: null,
  action: null,
  basis: observed,
  evidence: [fact(2)],
  runtime_wait: 'active',
  resolution: 'open',
  likely_resolved: null,
  priority: null,
  opened_at: at(1),
  closed_at: null,
}

const answered: AttentionItemDraft = {
  ...permission,
  runtime_wait: 'ended',
  resolution: 'answered',
  closed_at: at(20),
}

const build = stageDraft(stages.build, 'Build the parser', firstCall, [fact(4)])

const running: StageDraft = {
  ...build,
  execution: { value: { state: 'running' }, basis: byRule('stage-execution'), evidence: [fact(6)] },
}

const moved: StageDraft = { ...running, session_moved: true }

const testing = stageDraft(stages.test, 'Run the test suite', firstCall, [fact(5)])

const replaced: StageDraft = { ...testing, lifecycle: { state: 'replaced', by: [stages.verify] } }

const verify = stageDraft(stages.verify, 'Verify in CI', secondCall, [fact(8)])

const summarized: StageDraft = { ...verify, summary: 'The CI run replaces the local suite' }

const testsPass: Criterion = {
  id: CriterionId.parse('criterion-tests-pass'),
  run: runA,
  stage: stages.test,
  text: 'All tests pass',
  source: 'task',
  contract: null,
  status: { value: 'not_checked', basis: byObserver(firstCall), evidence: [fact(5)] },
  checked_commit: null,
  clean_tree_commit: null,
  carried_checks: [],
}

const participation: Link = {
  id: LinkId.parse('link-build-main'),
  run: runA,
  basis: byObserver(firstCall),
  evidence: [fact(4)],
  kind: 'participation',
  agent: mainAgentA,
  stage: stages.build,
}

const attachC: Binding = {
  id: BindingId.parse('binding-session-c'),
  kind: 'attach',
  session: sessionC,
  run: runB,
  created_at: at(30),
  revoked_at: null,
}

const ciCard: Card = {
  id: CardId.parse('card-ci'),
  run: runA,
  stages: [stages.verify],
  text: 'CI passed on the parser branch',
  source: { fact: fact(9), start: 0, end: 30 },
  basis: claimed,
  evidence: [fact(9)],
}

const review: AttentionItemDraft = {
  id: AttentionItemId.parse('attention-review'),
  run: runA,
  kind: 'review_request',
  author: 'observer',
  text: 'Review the CI change',
  stage: stages.verify,
  question: null,
  action: null,
  basis: byObserver(secondCall),
  evidence: [fact(9)],
  runtime_wait: 'none',
  resolution: 'open',
  likely_resolved: null,
  priority: null,
  opened_at: at(40),
  closed_at: null,
}

export const drafts = {
  runA: runADraft,
  runB: runBDraft,
  permission,
  answered,
  build,
  running,
  moved,
  testing,
  replaced,
  verify,
  summarized,
  testsPass,
  participation,
  attachC,
  ciCard,
  review,
}

export const membership = (session: SessionId, run: RunId): ModelEntityDraft => ({
  kind: 'session_membership',
  value: { session, run },
})

const version = (value: number): ModelVersion => ModelVersion.parse(value)

export const history = (): ChangeSet[][] => [
  [
    {
      run: runA,
      author: 'rule',
      at: at(1),
      changes: [
        put('run.create', { kind: 'run', value: runADraft }, observed, [fact(1)]),
        put('run.create', membership(sessionA, runA), observed, [fact(1)]),
        put('session.move', membership(sessionC, runA), observed, [fact(3)]),
        put('attention.open', { kind: 'attention_item', value: permission }, observed, [fact(2)]),
      ],
    },
  ],
  [
    {
      run: runA,
      author: 'observer',
      observer_call: firstCall,
      base_version: version(1),
      at: at(10),
      changes: [
        put('stage.create', { kind: 'stage', value: build }, byObserver(firstCall), [fact(4)]),
        put('stage.create', { kind: 'stage', value: testing }, byObserver(firstCall), [fact(5)]),
        put('criterion.add', { kind: 'criterion', value: testsPass }, byObserver(firstCall), [fact(5)]),
        put('agents.participate', { kind: 'link', value: participation }, byObserver(firstCall), [fact(4)]),
      ],
    },
  ],
  [
    {
      run: runA,
      author: 'rule',
      at: at(20),
      changes: [
        put('stage.execution', { kind: 'stage', value: running }, byRule('stage-execution'), [fact(6)]),
        put('attention.close', { kind: 'attention_item', value: answered }, observed, [fact(7)]),
      ],
    },
  ],
  [
    {
      run: runB,
      author: 'rule',
      at: at(25),
      changes: [
        put('run.create', { kind: 'run', value: runBDraft }, observed, [fact(20)]),
        put('run.create', membership(sessionB, runB), observed, [fact(20)]),
      ],
    },
  ],
  [
    {
      run: runB,
      author: 'user',
      at: at(30),
      changes: [
        put('binding.add', { kind: 'binding', value: attachC }, observed, []),
        put('session.move', membership(sessionC, runB), observed, []),
      ],
    },
    {
      run: runA,
      author: 'user',
      at: at(30),
      changes: [
        remove('session.move', { kind: 'session_membership', id: sessionC }, observed, []),
        put('session.move', { kind: 'stage', value: moved }, observed, []),
      ],
    },
  ],
  [
    {
      run: runA,
      author: 'observer',
      observer_call: secondCall,
      base_version: version(3),
      at: at(40),
      changes: [
        put('stage.replace', { kind: 'stage', value: replaced }, byObserver(secondCall), [fact(8)]),
        put('stage.create', { kind: 'stage', value: verify }, byObserver(secondCall), [fact(8)]),
        put('stage.update', { kind: 'stage', value: summarized }, byObserver(secondCall), [fact(9)]),
        put('card.add', { kind: 'card', value: ciCard }, claimed, [fact(9)]),
        put('attention.add', { kind: 'attention_item', value: review }, byObserver(secondCall), [fact(9)]),
      ],
    },
  ],
]
