import type { ScopeDecision, SessionKey, StreamKey } from '@aang/contract'
import type { SessionDecision, Store, Transaction } from '@aang/store'
import { streamOwner } from '../observations/sources.js'
import { prunedSession } from './prune.js'
import { type Adapters, sessionName } from './records.js'
import { createScopeJudge, type WatchedRoots } from './scope.js'

export interface WatchChange {
  readonly rescan: readonly StreamKey[]
}

export const judgeAgain = async (store: Store, watch: WatchedRoots): Promise<SessionDecision[]> => {
  const judge = createScopeJudge(watch)
  const verdicts = new Map<string, Promise<ScopeDecision>>()
  const changed: SessionDecision[] = []
  for (const decision of store.scopes.sessions()) {
    const { cwd, scope } = decision
    if (scope === 'observer' || cwd === null) {
      continue
    }
    const verdict = verdicts.get(cwd) ?? judge(cwd)
    verdicts.set(cwd, verdict)
    const judged = await verdict
    if (judged !== scope) {
      changed.push({ ...decision, scope: judged })
    }
  }
  return changed
}

export const applyDecisions = (
  transaction: Transaction,
  adapters: Adapters,
  changed: readonly SessionDecision[],
): void => {
  for (const decision of changed) {
    transaction.scopes.decideSession(decision)
  }
  const excluded = new Set(changed.filter(({ scope }) => scope === 'external').map(({ session }) => sessionName(session)))
  if (excluded.size === 0) {
    return
  }
  const sessionOf = (stream: StreamKey): SessionKey | null => {
    const owner = streamOwner(transaction, adapters, stream)
    if (owner !== null) {
      return owner.session
    }
    const pruned = transaction.pruned.ofStream(stream)
    return pruned === null ? null : prunedSession(pruned)
  }
  for (const { stream, runtime, scope } of transaction.scopes.list()) {
    const session = scope === 'watched' ? sessionOf(stream) : null
    if (session !== null && excluded.has(sessionName(session))) {
      transaction.scopes.decide({ stream, runtime, scope: 'external' })
    }
  }
}

export const externalStreams = (store: Store): StreamKey[] =>
  store.scopes.list().flatMap(({ stream, scope }) => (scope === 'external' ? [stream] : []))
