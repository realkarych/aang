import type { EpochNs, FactId, GapKey, ObserverCallId, RunId } from '@aang/contract'
import { objectId } from '@aang/contract/ids'
import type { GapDraft, PendingFact, Transaction } from '@aang/store'

export interface QueueBounds {
  readonly facts: number
  readonly ageMs: number
}

export interface QueueDeferral {
  readonly run: RunId
  readonly at: EpochNs
  readonly bounds: QueueBounds
}

export interface CallExhaustion {
  readonly call: ObserverCallId
  readonly attempts: number
  readonly at: EpochNs
}

const nanosecondsPerMillisecond = 1_000_000n

const openGap = (transaction: Transaction, draft: GapDraft): void => {
  const current = transaction.gaps.get(objectId(draft.key))
  if (current === null || current.closed_at !== null) {
    transaction.gaps.save(draft)
  }
}

const positive = (value: number): boolean => Number.isSafeInteger(value) && value > 0

export const boundObserverQueue = (transaction: Transaction, { run, at, bounds }: QueueDeferral): PendingFact[] => {
  if (!positive(bounds.facts) || !positive(bounds.ageMs)) {
    throw new RangeError('queue bounds must be positive integers')
  }
  const oldest = at - BigInt(bounds.ageMs) * nanosecondsPerMillisecond
  const queued = transaction.interpretations.pending(run)
  const recent = queued.filter((pending) => pending.at >= oldest)
  const kept = recent.slice(Math.max(recent.length - bounds.facts, 0))
  if (kept.length === queued.length) {
    return queued
  }
  const active = new Set(kept.map(({ fact }) => fact))
  transaction.interpretations.close(
    run,
    queued.flatMap(({ fact }) => (active.has(fact) ? [] : [fact])),
    'deferred',
  )
  const key: GapKey = { kind: 'gap', gap: 'summarized_backlog', subject: run }
  openGap(transaction, {
    key,
    run,
    session: null,
    stream: null,
    details: `facts beyond the active observer queue of ${String(bounds.facts)} facts or ${String(bounds.ageMs)} ms are deferred`,
    detected_at: at,
    closed_at: null,
  })
  return kept
}

export const exhaustObserverCall = (transaction: Transaction, { call, attempts, at }: CallExhaustion): FactId[] => {
  if (!positive(attempts)) {
    throw new RangeError('the attempt limit must be a positive integer')
  }
  const stored = transaction.observerCalls.get(call)
  if (stored === null) {
    throw new Error(`observer call ${call} is missing`)
  }
  const exhausted = transaction.interpretations.exhaust(call, attempts)
  if (exhausted.length > 0) {
    openGap(transaction, {
      key: { kind: 'gap', gap: 'not_interpreted', subject: `${stored.run}:${call}` },
      run: stored.run,
      session: null,
      stream: null,
      details: `${String(exhausted.length)} facts were not interpreted after ${String(attempts)} rejected observer responses`,
      detected_at: at,
      closed_at: null,
    })
  }
  return exhausted
}
