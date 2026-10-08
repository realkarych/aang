import { type ReactElement, useId, useState } from 'react'
import { LevelGlyph } from './glyphs.js'
import type { Lamp, LampId } from './lamps.js'

const lampText = ({ label, value }: Lamp): string => `${label}: ${value}`

const LampFace = ({ lamp }: { readonly lamp: Lamp }): ReactElement => (
  <>
    <span className="lamp-label">
      <LevelGlyph level={lamp.level} />
      {lamp.label}
    </span>{' '}
    <span className="lamp-value">{lamp.value}</span>
  </>
)

export const StatusStrip = ({ lamps }: { readonly lamps: readonly Lamp[] }): ReactElement => {
  const [open, setOpen] = useState<LampId | null>(null)
  const panel = useId()
  const opened = lamps.find(({ id, details }) => id === open && details.length > 0) ?? null
  return (
    <section className="annunciator" aria-label="Состояние наблюдения">
      <ul className="lamps">
        {lamps.map((lamp) => (
          <li key={lamp.id} className="lamp-slot">
            {lamp.details.length === 0 ? (
              <span className="lamp" data-level={lamp.level} title={lampText(lamp)}>
                <LampFace lamp={lamp} />
              </span>
            ) : (
              <button
                type="button"
                className="lamp"
                data-level={lamp.level}
                title={lampText(lamp)}
                aria-expanded={opened?.id === lamp.id}
                aria-controls={panel}
                onClick={() => {
                  setOpen(opened?.id === lamp.id ? null : lamp.id)
                }}
              >
                <LampFace lamp={lamp} />
              </button>
            )}
          </li>
        ))}
      </ul>
      {opened === null ? null : (
        <div id={panel} className="lamp-details" role="region" aria-label={`${opened.label}: подробности`}>
          <ul>
            {opened.details.map((detail, index) => (
              <li key={index} data-level={detail.level}>
                <LevelGlyph level={detail.level} />
                <span>{detail.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
