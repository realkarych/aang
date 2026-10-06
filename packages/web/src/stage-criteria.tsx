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
        <th scope="col">Снят</th>
        <th scope="col">Когда</th>
        <th scope="col">HEAD</th>
        <th scope="col">Под масками</th>
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
          <td>{snapshot.head === null ? 'неизвестен' : <code>{shortSha(snapshot.head)}</code>}</td>
          <td data-clean={snapshot.clean}>
            {snapshot.clean ? 'чисто' : 'есть изменения'}
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
        {status.value === 'stale' ? 'Проверен на коммите' : 'Проверенная версия — коммит'} <code>{shortSha(checked)}</code>
        {status.value === 'stale' ? ', текущее состояние уже другое' : null}
      </p>
    )
  }
  if (status.value === 'passed_unversioned') {
    return (
      <p className="criterion-version">
        Проверка прошла, но какую версию она проверила, неизвестно: подтверждением это не считается.
        {clean === null ? null : (
          <>
            {' '}
            Справочно: дерево было чистым на коммите <code>{shortSha(clean)}</code> в обоих снимках.
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
        <p className="criterion-scope">Критерий всего прогона: здесь он показан, потому что к этапу привязана его проверка.</p>
      ) : null}
      <VersionNote criterion={criterion} />
      {snapshots.length === 0 ? null : <Snapshots snapshots={snapshots} label={`Снимки рабочего дерева: ${criterion.text}`} />}
      <Grounds basis={criterion.status.basis} evidence={criterion.status.evidence} label={`Статус критерия «${criterion.text}»`} />
    </li>
  )
}

export const StageCriteria = ({ criteria }: { readonly criteria: readonly CheckedCriterion[] }): ReactElement =>
  criteria.length === 0 ? (
    <p className="section-empty">У этапа нет критериев: их берут из задания, явного плана или контракта проверки.</p>
  ) : (
    <ul className="criteria">
      {criteria.map((checked) => (
        <CriterionItem key={checked.criterion.id} checked={checked} />
      ))}
    </ul>
  )
