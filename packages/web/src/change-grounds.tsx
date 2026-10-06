import type {
  Basis,
  CardSource,
  Fact,
  FactId,
  ModelChange,
  ModelChangeRef,
  ObservationObjects,
  RunId,
  StageId,
} from '@aang/contract'
import { type ReactElement, useEffect, useId, useRef, useState } from 'react'
import { detailOf } from './action-input.js'
import { readFact, readStage, SignedOut } from './api.js'
import { plural } from './format.js'
import { basisLabel, factKindLabel, outcomeLabel, speakerLabel } from './labels.js'
import { Moment } from './moment.js'
import { factPlace } from './objects.js'

const factTimeoutMs = 10_000

const shownFacts = 6

const groundForms = { one: 'запись', few: 'записи', many: 'записей' } as const

const joined = (parts: readonly (string | null)[]): string | null => {
  const present = parts.filter((part): part is string => part !== null && part.trim() !== '')
  return present.length === 0 ? null : present.join(': ')
}

export const finalTextOf = (fact: Fact): string | null => {
  switch (fact.kind) {
    case 'message':
      return fact.payload.text
    case 'turn_end':
    case 'agent_end':
      return fact.payload.final_message
    default:
      return null
  }
}

const gistOf = (fact: Fact): string | null => {
  switch (fact.kind) {
    case 'prompt':
      return fact.payload.text
    case 'action_start':
      return joined([fact.payload.tool, detailOf(fact.payload.input) ?? fact.payload.description])
    case 'action_end':
      return outcomeLabel[fact.payload.outcome]
    case 'permission_request':
      return joined([fact.payload.tool, detailOf(fact.payload.input)])
    case 'question_asked':
      return fact.payload.questions.map(({ text }) => text).join('\n')
    case 'question_answered':
      return fact.payload.answers.map(({ answer }) => answer).join('\n')
    case 'plan_update':
      return fact.payload.text ?? fact.payload.items.map(({ text }) => text).join('\n')
    default:
      return finalTextOf(fact)
  }
}

type Reading<T> =
  | { readonly state: 'loading' }
  | { readonly state: 'failed' }
  | { readonly state: 'read'; readonly value: T }

const useRead = <T,>(
  load: (signal: AbortSignal) => Promise<T>,
  onSignedOut: () => void,
): { readonly reading: Reading<T>; readonly retry: () => void } => {
  const [attempt, setAttempt] = useState(0)
  const [reading, setReading] = useState<{ readonly attempt: number; readonly reading: Reading<T> } | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(factTimeoutMs)])
    load(signal).then(
      (value) => {
        setReading({ attempt, reading: { state: 'read', value } })
      },
      (error: unknown) => {
        if (controller.signal.aborted) {
          return
        }
        if (error instanceof SignedOut) {
          onSignedOut()
          return
        }
        setReading({ attempt, reading: { state: 'failed' } })
      },
    )
    return () => {
      controller.abort()
    }
  }, [load, onSignedOut, attempt])
  return {
    reading: reading?.attempt === attempt ? reading.reading : { state: 'loading' },
    retry: () => {
      setAttempt(attempt + 1)
    },
  }
}

const Failed = ({ what, retry }: { readonly what: string; readonly retry: () => void }): ReactElement => (
  <p className="grounds-failed" role="alert">
    {what} не загружены: демон не ответил.{' '}
    <button type="button" className="text-button" onClick={retry}>
      Повторить
    </button>
  </p>
)

const FactCaption = ({
  fact,
  objects,
  now,
}: {
  readonly fact: Fact
  readonly objects: ObservationObjects
  readonly now: bigint
}): ReactElement => {
  const place = factPlace(objects, fact.entity_key)
  return (
    <>
      <span className="ground-kind">{factKindLabel[fact.kind]}</span>
      <span>{speakerLabel[fact.speaker]}</span>
      <Moment at={fact.at} now={now} />
      {place === null ? null : <span>{place}</span>}
      <span>сырая запись № {fact.seq}</span>
    </>
  )
}

interface FactsProps {
  readonly ids: readonly FactId[]
  readonly objects: ObservationObjects
  readonly now: bigint
  readonly onSignedOut: () => void
}

const GroundFacts = ({ ids, objects, now, onSignedOut }: FactsProps): ReactElement => {
  const [load] = useState(() => (signal: AbortSignal) => Promise.all(ids.map((id) => readFact(id, signal))))
  const { reading, retry } = useRead(load, onSignedOut)
  if (reading.state === 'loading') {
    return <p className="grounds-loading">Загрузка оснований…</p>
  }
  if (reading.state === 'failed') {
    return <Failed what="Основания" retry={retry} />
  }
  return (
    <ul className="ground-facts">
      {reading.value.map((fact) => {
        const gist = gistOf(fact)
        return (
          <li key={fact.id} className="ground">
            <p className="ground-head">
              <FactCaption fact={fact} objects={objects} now={now} />
            </p>
            {gist === null ? null : <p className="ground-text">{gist}</p>}
          </li>
        )
      })}
    </ul>
  )
}

const journalText = (journal: readonly ModelChangeRef[]): string | null => {
  const versions = [...new Set(journal.map(({ version }) => version))].sort((left, right) => left - right)
  if (versions.length === 0) {
    return null
  }
  return versions.length === 1
    ? `журнал карты: версия ${String(versions[0])}`
    : `журнал карты: версии ${versions.join(', ')}`
}

const journalTitle = (journal: readonly ModelChangeRef[]): string =>
  journal.map(({ version, index }) => `версия ${String(version)}, изменение ${String(index + 1)}`).join('; ')

export interface Grounding {
  readonly basis: Basis | null
  readonly evidence: readonly FactId[]
}

export interface GroundsProps {
  readonly grounds: readonly Grounding[]
  readonly journal: readonly ModelChangeRef[]
  readonly objects: ObservationObjects
  readonly now: bigint
  readonly onSignedOut: () => void
}

export const Grounds = ({ grounds, journal, objects, now, onSignedOut }: GroundsProps): ReactElement => {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [all, setAll] = useState(false)
  const bases = [...new Set(grounds.flatMap(({ basis }) => (basis === null ? [] : [basisLabel[basis.kind]])))]
  const facts = [...new Set(grounds.flatMap(({ evidence }) => evidence))]
  const shown = all ? facts : facts.slice(0, shownFacts)
  const journalLine = journalText(journal)
  return (
    <div className="change-grounds">
      <p className="grounds-line">
        {bases.length === 0 ? null : <span>{bases.join(', ')}</span>}
        {journalLine === null ? null : <span title={journalTitle(journal)}>{journalLine}</span>}
        {facts.length === 0 ? null : (
          <button
            type="button"
            className="text-button"
            aria-expanded={open}
            aria-controls={id}
            onClick={() => {
              setOpen(!open)
            }}
          >
            {open ? 'Скрыть основания' : `Основания: ${plural(facts.length, groundForms)}`}
          </button>
        )}
      </p>
      {open ? (
        <div id={id} className="grounds-body">
          <GroundFacts key={shown.join(' ')} ids={shown} objects={objects} now={now} onSignedOut={onSignedOut} />
          {shown.length < facts.length ? (
            <button
              type="button"
              className="text-button grounds-more"
              onClick={() => {
                setAll(true)
              }}
            >
              {`Показать все ${plural(facts.length, groundForms)}`}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

const refKey = ({ version, index }: ModelChangeRef): string => `${String(version)}:${String(index)}`

export const journalKey = (journal: readonly ModelChangeRef[]): string => journal.map(refKey).join(' ')

export interface JournalGroundsProps {
  readonly run: RunId
  readonly stage: StageId
  readonly journal: readonly ModelChangeRef[]
  readonly select: (change: ModelChange) => boolean
  readonly objects: ObservationObjects
  readonly now: bigint
  readonly onSignedOut: () => void
}

export const JournalGrounds = ({
  run,
  stage,
  journal,
  select,
  objects,
  now,
  onSignedOut,
}: JournalGroundsProps): ReactElement => {
  const [load] = useState(() => async (signal: AbortSignal) => (await readStage(run, stage, signal)).history)
  const { reading, retry } = useRead(load, onSignedOut)
  if (reading.state === 'loading') {
    return <p className="grounds-loading">Загрузка оснований…</p>
  }
  if (reading.state === 'failed') {
    return <Failed what="Основания" retry={retry} />
  }
  const wanted = new Set(journal.map(refKey))
  const changes = reading.value.filter((change) => wanted.has(refKey(change)) && select(change))
  return <Grounds grounds={changes} journal={changes} objects={objects} now={now} onSignedOut={onSignedOut} />
}

interface OriginalProps {
  readonly source: CardSource
  readonly objects: ObservationObjects
  readonly now: bigint
  readonly onSignedOut: () => void
}

const OriginalText = ({ source, objects, now, onSignedOut }: OriginalProps): ReactElement => {
  const [load] = useState(() => (signal: AbortSignal) => readFact(source.fact, signal))
  const { reading, retry } = useRead(load, onSignedOut)
  const fragment = useRef<HTMLElement>(null)
  const ready = reading.state === 'read'
  useEffect(() => {
    if (ready) {
      fragment.current?.scrollIntoView({ block: 'nearest' })
    }
  }, [ready])
  if (reading.state === 'loading') {
    return <p className="grounds-loading">Загрузка оригинала…</p>
  }
  if (reading.state === 'failed') {
    return <Failed what="Оригинал" retry={retry} />
  }
  const fact = reading.value
  const text = finalTextOf(fact) ?? ''
  return (
    <figure className="original">
      <blockquote className="original-text">
        {text.slice(0, source.start)}
        <mark ref={fragment}>{text.slice(source.start, source.end)}</mark>
        {text.slice(source.end)}
      </blockquote>
      <figcaption className="ground-head">
        <FactCaption fact={fact} objects={objects} now={now} />
      </figcaption>
    </figure>
  )
}

export const Original = (props: OriginalProps): ReactElement => {
  const id = useId()
  const [open, setOpen] = useState(false)
  return (
    <div className="original-box">
      <button
        type="button"
        className="text-button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          setOpen(!open)
        }}
      >
        {open ? 'Скрыть оригинал' : 'Показать в оригинале'}
      </button>
      {open ? (
        <div id={id}>
          <OriginalText {...props} />
        </div>
      ) : null}
    </div>
  )
}
