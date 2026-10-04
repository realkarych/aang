import type { ChangesResponse, RunId, RunSnapshot, ViewMark, ViewPosition } from '@aang/contract'
import { type ReactElement, type ReactNode, useState } from 'react'
import { markViewed, RequestFailed, SignedOut } from './api.js'
import { ChangesView, changeCount } from './changes.js'
import { plural } from './format.js'
import { MarkGlyph } from './glyphs.js'
import { changeForms } from './labels.js'
import { Moment } from './moment.js'
import { type RunMode, runHref, useRoutedMode, useSwitchMode } from './route.js'
import './since.css'
import { useChanges } from './use-changes.js'

const markTimeoutMs = 10_000

const latest = (left: ViewMark | null, right: ViewMark | null): ViewMark | null => {
  if (left === null || right === null) {
    return left ?? right
  }
  return right.marked_at > left.marked_at ? right : left
}

type Saving =
  | { readonly state: 'idle' }
  | { readonly state: 'saving' }
  | { readonly state: 'failed'; readonly refusal: string | null }

interface MarkControlProps {
  readonly run: RunId
  readonly shown: ViewPosition | null
  readonly mark: ViewMark | null
  readonly now: bigint
  readonly onMarked: (mark: ViewMark) => void
  readonly onSignedOut: () => void
}

const MarkControl = ({ run, shown, mark, now, onMarked, onSignedOut }: MarkControlProps): ReactElement => {
  const [saving, setSaving] = useState<Saving>({ state: 'idle' })
  const save = (position: ViewPosition): void => {
    setSaving({ state: 'saving' })
    markViewed(run, position, AbortSignal.timeout(markTimeoutMs)).then(
      (saved) => {
        onMarked(saved.mark)
        setSaving({ state: 'idle' })
      },
      (error: unknown) => {
        if (error instanceof SignedOut) {
          onSignedOut()
          return
        }
        setSaving({ state: 'failed', refusal: error instanceof RequestFailed ? error.message : null })
      },
    )
  }
  return (
    <div className="mark" role="group" aria-label="Отметка просмотра">
      <p className="mark-state" data-marked={mark !== null}>
        <MarkGlyph />
        {mark === null ? (
          <span>Не отмечен просмотренным</span>
        ) : (
          <span>
            Просмотрен <Moment at={mark.marked_at} now={now} />, версия карты {mark.version}
          </span>
        )}
      </p>
      <button
        type="button"
        className="mark-button"
        disabled={shown === null || saving.state === 'saving'}
        onClick={
          shown === null
            ? undefined
            : () => {
                save(shown)
              }
        }
      >
        Отметить просмотренным
      </button>
      {saving.state === 'failed' ? (
        <p className="mark-failed" role="alert">
          {saving.refusal === null
            ? 'Отметка не сохранена: демон не ответил. Попробуйте ещё раз.'
            : `Отметка не сохранена: демон отказал (${saving.refusal}). Попробуйте ещё раз.`}
        </p>
      ) : null}
    </div>
  )
}

interface ModesProps {
  readonly snapshot: RunSnapshot
  readonly mode: RunMode
  readonly changes: ChangesResponse | null
}

const Modes = ({ snapshot, mode, changes }: ModesProps): ReactElement => {
  const switchMode = useSwitchMode()
  const run = snapshot.run.id
  const count = changes === null ? 0 : changeCount(changes)
  return (
    <nav className="modes" aria-label="Вид прогона">
      <a
        className="mode"
        href={runHref(run)}
        aria-current={mode === 'trace' ? 'page' : undefined}
        onClick={switchMode}
      >
        Ход прогона
      </a>
      <a
        className="mode"
        href={runHref(run, 'changes')}
        aria-current={mode === 'changes' ? 'page' : undefined}
        aria-label={count === 0 ? undefined : `С последнего просмотра, ${plural(count, changeForms)}`}
        onClick={switchMode}
      >
        С последнего просмотра
        {count === 0 ? null : (
          <span className="mode-count" aria-hidden="true">
            {count}
          </span>
        )}
      </a>
    </nav>
  )
}

export interface SinceLastViewProps {
  readonly snapshot: RunSnapshot
  readonly now: bigint
  readonly onSignedOut: () => void
  readonly children: ReactNode
}

export const SinceLastView = ({ snapshot, now, onSignedOut, children }: SinceLastViewProps): ReactElement => {
  const mode = useRoutedMode()
  const [saved, setSaved] = useState<ViewMark | null>(null)
  const mark = latest(snapshot.view.mark, saved)
  const { changes, failing } = useChanges(snapshot.run.id, mark, snapshot.change_seq, onSignedOut)
  const shown =
    mode === 'changes' && mark !== null
      ? (changes?.to ?? null)
      : { version: snapshot.summary.version, change_seq: snapshot.change_seq }
  return (
    <>
      <div className="since-bar">
        <Modes snapshot={snapshot} mode={mode} changes={changes} />
        <MarkControl
          run={snapshot.run.id}
          shown={shown}
          mark={mark}
          now={now}
          onMarked={setSaved}
          onSignedOut={onSignedOut}
        />
      </div>
      {mode === 'changes' ? (
        <ChangesView
          snapshot={snapshot}
          mark={mark}
          changes={changes}
          failing={failing}
          now={now}
          onSignedOut={onSignedOut}
        />
      ) : (
        children
      )}
    </>
  )
}
