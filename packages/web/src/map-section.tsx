import type { RunSnapshot, StageId } from '@aang/contract'
import { lazy, type ReactElement, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { plural } from './format.js'
import { HandoverGlyph } from './glyphs.js'
import { stageForms } from './labels.js'
import { replaceStage, selectStage, useRoutedStage } from './route.js'
import { type Handover, handoverText, selectionOf } from './stage-lineage.js'
import './map.css'

const StageMap = lazy(async () => ({ default: (await import('./stage-map.js')).StageMap }))

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

export const MapSection = ({ snapshot }: { readonly snapshot: RunSnapshot }): ReactElement => {
  const stages = snapshot.model.stages.filter(({ lifecycle }) => lifecycle.state === 'active').length
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
  const select = useCallback(
    (stage: StageId | null) => {
      selectStage(run, stage)
    },
    [run],
  )
  return (
    <section className="map" aria-labelledby="map-title">
      <header className="map-head">
        <h2 id="map-title" className="map-title">
          Карта этапов
        </h2>
        {stages === 0 ? null : <p className="map-count">{plural(stages, stageForms)}</p>}
      </header>
      <HandoverNote
        handover={selection?.handover ?? null}
        onDismiss={() => {
          setChosen(selected)
        }}
      />
      {stages === 0 ? (
        <p className="map-note">Этапы строит наблюдатель. Карта появится после его первого ответа по этому прогону.</p>
      ) : (
        <Suspense fallback={<p className="map-note">Загрузка карты…</p>}>
          <StageMap snapshot={snapshot} selection={selection} onSelect={select} />
        </Suspense>
      )}
    </section>
  )
}
