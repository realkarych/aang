import type { EpochNs, Freshness, Session } from '@aang/contract'
import type { Transaction } from '@aang/store'

export const freshnessOf = (
  transaction: Transaction,
  session: Pick<Session, 'id' | 'state' | 'support_mode' | 'last_event_at'>,
  now: EpochNs,
  quietAfterMs: number,
): Freshness => {
  if (transaction.gaps.ofSession(session.id).some((gap) => gap.kind === 'source_lost' && gap.closed_at === null)) {
    return 'lost'
  }
  if (session.support_mode === 'files_only') { return 'hooks_inactive' }
  return session.state === 'turn_running' && now - session.last_event_at >= BigInt(quietAfterMs) * 1_000_000n
    ? 'quiet'
    : 'ok'
}

export const refreshFreshness = (transaction: Transaction, now: EpochNs, quietAfterMs: number): void => {
  for (const session of transaction.observations.sessions()) {
    const freshness = freshnessOf(transaction, session, now, quietAfterMs)
    if (freshness !== session.freshness) { transaction.observations.save({ ...session, freshness }) }
  }
}
