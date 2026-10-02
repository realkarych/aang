import type { RecordOwner, SessionKey } from '@aang/contract'

export interface Evidence {
  readonly session: SessionKey
  readonly observer: boolean
  readonly start: string | null
}

export const noEvidence = (session: SessionKey): Evidence => ({
  session,
  observer: false,
  start: null,
})

export const withOwner = (evidence: Evidence, owner: RecordOwner, readFromStart: boolean): Evidence => {
  const rootCwd = owner.thread === 'root' ? owner.cwd : null
  return {
    ...evidence,
    observer: evidence.observer || owner.observer,
    start: evidence.start ?? (owner.start || readFromStart ? rootCwd : null),
  }
}
