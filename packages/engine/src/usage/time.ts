import type { EpochNs, Fact, PromptOrigin } from '@aang/contract'
import type { Evidence } from '../observations/evidence.js'

export interface RunPause {
  readonly started_at: EpochNs
  readonly ended_at: EpochNs
}

export interface RunTime {
  readonly started_at: EpochNs | null
  readonly ended_at: EpochNs | null
  readonly duration_ms: number
  readonly pauses: readonly RunPause[]
}

type TurnMark = 'open' | 'work' | 'close'

const nanosPerMs = 1_000_000n

const openingPrompts: ReadonlySet<PromptOrigin> = new Set(['human', 'task_notification', 'unknown'])

const markOrder: Readonly<Record<TurnMark, number>> = { open: 0, work: 1, close: 2 }

const markOf = (fact: Fact): TurnMark | null => {
  switch (fact.kind) {
    case 'turn_start':
    case 'agent_start':
      return 'open'
    case 'prompt':
      return openingPrompts.has(fact.payload.origin) ? 'open' : null
    case 'message':
      return fact.payload.final ? 'close' : 'work'
    case 'action_start':
    case 'usage':
      return 'work'
    case 'turn_end':
    case 'agent_end':
    case 'session_end':
      return 'close'
    default:
      return null
  }
}

const millisBetween = (from: EpochNs, to: EpochNs): number => Number((to - from) / nanosPerMs)

const earlier = (left: bigint, right: bigint): number => (left < right ? -1 : left > right ? 1 : 0)

export const activeMs = (items: readonly Evidence[]): number => {
  const marks = items
    .flatMap(({ fact }) => {
      const mark = markOf(fact)
      return mark === null ? [] : [{ at: fact.at, mark }]
    })
    .sort((left, right) => earlier(left.at, right.at) || markOrder[left.mark] - markOrder[right.mark])
  let open: EpochNs | null = null
  let total = 0
  for (const { at, mark } of marks) {
    if (mark !== 'close') {
      open ??= at
    } else if (open !== null) {
      total += millisBetween(open, at)
      open = null
    }
  }
  const last = items.reduce<EpochNs | null>((latest, { fact }) => (latest === null || fact.at > latest ? fact.at : latest), null)
  return open === null || last === null ? total : total + millisBetween(open, last)
}

interface SessionSpan {
  readonly started_at: EpochNs
  readonly last_event_at: EpochNs
}

export const runTime = (spans: readonly SessionSpan[], activity: readonly EpochNs[], pauseAfterMs: number): RunTime => {
  const starts = spans.map(({ started_at }) => started_at).sort(earlier)
  const ends = spans.map(({ last_event_at }) => last_event_at).sort(earlier)
  const startedAt = starts[0]
  const endedAt = ends.at(-1)
  if (startedAt === undefined || endedAt === undefined) {
    return { started_at: null, ended_at: null, duration_ms: 0, pauses: [] }
  }
  const instants = [startedAt, ...activity.filter((at) => at > startedAt && at < endedAt), endedAt].sort(earlier)
  const pauses: RunPause[] = []
  instants.forEach((at, index) => {
    const next = instants[index + 1]
    if (next !== undefined && millisBetween(at, next) >= pauseAfterMs) {
      pauses.push({ started_at: at, ended_at: next })
    }
  })
  return { started_at: startedAt, ended_at: endedAt, duration_ms: millisBetween(startedAt, endedAt), pauses }
}
