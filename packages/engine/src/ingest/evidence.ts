import type { RecordOwner, SessionKey } from '@aang/contract'

export interface Evidence {
  readonly session: SessionKey
  readonly observer: boolean
  readonly start: string | null
  readonly fallback: string | null
  readonly since: number
}

export const noEvidence = (session: SessionKey, since: number): Evidence => ({
  session,
  observer: false,
  start: null,
  fallback: null,
  since,
})

export const withOwner = (evidence: Evidence, owner: RecordOwner, readFromStart: boolean): Evidence => {
  const rootCwd = owner.thread === 'root' ? owner.cwd : null
  return {
    ...evidence,
    observer: evidence.observer || owner.observer,
    start: evidence.start ?? (owner.start || readFromStart ? rootCwd : null),
    fallback: evidence.fallback ?? rootCwd,
  }
}

export const decidingCwd = (evidence: Evidence, now: number, startGraceMs: number): string | null =>
  evidence.start ?? (now - evidence.since >= startGraceMs ? evidence.fallback : null)
