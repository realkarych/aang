import type { Stage } from '@catacomb/contract'
import type { ReactElement } from 'react'
import { BasisBadge, ExecutionBadge } from './badges.js'
import { attentionKindLabel } from './labels.js'
import type { HeldItem } from './map-graph.js'
import { fullHint, shortIds, useKnownAgents } from './short-ids.js'

export const StageSummary = ({
  stage,
  held,
  onClear,
}: {
  readonly stage: Stage
  readonly held: readonly HeldItem[]
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
          <span aria-hidden="true">✕ </span>
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
      {held.length === 0 ? null : (
        <ul className="stage-summary-waiting" aria-label="Waiting for you">
          {held.map(({ item, within }) => (
            <li key={item.id} title={within === null ? undefined : fullHint(within.title, agents)}>
              {`${within === null ? '' : `${shortIds(within.title, agents)} · `}${attentionKindLabel[item.kind]}: ${item.text}`}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
