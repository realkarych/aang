import {
  type FactId,
  JsonValue,
  type ModelVersion,
  type ModelVersionRecord,
  type ObserverCall,
  type ObserverCallId,
  type ObserverCallOutcome,
  type RunId,
} from '@aang/contract'
import type { StoredObserverCall } from '@aang/store'
import { batchFacts } from '../model/observer-context.js'
import { origin, type ReadContext, runOf } from './context.js'

const nanosecondsPerMillisecond = 1_000_000n

interface LogicalCall {
  readonly call: StoredObserverCall
  readonly needs: StoredObserverCall | null
}

const outcomeOf = ({ verdict }: StoredObserverCall, holding: boolean): ObserverCallOutcome => {
  switch (verdict) {
    case 'accepted':
    case 'rejected':
      return verdict
    case null:
    case 'needs_requested':
      return holding ? 'running' : 'failed'
  }
}

const logicalCalls = (calls: readonly StoredObserverCall[]): LogicalCall[] => {
  const logical: LogicalCall[] = []
  let waiting: StoredObserverCall | null = null
  for (const call of calls) {
    const followUp = waiting !== null && call.input.materials.length > 0
    if (waiting !== null && !followUp) {
      logical.push({ call: waiting, needs: null })
    }
    if (call.verdict === 'needs_requested') {
      waiting = call
    } else {
      logical.push({ call, needs: followUp ? waiting : null })
      waiting = null
    }
  }
  return waiting === null ? logical : [...logical, { call: waiting, needs: null }]
}

const millisecondsBetween = (start: bigint, end: bigint): number =>
  Number((end - start) / nanosecondsPerMillisecond)

const attemptsOf = (calls: readonly StoredObserverCall[]): Map<ObserverCallId, number> => {
  const rejections = new Map<FactId, number>()
  const attempts = new Map<ObserverCallId, number>()
  for (const call of calls) {
    const facts = batchFacts(call.input)
    attempts.set(call.id, 1 + facts.reduce((most, fact) => Math.max(most, rejections.get(fact) ?? 0), 0))
    if (call.verdict === 'rejected') {
      for (const fact of facts) {
        rejections.set(fact, (rejections.get(fact) ?? 0) + 1)
      }
    }
  }
  return attempts
}

const resultsOf = (
  calls: readonly StoredObserverCall[],
  versions: readonly ModelVersionRecord[],
): Map<ObserverCallId, ModelVersion> => {
  const finished = new Map(calls.map(({ id, change_seq: seq }) => [id, seq]))
  const results = new Map<ObserverCallId, ModelVersion>()
  let current: ObserverCallId | null = null
  for (const { observer_call: call, version, change_seq: seq } of versions) {
    const sameTransaction: boolean = current !== null && seq < (finished.get(current) ?? seq)
    current = call ?? (sameTransaction ? current : null)
    if (current !== null) {
      results.set(current, version)
    }
  }
  return results
}

export const observerCallsOf = ({ store }: ReadContext, run: RunId): ObserverCall[] => {
  const calls = store.observerCalls.ofRun(run)
  const attempts = attemptsOf(calls)
  const results = resultsOf(calls, store.model.versions(run, origin))
  const holders = new Set(
    store.interpretations
      .ofRun(run)
      .flatMap(({ status, observer_call: call }) => (status === 'in_call' && call !== null ? [call] : [])),
  )
  return logicalCalls(calls).map(({ call, needs }): ObserverCall => {
    const holding = holders.has(call.id)
    const started = needs?.started_at ?? call.started_at
    const ended = holding ? null : call.finished_at
    return {
      id: call.id,
      run: call.run,
      kind: 'batch',
      vendor: call.backend,
      cli_version: null,
      model: null,
      base_version: call.base_version,
      result_version: results.get(call.id) ?? null,
      facts: batchFacts(call.input),
      attempt: attempts.get(call.id) ?? 1,
      outcome: outcomeOf(call, holding),
      error: null,
      rejections: call.reasons,
      output: JsonValue.nullable().catch(null).parse(call.output),
      usage: null,
      started_at: started,
      ended_at: ended,
      latency_ms: ended === null ? null : millisecondsBetween(started, ended),
      needs_latency_ms:
        needs === null || call.finished_at === null ? null : millisecondsBetween(call.started_at, call.finished_at),
    }
  })
}

export const runObserverCalls = (context: ReadContext, run: RunId): ObserverCall[] | null =>
  runOf(context.store, run) === null ? null : observerCallsOf(context, run)
