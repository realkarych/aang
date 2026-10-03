import {
  type FactId,
  JsonValue,
  type ModelVersion,
  type ObserverCall,
  type ObserverCallId,
  type ObserverCallOutcome,
  type RunId,
} from '@aang/contract'
import type { StoredObserverCall } from '@aang/store'
import { batchFacts } from '../model/observer-context.js'
import { origin, type ReadContext, runOf } from './context.js'

const nanosecondsPerMillisecond = 1_000_000n

const outcomeOf = ({ verdict }: StoredObserverCall): ObserverCallOutcome => {
  switch (verdict) {
    case null:
      return 'running'
    case 'accepted':
      return 'accepted'
    case 'rejected':
      return 'rejected'
  }
}

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

export const observerCallsOf = ({ store }: ReadContext, run: RunId): ObserverCall[] => {
  const calls = store.observerCalls.ofRun(run)
  const attempts = attemptsOf(calls)
  const results = new Map<ObserverCallId, ModelVersion>()
  for (const { observer_call: call, version } of store.model.versions(run, origin)) {
    if (call !== null && !results.has(call)) {
      results.set(call, version)
    }
  }
  return calls.map((call) => ({
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
    outcome: outcomeOf(call),
    error: null,
    rejections: call.reasons,
    output: JsonValue.nullable().catch(null).parse(call.output),
    usage: null,
    started_at: call.started_at,
    ended_at: call.finished_at,
    latency_ms:
      call.finished_at === null ? null : Number((call.finished_at - call.started_at) / nanosecondsPerMillisecond),
    needs_latency_ms: null,
  }))
}

export const runObserverCalls = (context: ReadContext, run: RunId): ObserverCall[] | null =>
  runOf(context.store, run) === null ? null : observerCallsOf(context, run)
