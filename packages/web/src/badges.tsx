import type {
  Action,
  ActionOutcome,
  Basis,
  Execution,
} from '@catacomb/contract'
import type { ReactElement } from 'react'
import {
  BasisGlyph,
  ExecutionGlyph,
  OutcomeGlyph,
} from './glyphs.js'
import {
  basisLabel,
  executionLabel,
  interpreterLabel,
  outcomeLabel,
} from './labels.js'

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

export const ExecutionBadge = ({ execution }: { readonly execution: Execution }): ReactElement => (
  <span className="badge" data-tone={executionTone(execution)}>
    <ExecutionGlyph execution={execution} />
    {executionLabel(execution)}
  </span>
)

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
