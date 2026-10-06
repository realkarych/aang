import type {
  Action,
  ActionOutcome,
  Basis,
  CriterionStatus,
  Execution,
  Freshness,
  HumanDecision,
  RunSummary,
} from '@aang/contract'
import type { ReactElement } from 'react'
import {
  BasisGlyph,
  CriterionGlyph,
  DecisionGlyph,
  ExecutionGlyph,
  FreshnessGlyph,
  LevelGlyph,
  OutcomeGlyph,
} from './glyphs.js'
import {
  basisLabel,
  decisionLabel,
  executionLabel,
  freshnessLabel,
  interpreterLabel,
  outcomeLabel,
} from './labels.js'
import { criterionStatusLabel } from './stage-labels.js'

type Tone = 'go' | 'ask' | 'hold' | 'done' | 'fail' | 'idle'

export const executionTone = (execution: Execution): Tone => {
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

const BasisNote = ({ basis }: { readonly basis: Basis }): ReactElement | null =>
  basis.kind === 'observed' ? null : <span className="badge-basis">{basisLabel[basis.kind]}</span>

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
      <BasisNote basis={outcome.basis} />
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

export const DecisionBadge = ({
  decision,
  basis,
}: {
  readonly decision: HumanDecision
  readonly basis?: Basis
}): ReactElement => (
  <span className="badge" data-tone={decisionTone[decision]}>
    <DecisionGlyph decision={decision} />
    {decisionLabel[decision]}
    {basis === undefined ? null : <BasisNote basis={basis} />}
  </span>
)

export const BasisBadge = ({ basis }: { readonly basis: Basis }): ReactElement => (
  <span
    className="badge"
    data-tone="basis"
    title={basis.kind === 'interpreted' ? interpreterLabel(basis.interpreter) : undefined}
  >
    <BasisGlyph basis={basis.kind} />
    {basisLabel[basis.kind]}
  </span>
)

const criterionTone: Readonly<Record<CriterionStatus, Tone>> = {
  not_checked: 'idle',
  confirmed: 'done',
  passed_unversioned: 'hold',
  partial: 'hold',
  failed: 'fail',
  stale: 'ask',
  reported_done: 'idle',
}

export const CriterionBadge = ({ status }: { readonly status: CriterionStatus }): ReactElement => (
  <span className="badge" data-tone={criterionTone[status]}>
    <CriterionGlyph status={status} />
    {criterionStatusLabel[status]}
  </span>
)
