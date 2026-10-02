import {
  type EpochNs,
  ModelVersion,
  type ObserverCallId,
  type ObserverOp,
  ObserverOutput,
  type ObserverRejection,
} from '@aang/contract'
import type { ObserverCallStart, Transaction } from '@aang/store'
import { applyChangeSet } from './journal.js'
import {
  batchFacts,
  factBelongsToRun,
  ObserverContext,
  OperationRejection,
  type ValidationLimits,
} from './observer-context.js'
import { planOperation } from './observer-operations.js'

export interface ObserverResponse {
  readonly call: ObserverCallId
  readonly output: unknown
  readonly at: EpochNs
  readonly limits?: ValidationLimits
}

export type ObserverResponseResult =
  | { readonly status: 'accepted'; readonly version: ModelVersion }
  | { readonly status: 'rejected'; readonly rejections: readonly ObserverRejection[] }

export const beginObserverCall = (transaction: Transaction, call: ObserverCallStart): void => {
  const { input, id } = call
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
  const facts = batchFacts(input)
  if (facts.length === 0) {
    throw new Error('observer calls require a nonempty batch')
  }
  for (const id of facts) {
    const fact = transaction.facts.get(id)
    if (fact === null || !factBelongsToRun(transaction, run.id, fact)) {
      throw new Error(`fact ${id} is not in run ${run.id}`)
    }
  }
  transaction.observerCalls.start(call)
  transaction.interpretations.begin(run.id, id, facts)
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
  const context: ObserverContext = new ObserverContext(transaction, call)
  const limits = response.limits ?? { operations: 200, textLength: 16_384 }
  if (![limits.operations, limits.textLength].every((value) => Number.isSafeInteger(value) && value > 0)) {
    throw new RangeError('observer validation limits must be positive integers')
  }
  const parsed = ObserverOutput.safeParse(response.output)
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
  transaction.interpretations.settle(call.id, rejected ? 'pending' : 'interpreted')
  transaction.observerCalls.finish({
    id: call.id,
    output: response.output ?? null,
    verdict: rejected ? 'rejected' : 'accepted',
    reasons: context.rejections,
    at: response.at,
  })
  return rejected ? { status: 'rejected', rejections: context.rejections } : { status: 'accepted', version }
}
