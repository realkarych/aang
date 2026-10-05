import type { RunSnapshot, Stage, StageId } from '@aang/contract'
import { lazy, type ReactElement, Suspense, useEffect, useMemo, useState } from 'react'
import { plural } from './format.js'
import { HandoverGlyph } from './glyphs.js'
import { stageForms } from './labels.js'
import { routedStage, routeStage } from './route.js'
import { type Handover, handoverText, type StageSelection, selectionOf } from './stage-lineage.js'
import './map.css'

const StageMap = lazy(async () => ({ default: (await import('./stage-map.js')).StageMap }))

export const mapHeading = 'map-title'

export interface StageChoice {
  readonly selection: StageSelection | null
  readonly choose: (stage: StageId | null) => void
}

export const useStageChoice = (stages: readonly Stage[]): StageChoice => {
  const [chosen, setChosen] = useState(routedStage)
  const selection = useMemo(() => (chosen === null ? null : selectionOf(stages, chosen)), [stages, chosen])
  const selected = selection?.stage.id ?? null
  useEffect(() => {
    routeStage(selected)
  }, [selected])
  return { selection, choose: setChosen }
}

const HandoverNote = ({
  handover,
  onDismiss,
}: {
  readonly handover: Handover | null
  readonly onDismiss: () => void
}): ReactElement => (
  <div className="map-handover" data-shown={handover !== null}>
    {handover === null ? null : <HandoverGlyph />}
    <p role="status">{handover === null ? null : handoverText(handover)}</p>
    {handover === null ? null : (
      <button type="button" className="map-dismiss" onClick={onDismiss}>
        Скрыть
      </button>
    )}
  </div>
)

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
  const { selection, choose } = choice
  const selected = selection?.stage.id ?? null
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
        onDismiss={() => {
          choose(selected)
        }}
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
