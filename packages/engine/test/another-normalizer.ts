import { type Fact, FactDraft, NormalizerVersion, type RawRecord } from '@aang/contract'
import { canonicalJson } from '@aang/contract/ids'
import type { Store } from '@aang/store'
import { recordsOf } from './harness.js'

export const anotherVersion = NormalizerVersion.parse(2)

export type AnotherParse = (drafts: readonly FactDraft[], record: RawRecord) => readonly FactDraft[] | 'invalid'

const storedOnly: ReadonlySet<string> = new Set(['id', 'seq', 'normalizer_version'])

export const draftOf = (fact: Fact): FactDraft =>
  FactDraft.parse(Object.fromEntries(Object.entries(fact).filter(([field]) => !storedOnly.has(field))))

export const storeAnotherNormalizer = (store: Store, parse: AnotherParse): void => {
  store.transaction((transaction) => {
    for (const record of recordsOf(store)) {
      const parsed = parse(transaction.facts.ofRecord(record.seq).map(draftOf), record)
      transaction.facts.replace(record.seq, anotherVersion, parsed === 'invalid' ? [] : parsed)
      if (parsed === 'invalid') {
        transaction.rawRecords.setParse(record.seq, 'invalid', null)
      }
    }
  })
}

export const sameFacts: AnotherParse = (drafts) => drafts

export const reversedFactGroups: AnotherParse = (drafts) => {
  const groups = new Map<string, FactDraft[]>()
  for (const draft of drafts) {
    const group = canonicalJson([draft.kind, draft.entity_key])
    groups.set(group, [...(groups.get(group) ?? []), draft])
  }
  return [...groups.values()].reverse().flat()
}
