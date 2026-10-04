import type { RunSnapshot } from '@aang/contract'
import { lazy, type ReactElement, Suspense } from 'react'
import { plural } from './format.js'
import { stageForms } from './labels.js'
import './map.css'

const StageMap = lazy(async () => ({ default: (await import('./stage-map.js')).StageMap }))

export const MapSection = ({ snapshot }: { readonly snapshot: RunSnapshot }): ReactElement => {
  const stages = snapshot.model.stages.filter(({ lifecycle }) => lifecycle.state === 'active').length
  return (
    <section className="map" aria-labelledby="map-title">
      <header className="map-head">
        <h2 id="map-title" className="map-title">
          Карта этапов
        </h2>
        {stages === 0 ? null : <p className="map-count">{plural(stages, stageForms)}</p>}
      </header>
      {stages === 0 ? (
        <p className="map-note">Этапы строит наблюдатель. Карта появится после его первого ответа по этому прогону.</p>
      ) : (
        <Suspense fallback={<p className="map-note">Загрузка карты…</p>}>
          <StageMap snapshot={snapshot} />
        </Suspense>
      )}
    </section>
  )
}
