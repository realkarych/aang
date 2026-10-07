import type { EpochNs, Freshness, Session, SessionId } from '@aang/contract'
import type { Transaction } from '@aang/store'
import { silenceDeadline } from './silence.js'
import { sourceGaps } from './sources.js'

export interface FreshnessLimits {
  readonly quietAfterMs: number
  readonly hooksInactiveAfterMs: number
}

export interface FreshnessWatch {
  readonly quiet: Map<SessionId, EpochNs>
  readonly hooks: Map<SessionId, EpochNs>
}

export interface WatchedProjection {
  readonly session: Pick<Session, 'id' | 'state' | 'freshness' | 'last_event_at'>
  readonly awaitingHooks: EpochNs | null
}

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

const watchQuiet = (quiet: Map<SessionId, EpochNs>, session: WatchedProjection['session']): void => {
  if (session.state === 'turn_running' && session.freshness === 'ok') {
    quiet.set(session.id, session.last_event_at)
  } else {
    quiet.delete(session.id)
  }
}

export const watchFreshness = (watch: FreshnessWatch, { session, awaitingHooks }: WatchedProjection): void => {
  watchQuiet(watch.quiet, session)
  if (awaitingHooks === null) {
    watch.hooks.delete(session.id)
  } else {
    watch.hooks.set(session.id, awaitingHooks)
  }
}

export const unwatchFreshness = (watch: FreshnessWatch, session: SessionId): void => {
  watch.quiet.delete(session)
  watch.hooks.delete(session)
}

export const copyWatch = (watch: FreshnessWatch): FreshnessWatch => ({
  quiet: new Map(watch.quiet),
  hooks: new Map(watch.hooks),
})

export const freshnessWatchOf = (sessions: readonly Session[]): FreshnessWatch => {
  const watch: FreshnessWatch = { quiet: new Map(), hooks: new Map() }
  for (const session of sessions) { watchQuiet(watch.quiet, session) }
  return watch
}

const settleQuiet = (transaction: Transaction, watch: FreshnessWatch, now: EpochNs, limits: FreshnessLimits): void => {
  for (const [id, lastEventAt] of watch.quiet) {
    if (now < quietAt(lastEventAt, limits.quietAfterMs)) { continue }
    watch.quiet.delete(id)
    const session = transaction.observations.getSession(id)
    if (session?.freshness !== 'ok') { continue }
    const freshness = freshnessOf(session, false, now, limits.quietAfterMs)
    if (freshness !== session.freshness) { transaction.observations.save({ ...session, freshness }) }
  }
}

const settleHooks = (transaction: Transaction, watch: FreshnessWatch, now: EpochNs, limits: FreshnessLimits): void => {
  let lost: ReadonlySet<SessionId> | null = null
  for (const [id, from] of watch.hooks) {
    if (now < silenceDeadline(from, limits.hooksInactiveAfterMs)) { continue }
    watch.hooks.delete(id)
    const session = transaction.observations.getSession(id)
    if (session?.support_mode !== 'full') { continue }
    lost ??= lostSessions(transaction)
    const silent = { ...session, support_mode: 'files_only' } as const
    sourceGaps(transaction, silent, now, [{ from, until: null }], session.support_mode)
    const saved = { ...silent, freshness: freshnessOf(silent, lost.has(id), now, limits.quietAfterMs) }
    transaction.observations.save(saved)
    watchQuiet(watch.quiet, saved)
  }
}

export const settleFreshness = (transaction: Transaction, watch: FreshnessWatch, now: EpochNs, limits: FreshnessLimits): void => {
  settleQuiet(transaction, watch, now, limits)
  settleHooks(transaction, watch, now, limits)
}
