import type { Evidence, Fact, FactId } from '@aang/contract'
import type { FactReader } from '@aang/store'

export type EvidenceReference =
  | { readonly id: FactId; readonly state: 'available'; readonly fact: Fact }
  | { readonly id: FactId; readonly state: 'unavailable' }

export const resolveEvidence = (facts: FactReader, evidence: Evidence): EvidenceReference[] =>
  evidence.map((id): EvidenceReference => {
    const fact = facts.get(id)
    return fact === null ? { id, state: 'unavailable' } : { id, state: 'available', fact }
  })
