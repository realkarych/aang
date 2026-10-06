import type {
  ActionOutcome,
  AttentionKind,
  BasisKind,
  CriterionStatus,
  Execution,
  Freshness,
  HumanDecision,
  PlanItemStatus,
} from '@aang/contract'
import type { ReactElement } from 'react'
import type { Level } from './lamps.js'

const Glyph = ({ children }: { readonly children: ReactElement | readonly ReactElement[] }): ReactElement => (
  <svg className="glyph" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false">
    {children}
  </svg>
)

const Ring = (): ReactElement => <circle cx="6" cy="6" r="4" fill="none" stroke="currentColor" strokeWidth="1.5" />

const Dot = (): ReactElement => <circle cx="6" cy="6" r="4" fill="currentColor" />

const Triangle = (): ReactElement => (
  <>
    <path d="M6 1.2 11 10.5H1Z" fill="currentColor" />
    <path d="M6 4.6v2.8M6 8.6v.6" stroke="var(--glyph-cut)" strokeWidth="1.3" strokeLinecap="round" />
  </>
)

const Octagon = (): ReactElement => (
  <>
    <path d="M4 1h4l3 3v4l-3 3H4L1 8V4Z" fill="currentColor" />
    <path d="M6 3.4v3.2M6 8.2v.6" stroke="var(--glyph-cut)" strokeWidth="1.4" strokeLinecap="round" />
  </>
)

const Check = (): ReactElement => (
  <path d="M2 6.4 4.8 9 10 3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
)

const Cross = (): ReactElement => (
  <path d="M2.5 2.5 9.5 9.5M9.5 2.5 2.5 9.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
)

const Pause = (): ReactElement => (
  <>
    <Ring />
    <path d="M5 4.3v3.4M7 4.3v3.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </>
)

const Slash = (): ReactElement => (
  <>
    <Ring />
    <path d="M3.3 8.7 8.7 3.3" stroke="currentColor" strokeWidth="1.3" />
  </>
)

const Dashed = (): ReactElement => (
  <circle cx="6" cy="6" r="4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2 1.6" />
)

const Unknown = (): ReactElement => (
  <path
    d="M4.2 4.3a1.9 1.9 0 1 1 2.6 1.8c-.5.2-.8.6-.8 1.1v.4M6 9.4v.3"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
  />
)

const Gap = (): ReactElement => (
  <path d="M1.5 6h3M7.5 6h3M4.5 3.5v5M7.5 3.5v5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
)

export const LevelGlyph = ({ level }: { readonly level: Level }): ReactElement => (
  <Glyph>{level === 'warning' ? <Octagon /> : level === 'caution' ? <Triangle /> : <Ring />}</Glyph>
)

export const ExecutionGlyph = ({ execution }: { readonly execution: Execution }): ReactElement => {
  switch (execution.state) {
    case 'running':
      return <Glyph><Dot /></Glyph>
    case 'waiting':
      return <Glyph><Pause /></Glyph>
    case 'done':
      return <Glyph><Check /></Glyph>
    case 'failed':
      return <Glyph><Cross /></Glyph>
    case 'cancelled':
      return <Glyph><Slash /></Glyph>
    case 'planned':
      return <Glyph><Dashed /></Glyph>
    case 'unknown':
      return <Glyph><Unknown /></Glyph>
  }
}

export const FreshnessGlyph = ({ freshness }: { readonly freshness: Freshness }): ReactElement => {
  switch (freshness) {
    case 'ok':
      return <Glyph><Dot /></Glyph>
    case 'quiet':
      return <Glyph><Ring /></Glyph>
    case 'lost':
      return <Glyph><Gap /></Glyph>
    case 'hooks_inactive':
      return <Glyph><Triangle /></Glyph>
  }
}

const Lock = (): ReactElement => (
  <>
    <path d="M3.8 5.2V3.9a2.2 2.2 0 0 1 4.4 0v1.3" fill="none" stroke="currentColor" strokeWidth="1.4" />
    <rect x="2.2" y="5.2" width="7.6" height="5.6" rx="1" fill="currentColor" />
  </>
)

const Eye = (): ReactElement => (
  <>
    <path d="M1 6c1.4-2.4 3.1-3.6 5-3.6S9.6 3.6 11 6c-1.4 2.4-3.1 3.6-5 3.6S2.4 8.4 1 6Z" fill="none" stroke="currentColor" strokeWidth="1.3" />
    <circle cx="6" cy="6" r="1.5" fill="currentColor" />
  </>
)

export const AttentionGlyph = ({ kind }: { readonly kind: AttentionKind }): ReactElement => {
  switch (kind) {
    case 'permission':
      return <Glyph><Lock /></Glyph>
    case 'question':
      return <Glyph><Unknown /></Glyph>
    case 'review_request':
      return <Glyph><Eye /></Glyph>
    case 'blocker':
      return <Glyph><Octagon /></Glyph>
    case 'failed_check':
      return <Glyph><Cross /></Glyph>
  }
}

const Clock = (): ReactElement => (
  <>
    <Ring />
    <path d="M6 3.8V6l1.6 1.1" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </>
)

const FanOut = (): ReactElement => (
  <>
    <path d="M2.4 6 9.4 2.8M2.4 6l7 3.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
    <circle cx="2.4" cy="6" r="1.7" fill="currentColor" />
    <circle cx="9.6" cy="2.8" r="1.5" fill="currentColor" />
    <circle cx="9.6" cy="9.2" r="1.5" fill="currentColor" />
  </>
)

const Seen = (): ReactElement => (
  <>
    <Ring />
    <path d="M4.3 6.1 5.5 7.3l2.3-2.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </>
)

const EyeOff = (): ReactElement => (
  <>
    <Eye />
    <path d="M1.8 10.6 10.2 1.4" stroke="var(--glyph-cut)" strokeWidth="2.6" />
    <path d="M1.8 10.6 10.2 1.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </>
)

const Stop = (): ReactElement => <rect x="2.6" y="2.6" width="6.8" height="6.8" rx="1" fill="currentColor" />

const Spark = (): ReactElement => (
  <path d="M6 1.2 7.3 4.7 10.8 6 7.3 7.3 6 10.8 4.7 7.3 1.2 6 4.7 4.7Z" fill="currentColor" />
)

const Minus = (): ReactElement => (
  <>
    <Ring />
    <path d="M4 6h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </>
)

export type ZoneMark = 'age' | 'blocks' | 'viewed' | 'hidden' | 'ended' | 'recommended' | 'likely' | 'dismissed'

export const ZoneGlyph = ({ mark }: { readonly mark: ZoneMark }): ReactElement => {
  switch (mark) {
    case 'age':
      return <Glyph><Clock /></Glyph>
    case 'blocks':
      return <Glyph><FanOut /></Glyph>
    case 'viewed':
      return <Glyph><Seen /></Glyph>
    case 'hidden':
      return <Glyph><EyeOff /></Glyph>
    case 'ended':
      return <Glyph><Stop /></Glyph>
    case 'recommended':
      return <Glyph><Spark /></Glyph>
    case 'likely':
      return <Glyph><Check /></Glyph>
    case 'dismissed':
      return <Glyph><Minus /></Glyph>
  }
}

export const OutcomeGlyph =({ outcome }: { readonly outcome: ActionOutcome }): ReactElement => {
  switch (outcome) {
    case 'ok':
      return <Glyph><Check /></Glyph>
    case 'error':
      return <Glyph><Cross /></Glyph>
    case 'denied':
      return <Glyph><Octagon /></Glyph>
    case 'interrupted':
      return <Glyph><Slash /></Glyph>
    case 'unknown':
      return <Glyph><Unknown /></Glyph>
  }
}

export const DecisionGlyph = ({ decision }: { readonly decision: HumanDecision }): ReactElement => {
  switch (decision) {
    case 'requested':
      return <Glyph><Pause /></Glyph>
    case 'approved':
    case 'answered':
      return <Glyph><Check /></Glyph>
    case 'rejected':
      return <Glyph><Cross /></Glyph>
    case 'none':
      return <Glyph><Ring /></Glyph>
    case 'unknown':
      return <Glyph><Unknown /></Glyph>
  }
}

export const PlanItemGlyph = ({ status }: { readonly status: PlanItemStatus }): ReactElement => {
  switch (status) {
    case 'pending':
      return <Glyph><Dashed /></Glyph>
    case 'in_progress':
      return <Glyph><Dot /></Glyph>
    case 'completed':
      return <Glyph><Check /></Glyph>
    case 'cancelled':
      return <Glyph><Slash /></Glyph>
    case 'unknown':
      return <Glyph><Unknown /></Glyph>
  }
}

const Said = (): ReactElement => (
  <path d="M1.8 2.2h8.4v5.6H5.4L2.8 10V7.8h-1Z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
)

const Derived = (): ReactElement => (
  <>
    <path d="M6 1.4 10.6 6 6 10.6 1.4 6Z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    <circle cx="6" cy="6" r="1.3" fill="currentColor" />
  </>
)

const Half = (): ReactElement => (
  <>
    <Ring />
    <path d="M6 2a4 4 0 0 1 0 8Z" fill="currentColor" />
  </>
)

const Pinless = (): ReactElement => (
  <>
    <Dashed />
    <path d="M3.9 6.2 5.4 7.6 8.2 4.6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </>
)

export const CriterionGlyph = ({ status }: { readonly status: CriterionStatus }): ReactElement => {
  switch (status) {
    case 'confirmed':
      return <Glyph><Check /></Glyph>
    case 'passed_unversioned':
      return <Glyph><Pinless /></Glyph>
    case 'partial':
      return <Glyph><Half /></Glyph>
    case 'failed':
      return <Glyph><Cross /></Glyph>
    case 'stale':
      return <Glyph><Triangle /></Glyph>
    case 'reported_done':
      return <Glyph><Said /></Glyph>
    case 'not_checked':
      return <Glyph><Dashed /></Glyph>
  }
}

export const BasisGlyph = ({ basis }: { readonly basis: BasisKind }): ReactElement => {
  switch (basis) {
    case 'observed':
      return <Glyph><Eye /></Glyph>
    case 'claimed':
      return <Glyph><Said /></Glyph>
    case 'interpreted':
      return <Glyph><Derived /></Glyph>
  }
}

export const DisclosureGlyph = ({ open }: { readonly open: boolean }): ReactElement => (
  <Glyph>
    <path
      d={open ? 'M2.5 4.2 6 7.8l3.5-3.6' : 'M4.2 2.5 7.8 6l-3.6 3.5'}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </Glyph>
)

export const HandoverGlyph = (): ReactElement => (
  <Glyph>
    <path
      d="M1.5 3.5h6.5M6 1.5l2 2-2 2M10.5 8.5H4M6 6.5l-2 2 2 2"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </Glyph>
)
