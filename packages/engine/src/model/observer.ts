import {
  type CallUsage,
  type EpochNs,
  type FactId,
  ModelVersion,
  type ObserverCallId,
  type ObserverInput,
  type ObserverNeed,
  type ObserverOp,
  ObserverOutput,
  type ObserverRejection,
  type RunId,
  type SessionId,
} from '@aang/contract'
import type { ObserverCallError, ObserverCallStart, StoredObserverCall, Transaction } from '@aang/store'
import {
  clipAttempt,
  clipInputFact,
  clipRun,
  clipSnapshot,
  defaultInputTokens,
  longestStateText,
  type Packing,
  packObserverInput,
} from '../input/fit.js'
import { clipContext, defaultMaterialLimits, type MaterialLimits, resolveObserverNeeds } from '../input/materials.js'
import { type InputScope, inputScope, inputViolations } from '../input/scope.js'
import { applyChangeSet } from './journal.js'
import { batchFacts, ObserverContext, OperationRejection, type ValidationLimits } from './observer-context.js'
import { planOperation } from './observer-operations.js'
import { refreshStageDecisions } from './stage-decision.js'
import { refreshStageExecution, type StageObservations } from './stage-execution.js'

export interface FollowUpOptions {
  readonly crossVendor: boolean
  readonly limits?: MaterialLimits
  readonly inputTokens?: number
}

export interface ObserverResponse {
  readonly call: ObserverCallId
  readonly output: unknown
  readonly at: EpochNs
  readonly limits?: ValidationLimits
  readonly observations?: StageObservations
  readonly usage?: CallUsage | null
  readonly followUp?: FollowUpOptions
}

interface ObserverCallEnd {
  readonly call: ObserverCallId
  readonly at: EpochNs
  readonly usage?: CallUsage | null
  readonly error?: ObserverCallError | null
}

export type ObserverCallFailure =
  | (ObserverCallEnd & { readonly outcome: 'rejected'; readonly message: string })
  | (ObserverCallEnd & { readonly outcome: 'failed' })

export type ObserverResponseResult =
  | { readonly status: 'accepted'; readonly version: ModelVersion }
  | { readonly status: 'rejected'; readonly rejections: readonly ObserverRejection[] }
  | { readonly status: 'needs_requested' }

export interface ObserverCallBegin extends ObserverCallStart {
  readonly crossVendor: boolean
}

export interface ObserverFollowUp extends FollowUpOptions {
  readonly previous: ObserverCallId
  readonly id: ObserverCallId
  readonly at: EpochNs
}

const admitInput = (transaction: Transaction, scope: InputScope, input: ObserverInput): void => {
  const [violation] = inputViolations(transaction, scope, input)
  if (violation !== undefined) {
    throw new Error(
      violation.reason === 'out_of_scope'
        ? `${violation.object} is not in run ${scope.run}`
        : `${violation.object} comes from a vendor other than backend ${scope.backend}`,
    )
  }
}

const callInProgress = (transaction: Transaction, run: RunId): boolean => {
  const unfinished = new Set(transaction.observerCalls.unfinished())
  return transaction.interpretations
    .ofRun(run)
    .some(({ status, observer_call: call }) => status === 'in_call' || (status === 'deferred' && call !== null && unfinished.has(call)))
}

export const beginObserverCall = (transaction: Transaction, call: ObserverCallBegin): void => {
  const { input, id, backend, crossVendor } = call
  const { run } = input
  if (
    transaction.model.entity(run.id, { kind: 'run', id: run.id }) === null ||
    input.model.version !== transaction.model.head(run.id)
  ) {
    throw new Error('observer call must start from the current run version')
  }
  if (callInProgress(transaction, run.id)) {
    throw new Error(`run ${run.id} already has an observer call`)
  }
  if (input.materials.length > 0) {
    throw new Error('materials are sent only in a follow-up call')
  }
  const facts = batchFacts(input)
  if (facts.length === 0 && input.batch.backlog === null) {
    throw new Error('observer calls require a nonempty batch or a backlog summary')
  }
  admitInput(transaction, inputScope(transaction, { run: run.id, backend, crossVendor }), input)
  transaction.observerCalls.start({ id, backend, input, at: call.at })
  transaction.interpretations.begin(run.id, id, facts)
}

const inputTokensOf = ({ inputTokens = defaultInputTokens }: FollowUpOptions): number => {
  if (!Number.isSafeInteger(inputTokens) || inputTokens <= 0) {
    throw new RangeError('the input limit must be a positive integer')
  }
  return inputTokens
}

const followUpInput = (
  transaction: Transaction,
  call: StoredObserverCall,
  needs: readonly ObserverNeed[],
  options: FollowUpOptions,
): ObserverInput | null => {
  const tokens = inputTokensOf(options)
  const limits = options.limits ?? defaultMaterialLimits
  const scope = inputScope(transaction, { run: call.run, backend: call.backend, crossVendor: options.crossVendor })
  const base = call.input
  const materials = (textLength: number) => resolveObserverNeeds(transaction, scope, needs, { ...limits, textLength })
  const render = ({ count, batchText, stateText }: Packing): ObserverInput => ({
    ...base,
    run: clipRun(base.run, stateText),
    context: clipContext(base.context, batchText),
    model: clipSnapshot(base.model, stateText),
    batch: { ...base.batch, facts: base.batch.facts.map((fact) => clipInputFact(fact, batchText)) },
    materials: materials(batchText).slice(0, count),
    previous_attempt: clipAttempt(base.previous_attempt, stateText),
  })
  const range = {
    count: materials(limits.textLength).length,
    minimumCount: 1,
    batchText: limits.textLength,
    stateText: longestStateText(base),
  }
  return packObserverInput(range, tokens, render)
}

export const beginObserverFollowUp = (transaction: Transaction, followUp: ObserverFollowUp): ObserverInput => {
  const previous = transaction.observerCalls.get(followUp.previous)
  if (previous?.verdict !== 'needs_requested') {
    throw new Error(`observer call ${followUp.previous} did not request materials`)
  }
  const batch = batchFacts(previous.input)
  admitInput(
    transaction,
    inputScope(transaction, { run: previous.run, backend: previous.backend, crossVendor: followUp.crossVendor }),
    previous.input,
  )
  const { needs } = ObserverOutput.parse(previous.output)
  const input = followUpInput(transaction, previous, needs, followUp)
  if (input === null) {
    throw new Error(`no material requested by observer call ${previous.id} fits the input limit`)
  }
  transaction.observerCalls.start({ id: followUp.id, backend: previous.backend, input, at: followUp.at })
  if (transaction.interpretations.handover(previous.id, followUp.id) !== batch.length) {
    throw new Error(`observer call ${previous.id} no longer owns its batch`)
  }
  return input
}

export const skipObserverFollowUp = (transaction: Transaction, previous: ObserverCallId): void => {
  if (transaction.observerCalls.get(previous)?.verdict !== 'needs_requested') {
    throw new Error(`observer call ${previous} did not request materials`)
  }
  transaction.interpretations.release(previous)
}

export interface CallEnding {
  readonly run: RunId
  readonly session: SessionId
  readonly facts: readonly FactId[]
  readonly at: EpochNs
  readonly message: string
}

export interface EndedCallUsage {
  readonly call: ObserverCallId
  readonly usage: CallUsage | null
}

export const endObserverCalls = (transaction: Transaction, { run, session, facts, at, message }: CallEnding): void => {
  const leaving = new Set(facts)
  const linked = transaction.interpretations
    .ofRun(run)
    .flatMap(({ fact, status, observer_call: call }) =>
      call !== null && (status === 'in_call' || status === 'deferred') ? [{ fact, call }] : [],
    )
  const open = new Set(
    [...new Set(linked.map(({ call }) => call))].filter((call) => {
      const stored = transaction.observerCalls.get(call)
      return stored !== null && (stored.finished_at === null || stored.verdict === 'needs_requested')
    }),
  )
  const owning = new Set(linked.flatMap(({ fact, call }) => (leaving.has(fact) && open.has(call) ? [call] : [])))
  const describes = (call: ObserverCallId): boolean =>
    transaction.observerCalls.get(call)?.input.run.sessions.some(({ id }) => id === session) === true
  const calls = [...open].filter((call) => owning.has(call) || describes(call))
  for (const call of calls) {
    transaction.interpretations.release(call)
    if (transaction.observerCalls.get(call)?.finished_at !== null) {
      continue
    }
    transaction.observerCalls.finish({
      id: call,
      output: null,
      verdict: 'rejected',
      reasons: [{ op_index: null, cause: 'scope', message }],
      at,
    })
  }
}

export const chargeEndedObserverCall = (transaction: Transaction, { call, usage }: EndedCallUsage): boolean => {
  const stored = transaction.observerCalls.get(call)
  if (stored === null || stored.finished_at === null) {
    return false
  }
  if (usage !== null) {
    transaction.observerCalls.charge(call, usage)
  }
  return true
}

const textsOf = (op: ObserverOp): string[] =>
  Object.entries(op)
    .filter(
      ([field, value]) =>
        ['title', 'expected_result', 'summary', 'text', 'rationale'].includes(field) &&
        typeof value === 'string',
    )
    .map(([, value]) => value as string)

const creation = (op: ObserverOp): boolean => 'temp_id' in op

export const failObserverCall = (transaction: Transaction, failure: ObserverCallFailure): void => {
  const call = transaction.observerCalls.get(failure.call)
  if (call === null || call.finished_at !== null) {
    throw new Error(`observer call ${failure.call} is missing or already finished`)
  }
  if (failure.outcome === 'rejected') {
    transaction.interpretations.settle(call.id, 'pending')
  } else {
    transaction.interpretations.release(call.id)
  }
  transaction.observerCalls.finish({
    id: call.id,
    output: null,
    verdict: failure.outcome,
    reasons: failure.outcome === 'rejected' ? [{ op_index: null, cause: 'schema', message: failure.message }] : [],
    error: failure.error ?? null,
    usage: failure.usage ?? null,
    at: failure.at,
  })
}

const nanosecondsPerMillisecond = 1_000_000n

const batchDelay = (transaction: Transaction, input: ObserverInput, at: EpochNs): number => {
  const oldest = batchFacts(input).reduce((earliest, id) => {
    const fact = transaction.facts.get(id)
    const observed = fact === null ? null : (transaction.rawRecords.get(fact.seq)?.observed_at ?? null)
    return observed !== null && observed < earliest ? observed : earliest
  }, at)
  return Number((at - oldest) / nanosecondsPerMillisecond)
}

export const applyObserverResponse = (
  transaction: Transaction,
  response: ObserverResponse,
): ObserverResponseResult => {
  const call = transaction.observerCalls.get(response.call)
  if (call === null || call.finished_at !== null) {
    throw new Error(`observer call ${response.call} is missing or already finished`)
  }
  const batch = batchFacts(call.input)
  const active = transaction.interpretations.ofCall(call.id).filter(({ status }) => status === 'in_call')
  if (
    active.length !== batch.length ||
    active.some(({ run, fact }) => run !== call.run || !batch.includes(fact))
  ) {
    throw new Error(`observer call ${call.id} no longer owns its batch`)
  }
  const limits = response.limits ?? { operations: 200, textLength: 16_384 }
  if (![limits.operations, limits.textLength].every((value) => Number.isSafeInteger(value) && value > 0)) {
    throw new RangeError('observer validation limits must be positive integers')
  }
  const parsed = ObserverOutput.safeParse(response.output)
  const options = response.followUp ?? { crossVendor: false }
  const needs =
    parsed.success && parsed.data.base_version === call.base_version && call.input.materials.length === 0
      ? parsed.data.needs
      : []
  if (needs.length > 0 && followUpInput(transaction, call, needs, options) !== null) {
    transaction.observerCalls.finish({
      id: call.id,
      output: response.output,
      verdict: 'needs_requested',
      reasons: [],
      usage: response.usage ?? null,
      at: response.at,
    })
    return { status: 'needs_requested' }
  }
  const context: ObserverContext = new ObserverContext(transaction, call)
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const index = issue.path[0] === 'ops' && typeof issue.path[1] === 'number' ? issue.path[1] : null
      context.reject(index, new OperationRejection('schema', `${issue.path.join('.')}: ${issue.message}`))
    }
  } else if (parsed.data.base_version !== call.base_version) {
    context.reject(
      null,
      new OperationRejection('version', 'base_version does not match the saved observer call'),
    )
  } else if (needs.length > 0) {
    context.reject(
      null,
      new OperationRejection(
        'limit',
        `needs: none of the requested materials fits the input limit of ${String(inputTokensOf(options))} tokens`,
      ),
    )
  } else if (parsed.data.ops.length > limits.operations) {
    context.reject(
      null,
      new OperationRejection('limit', `response exceeds ${String(limits.operations)} operations`),
    )
  } else {
    const operations = parsed.data.ops.map((op, index) => ({ op, index }))
    for (const { op, index } of operations) {
      try {
        context.check(
          textsOf(op).every((value) => value.length <= limits.textLength),
          'limit',
          'operation text exceeds the limit',
        )
        context.declare(op)
      } catch (error) {
        if (!(error instanceof OperationRejection)) {
          throw error
        }
        context.reject(index, error)
      }
    }
    if (context.rejections.length === 0) {
      for (const { op, index } of [
        ...operations.filter(({ op }) => creation(op)),
        ...operations.filter(({ op }) => !creation(op)),
      ]) {
        try {
          planOperation(context, op, response.at)
        } catch (error) {
          if (!(error instanceof OperationRejection)) {
            throw error
          }
          context.reject(index, error)
        }
      }
    }
  }
  const rejected = context.rejections.length > 0
  let version = transaction.model.head(call.run)
  if (!rejected) {
    if (context.changes.length > 0) {
      version = applyChangeSet(transaction, {
        run: call.run,
        at: response.at,
        author: 'observer',
        observer_call: call.id,
        base_version: call.base_version,
        changes: context.changes,
      }).version.version
    } else {
      version = ModelVersion.parse(version + 1)
      transaction.model.commit(
        {
          run: call.run,
          version,
          base_version: call.base_version,
          author: 'observer',
          observer_call: call.id,
          created_at: response.at,
          change_seq: transaction.nextChangeSeq(),
        },
        [],
      )
    }
  }
  if (!rejected) {
    const refreshed =
      response.observations === undefined
        ? refreshStageDecisions(transaction, { run: call.run, at: response.at })
        : refreshStageExecution(transaction, { run: call.run, at: response.at, observations: response.observations })
    version = refreshed?.version.version ?? version
  }
  transaction.interpretations.settle(call.id, rejected ? 'pending' : 'interpreted')
  transaction.observerCalls.finish({
    id: call.id,
    output: response.output ?? null,
    verdict: rejected ? 'rejected' : 'accepted',
    reasons: context.rejections,
    usage: response.usage ?? null,
    delay_ms: rejected || batch.length === 0 ? null : batchDelay(transaction, call.input, response.at),
    at: response.at,
  })
  return rejected ? { status: 'rejected', rejections: context.rejections } : { status: 'accepted', version }
}
