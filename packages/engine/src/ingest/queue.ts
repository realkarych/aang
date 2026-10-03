import type { Fact, FactId, RunId, SessionId } from '@aang/contract'
import type { Transaction } from '@aang/store'
import { factSession } from '../input/scope.js'

export const interpretable = (fact: Fact): boolean => fact.kind !== 'context'

export const queueFacts = (transaction: Transaction, facts: readonly Fact[]): void => {
  const runs = new Map<SessionId, RunId | null>()
  const queued = new Map<RunId, FactId[]>()
  for (const fact of facts.filter(interpretable)) {
    const session = factSession(fact)
    if (!runs.has(session)) {
      runs.set(session, transaction.observations.getSession(session)?.run ?? null)
    }
    const run = runs.get(session) ?? null
    if (run !== null) {
      const ids = queued.get(run) ?? []
      ids.push(fact.id)
      queued.set(run, ids)
    }
  }
  for (const [run, ids] of queued) {
    transaction.interpretations.queue(run, ids)
  }
}
