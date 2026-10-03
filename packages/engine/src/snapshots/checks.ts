import type { ActionKey } from '@aang/contract'
import { canonicalJson, objectId } from '@aang/contract/ids'
import type { Transaction } from '@aang/store'
import type { ContractCatalog } from '../checks/catalog.js'
import { matchedStarts } from '../checks/results.js'
import { rootSessionOf, sessionRun } from '../observations/runs.js'
import type { SnapshotRequest } from './take.js'

const directory = (path: string | null): string | null => (path === '' ? null : path)

const checkRequests = (transaction: Transaction, key: ActionKey, catalog: ContractCatalog): SnapshotRequest[] => {
  const action = transaction.observations.getAction(objectId(key))
  const session = action === null ? null : transaction.observations.getSession(action.session)
  if (action === null || session === null || action.inherited || action.action_kind !== 'command') {
    return []
  }
  const run = sessionRun(transaction, session.key)
  const root = rootSessionOf(transaction, run, session)
  const rootCwd = directory(root?.cwd ?? null)
  if (root === null || rootCwd === null) {
    return []
  }
  const facts = transaction.facts.ofEntity(key)
  return catalog.contractsFor(rootCwd).flatMap((contract) => {
    const [start] = matchedStarts(facts, contract)
    return start === undefined
      ? []
      : [
          {
            run,
            root: root.key,
            cwd: directory(start.runtime_env.cwd) ?? directory(session.cwd) ?? rootCwd,
            maskRoot: contract.root,
            masks: contract.inputMasks,
            trigger: 'check',
          } satisfies SnapshotRequest,
        ]
  })
}

export const checkSnapshots = (
  transaction: Transaction,
  actions: Iterable<ActionKey>,
  catalog: ContractCatalog,
): SnapshotRequest[] => {
  if (catalog.empty) {
    return []
  }
  const requests = new Map<string, SnapshotRequest>()
  for (const key of actions) {
    for (const request of checkRequests(transaction, key, catalog)) {
      requests.set(canonicalJson([request.run, request.cwd, request.maskRoot, [...request.masks]]), request)
    }
  }
  return [...requests.values()]
}
