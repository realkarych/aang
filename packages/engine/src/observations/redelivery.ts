import type { DedupeKey, FactId, SessionKey } from '@aang/contract'
import { canonicalJson } from '@aang/contract/ids'
import { compareText, type Evidence, grouped, type ObservationSource, sessionEvidence } from './evidence.js'

export interface HookRedelivery {
  readonly id: DedupeKey
  readonly episodes: readonly DedupeKey[]
  readonly facts: readonly FactId[]
  readonly count: number
  readonly ambiguous: true
}

export const registrationOf = ({ raw }: Evidence): string | null =>
  raw.hook === null ? null : canonicalJson([raw.hook.registration, raw.hook.env.CLAUDE_PLUGIN_ROOT ?? null])

const windowNs = 2_000_000_000n

type Episode = [Evidence, ...Evidence[]]

const withoutOccurrence = ({ fact, raw }: Evidence): boolean =>
  raw.channel === 'hook' &&
  raw.position.kind === 'spool' &&
  fact.redelivery_key !== null &&
  fact.entity_key.kind !== 'action' &&
  (fact.entity_key.kind !== 'question' || fact.entity_key.question === raw.position.file)

export const redeliveries = (evidence: readonly Evidence[]): HookRedelivery[] => {
  const knownOccurrences = new Set(
    evidence
      .filter(({ fact, raw }) => raw.channel === 'hook' && fact.entity_key.kind === 'action')
      .map(({ raw }) => raw.dedupe_key),
  )
  const eligible = evidence.filter(
    (item) => !knownOccurrences.has(item.raw.dedupe_key) && withoutOccurrence(item),
  )
  const groups: HookRedelivery[] = []
  for (const matching of grouped(eligible, ({ fact }) =>
    canonicalJson([fact.kind, fact.redelivery_key]),
  ).values()) {
    const episodes = [...grouped(matching, ({ raw }) => raw.dedupe_key).values()]
    const visited = new Set<Episode>()
    for (const start of episodes) {
      if (visited.has(start)) {
        continue
      }
      const connected: Episode[] = [start]
      visited.add(start)
      for (const episode of connected) {
        const left = episode[0]
        for (const next of episodes) {
          if (visited.has(next)) {
            continue
          }
          const right = next[0]
          const distance = left.raw.observed_at - right.raw.observed_at
          if (
            registrationOf(left) !== registrationOf(right) &&
            distance >= -windowNs &&
            distance <= windowNs
          ) {
            visited.add(next)
            connected.push(next)
          }
        }
      }
      if (connected.length < 2) {
        continue
      }
      const ids = connected.map((episode) => episode[0].raw.dedupe_key).sort(compareText)
      const id = ids[0]
      if (id === undefined) {
        continue
      }
      groups.push({
        id,
        episodes: ids,
        facts: connected.flatMap((episode) => episode.map(({ fact }) => fact.id)).sort(compareText),
        count: ids.length,
        ambiguous: true,
      })
    }
  }
  return groups.sort((left, right) => compareText(left.id, right.id))
}

export const hookRedeliveries = (source: ObservationSource, session: SessionKey): HookRedelivery[] =>
  redeliveries(sessionEvidence(source, session))
