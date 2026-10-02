import type { EpochNs, Freshness, Session, SessionId } from '@aang/contract'
import type { Transaction } from '@aang/store'

export type QuietWatch = Map<SessionId, EpochNs>

const quietAt = (lastEventAt: EpochNs, quietAfterMs: number): bigint => lastEventAt + BigInt(quietAfterMs) * 1_000_000n

export const lostSessions = (transaction: Transaction): ReadonlySet<SessionId> =>
  new Set(transaction.gaps.open('source_lost').flatMap(({ session }) => (session === null ? [] : [session])))

export const freshnessOf = (
  session: Pick<Session, 'state' | 'support_mode' | 'last_event_at'>,
  lost: boolean,
  now: EpochNs,
  quietAfterMs: number,
): Freshness => {
  if (lost) { return 'lost' }
  if (session.support_mode === 'files_only') { return 'hooks_inactive' }
  return session.state === 'turn_running' && now >= quietAt(session.last_event_at, quietAfterMs) ? 'quiet' : 'ok'
}

export const watchQuiet = (watch: QuietWatch, session: Pick<Session, 'id' | 'state' | 'freshness' | 'last_event_at'>): void => {
  if (session.state === 'turn_running' && session.freshness === 'ok') {
    watch.set(session.id, session.last_event_at)
  } else {
    watch.delete(session.id)
  }
}

export const quietWatchOf = (sessions: readonly Session[]): QuietWatch => {
  const watch: QuietWatch = new Map()
  for (const session of sessions) { watchQuiet(watch, session) }
  return watch
}

export const settleQuiet = (transaction: Transaction, watch: QuietWatch, now: EpochNs, quietAfterMs: number): void => {
  for (const [id, lastEventAt] of watch) {
    if (now < quietAt(lastEventAt, quietAfterMs)) { continue }
    watch.delete(id)
    const session = transaction.observations.getSession(id)
    if (session?.freshness !== 'ok') { continue }
    const freshness = freshnessOf(session, false, now, quietAfterMs)
    if (freshness !== session.freshness) { transaction.observations.save({ ...session, freshness }) }
  }
}
