import {
  type CallUsage,
  type EpochNs,
  type FactId,
  ModelVersion,
  type ObserverCallId,
  type ObserverInput,
  type ObserverOp,
  ObserverOutput,
  type ObserverRejection,
  type RunId,
} from '@aang/contract'
import type { ObserverCallError, ObserverCallStart, Transaction } from '@aang/store'
import { type MaterialLimits, resolveObserverNeeds } from '../input/materials.js'
import { type InputScope, inputScope, inputViolations } from '../input/scope.js'
import { applyChangeSet } from './journal.js'
import { batchFacts, ObserverContext, OperationRejection, type ValidationLimits } from './observer-context.js'
import { planOperation } from './observer-operations.js'
import { refreshStageDecisions } from './stage-decision.js'
import { refreshStageExecution, type StageObservations } from './stage-execution.js'

export interface ObserverResponse {
  readonly call: ObserverCallId
  readonly output: unknown
  readonly at: EpochNs
  readonly limits?: ValidationLimits
  readonly observations?: StageObservations
  readonly usage?: CallUsage | null
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

export interface ObserverFollowUp {
  readonly previous: ObserverCallId
  readonly id: ObserverCallId
  readonly at: EpochNs
  readonly crossVendor: boolean
  readonly limits?: MaterialLimits
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

export const beginObserverCall = (transaction: Transaction, call: ObserverCallBegin): void => {
  const { input, id, backend, crossVendor } = call
  const { run } = input
  if (
    transaction.model.entity(run.id, { kind: 'run', id: run.id }) === null ||
    input.model.version !== transaction.model.head(run.id)
  ) {
    throw new Error('observer call must start from the current run version')
  }
  if (transaction.interpretations.ofRun(run.id).some(({ status }) => status === 'in_call')) {
    throw new Error(`run ${run.id} already has an observer call`)
  }
  if (input.materials.length > 0) {
    throw new Error('materials are sent only in a follow-up call')
  }
  const facts = batchFacts(input)
  if (facts.length === 0) {
    throw new Error('observer calls require a nonempty batch')
  }
  admitInput(transaction, inputScope(transaction, { run: run.id, backend, crossVendor }), input)
  transaction.observerCalls.start({ id, backend, input, at: call.at })
  transaction.interpretations.begin(run.id, id, facts)
}

export const beginObserverFollowUp = (transaction: Transaction, followUp: ObserverFollowUp): ObserverInput => {
  const previous = transaction.observerCalls.get(followUp.previous)
  if (previous?.verdict !== 'needs_requested') {
    throw new Error(`observer call ${followUp.previous} did not request materials`)
  }
  const batch = batchFacts(previous.input)
  const scope = inputScope(transaction, {
    run: previous.run,
    backend: previous.backend,
    crossVendor: followUp.crossVendor,
  })
  admitInput(transaction, scope, previous.input)
  const { needs } = ObserverOutput.parse(previous.output)
  const input: ObserverInput = {
    ...previous.input,
    materials: resolveObserverNeeds(transaction, scope, needs, followUp.limits),
  }
  transaction.observerCalls.start({ id: followUp.id, backend: previous.backend, input, at: followUp.at })
  if (transaction.interpretations.handover(previous.id, followUp.id) !== batch.length) {
    throw new Error(`observer call ${previous.id} no longer owns its batch`)
  }
  return input
}

export const endObserverCalls = (
  transaction: Transaction,
  run: RunId,
  facts: readonly FactId[],
  at: EpochNs,
  message: string,
): void => {
  const leaving = new Set(facts)
  const calls = new Set(
    transaction.interpretations
      .ofRun(run)
      .flatMap(({ fact, status, observer_call: call }) =>
        status === 'in_call' && call !== null && leaving.has(fact) ? [call] : [],
      ),
  )
  for (const call of calls) {
    transaction.interpretations.settle(call, 'pending')
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
  if (
    parsed.success &&
    parsed.data.base_version === call.base_version &&
    parsed.data.needs.length > 0 &&
    call.input.materials.length === 0
  ) {
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
    delay_ms: rejected ? null : batchDelay(transaction, call.input, response.at),
    at: response.at,
  })
  return rejected ? { status: 'rejected', rejections: context.rejections } : { status: 'accepted', version }
}
