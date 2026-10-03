import type { ActionKey, RunId, SessionKey, SnapshotTrigger } from '@aang/contract'
import { canonicalJson, objectId } from '@aang/contract/ids'
import type { Transaction } from '@aang/store'
import type { Contract, ContractCatalog } from '../checks/catalog.js'
import { checkDirectory } from '../checks/history.js'
import { matchedStarts } from '../checks/results.js'
import { rootSessionOf, sessionRun } from '../observations/runs.js'
import type { SnapshotRequest } from './take.js'

export const snapshotRequest = (
  run: RunId,
  root: SessionKey,
  cwd: string,
  contract: Contract,
  trigger: SnapshotTrigger,
): SnapshotRequest => ({ run, root, cwd, maskRoot: contract.root, masks: contract.inputMasks, trigger })

const requestKey = ({ run, cwd, maskRoot, masks }: SnapshotRequest): string =>
  canonicalJson([run, cwd, maskRoot, [...masks]])

export const distinctRequests = (requests: readonly SnapshotRequest[]): SnapshotRequest[] => [
  ...new Map(requests.map((request) => [requestKey(request), request])).values(),
]

const checkRequests = (transaction: Transaction, key: ActionKey, catalog: ContractCatalog): SnapshotRequest[] => {
  const action = transaction.observations.getAction(objectId(key))
  const session = action === null ? null : transaction.observations.getSession(action.session)
  if (action === null || session === null || action.inherited || action.action_kind !== 'command') {
    return []
  }
  const run = sessionRun(transaction, session.key)
  const root = rootSessionOf(transaction, run, session)
  const facts = transaction.facts.ofEntity(key)
  const cwd = root === null ? null : checkDirectory(transaction, { action, facts }, root)
  if (root?.cwd === null || root?.cwd === undefined || root.cwd === '' || cwd === null) {
    return []
  }
  return catalog
    .contractsFor(root.cwd)
    .flatMap((contract) =>
      matchedStarts(facts, contract).length === 0 ? [] : [snapshotRequest(run, root.key, cwd, contract, 'check')],
    )
}

export const checkSnapshots = (
  transaction: Transaction,
  actions: Iterable<ActionKey>,
  catalog: ContractCatalog,
): SnapshotRequest[] =>
  catalog.empty ? [] : distinctRequests([...actions].flatMap((key) => checkRequests(transaction, key, catalog)))
