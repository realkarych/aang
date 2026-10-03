import type {
  AttentionItem,
  AttentionItemId,
  AttentionPlace,
  AttentionView,
  Link,
  RunId,
  Stage,
  StageId,
} from '@aang/contract'
import type { ModelReader } from '@aang/store'
import { compareText, grouped } from '../observations/evidence.js'

export interface ZoneModel {
  readonly stages: readonly Stage[]
  readonly links: readonly Link[]
  readonly attention: readonly AttentionItem[]
}

interface Ranked {
  readonly place: AttentionPlace
  readonly opened: AttentionItem['opened_at']
}

type LinkOf<K extends Link['kind']> = Extract<Link, { readonly kind: K }>

const linksOf = <K extends Link['kind']>(links: readonly Link[], kind: K): LinkOf<K>[] =>
  links.filter((link): link is LinkOf<K> => link.kind === kind)

const compareRanked = (left: Ranked, right: Ranked): number =>
  Number(left.place.viewed) - Number(right.place.viewed) ||
  Number(right.place.waiting_for_human) - Number(left.place.waiting_for_human) ||
  right.place.dependent_stages.length - left.place.dependent_stages.length ||
  (left.opened < right.opened ? -1 : left.opened > right.opened ? 1 : 0) ||
  compareText(left.place.item, right.place.item)

export const inZone = (item: AttentionItem, dismissed: ReadonlySet<AttentionItemId>): boolean =>
  item.resolution === 'open' && !dismissed.has(item.id)

export const dismissedItems = (views: readonly AttentionView[]): Set<AttentionItemId> =>
  new Set(views.flatMap(({ item, dismissed_at: dismissedAt }) => (dismissedAt === null ? [] : [item])))

export const attentionZone = (
  model: Pick<ModelReader, 'objectRun'>,
  run: RunId,
  { stages, links, attention }: ZoneModel,
  views: readonly AttentionView[],
): AttentionPlace[] => {
  const active = new Set(stages.flatMap(({ id, lifecycle }) => (lifecycle.state === 'active' ? [id] : [])))
  const assigned = grouped(linksOf(links, 'assignment'), ({ action }) => action)
  const dependentsOf = grouped(linksOf(links, 'dependency'), ({ depends_on: dependsOn }) => dependsOn)
  const dismissed = dismissedItems(views)
  const viewed = new Set(views.flatMap(({ item, viewed_at: viewedAt }) => (viewedAt === null ? [] : [item])))
  const ownStages = (item: AttentionItem): StageId[] => {
    if (item.stage !== null) {
      return [item.stage]
    }
    return item.action !== null && model.objectRun('action', item.action) === run
      ? (assigned.get(item.action) ?? []).map(({ stage }) => stage)
      : []
  }
  const dependentStages = (item: AttentionItem): StageId[] => {
    const found = new Set<StageId>()
    const pending = ownStages(item).filter((stage) => active.has(stage))
    for (let stage = pending.pop(); stage !== undefined; stage = pending.pop()) {
      if (!found.has(stage)) {
        found.add(stage)
        pending.push(
          ...(dependentsOf.get(stage) ?? []).flatMap((link) =>
            active.has(link.stage) && !found.has(link.stage) ? [link.stage] : [],
          ),
        )
      }
    }
    return [...found].sort(compareText)
  }
  return attention
    .filter((item) => inZone(item, dismissed))
    .map(
      (item): Ranked => ({
        place: {
          item: item.id,
          waiting_for_human: item.runtime_wait === 'active',
          dependent_stages: dependentStages(item),
          viewed: viewed.has(item.id),
        },
        opened: item.opened_at,
      }),
    )
    .sort(compareRanked)
    .map(({ place }) => place)
}
