import type { AgentKey, Fact, FactKind, FactOf, RawRecord, SessionKey } from '@aang/contract'
import { canonicalJson } from '@aang/contract/ids'
import type { FactReader, RawRecordReader } from '@aang/store'

export interface ObservationSource {
  readonly facts: FactReader
  readonly rawRecords: RawRecordReader
}

export interface Evidence {
  readonly fact: Fact
  readonly raw: RawRecord
}

export const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)

export const byTime = (left: Evidence, right: Evidence): number =>
  left.fact.at < right.fact.at
    ? -1
    : left.fact.at > right.fact.at
      ? 1
      : compareText(left.fact.id, right.fact.id)

export const isFile = ({ raw }: Evidence): boolean =>
  raw.channel === 'transcript' || raw.channel === 'rollout'

export const byContent = (left: Evidence, right: Evidence): number =>
  Number(isFile(right)) - Number(isFile(left)) || byTime(left, right)

export const sessionEvidence = (source: ObservationSource, key: SessionKey): Evidence[] => {
  const raws = new Map<number, RawRecord>()
  return source.facts
    .ofSession(key)
    .map((fact) => {
      const raw = raws.get(fact.seq) ?? source.rawRecords.get(fact.seq)
      if (raw === null) {
        throw new Error(`missing raw record ${String(fact.seq)}`)
      }
      raws.set(fact.seq, raw)
      return { fact, raw }
    })
    .sort(byTime)
}

export const agentKey = (fact: Fact): AgentKey => {
  const key = fact.entity_key
  if (key.kind === 'agent') {
    return key
  }
  const { agent_id: agent, thread_id: thread } = fact.runtime_ids
  return {
    kind: 'agent',
    runtime: key.runtime,
    session: key.session,
    agent:
      key.runtime === 'codex' && thread !== null && thread !== key.session
        ? { kind: 'thread', thread_id: thread }
        : agent !== null
          ? key.runtime === 'codex'
            ? { kind: 'thread', thread_id: agent }
            : { kind: 'subagent', agent_id: agent }
          : { kind: 'main' },
  }
}

export const grouped = <T>(items: readonly T[], keyOf: (item: T) => string): Map<string, [T, ...T[]]> => {
  const groups = new Map<string, [T, ...T[]]>()
  for (const item of items) {
    const key = keyOf(item)
    const group = groups.get(key)
    if (group === undefined) {
      groups.set(key, [item])
    } else {
      group.push(item)
    }
  }
  return groups
}

export const entityEvidence = (items: readonly Evidence[]): Map<string, [Evidence, ...Evidence[]]> =>
  grouped(items, ({ fact }) => canonicalJson(fact.entity_key))

export type KindEvidence<K extends FactKind> = Evidence & { readonly fact: FactOf<K> }

export const ofKind = <K extends FactKind>(items: readonly Evidence[], kind: K): KindEvidence<K>[] =>
  items.filter((item): item is KindEvidence<K> => item.fact.kind === kind)
