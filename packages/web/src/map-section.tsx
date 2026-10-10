import type { RunSnapshot, StageId } from '@aang/contract'
import { lazy, type ReactElement, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { plural } from './format.js'
import { HandoverGlyph } from './glyphs.js'
import { stageForms } from './labels.js'
import { replaceStage, selectStage, useRoutedStage } from './route.js'
import { fullHint, shortIds, useKnownAgents } from './short-ids.js'
import { type Handover, handoverText, type StageSelection, selectionOf } from './stage-lineage.js'
import './map.css'

const StageMap = lazy(async () => ({ default: (await import('./stage-map.js')).StageMap }))

export const mapHeading = 'map-title'

export interface StageChoice {
  readonly selection: StageSelection | null
  readonly choose: (stage: StageId | null) => void
  readonly dismissHandover: () => void
}

export const useStageChoice = (snapshot: RunSnapshot): StageChoice => {
  const run = snapshot.run.id
  const routed = useRoutedStage()
  const [chosen, setChosen] = useState(routed)
  const [seen, setSeen] = useState(routed)
  const selection = useMemo(
    () => (chosen === null ? null : selectionOf(snapshot.model.stages, chosen)),
    [snapshot.model.stages, chosen],
  )
  const selected = selection?.stage.id ?? null
  const shown = selection === null ? chosen : selected
  if (routed !== seen) {
    setSeen(routed)
    if (routed !== shown) {
      setChosen(routed)
    }
  }
  useEffect(() => {
    replaceStage(run, shown)
  }, [run, routed, shown])
  const choose = useCallback(
    (stage: StageId | null) => {
      selectStage(run, stage)
    },
    [run],
  )
  const dismissHandover = useCallback(() => {
    setChosen(selected)
  }, [selected])
  return { selection, choose, dismissHandover }
}

const HandoverNote = ({
  handover,
  onDismiss,
}: {
  readonly handover: Handover | null
  readonly onDismiss: () => void
}): ReactElement => {
  const agents = useKnownAgents()
  const text = handover === null ? null : handoverText(handover)
  return (
    <div className="map-handover" data-shown={handover !== null}>
      {handover === null ? null : <HandoverGlyph />}
      <p role="status" title={text === null ? undefined : fullHint(text, agents)}>
        {text === null ? null : shortIds(text, agents)}
      </p>
      {handover === null ? null : (
        <button type="button" className="map-dismiss" onClick={onDismiss}>
          Скрыть
        </button>
      )}
    </div>
  )
}

export const MapSection = ({
  snapshot,
  choice,
}: {
  readonly snapshot: RunSnapshot
  readonly choice: StageChoice
}): ReactElement => {
  const stages = snapshot.model.stages.filter(({ lifecycle }) => lifecycle.state === 'active').length
  const hidden = snapshot.view.placements.filter(
    ({ element, visibility }) => element.kind === 'stage' && visibility?.state === 'hidden',
  ).length
  const { selection, choose, dismissHandover } = choice
  return (
    <section className="map" aria-labelledby={mapHeading}>
      <header className="map-head">
        <h2 id={mapHeading} className="map-title">
          Карта этапов
        </h2>
        {stages === 0 ? null : <p className="map-count">{plural(stages, stageForms)}</p>}
        {hidden === 0 ? null : <p className="map-count">{`скрыто правилами вида: ${plural(hidden, stageForms)}`}</p>}
      </header>
      <HandoverNote
        handover={selection?.handover ?? null}
        onDismiss={dismissHandover}
      />
      {stages === 0 ? (
        <p className="map-note">Этапы строит наблюдатель. Карта появится после его первого ответа по этому прогону.</p>
      ) : (
        <Suspense fallback={<p className="map-note">Загрузка карты…</p>}>
          <StageMap snapshot={snapshot} selection={selection} onSelect={choose} />
        </Suspense>
      )}
    </section>
  )
}
