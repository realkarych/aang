import type { AttentionItem, Stage } from '@aang/contract'
import type { ReactElement } from 'react'
import { BasisBadge, ExecutionBadge } from './badges.js'
import { attentionKindLabel } from './labels.js'
import { fullHint, shortIds, useKnownAgents } from './short-ids.js'

export const StageSummary = ({
  stage,
  open,
  onClear,
}: {
  readonly stage: Stage
  readonly open: readonly AttentionItem[]
  readonly onClear: () => void
}): ReactElement => {
  const agents = useKnownAgents()
  return (
    <section className="stage-summary" aria-label="Selected stage">
      <header className="stage-summary-head">
        <h2 className="stage-summary-title" title={fullHint(stage.title, agents)}>
          {shortIds(stage.title, agents)}
        </h2>
        <button type="button" className="stage-summary-clear" onClick={onClear}>
          Whole run
        </button>
      </header>
      <p className="stage-summary-axes">
        <span className="visually-hidden">Execution: </span>
        <ExecutionBadge execution={stage.execution.value} />
        <span className="visually-hidden">Basis: </span>
        <BasisBadge basis={stage.execution.basis} />
      </p>
      {stage.summary === null ? null : <p className="stage-summary-text">{stage.summary}</p>}
      {open.length === 0 ? null : (
        <ul className="stage-summary-waiting" aria-label="Waiting for you">
          {open.map((item) => (
            <li key={item.id}>{`${attentionKindLabel[item.kind]}: ${item.text}`}</li>
          ))}
        </ul>
      )}
    </section>
  )
}
