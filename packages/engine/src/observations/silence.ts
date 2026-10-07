import type { EpochNs, Fact } from '@aang/contract'
import { byTime, type Evidence, isFile } from './evidence.js'

export interface HooksSilence {
  readonly from: EpochNs
  readonly until: EpochNs | null
}

export interface SessionSilence {
  readonly silences: readonly HooksSilence[]
  readonly awaiting: EpochNs | null
}

const noSilence: SessionSilence = { silences: [], awaiting: null }

export const silenceDeadline = (from: EpochNs, afterMs: number): bigint => from + BigInt(afterMs) * 1_000_000n

const turnOf = ({ runtime_ids: ids }: Fact): string | null => ids.turn_id ?? ids.prompt_id

const opensTurn = (item: Evidence): boolean => {
  const { fact } = item
  return isFile(item) && fact.kind === 'prompt' && fact.speaker === 'human' && fact.payload.origin !== 'command'
}

const ascending = (left: EpochNs, right: EpochNs): number => (left < right ? -1 : left > right ? 1 : 0)

export const hooksSilence = (
  root: readonly Evidence[],
  items: readonly Evidence[],
  now: EpochNs,
  afterMs: number,
): SessionSilence => {
  const hooks = items.flatMap(({ fact, raw }) => (raw.channel === 'hook' ? [fact] : []))
  const times = hooks.map(({ at }) => at).sort(ascending)
  const first = times[0]
  if (first === undefined) { return noSilence }
  const turns = new Set(hooks.map(turnOf).filter((turn) => turn !== null))
  const periods = new Map<EpochNs | null, EpochNs>()
  let next = 0
  for (const { fact } of root.filter(opensTurn).toSorted(byTime)) {
    let until = times[next]
    while (until !== undefined && until < fact.at) {
      next += 1
      until = times[next]
    }
    const turn = turnOf(fact)
    if (fact.at < first || (turn !== null && turns.has(turn)) || periods.has(until ?? null)) { continue }
    periods.set(until ?? null, fact.at)
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
  return { silences, awaiting }
}

export const isSilent = (silences: readonly HooksSilence[]): boolean => silences.some(({ until }) => until === null)
