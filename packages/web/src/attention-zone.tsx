import type {
  AttentionItem,
  AttentionItemId,
  AttentionPlace,
  AttentionView,
  EpochNs,
  ObservationObjects,
  RunSnapshot,
  SessionId,
} from '@aang/contract'
import { type ReactElement, type RefObject, useEffect, useId, useRef, useState } from 'react'
import { dismissAttention, markAttentionViewed, SignedOut, Unreachable } from './api.js'
import { plural } from './format.js'
import { AttentionGlyph, LevelGlyph, ZoneGlyph } from './glyphs.js'
import {
  attentionAuthorLabel,
  attentionKindLabel,
  attentionOutcomeLabel,
  attentionPriorityLabel,
  basisLabel,
  itemForms,
  stageForms,
} from './labels.js'
import { LongText } from './long-text.js'
import { Moment } from './moment.js'
import { placeOf } from './objects.js'

type Act = 'view' | 'dismiss'

type Work =
  | { readonly state: 'idle' }
  | { readonly state: 'pending' }
  | { readonly state: 'failed'; readonly act: Act; readonly reason: string }

interface ZoneEntry {
  readonly item: AttentionItem
  readonly place: AttentionPlace
  readonly viewed: boolean
}

interface PastEntry {
  readonly item: AttentionItem
  readonly outcome: string
  readonly dismissed: boolean
  readonly at: EpochNs
}

interface ItemContext {
  readonly snapshot: RunSnapshot
  readonly hidden: ReadonlySet<AttentionItemId>
  readonly now: bigint
  readonly perform: (item: AttentionItem, act: Act) => Promise<void>
}

const failedAct: Readonly<Record<Act, string>> = {
  view: 'Не удалось отметить пункт',
  dismiss: 'Не удалось снять пункт',
}

const noticeLength = 48

const byMoment = (left: EpochNs, right: EpochNs): number => (left < right ? -1 : left > right ? 1 : 0)

const viewsOf = (snapshot: RunSnapshot): Map<AttentionItemId, AttentionView> =>
  new Map(snapshot.attention.views.map((view) => [view.item, view]))

const zoneEntries = (snapshot: RunSnapshot, views: ReadonlyMap<AttentionItemId, AttentionView>): ZoneEntry[] => {
  const items = new Map(snapshot.attention.items.map((item) => [item.id, item]))
  return snapshot.view.zone.flatMap((place): ZoneEntry[] => {
    const item = items.get(place.item)
    const view = views.get(place.item)
    if (item === undefined || item.resolution !== 'open' || (view?.dismissed_at ?? null) !== null) {
      return []
    }
    return [{ item, place, viewed: place.viewed || (view?.viewed_at ?? null) !== null }]
  })
}

const pastEntries = (snapshot: RunSnapshot, views: ReadonlyMap<AttentionItemId, AttentionView>): PastEntry[] =>
  snapshot.attention.items
    .flatMap((item): PastEntry[] => {
      const dismissedAt = views.get(item.id)?.dismissed_at ?? null
      if (dismissedAt !== null) {
        return [{ item, outcome: 'снят пользователем', dismissed: true, at: dismissedAt }]
      }
      return item.resolution === 'open'
        ? []
        : [
            {
              item,
              outcome: attentionOutcomeLabel(item.kind, item.resolution),
              dismissed: false,
              at: item.closed_at ?? item.opened_at,
            },
          ]
    })
    .sort((left, right) => byMoment(right.at, left.at))

const hiddenItems = (snapshot: RunSnapshot): Set<AttentionItemId> =>
  new Set(snapshot.view.placements.flatMap(({ attention }) => attention))

const sourceOf = (objects: ObservationObjects, item: AttentionItem) =>
  objects.questions.find(({ id }) => id === item.question) ?? objects.actions.find(({ id }) => id === item.action)

const itemPlace = (objects: ObservationObjects, item: AttentionItem): string | null => {
  const source = sourceOf(objects, item)
  return source === undefined ? null : placeOf(objects, source.session, source.agent)
}

const sessionEnded = (objects: ObservationObjects, item: AttentionItem): boolean => {
  const own: SessionId | undefined = sourceOf(objects, item)?.session
  const sessions = own === undefined ? objects.sessions : objects.sessions.filter(({ id }) => id === own)
  return sessions.length > 0 && sessions.every(({ state }) => state === 'ended')
}

const failureReason = (error: unknown): string =>
  error instanceof Unreachable ? 'нет связи с демоном' : error instanceof Error ? error.message : String(error)

const clipped = (text: string): string => {
  const [line = text] = text.split('\n')
  return line.length > noticeLength ? `${line.slice(0, noticeLength - 1)}…` : line
}

const OrderReasons = ({
  entry,
  stageTitles,
}: {
  readonly entry: ZoneEntry
  readonly stageTitles: readonly string[]
}): ReactElement => {
  const { place, viewed } = entry
  const blocking = place.dependent_stages.length
  return (
    <span className="zone-why">
      <span className="visually-hidden">Порядок: </span>
      {viewed ? (
        <span className="badge" data-tone="idle">
          <ZoneGlyph mark="viewed" />
          просмотрен
        </span>
      ) : null}
      {place.waiting_for_human ? (
        <span className="badge" data-tone="ask">
          <LevelGlyph level="caution" />
          ждёт ответа
        </span>
      ) : null}
      {blocking > 0 ? (
        <span className="badge" data-tone="hold" title={stageTitles.join('\n')}>
          <ZoneGlyph mark="blocks" />
          {`блокирует ${plural(blocking, stageForms)}`}
        </span>
      ) : null}
      {place.waiting_for_human || blocking > 0 ? null : (
        <span className="badge" data-tone="idle">
          <ZoneGlyph mark="age" />
          по времени открытия
        </span>
      )}
    </span>
  )
}

const ItemNotes = ({
  item,
  objects,
  hidden,
}: {
  readonly item: AttentionItem
  readonly objects: ObservationObjects
  readonly hidden: boolean
}): ReactElement | null => {
  const ended = sessionEnded(objects, item)
  const { likely_resolved: likely, priority } = item
  if (likely === null && priority === null && !ended && !hidden) {
    return null
  }
  return (
    <p className="zone-notes">
      {likely === null ? null : (
        <span className="badge" data-tone="done">
          <ZoneGlyph mark="likely" />
          вероятно отвечен
          {likely.basis.kind === 'observed' ? null : (
            <span className="badge-basis">{basisLabel[likely.basis.kind]}</span>
          )}
        </span>
      )}
      {ended ? (
        <span className="badge" data-tone="idle">
          <ZoneGlyph mark="ended" />
          сессия завершена
        </span>
      ) : null}
      {hidden ? (
        <span className="badge" data-tone="idle">
          <ZoneGlyph mark="hidden" />
          из скрытого элемента
        </span>
      ) : null}
      {priority === null ? null : (
        <span className="badge zone-advice" data-tone="idle" title="Оценка наблюдателя. Порядок зоны она не меняет.">
          <ZoneGlyph mark="recommended" />
          {`рекомендация: ${attentionPriorityLabel[priority.value]}`}
        </span>
      )}
    </p>
  )
}

const ZoneItem = ({ entry, context }: { readonly entry: ZoneEntry; readonly context: ItemContext }): ReactElement => {
  const { item, place, viewed } = entry
  const { snapshot, hidden, now, perform } = context
  const textId = useId()
  const [work, setWork] = useState<Work>({ state: 'idle' })
  const busy = work.state === 'pending'
  const act = (chosen: Act): void => {
    setWork({ state: 'pending' })
    perform(item, chosen).then(
      () => {
        setWork({ state: 'idle' })
      },
      (error: unknown) => {
        setWork({ state: 'failed', act: chosen, reason: failureReason(error) })
      },
    )
  }
  const stageTitles = place.dependent_stages.flatMap(
    (stage) => snapshot.model.stages.find(({ id }) => id === stage)?.title ?? [],
  )
  const where = itemPlace(snapshot.objects, item)
  return (
    <li
      className="zone-item"
      data-kind={item.kind}
      data-waiting={place.waiting_for_human}
      data-viewed={viewed}
      aria-busy={busy}
    >
      <p className="zone-kind">
        <AttentionGlyph kind={item.kind} />
        <span>{attentionKindLabel[item.kind]}</span>
        <OrderReasons entry={entry} stageTitles={stageTitles} />
      </p>
      <div className="zone-question" id={textId}>
        <LongText text={item.text} className="zone-text" />
      </div>
      <p className="zone-meta">
        {where === null ? null : <span>{where}</span>}
        <span>
          открыт <Moment at={item.opened_at} now={now} />
        </span>
        <span>{attentionAuthorLabel[item.author]}</span>
      </p>
      <ItemNotes item={item} objects={snapshot.objects} hidden={hidden.has(item.id)} />
      <div className="zone-actions">
        {viewed ? null : (
          <button
            type="button"
            className="zone-act"
            disabled={busy}
            aria-describedby={textId}
            onClick={() => {
              act('view')
            }}
          >
            Отметить просмотренным
          </button>
        )}
        <button
          type="button"
          className="zone-act"
          disabled={busy}
          aria-describedby={textId}
          onClick={() => {
            act('dismiss')
          }}
        >
          Снять
        </button>
      </div>
      {work.state === 'failed' ? (
        <p className="zone-failure" role="alert">
          {`${failedAct[work.act]}: ${work.reason}`}
        </p>
      ) : null}
    </li>
  )
}

const PastItem = ({ entry, now }: { readonly entry: PastEntry; readonly now: bigint }): ReactElement => (
  <li className="zone-past-item" data-dismissed={entry.dismissed}>
    <span className="zone-past-kind">
      <AttentionGlyph kind={entry.item.kind} />
      {attentionKindLabel[entry.item.kind]}
    </span>
    <span className="zone-past-text" title={entry.item.text}>
      {entry.item.text}
    </span>
    <span className="zone-past-outcome">
      {entry.dismissed ? <ZoneGlyph mark="dismissed" /> : null}
      {entry.outcome}
    </span>
    <span className="zone-past-time">
      <Moment at={entry.at} now={now} />
    </span>
  </li>
)

const Notice = ({
  text,
  anchor,
}: {
  readonly text: string | null
  readonly anchor: RefObject<HTMLParagraphElement | null>
}): ReactElement => (
  <p className="zone-notice" role="status" tabIndex={-1} ref={anchor} hidden={text === null}>
    {text}
  </p>
)

export interface ZoneHandlers {
  readonly onView: (view: AttentionView) => void
  readonly onSignedOut: () => void
}

export const AttentionZone = ({
  snapshot,
  now,
  handlers,
}: {
  readonly snapshot: RunSnapshot
  readonly now: bigint
  readonly handlers: ZoneHandlers
}): ReactElement => {
  const heading = useId()
  const historyId = useId()
  const anchor = useRef<HTMLParagraphElement>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const views = viewsOf(snapshot)
  const entries = zoneEntries(snapshot, views)
  const past = pastEntries(snapshot, views)
  const run = snapshot.run.id
  const perform = async (item: AttentionItem, act: Act): Promise<void> => {
    setNotice(null)
    try {
      const view = await (act === 'view' ? markAttentionViewed(run, item.id) : dismissAttention(run, item.id))
      handlers.onView(view)
    } catch (error) {
      if (error instanceof SignedOut) {
        handlers.onSignedOut()
        return
      }
      throw error
    }
    if (act === 'dismiss') {
      setNotice(`Пункт «${clipped(item.text)}» снят из зоны и сохранён в истории.`)
    }
  }
  useEffect(() => {
    if (notice !== null) {
      anchor.current?.focus()
    }
  }, [notice])
  const context: ItemContext = { snapshot, hidden: hiddenItems(snapshot), now, perform }
  return (
    <section className="zone" aria-labelledby={heading} data-calm={entries.length === 0}>
      <div className="zone-head">
        <h2 id={heading} className="section-title">
          Внимание
        </h2>
        {entries.length === 0 ? (
          <p className="zone-empty">
            Открытых пунктов нет. Вопросы и запросы одобрения, которые ждут человека, появятся здесь.
          </p>
        ) : (
          <p className="zone-note">Отметка и снятие меняют только этот вид: решателю ничего не отправляется.</p>
        )}
      </div>
      <Notice text={notice} anchor={anchor} />
      {entries.length === 0 ? null : (
        <ol className="zone-items" aria-label="Открытые пункты">
          {entries.map((entry) => (
            <ZoneItem key={entry.item.id} entry={entry} context={context} />
          ))}
        </ol>
      )}
      {past.length === 0 ? null : (
        <div className="zone-foot">
          <button
            type="button"
            className="text-button zone-history-toggle"
            aria-expanded={historyOpen}
            aria-controls={historyOpen ? historyId : undefined}
            onClick={() => {
              setHistoryOpen(!historyOpen)
            }}
          >
            {`История: ${plural(past.length, itemForms)}`}
          </button>
        </div>
      )}
      {historyOpen && past.length > 0 ? (
        <ol id={historyId} className="zone-past" aria-label="История зоны внимания">
          {past.map((entry) => (
            <PastItem key={entry.item.id} entry={entry} now={now} />
          ))}
        </ol>
      ) : null}
    </section>
  )
}
