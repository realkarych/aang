import type { CollectedGap, EpochNs, StreamKey } from '@aang/contract'
import { describeError } from './errors.js'
import { millisecondsToNs, nowNs } from './time.js'

export interface ReadRetry {
  readonly pauseMs: number
  readonly gapAfterMs: number
}

export interface Backoff {
  readonly since: EpochNs
  attempts: number
  timer: NodeJS.Timeout | undefined
}

export interface Failure extends Backoff {
  gap: CollectedGap | null
}

export interface Failing {
  readonly path: string
  failure: Failure | null
}

export interface Retrier {
  readonly backoff: () => Backoff
  readonly later: (backoff: Backoff, again: () => void) => void
  readonly lasted: (backoff: Backoff) => boolean
  readonly failed: (file: Failing, stream: StreamKey | null, error: unknown, again: () => void) => CollectedGap[]
  readonly recovered: (file: Failing) => CollectedGap[]
}

export const createRetrier = (retry: ReadRetry, maxPauseMs: number): Retrier => {
  const backoff = (): Backoff => ({ since: nowNs(), attempts: 0, timer: undefined })

  const later = (pending: Backoff, again: () => void): void => {
    clearTimeout(pending.timer)
    pending.attempts += 1
    const pause = Math.min(retry.pauseMs * 2 ** (pending.attempts - 1), maxPauseMs)
    pending.timer = setTimeout(again, pause).unref()
  }

  const lasted = (pending: Backoff): boolean => nowNs() - pending.since >= millisecondsToNs(retry.gapAfterMs)

  const failed = (file: Failing, stream: StreamKey | null, error: unknown, again: () => void): CollectedGap[] => {
    const failure = file.failure ?? { ...backoff(), gap: null }
    file.failure = failure
    later(failure, again)
    if (failure.gap !== null || !lasted(failure)) {
      return []
    }
    failure.gap = {
      key: { kind: 'gap', gap: 'read_failed', subject: file.path },
      stream,
      details: describeError(error),
      detected_at: failure.since,
      closed_at: null,
    }
    return [failure.gap]
  }

  const recovered = (file: Failing): CollectedGap[] => {
    const gap = file.failure?.gap ?? null
    clearTimeout(file.failure?.timer)
    file.failure = null
    if (gap === null) {
      return []
    }
    const now = nowNs()
    return [{ ...gap, closed_at: now > gap.detected_at ? now : gap.detected_at }]
  }

  return { backoff, later, lasted, failed, recovered }
}
