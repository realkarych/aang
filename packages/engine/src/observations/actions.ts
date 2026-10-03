import type { ActionKey, ActionOutcome, Execution, RunId, SessionKey } from '@aang/contract'
import { canonicalJson, objectId } from '@aang/contract/ids'
import type { ObservationDraft, Transaction } from '@aang/store'
import type { AgentIdentity } from './agents.js'
import { byContent, byTime, type Evidence, ofKind } from './evidence.js'

interface ActionEvidence {
  readonly key: ActionKey
  readonly items: Evidence[]
}

interface ActionContext {
  readonly run: RunId
  readonly identity: AgentIdentity
}

const actionExecution = (outcome: ActionOutcome): Execution => {
  switch (outcome) {
    case 'ok':
      return { state: 'done' }
    case 'error':
      return { state: 'failed' }
    case 'denied':
    case 'interrupted':
      return { state: 'cancelled' }
    case 'unknown':
      return { state: 'unknown' }
  }
}

const projectAction = (
  transaction: Transaction,
  { key, items }: ActionEvidence,
  { run, identity }: ActionContext,
): string | null => {
  const first = items[0]?.fact
  if (first === undefined) {
    return null
  }
  const starts = ofKind(items, 'action_start')
  const ends = ofKind(items, 'action_end')
  const batches = ofKind(items, 'tool_batch_end')
  const denials = ofKind(items, 'permission_denied')
  const start = starts.toSorted(byContent)[0]?.fact
  const end = ends.toSorted(byContent)[0]?.fact
  const batch = batches.toSorted(byContent)[0]?.fact
  const denied = denials.toSorted(byTime)[0]?.fact
  const id = objectId(key)
  const previous = transaction.observations.getAction(id)
  const evidence = end ?? denied ?? batch
  const outcome =
    end?.payload.outcome ?? (denied !== undefined ? 'denied' : batch === undefined ? null : 'unknown')
  const tool =
    start?.payload.tool ??
    denied?.payload.tool ??
    batch?.payload.calls.find(({ call_id }) => call_id === key.call)?.tool ??
    ofKind(items, 'permission_decision')[0]?.fact.payload.tool ??
    'unknown'
  const draft: ObservationDraft = {
    id,
    key,
    session: objectId({ kind: 'session', runtime: key.runtime, session: key.session }),
    agent: objectId(identity.of(start ?? first)),
    run,
    tool,
    action_kind: start?.payload.action_kind ?? 'other',
    container:
      start?.payload.container_call == null ? null : objectId({ ...key, call: start.payload.container_call }),
    is_container: start?.payload.action_kind === 'code_cell',
    started_at: starts.toSorted(byTime)[0]?.fact.at ?? null,
    ended_at: [...ends, ...denials, ...batches].sort(byTime)[0]?.fact.at ?? null,
    outcome:
      outcome === null || evidence === undefined
        ? null
        : { value: outcome, basis: { kind: 'observed' }, evidence: [evidence.id] },
    execution:
      outcome === null ? { state: starts.length === 0 ? 'unknown' : 'running' } : actionExecution(outcome),
    input_fact: start?.id ?? null,
    output_fact: end?.id ?? batch?.id ?? null,
    inherited: previous?.inherited ?? false,
  }
  return transaction.observations.save(draft).id
}

export const projectActions = (
  transaction: Transaction,
  session: SessionKey,
  evidence: readonly Evidence[],
  context: ActionContext,
): string[] => {
  const groups = new Map<string, ActionEvidence>()
  const add = (key: ActionKey, item: Evidence): void => {
    const name = canonicalJson(key)
    const group = groups.get(name)
    if (group === undefined) {
      groups.set(name, { key, items: [item] })
    } else {
      group.items.push(item)
    }
  }
  for (const item of evidence) {
    const { fact } = item
    if (fact.entity_key.kind === 'action') {
      add(fact.entity_key, item)
    }
    if (fact.kind === 'tool_batch_end') {
      for (const { call_id: call } of fact.payload.calls) {
        add({ kind: 'action', runtime: session.runtime, session: session.session, call }, item)
      }
    }
  }
  return [...groups.values()].flatMap((group) => projectAction(transaction, group, context) ?? [])
}
