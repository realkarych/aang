import type { RunId, Session, SessionKey } from '@aang/contract'
import { objectId, runId } from '@aang/contract/ids'
import type { Transaction } from '@aang/store'

const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)

export const runOf = (transaction: Transaction, key: SessionKey): RunId =>
  transaction.model.entityRuns({ kind: 'session_membership', id: objectId(key) }).toSorted(compareText)[0] ??
  runId(key)

export const rootSessionOf = (transaction: Transaction, run: RunId, session: Session): Session | null => {
  const entity = transaction.model.entity(run, { kind: 'run', id: run })
  if (entity?.kind === 'run') {
    return transaction.observations.getSession(entity.value.root_session)
  }
  return runId(session.key) === run ? session : null
}
