import { type ReactElement, useId, useState } from 'react'
import { LevelGlyph } from './glyphs.js'
import { type Lamp, problemsOf } from './lamps.js'

const worst = (lamps: readonly Lamp[]): Lamp['level'] =>
  lamps.some(({ level }) => level === 'warning') ? 'warning' : 'caution'

export const HealthDot = ({ lamps }: { readonly lamps: readonly Lamp[] }): ReactElement | null => {
  const [open, setOpen] = useState(false)
  const panel = useId()
  const problems = problemsOf(lamps)
  if (problems.length === 0) {
    return null
  }
  const level = worst(problems)
  return (
    <div className="health">
      <button
        type="button"
        className="health-dot"
        data-level={level}
        aria-label={`Observation problems: ${String(problems.length)}`}
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => {
          setOpen(!open)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            setOpen(false)
          }
        }}
      >
        <LevelGlyph level={level} />
      </button>
      {open ? (
        <div id={panel} className="health-panel" role="region" aria-label="Observation problems">
          <ul>
            {problems.flatMap((lamp) => [
              <li key={lamp.id} data-level={lamp.level}>
                <LevelGlyph level={lamp.level} />
                <span>{`${lamp.label}: ${lamp.value}`}</span>
              </li>,
              ...lamp.details.map((detail, index) => (
                <li key={`${lamp.id}-${String(index)}`} data-level={detail.level} className="health-detail">
                  <span>{detail.text}</span>
                </li>
              )),
            ])}
          </ul>
          <p className="health-note">
            Details: <code>aang status</code>
          </p>
        </div>
      ) : null}
    </div>
  )
}
