import type { Basis, Evidence, Fact, FactId, ObservationObjects, RawPosition, RawRecord, RawSeq } from '@aang/contract'
import { createContext, type ReactElement, type ReactNode, useContext, useId, useState } from 'react'
import { factExcerpt } from './fact-excerpt.js'
import { absoluteTime, bytes, clockTime, plural } from './format.js'
import { useGeneration } from './generation.js'
import { BasisGlyph } from './glyphs.js'
import { basisLabel, factForms, runtimeLabel } from './labels.js'
import { factPlace } from './objects.js'
import { factKindLabel, parseStateLabel, rawChannelLabel, speakerLabel } from './stage-labels.js'
import { type Read, useRead } from './use-read.js'

export interface GroundsContext {
  readonly objects: ObservationObjects | null
  readonly known: ReadonlyMap<FactId, Fact>
}

export const Groundwork = createContext<GroundsContext>({ objects: null, known: new Map() })

const shownLimit = 100_000

export const shortId = (id: string): string => id.slice(0, 8)

export const BasisLine = ({ basis }: { readonly basis: Basis }): ReactElement => (
  <span className="basis-line" data-basis={basis.kind}>
    <BasisGlyph basis={basis.kind} />
    <span>{basisLabel[basis.kind]}</span>
    {basis.kind === 'interpreted' ? (
      basis.interpreter.kind === 'rule' ? (
        <span className="basis-source">
          rule <code>{basis.interpreter.rule}</code>
        </span>
      ) : (
        <span className="basis-source">
          observer call <code>{shortId(basis.interpreter.call)}</code>
        </span>
      )
    ) : null}
  </span>
)

export const Clipped = ({ text, className }: { readonly text: string; readonly className: string }): ReactElement => {
  const [whole, setWhole] = useState(false)
  const clipped = !whole && text.length > shownLimit
  return (
    <>
      <pre className={className}>{clipped ? text.slice(0, shownLimit) : text}</pre>
      {clipped ? (
        <p className="clip-note">
          Showing the first {shownLimit.toLocaleString('en-US')} of {text.length.toLocaleString('en-US')} characters.{' '}
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setWhole(true)
            }}
          >
            Show all
          </button>
        </p>
      ) : null}
    </>
  )
}

export const ReadNote = ({
  read,
  loading,
  missing,
  failed,
}: {
  readonly read: Exclude<Read<unknown>, { readonly kind: 'ready' }>
  readonly loading: string
  readonly missing: string
  readonly failed: string
}): ReactElement => {
  switch (read.kind) {
    case 'loading':
      return <p className="read-note">{loading}</p>
    case 'missing':
      return (
        <p className="read-note" data-trouble="true">
          {missing}
        </p>
      )
    case 'failed':
      return (
        <p className="read-note" data-trouble="true">
          {failed}{' '}
          <button type="button" className="text-button" onClick={read.retry}>
            Retry
          </button>
        </p>
      )
  }
}

const pretty = (payload: string): string => {
  try {
    return JSON.stringify(JSON.parse(payload) as unknown, null, 2)
  } catch {
    return payload
  }
}

const positionOf = (position: RawPosition): ReactNode => {
  switch (position.kind) {
    case 'line':
      return (
        <>
          <code>{position.path}</code>, line {position.line}
        </>
      )
    case 'file':
      return <code>{position.path}</code>
    case 'file_removed':
      return (
        <>
          <code>{position.path}</code>, file deleted
        </>
      )
    case 'stream_lost':
      return (
        <>
          <code>{position.path}</code>, stream lost
        </>
      )
    case 'process_exited':
      return (
        <>
          <code>{position.path}</code>, process {position.pid} exited
        </>
      )
    case 'spool':
      return (
        <>
          spool file <code>{position.file}</code>
        </>
      )
    case 'otel':
      return 'OTel receiver'
    case 'daemon':
      return 'recorded by the aang daemon'
  }
}

const RawBody = ({ raw }: { readonly raw: RawRecord }): ReactElement => (
  <>
    <dl className="raw-meta">
      <div className="raw-place">
        <dt>Location</dt>
        <dd>{positionOf(raw.position)}</dd>
      </div>
      <div>
        <dt>Channel</dt>
        <dd>
          {rawChannelLabel[raw.channel]}
          {raw.runtime === null ? null : `, ${runtimeLabel[raw.runtime]}`}
        </dd>
      </div>
      <div>
        <dt>Received</dt>
        <dd>{absoluteTime(raw.observed_at)}</dd>
      </div>
      {raw.source_ts === null ? null : (
        <div>
          <dt>Source time</dt>
          <dd>{absoluteTime(raw.source_ts)}</dd>
        </div>
      )}
      <div>
        <dt>Parsing</dt>
        <dd>
          {parseStateLabel[raw.parse_state]}, {bytes(new TextEncoder().encode(raw.payload).byteLength)}
        </dd>
      </div>
    </dl>
    <Clipped text={pretty(raw.payload)} className="raw-payload" />
  </>
)

const RawView = ({ seq, label }: { readonly seq: RawSeq; readonly label: string }): ReactElement => {
  const { raws } = useGeneration()
  const read = useRead(raws, String(seq))
  return (
    <div className="rung" data-level="raw" role="region" aria-label={label}>
      {read.kind === 'ready' ? (
        <RawBody raw={read.value} />
      ) : (
        <ReadNote
          read={read}
          loading="Loading raw record…"
          missing="The raw record is no longer in aang storage."
          failed="Could not load the raw record."
        />
      )}
    </div>
  )
}

const FactView = ({ fact }: { readonly fact: Fact }): ReactElement => {
  const { objects } = useContext(Groundwork)
  const [open, setOpen] = useState(false)
  const raw = useId()
  const excerpt = factExcerpt(fact)
  const place = objects === null ? null : factPlace(objects, fact.entity_key)
  const name = `${factKindLabel[fact.kind]}, ${clockTime(fact.at)}`
  return (
    <li className="rung" data-level="fact">
      <div className="fact-line">
        <span className="fact-kind">{factKindLabel[fact.kind]}</span>
        <span className="fact-speaker">{speakerLabel[fact.speaker]}</span>
        {place === null ? null : <span className="fact-place">{place}</span>}
        <time className="fact-time" dateTime={new Date(Number(fact.at / 1_000_000n)).toISOString()} title={absoluteTime(fact.at)}>
          {clockTime(fact.at)}
        </time>
      </div>
      {excerpt === null ? null : <p className="fact-excerpt">{excerpt}</p>}
      <button
        type="button"
        className="text-button rung-toggle"
        aria-expanded={open}
        aria-controls={raw}
        onClick={() => {
          setOpen(!open)
        }}
      >
        {open ? 'Hide raw record' : 'Raw record'}
      </button>
      <div id={raw}>{open ? <RawView seq={fact.seq} label={`Raw record: ${name}`} /> : null}</div>
    </li>
  )
}

const LazyFact = ({ id }: { readonly id: FactId }): ReactElement => {
  const { facts } = useGeneration()
  const read = useRead(facts, id)
  return read.kind === 'ready' ? (
    <FactView fact={read.value} />
  ) : (
    <li className="rung" data-level="fact">
      <ReadNote
        read={read}
        loading="Loading fact…"
        missing={`Ground unavailable: fact ${shortId(id)} no longer exists.`}
        failed="Could not load the fact."
      />
    </li>
  )
}

const FactRung = ({ id }: { readonly id: FactId }): ReactElement => {
  const fact = useContext(Groundwork).known.get(id)
  return fact === undefined ? <LazyFact id={id} /> : <FactView fact={fact} />
}

const FactLadder = ({ evidence, label }: { readonly evidence: Evidence; readonly label: string }): ReactElement => (
  <ol className="ladder" aria-label={`Grounds: ${label}`}>
    {evidence.map((id) => (
      <FactRung key={id} id={id} />
    ))}
  </ol>
)

export const Grounds = ({
  basis,
  evidence,
  label,
}: {
  readonly basis: Basis | null
  readonly evidence: Evidence
  readonly label: string
}): ReactElement | null => {
  const [open, setOpen] = useState(false)
  const ladder = useId()
  if (basis === null && evidence.length === 0) {
    return null
  }
  return (
    <div className="grounds">
      <p className="grounds-head">
        {basis === null ? null : <BasisLine basis={basis} />}
        {evidence.length === 0 ? null : (
          <button
            type="button"
            className="text-button"
            aria-expanded={open}
            aria-controls={ladder}
            aria-label={`${label}: ${plural(evidence.length, factForms)}`}
            onClick={() => {
              setOpen(!open)
            }}
          >
            {open ? 'Hide grounds' : `Grounds: ${plural(evidence.length, factForms)}`}
          </button>
        )}
      </p>
      <div id={ladder}>{open ? <FactLadder evidence={evidence} label={label} /> : null}</div>
    </div>
  )
}
