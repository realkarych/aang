import type { Action, ActionId, ActionKind, CollapsedFacts, Fact, InputFact } from '@aang/contract'
import { compareText } from '../observations/evidence.js'

export interface BatchEntry {
  readonly fact: Fact
  readonly input: InputFact
  readonly action: Action | null
}

export interface CollapsedBatch {
  readonly facts: BatchEntry[]
  readonly collapsed: CollapsedFacts[]
}

interface Member {
  readonly entry: BatchEntry
  readonly position: number
}

interface Series {
  readonly tool: string
  readonly kind: ActionKind
  readonly members: Member[]
  readonly actions: Set<ActionId>
}

const routineKinds: ReadonlySet<ActionKind> = new Set(['file_read', 'search'])

const seriesActions = 3

const routine = ({ fact, action }: BatchEntry): Action | null => {
  if (action === null || fact.urgent || !routineKinds.has(action.action_kind)) {
    return null
  }
  return fact.kind === 'action_start' || (fact.kind === 'action_end' && fact.payload.outcome === 'ok') ? action : null
}

const counterOf = ({ tool, kind, members }: Series): CollapsedFacts => {
  const times = members.map(({ entry }) => entry.input.at).toSorted(compareText)
  return {
    tool,
    action_kind: kind,
    agent: members[0]?.entry.input.agent ?? null,
    facts: members.map(({ entry }) => entry.input.id),
    from: times[0] ?? '',
    to: times.at(-1) ?? '',
  }
}

const seriesOfStream = (members: readonly Member[]): Series[] => {
  const runs: Series[] = []
  let open = false
  for (const member of members) {
    const action = routine(member.entry)
    const last = runs.at(-1)
    if (action === null) {
      open = false
    } else if (open && last?.tool === action.tool && last.kind === action.action_kind) {
      last.members.push(member)
      last.actions.add(action.id)
    } else {
      runs.push({ tool: action.tool, kind: action.action_kind, members: [member], actions: new Set([action.id]) })
      open = true
    }
  }
  return runs.filter(({ actions }) => actions.size >= seriesActions)
}

export const collapseRoutine = (entries: readonly BatchEntry[]): CollapsedBatch => {
  const streams = new Map<string, Member[]>()
  entries.forEach((entry, position) => {
    const key = JSON.stringify([entry.input.session, entry.input.agent])
    streams.set(key, [...(streams.get(key) ?? []), { entry, position }])
  })
  const series = [...streams.values()]
    .flatMap(seriesOfStream)
    .toSorted((left, right) => (left.members[0]?.position ?? 0) - (right.members[0]?.position ?? 0))
  const folded = new Set(series.flatMap(({ members }) => members.map(({ entry }) => entry.input.id)))
  return { facts: entries.filter(({ input }) => !folded.has(input.id)), collapsed: series.map(counterOf) }
}
