import type { EpochNs, RunId, SnapshotTrigger } from '@aang/contract'
import type { Store, Transaction } from '@aang/store'
import type { ContractCatalog } from '../checks/catalog.js'
import { storedRunChecks } from '../checks/history.js'
import { sessionRun } from '../observations/runs.js'
import { distinctRequests, snapshotRequest } from '../snapshots/checks.js'
import { recordSnapshot } from '../snapshots/record.js'
import { type SnapshotRequest, takeSnapshot, type TakenSnapshot } from '../snapshots/take.js'
import { createGitResolver, type ResolvedCheck } from './git.js'
import { type CriterionCheck, latestChecks } from './plan.js'
import { isVersioned, reconcileCriteria } from './status.js'
import { createTreeWatch, maskTargets } from './watch.js'

export interface CriteriaMonitor {
  readonly settle: (requests: readonly SnapshotRequest[], checks: readonly CriterionCheck[]) => Promise<void>
  readonly recheck: (runs: ReadonlySet<RunId> | null, trigger: SnapshotTrigger) => Promise<void>
  readonly close: () => void
}

export interface CriteriaMonitorOptions {
  readonly store: Store
  readonly catalog: ContractCatalog
  readonly now: () => EpochNs
  readonly fsWatch: boolean
  readonly onTreeChange: (runs: ReadonlySet<RunId>) => void
}

const treeSettleMs = 100

export const versionedSnapshots = (
  transaction: Transaction,
  checks: readonly CriterionCheck[],
  trigger: SnapshotTrigger,
): SnapshotRequest[] =>
  distinctRequests(
    checks.flatMap((check) =>
      check.result.passed && check.commit !== null && check.directory !== null && isVersioned(transaction, check)
        ? [snapshotRequest(check.run, check.root, check.directory, check.contract, trigger)]
        : [],
    ),
  )

const versionedRuns = (transaction: Transaction): RunId[] =>
  [...new Set(transaction.observations.sessions().map(({ key }) => sessionRun(transaction, key)))].filter((run) =>
    transaction.model
      .entities(run)
      .some(
        (entity) =>
          entity.kind === 'criterion' && entity.value.source === 'contract' && entity.value.checked_commit !== null,
      ),
  )

export const createCriteriaMonitor = ({
  store,
  catalog,
  now,
  fsWatch,
  onTreeChange,
}: CriteriaMonitorOptions): CriteriaMonitor => {
  const git = createGitResolver()
  const trees = fsWatch ? createTreeWatch(onTreeChange, treeSettleMs) : null

  const track = (versioned: ReadonlyMap<RunId, readonly ResolvedCheck[]>): void => {
    for (const [run, entries] of versioned) {
      trees?.track(
        run,
        entries.flatMap(({ check, git: { worktree } }) =>
          worktree === null ? [] : maskTargets(worktree, check.contract.root, check.contract.inputMasks),
        ),
      )
    }
  }

  const settle = async (requests: readonly SnapshotRequest[], checks: readonly CriterionCheck[]): Promise<void> => {
    const taken: TakenSnapshot[] = []
    for (const request of requests) {
      const snapshot = await takeSnapshot(request, now)
      if (snapshot !== null) {
        taken.push(snapshot)
      }
    }
    const resolved = await git.resolve(checks)
    if (taken.length === 0 && resolved.length === 0) {
      return
    }
    track(
      store.transaction((transaction) => {
        for (const snapshot of taken) {
          recordSnapshot(transaction, snapshot)
        }
        return reconcileCriteria(transaction, resolved)
      }),
    )
  }

  return {
    settle,
    recheck: async (runs, trigger) => {
      if (catalog.empty) {
        return
      }
      const { requests, checks } = store.transaction((transaction) => {
        const selected = latestChecks(transaction, storedRunChecks(transaction, runs ?? versionedRuns(transaction), catalog))
        return { requests: versionedSnapshots(transaction, selected, trigger), checks: selected }
      })
      await settle(requests, checks)
    },
    close: () => {
      trees?.close()
    },
  }
}
