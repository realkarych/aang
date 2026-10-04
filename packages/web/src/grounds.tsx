import type { Basis, Evidence, Fact, FactId, ObservationObjects, RawPosition, RawRecord, RawSeq } from '@aang/contract'
import { createContext, type ReactElement, type ReactNode, useContext, useId, useState } from 'react'
import { factExcerpt } from './fact-excerpt.js'
import { absoluteTime, bytes, clockTime, plural } from './format.js'
import { BasisGlyph } from './glyphs.js'
import { basisLabel, factForms, runtimeLabel } from './labels.js'
import { factPlace } from './objects.js'
import { factSource, rawSource } from './sources.js'
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
          правило <code>{basis.interpreter.rule}</code>
        </span>
      ) : (
        <span className="basis-source">
          вызов наблюдателя <code>{shortId(basis.interpreter.call)}</code>
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
          Показаны первые {shownLimit.toLocaleString('ru')} символов из {text.length.toLocaleString('ru')}.{' '}
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setWhole(true)
            }}
          >
            Показать полностью
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
            Повторить
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
          <code>{position.path}</code>, строка {position.line}
        </>
      )
    case 'file':
      return <code>{position.path}</code>
    case 'file_removed':
      return (
        <>
          <code>{position.path}</code>, файл удалён
        </>
      )
    case 'stream_lost':
      return (
        <>
          <code>{position.path}</code>, поток потерян
        </>
      )
    case 'spool':
      return (
        <>
          файл spool <code>{position.file}</code>
        </>
      )
    case 'otel':
      return 'приёмник OTel'
    case 'daemon':
      return 'записано демоном aang'
  }
}

const RawBody = ({ raw }: { readonly raw: RawRecord }): ReactElement => (
  <>
    <dl className="raw-meta">
      <div className="raw-place">
        <dt>Место</dt>
        <dd>{positionOf(raw.position)}</dd>
      </div>
      <div>
        <dt>Канал</dt>
        <dd>
          {rawChannelLabel[raw.channel]}
          {raw.runtime === null ? null : `, ${runtimeLabel[raw.runtime]}`}
        </dd>
      </div>
      <div>
        <dt>Принята</dt>
        <dd>{absoluteTime(raw.observed_at)}</dd>
      </div>
      {raw.source_ts === null ? null : (
        <div>
          <dt>Время источника</dt>
          <dd>{absoluteTime(raw.source_ts)}</dd>
        </div>
      )}
      <div>
        <dt>Разбор</dt>
        <dd>
          {parseStateLabel[raw.parse_state]}, {bytes(new TextEncoder().encode(raw.payload).byteLength)}
        </dd>
      </div>
    </dl>
    <Clipped text={pretty(raw.payload)} className="raw-payload" />
  </>
)

const RawView = ({ seq, label }: { readonly seq: RawSeq; readonly label: string }): ReactElement => {
  const read = useRead(rawSource, String(seq))
  return (
    <div className="rung" data-level="raw" role="region" aria-label={label}>
      {read.kind === 'ready' ? (
        <RawBody raw={read.value} />
      ) : (
        <ReadNote
          read={read}
          loading="Загрузка сырой записи…"
          missing="Сырой записи больше нет в хранилище aang."
          failed="Не удалось загрузить сырую запись."
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
        {open ? 'Скрыть сырую запись' : 'Сырая запись'}
      </button>
      <div id={raw}>{open ? <RawView seq={fact.seq} label={`Сырая запись: ${name}`} /> : null}</div>
    </li>
  )
}

const LazyFact = ({ id }: { readonly id: FactId }): ReactElement => {
  const read = useRead(factSource, id)
  return read.kind === 'ready' ? (
    <FactView fact={read.value} />
  ) : (
    <li className="rung" data-level="fact">
      <ReadNote
        read={read}
        loading="Загрузка факта…"
        missing={`Основание недоступно: факта ${shortId(id)} больше нет.`}
        failed="Не удалось загрузить факт."
      />
    </li>
  )
}

const FactRung = ({ id }: { readonly id: FactId }): ReactElement => {
  const fact = useContext(Groundwork).known.get(id)
  return fact === undefined ? <LazyFact id={id} /> : <FactView fact={fact} />
}

const FactLadder = ({ evidence, label }: { readonly evidence: Evidence; readonly label: string }): ReactElement => (
  <ol className="ladder" aria-label={`Основания: ${label}`}>
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
            {open ? 'Скрыть основания' : `Основания: ${plural(evidence.length, factForms)}`}
          </button>
        )}
      </p>
      <div id={ladder}>{open ? <FactLadder evidence={evidence} label={label} /> : null}</div>
    </div>
  )
}
