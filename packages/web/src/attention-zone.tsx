import type { AttentionItem, ObservationObjects, RunSnapshot } from '@aang/contract'
import { type ReactElement, useId } from 'react'
import { AttentionGlyph, LevelGlyph } from './glyphs.js'
import { attentionAuthorLabel, attentionKindLabel } from './labels.js'
import { LongText } from './long-text.js'
import { Moment } from './moment.js'
import { placeOf } from './objects.js'

const waiting = (item: AttentionItem): boolean => item.runtime_wait === 'active'

const urgency = (left: AttentionItem, right: AttentionItem): number =>
  Number(waiting(right)) - Number(waiting(left)) ||
  (left.opened_at < right.opened_at ? -1 : left.opened_at > right.opened_at ? 1 : 0) ||
  (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)

const itemPlace = (objects: ObservationObjects, item: AttentionItem): string | null => {
  const question = objects.questions.find(({ id }) => id === item.question)
  const action = objects.actions.find(({ id }) => id === item.action)
  const source = question ?? action
  return source === undefined ? null : placeOf(objects, source.session, source.agent)
}

const ZoneItem = ({
  item,
  objects,
  now,
}: {
  readonly item: AttentionItem
  readonly objects: ObservationObjects
  readonly now: bigint
}): ReactElement => {
  const place = itemPlace(objects, item)
  return (
    <li className="zone-item" data-kind={item.kind} data-waiting={waiting(item)}>
      <p className="zone-kind">
        <AttentionGlyph kind={item.kind} />
        <span>{attentionKindLabel[item.kind]}</span>
        {waiting(item) ? (
          <span className="badge" data-tone="ask">
            <LevelGlyph level="caution" />
            ждёт ответа
          </span>
        ) : null}
      </p>
      <div className="zone-question">
        <LongText text={item.text} className="zone-text" />
      </div>
      <p className="zone-meta">
        {place === null ? null : <span>{place}</span>}
        <span>
          открыт <Moment at={item.opened_at} now={now} />
        </span>
        <span>{attentionAuthorLabel[item.author]}</span>
      </p>
    </li>
  )
}

export const AttentionZone = ({
  snapshot,
  now,
}: {
  readonly snapshot: RunSnapshot
  readonly now: bigint
}): ReactElement => {
  const heading = useId()
  const open = snapshot.attention.items.filter(({ resolution }) => resolution === 'open').toSorted(urgency)
  return (
    <section className="zone" aria-labelledby={heading} data-calm={open.length === 0}>
      <h2 id={heading} className="section-title">
        Внимание
      </h2>
      {open.length === 0 ? (
        <p className="zone-empty">Открытых пунктов нет. Вопросы и запросы одобрения, которые ждут человека, появятся здесь.</p>
      ) : (
        <ol className="zone-items">
          {open.map((item) => (
            <ZoneItem key={item.id} item={item} objects={snapshot.objects} now={now} />
          ))}
        </ol>
      )}
    </section>
  )
}
