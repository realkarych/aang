import type { FactOf, ObservationObjects, RunSnapshot } from '@aang/contract'
import { type ReactElement, useId } from 'react'
import { PlanItemGlyph } from './glyphs.js'
import { planItemLabel, planSourceLabel } from './labels.js'
import { Moment } from './moment.js'
import { factPlace } from './objects.js'

type PlanFact = FactOf<'plan_update'>

const isPlan = (fact: RunSnapshot['plan_facts'][number]): fact is PlanFact => fact.kind === 'plan_update'

const newestFirst = (left: PlanFact, right: PlanFact): number =>
  left.at > right.at ? -1 : left.at < right.at ? 1 : right.seq - left.seq

const PlanUpdate = ({
  fact,
  objects,
  now,
}: {
  readonly fact: PlanFact
  readonly objects: ObservationObjects
  readonly now: bigint
}): ReactElement => {
  const { payload } = fact
  const place = factPlace(objects, fact.entity_key)
  return (
    <li className="plan-update">
      <p className="plan-head">
        <span className="plan-source">{planSourceLabel[payload.source]}</span>
        <Moment at={fact.at} now={now} />
      </p>
      <p className="plan-meta">
        {place === null ? null : <span>{place}</span>}
        {fact.format_verified ? null : <span className="plan-unverified">формат записи не проверен</span>}
      </p>
      {payload.text === null ? null : <p className="plan-text">{payload.text}</p>}
      {payload.items.length === 0 ? null : (
        <ul className="plan-items">
          {payload.items.map((item, index) => (
            <li key={index} className="plan-item" data-status={item.status}>
              <PlanItemGlyph status={item.status} />
              <span className="plan-item-text">{item.text}</span>
              <span className="plan-item-status">{planItemLabel[item.status]}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

export const PlanFacts = ({ snapshot, now }: { readonly snapshot: RunSnapshot; readonly now: bigint }): ReactElement => {
  const heading = useId()
  const facts = snapshot.plan_facts.filter(isPlan).toSorted(newestFirst)
  return (
    <section className="plan" aria-labelledby={heading}>
      <h2 id={heading} className="section-title">
        План решателя
      </h2>
      {facts.length === 0 ? (
        <p className="plan-empty">
          Решатель не объявлял план. Задачи, списки дел и планы на одобрение появятся здесь в том виде, в каком он их
          записал.
        </p>
      ) : (
        <ol className="plan-updates">
          {facts.map((fact) => (
            <PlanUpdate key={fact.id} fact={fact} objects={snapshot.objects} now={now} />
          ))}
        </ol>
      )}
    </section>
  )
}
