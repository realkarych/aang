import type { CheckedCriterion, Criterion, GitSnapshot } from '@aang/contract'
import { type ReactElement, useId } from 'react'
import { CriterionBadge } from './badges.js'
import { absoluteTime, clockTime } from './format.js'
import { Grounds } from './grounds.js'
import { criterionSourceLabel, snapshotTriggerLabel } from './stage-labels.js'

const shortSha = (sha: string): string => sha.slice(0, 12)

const Snapshots = ({ snapshots, label }: { readonly snapshots: readonly GitSnapshot[]; readonly label: string }): ReactElement => (
  <table className="snapshots" aria-label={label}>
    <thead>
      <tr>
        <th scope="col">Taken</th>
        <th scope="col">When</th>
        <th scope="col">HEAD</th>
        <th scope="col">Under masks</th>
      </tr>
    </thead>
    <tbody>
      {snapshots.map((snapshot) => (
        <tr key={snapshot.id}>
          <td>
            <time dateTime={new Date(Number(snapshot.taken_at / 1_000_000n)).toISOString()} title={absoluteTime(snapshot.taken_at)}>
              {clockTime(snapshot.taken_at)}
            </time>
          </td>
          <td>{snapshotTriggerLabel[snapshot.trigger]}</td>
          <td>{snapshot.head === null ? 'unknown' : <code>{shortSha(snapshot.head)}</code>}</td>
          <td data-clean={snapshot.clean}>
            {snapshot.clean ? 'clean' : 'has changes'}
            {snapshot.masks.length === 0 ? null : (
              <span className="snapshot-masks">
                {snapshot.masks.map((mask) => (
                  <code key={mask}>{mask}</code>
                ))}
              </span>
            )}
          </td>
        </tr>
      ))}
    </tbody>
  </table>
)

const VersionNote = ({ criterion }: { readonly criterion: Criterion }): ReactElement | null => {
  const { status, checked_commit: checked, clean_tree_commit: clean } = criterion
  if (checked !== null) {
    return (
      <p className="criterion-version">
        {status.value === 'stale' ? 'Checked at commit' : 'Checked version: commit'} <code>{shortSha(checked)}</code>
        {status.value === 'stale' ? ', the current state is already different' : null}
      </p>
    )
  }
  if (status.value === 'passed_unversioned') {
    return (
      <p className="criterion-version">
        The check passed, but which version it checked is unknown: this does not count as confirmation.
        {clean === null ? null : (
          <>
            {' '}
            For reference: the tree was clean at commit <code>{shortSha(clean)}</code> in both snapshots.
          </>
        )}
      </p>
    )
  }
  return null
}

const CriterionItem = ({ checked }: { readonly checked: CheckedCriterion }): ReactElement => {
  const { criterion, snapshots } = checked
  const name = useId()
  return (
    <li className="criterion" aria-labelledby={name}>
      <p id={name} className="criterion-text">
        {criterion.text}
      </p>
      <p className="criterion-state">
        <CriterionBadge status={criterion.status.value} />
        <span className="criterion-source">
          {criterionSourceLabel[criterion.source]}
          {criterion.contract === null ? null : (
            <>
              {' '}
              <code>{criterion.contract}</code>
            </>
          )}
        </span>
      </p>
      {criterion.stage === null ? (
        <p className="criterion-scope">A whole-run criterion: it is shown here because its check is linked to the stage.</p>
      ) : null}
      <VersionNote criterion={criterion} />
      {snapshots.length === 0 ? null : <Snapshots snapshots={snapshots} label={`Working tree snapshots: ${criterion.text}`} />}
      <Grounds basis={criterion.status.basis} evidence={criterion.status.evidence} label={`Status of criterion "${criterion.text}"`} />
    </li>
  )
}

export const StageCriteria = ({ criteria }: { readonly criteria: readonly CheckedCriterion[] }): ReactElement =>
  criteria.length === 0 ? (
    <p className="section-empty">The stage has no criteria: they come from the task, an explicit plan or a check contract.</p>
  ) : (
    <ul className="criteria">
      {criteria.map((checked) => (
        <CriterionItem key={checked.criterion.id} checked={checked} />
      ))}
    </ul>
  )
