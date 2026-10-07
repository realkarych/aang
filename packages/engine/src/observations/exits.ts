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

const pidOf = ({ fact, raw }: Evidence): number | null => {
  if (fact.kind === 'process_exited') {
    return fact.payload.pid
  }
  if (fact.kind === 'json_snapshot' && fact.payload.file === 'registry') {
    return fact.payload.content?.pid ?? null
  }
  const pid = raw.hook?.env.CLAUDE_PID
  return pid !== undefined && decimal.test(pid) ? Number(pid) : null
}

const earliest = (times: readonly EpochNs[]): EpochNs | null =>
  times.reduce<EpochNs | null>((first, at) => (first === null || at < first ? at : first), null)

export const processExits = (items: readonly Evidence[]): ProcessExit[] => {
  const signs = items.flatMap((item): ProcessSign[] => {
    const pid = pidOf(item)
    return pid === null ? [] : [{ pid, at: item.fact.at }]
  })
  return ofKind(items, 'process_exited')
    .map((evidence): ProcessExit => {
      const { pid, started_at: startedAt } = evidence.fact.payload
      const exitedAt = evidence.fact.at
      const start = startedAt ?? earliest(signs.filter((sign) => sign.pid === pid).map(({ at }) => at)) ?? exitedAt
      const next = earliest(signs.filter((sign) => sign.pid !== pid && sign.at > start).map(({ at }) => at))
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
