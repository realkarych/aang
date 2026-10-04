import type { Execution, Freshness } from '@aang/contract'
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
