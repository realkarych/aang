import type { Action, ActionOutcome, Execution, Freshness, HumanDecision, RunSummary } from '@aang/contract'
import type { ReactElement } from 'react'
import { DecisionGlyph, ExecutionGlyph, FreshnessGlyph, LevelGlyph, OutcomeGlyph } from './glyphs.js'
import { basisLabel, decisionLabel, executionLabel, freshnessLabel, outcomeLabel } from './labels.js'

type Tone = 'go' | 'ask' | 'hold' | 'done' | 'fail' | 'idle'

const executionTone = (execution: Execution): Tone => {
  switch (execution.state) {
    case 'running':
      return 'go'
    case 'waiting':
      return execution.reason === 'human' ? 'ask' : 'hold'
    case 'done':
      return 'done'
    case 'failed':
      return 'fail'
    case 'planned':
    case 'cancelled':
    case 'unknown':
      return 'idle'
  }
}

const freshnessTone: Readonly<Record<Freshness, Tone>> = {
  ok: 'go',
  quiet: 'hold',
  lost: 'fail',
  hooks_inactive: 'ask',
}

export const ExecutionBadge = ({ execution }: { readonly execution: Execution }): ReactElement => (
  <span className="badge" data-tone={executionTone(execution)}>
    <ExecutionGlyph execution={execution} />
    {executionLabel(execution)}
  </span>
)

export const FreshnessBadge = ({ freshness }: { readonly freshness: Freshness }): ReactElement => (
  <span className="badge" data-tone={freshnessTone[freshness]}>
    <FreshnessGlyph freshness={freshness} />
    {freshnessLabel[freshness]}
  </span>
)

export const AttentionBadge = ({ attention }: { readonly attention: RunSummary['attention'] }): ReactElement => {
  if (attention.waiting_for_human > 0) {
    return (
      <span className="badge" data-tone="ask">
        <LevelGlyph level="caution" />
        {`ждут ответа: ${String(attention.waiting_for_human)}`}
      </span>
    )
  }
  if (attention.open > 0) {
    return (
      <span className="badge" data-tone="hold">
        <LevelGlyph level="normal" />
        {`открыто: ${String(attention.open)}`}
      </span>
    )
  }
  return <span className="quiet">нет</span>
}

const outcomeTone: Readonly<Record<ActionOutcome, Tone>> = {
  ok: 'done',
  error: 'fail',
  denied: 'fail',
  interrupted: 'idle',
  unknown: 'idle',
}

export const ActionBadge = ({ action }: { readonly action: Pick<Action, 'execution' | 'outcome'> }): ReactElement => {
  const { outcome } = action
  if (outcome === null) {
    return <ExecutionBadge execution={action.execution} />
  }
  return (
    <span className="badge" data-tone={outcomeTone[outcome.value]}>
      <OutcomeGlyph outcome={outcome.value} />
      <span className={outcome.value === 'ok' ? 'visually-hidden' : undefined}>{outcomeLabel[outcome.value]}</span>
      {outcome.basis.kind === 'observed' ? null : <span className="badge-basis">{basisLabel[outcome.basis.kind]}</span>}
    </span>
  )
}

const decisionTone: Readonly<Record<HumanDecision, Tone>> = {
  none: 'idle',
  requested: 'ask',
  approved: 'done',
  rejected: 'fail',
  answered: 'done',
  unknown: 'idle',
}

export const DecisionBadge = ({ decision }: { readonly decision: HumanDecision }): ReactElement => (
  <span className="badge" data-tone={decisionTone[decision]}>
    <DecisionGlyph decision={decision} />
    {decisionLabel[decision]}
  </span>
)
