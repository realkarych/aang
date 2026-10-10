import type { EpochNs } from '@aang/contract'
import { byTime, type Evidence, type KindEvidence, ofKind } from './evidence.js'

export interface ProcessExit {
  readonly evidence: KindEvidence<'process_exited'>
  readonly cut: EpochNs
  readonly current: boolean
}

interface ProcessSign {
  readonly pid: number
  readonly at: EpochNs
}

const decimal = /^\d+$/

const signOf = ({ fact, raw }: Evidence): ProcessSign | null => {
  if (fact.kind === 'process_exited') {
    const { pid, started_at: startedAt } = fact.payload
    return startedAt === null ? null : { pid, at: startedAt }
  }
  if (fact.kind === 'json_snapshot' && fact.payload.file === 'registry') {
    const pid = fact.payload.content?.pid ?? null
    return pid === null ? null : { pid, at: fact.at }
  }
  const pid = raw.hook?.env.CLAUDE_PID
  return pid !== undefined && decimal.test(pid) ? { pid: Number(pid), at: fact.at } : null
}

const launches = (items: readonly Evidence[]): Map<number, EpochNs> => {
  const first = new Map<number, EpochNs>()
  for (const item of items) {
    const sign = signOf(item)
    if (sign === null) {
      continue
    }
    const known = first.get(sign.pid)
    if (known === undefined || sign.at < known) {
      first.set(sign.pid, sign.at)
    }
  }
  return first
}

const earliest = (times: readonly EpochNs[]): EpochNs | null =>
  times.reduce<EpochNs | null>((first, at) => (first === null || at < first ? at : first), null)

export const processExits = (items: readonly Evidence[]): ProcessExit[] => {
  const launched = launches(items)
  return ofKind(items, 'process_exited')
    .map((evidence): ProcessExit => {
      const { pid } = evidence.fact.payload
      const exitedAt = evidence.fact.at
      const start = launched.get(pid) ?? exitedAt
      const next = earliest([...launched].flatMap(([other, at]) => (other !== pid && at > start ? [at] : [])))
      return {
        evidence,
        cut: next !== null && next < exitedAt ? next : exitedAt,
        current: next === null || next > exitedAt,
      }
    })
    .sort((left, right) => (left.cut < right.cut ? -1 : left.cut > right.cut ? 1 : byTime(left.evidence, right.evidence)))
}

export const exitAfter = (exits: readonly ProcessExit[], at: EpochNs): ProcessExit | null =>
  exits.find(({ cut }) => at < cut) ?? null
