import { type Basis, type JsonValue, type ModelChange, type ModelEntity, ModelOperation, type ObserverCall } from '@aang/contract'
import type { ReactElement } from 'react'
import { absoluteTime } from './format.js'
import { BasisLine, Grounds } from './grounds.js'
import { executionLabel, runtimeLabel } from './labels.js'
import { fullHint, shortIds, useKnownAgents } from './short-ids.js'
import {
  changeAuthorLabel,
  criterionStatusLabel,
  entityKindLabel,
  operationLabel,
  rejectionCauseLabel,
  resolutionLabel,
} from './stage-labels.js'

const lifecycleLabel = (entity: Extract<ModelEntity, { kind: 'stage' }>): string => {
  const { lifecycle } = entity.value
  switch (lifecycle.state) {
    case 'active':
      return 'действует'
    case 'replaced':
      return 'заменён'
    case 'merged':
      return 'объединён'
    case 'split':
      return 'разделён'
  }
}

const transition = (label: string, before: string, after: string): string | null =>
  before === after ? null : `${label}: ${before} → ${after}`

const present = (lines: readonly (string | null)[]): string[] => lines.filter((line): line is string => line !== null)

const stageDetail = (
  before: Extract<ModelEntity, { kind: 'stage' }> | null,
  after: Extract<ModelEntity, { kind: 'stage' }>,
): string[] =>
  before === null
    ? [`«${after.value.title}»`]
    : present([
        transition('название', `«${before.value.title}»`, `«${after.value.title}»`),
        transition('выполнение', executionLabel(before.value.execution.value), executionLabel(after.value.execution.value)),
        transition('жизнь этапа', lifecycleLabel(before), lifecycleLabel(after)),
        before.value.summary !== after.value.summary && after.value.summary !== null
          ? `сводка: ${after.value.summary}`
          : null,
      ])

const detailOf = ({ before, after }: ModelChange): string[] => {
  switch (after?.kind) {
    case 'stage':
      return stageDetail(before?.kind === 'stage' ? before : null, after)
    case 'criterion':
      return [
        before?.kind === 'criterion'
          ? `«${after.value.text}»: ${criterionStatusLabel[before.value.status.value]} → ${criterionStatusLabel[after.value.status.value]}`
          : `«${after.value.text}»`,
      ]
    case 'attention_item':
      return [`«${after.value.text}»: ${resolutionLabel[after.value.resolution]}`]
    case undefined:
      return before === null ? [] : [`${entityKindLabel[before.kind]} удалён из модели`]
    default:
      return []
  }
}

const sameBasis = (left: Basis | null, right: Basis | null): boolean => JSON.stringify(left) === JSON.stringify(right)

const ChangeItem = ({ change, shared }: { readonly change: ModelChange; readonly shared: Basis | null }): ReactElement => {
  const details = detailOf(change)
  const operation = operationLabel[change.op]
  const agents = useKnownAgents()
  return (
    <li className="change">
      <p className="change-head">
        <span className="change-op">{operation}</span>
        <span className="change-target">{entityKindLabel[change.target.kind]}</span>
      </p>
      {details.map((detail) => (
        <p key={detail} className="change-detail" title={fullHint(detail, agents)}>
          {shortIds(detail, agents)}
        </p>
      ))}
      <Grounds
        basis={sameBasis(change.basis, shared) ? null : change.basis}
        evidence={change.evidence}
        label={`Версия ${String(change.version)}, ${operation}`}
      />
    </li>
  )
}

interface VersionGroup {
  readonly version: ModelChange['version']
  readonly author: ModelChange['author']
  readonly changes: readonly ModelChange[]
}

const sharedBasis = ({ changes }: VersionGroup): Basis | null => {
  const [first] = changes
  return first !== undefined && changes.every(({ basis }) => sameBasis(basis, first.basis)) ? first.basis : null
}

const byVersion = (history: readonly ModelChange[]): VersionGroup[] =>
  history.reduce<VersionGroup[]>((groups, change) => {
    const last = groups.at(-1)
    return last !== undefined && last.version === change.version && last.author === change.author
      ? [...groups.slice(0, -1), { ...last, changes: [...last.changes, change] }]
      : [...groups, { version: change.version, author: change.author, changes: [change] }]
  }, [])

export const StageHistory = ({ history }: { readonly history: readonly ModelChange[] }): ReactElement => (
  <ol className="history">
    {byVersion(history).map((group) => {
      const shared = sharedBasis(group)
      return (
        <li key={`${String(group.version)}-${group.author}`} className="version" data-author={group.author}>
          <p className="version-head">
            <span className="version-number">Версия {group.version}</span>
            <span className="version-author">{changeAuthorLabel[group.author]}</span>
            {shared === null ? null : <BasisLine basis={shared} />}
          </p>
          <ol className="version-changes">
            {group.changes.map((change) => (
              <ChangeItem key={`${String(change.version)}-${String(change.index)}`} change={change} shared={shared} />
            ))}
          </ol>
        </li>
      )
    })}
  </ol>
)

const operationAt = (output: JsonValue | null, index: number): string | null => {
  if (output === null || typeof output !== 'object' || Array.isArray(output)) {
    return null
  }
  const ops = output['ops']
  const op = Array.isArray(ops) ? ops[index] : undefined
  if (op === null || typeof op !== 'object' || Array.isArray(op)) {
    return null
  }
  const parsed = ModelOperation.safeParse(op['op'])
  return parsed.success ? operationLabel[parsed.data] : null
}

const RejectedCall = ({ call }: { readonly call: ObserverCall }): ReactElement => (
  <li className="rejected">
    <p className="rejected-head">
      <time dateTime={new Date(Number(call.started_at / 1_000_000n)).toISOString()}>{absoluteTime(call.started_at)}</time>
      <span>
        {runtimeLabel[call.vendor]}
        {call.model === null ? null : <code>{call.model}</code>}
      </span>
      <span>попытка {call.attempt}</span>
      {call.base_version === null ? null : <span>по версии карты {call.base_version}</span>}
    </p>
    <ul className="rejections">
      {call.rejections.map((rejection, index) => {
        const operation = rejection.op_index === null ? null : operationAt(call.output, rejection.op_index)
        return (
          <li key={index}>
            <span className="rejection-cause">{rejectionCauseLabel[rejection.cause]}</span>
            {rejection.op_index === null ? null : (
              <span className="rejection-op">
                операция {rejection.op_index + 1}
                {operation === null ? null : `, ${operation}`}
              </span>
            )}
            <span className="rejection-message">{rejection.message}</span>
          </li>
        )
      })}
    </ul>
  </li>
)

export const RejectedCalls = ({ calls }: { readonly calls: readonly ObserverCall[] }): ReactElement => (
  <>
    <p className="section-lead">Ответ отклонён целиком: проверка демона его не приняла, карта не изменилась.</p>
    <ol className="rejected-calls">
      {calls.map((call) => (
        <RejectedCall key={call.id} call={call} />
      ))}
    </ol>
  </>
)
