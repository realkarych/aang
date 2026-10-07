import type { EpochNs, Fact } from '@aang/contract'
import { byTime, type Evidence, isFile } from './evidence.js'

export interface HooksSilence {
  readonly from: EpochNs
  readonly until: EpochNs | null
}

export interface SessionSilence {
  readonly silences: readonly HooksSilence[]
  readonly hooks: readonly EpochNs[]
  readonly awaiting: EpochNs | null
}

const noSilence: SessionSilence = { silences: [], hooks: [], awaiting: null }

export const silenceDeadline = (from: EpochNs, afterMs: number): bigint => from + BigInt(afterMs) * 1_000_000n

const turnOf = ({ runtime_ids: ids }: Fact): string | null => ids.turn_id ?? ids.prompt_id

const opensTurn = (item: Evidence): boolean => {
  const { fact } = item
  return isFile(item) && fact.kind === 'prompt' && fact.speaker === 'human' && fact.payload.origin !== 'command'
}

export const hooksSilence = (
  root: readonly Evidence[],
  items: readonly Evidence[],
  now: EpochNs,
  afterMs: number,
): SessionSilence => {
  const hooks = items.filter(({ raw }) => raw.channel === 'hook').toSorted(byTime).map(({ fact }) => fact)
  const first = hooks[0]?.at
  if (first === undefined) { return noSilence }
  const earlier = new Set<string>()
  const periods = new Map<EpochNs | null, EpochNs>()
  let next = 0
  for (const { fact } of root.filter(opensTurn).toSorted(byTime)) {
    let hook = hooks[next]
    while (hook !== undefined && hook.at < fact.at) {
      const turn = turnOf(hook)
      if (turn !== null) { earlier.add(turn) }
      next += 1
      hook = hooks[next]
    }
    const until = hook?.at ?? null
    const turn = turnOf(fact)
    if (fact.at < first || (turn !== null && earlier.has(turn)) || periods.has(until)) { continue }
    periods.set(until, fact.at)
  }
  const silences: HooksSilence[] = []
  let awaiting: EpochNs | null = null
  for (const [until, from] of periods) {
    if ((until ?? now) >= silenceDeadline(from, afterMs)) {
      silences.push({ from, until })
    } else if (until === null) {
      awaiting = from
    }
  }
  return { silences, hooks: hooks.map(({ at }) => at), awaiting }
}

export const isSilent = (silences: readonly HooksSilence[]): boolean => silences.some(({ until }) => until === null)
