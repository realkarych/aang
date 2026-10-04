import {
  type ActionMaterial,
  type AttentionItem,
  type ChatFocus,
  type ChatInput,
  type ChatMessage,
  type ChatNeed,
  type ChatTurn,
  type EpochNs,
  type InputArtifactVersion,
  type InputFact,
  type Link,
  type ModelChange,
  ModelVersion,
  type RunId,
  type Runtime,
  type Stage,
  type StageId,
} from '@aang/contract'
import type { ChatReader, Transaction, ViewReader } from '@aang/store'
import { compareText } from '../observations/evidence.js'
import { origin, partsOf } from '../read/context.js'
import { attentionZone } from '../view/zone.js'
import { describeRun, factInput, snapshotAttentionItem, snapshotOf } from '../input/batch.js'
import {
  clipInputFact,
  clipNote,
  clipOptional,
  clipRun,
  clipSnapshot,
  defaultInputTokens,
  firstCallTokens,
  longestStateText,
  mergedTruncation,
  type Packing,
  packInput,
} from '../input/fit.js'
import { actionMaterial, clipJson, clipText, isoTime } from '../input/materials.js'
import { type InputScope, inputScope, type ScopeReader } from '../input/scope.js'
import { clipEntries, journalEntry } from './journal.js'
import { resolveChatNeeds } from './materials.js'

export interface ChatLimits {
  readonly inputTokens: number
  readonly textLength: number
  readonly history: number
  readonly focus: number
  readonly needs: number
}

export const defaultChatLimits: ChatLimits = {
  inputTokens: defaultInputTokens,
  textLength: 4_000,
  history: 10,
  focus: 20,
  needs: 8,
}

export type ChatErrorCode = 'unknown_stage' | 'input_limit'

export class ChatError extends Error {
  override readonly name = 'ChatError'

  constructor(
    readonly code: ChatErrorCode,
    message: string,
  ) {
    super(message)
  }
}

export interface ChatStart {
  readonly run: RunId
  readonly stage: StageId | null
  readonly question: string
  readonly backend: Runtime
  readonly crossVendor: boolean
  readonly at: EpochNs
  readonly limits?: ChatLimits
}

export interface ChatTurnStart {
  readonly message: ChatMessage
  readonly input: ChatInput
}

export interface ChatFollowUp {
  readonly input: ChatInput
  readonly needs: readonly ChatNeed[]
  readonly backend: Runtime
  readonly crossVendor: boolean
  readonly limits?: ChatLimits
}

export type ChatSource = ScopeReader & { readonly chat: ChatReader; readonly views: ViewReader }

const limitsOf = (limits: ChatLimits = defaultChatLimits): ChatLimits => {
  if (!Object.values(limits).every((value) => Number.isSafeInteger(value) && value > 0)) {
    throw new RangeError('chat limits must be positive integers')
  }
  return limits
}

const last = <T>(list: readonly T[], count: number): T[] => list.slice(Math.max(0, list.length - count))

const journalKinds: ReadonlySet<ModelChange['target']['kind']> = new Set(['stage', 'criterion', 'card', 'attention_item'])

const clipAction = (material: ActionMaterial, limit: number): ActionMaterial => {
  const input = clipJson(material.input, 'input', limit)
  const output = material.output === null ? null : clipText(material.output, 'output', limit)
  return {
    ...material,
    input: input.value,
    output: output?.value ?? null,
    truncated: mergedTruncation(material.truncated, [...input.truncated, ...(output?.truncated ?? [])]),
  }
}

const clipFocus = (focus: ChatFocus, batchText: number, stateText: number): ChatFocus =>
  focus.kind === 'stage'
    ? {
        ...focus,
        facts: focus.facts.map((fact) => clipInputFact(fact, batchText)),
        actions: focus.actions.map((action) => clipAction(action, batchText)),
      }
    : {
        ...focus,
        attention: focus.attention.map((item) => ({ ...item, text: clipNote(item.text, stateText) })),
        recent_changes: clipEntries(focus.recent_changes, batchText),
      }

const clipTurn = (turn: ChatTurn, limit: number): ChatTurn => ({
  ...turn,
  question: clipNote(turn.question, limit),
  answer: clipOptional(turn.answer, limit),
})

const focusSize = (focus: ChatFocus): number =>
  focus.kind === 'stage'
    ? Math.max(focus.facts.length, focus.actions.length, focus.artifact_versions.length)
    : Math.max(focus.attention.length, focus.recent_changes.length)

const narrowed = (focus: ChatFocus, count: number): ChatFocus =>
  focus.kind === 'stage'
    ? {
        ...focus,
        facts: last(focus.facts, count),
        actions: last(focus.actions, count),
        artifact_versions: last(focus.artifact_versions, count),
      }
    : { ...focus, attention: focus.attention.slice(0, count), recent_changes: last(focus.recent_changes, count) }

const longestText = (input: Pick<ChatInput, 'run' | 'model' | 'history' | 'focus'>): number =>
  Math.max(
    longestStateText({ run: input.run, model: input.model, previous_attempt: null }),
    ...input.history.flatMap(({ question, answer }) => [question.length, answer?.length ?? 0]),
    ...(input.focus.kind === 'run' ? input.focus.attention.map(({ text }) => text.length) : []),
  )

const linksOf = (source: ChatSource, run: RunId): Link[] =>
  source.model.entities(run).flatMap((entity) => (entity.kind === 'link' ? [entity.value] : []))

const compareEpochs = (left: EpochNs | null, right: EpochNs | null): number =>
  left === right ? 0 : left === null ? -1 : right === null ? 1 : left < right ? -1 : 1

const byTime = (left: { readonly at: string; readonly id: string }, right: { readonly at: string; readonly id: string }): number =>
  compareText(left.at, right.at) || compareText(left.id, right.id)

const stageFocus = (source: ChatSource, scope: InputScope, stage: Stage, textLength: number): ChatFocus => {
  const links = linksOf(source, scope.run)
  const actions = links
    .flatMap((link) => (link.kind === 'assignment' && link.stage === stage.id ? [source.observations.getAction(link.action)] : []))
    .flatMap((action) => (action === null || scope.action(action) !== null ? [] : [action]))
    .sort((left, right) => compareEpochs(left.started_at, right.started_at) || compareText(left.id, right.id))
  const factIds = new Set([
    ...stage.evidence,
    ...actions.flatMap(({ input_fact: start, output_fact: end }) => [start, end].flatMap((id) => (id === null ? [] : [id]))),
  ])
  const facts: InputFact[] = [...factIds]
    .flatMap((id) => {
      const fact = source.facts.get(id)
      return fact === null || scope.fact(fact) !== null ? [] : [factInput(source, scope, fact, textLength)]
    })
    .sort(byTime)
  const versions: InputArtifactVersion[] = [
    ...new Set(links.flatMap((link) => (link.kind === 'artifact' && link.stage === stage.id ? [link.version] : []))),
  ].flatMap((id) => {
    const version = source.artifacts.getVersion(id)
    if (version === null || source.model.objectRun('artifact_version', id) !== scope.run) {
      return []
    }
    const producer = version.produced_by === null ? null : source.observations.getAction(version.produced_by)
    if (producer !== null && scope.action(producer) !== null) {
      return []
    }
    const { retention } = version
    return [
      {
        id: version.id,
        ref: version.ref,
        produced_by: version.produced_by,
        retained:
          (retention.kind === 'action_payload' || retention.kind === 'file_read') &&
          source.artifacts.blob(retention.blob) !== null,
      },
    ]
  })
  return {
    kind: 'stage',
    stage: stage.id,
    facts,
    actions: actions.map((action) => actionMaterial(source, action, textLength)),
    artifact_versions: versions,
  }
}

const runFocus = (source: ChatSource, scope: InputScope, limits: ChatLimits): ChatFocus => {
  const { run } = scope
  const parts = partsOf(source.model.entities(run))
  const stages = new Set(
    parts.stages.flatMap(({ id, lifecycle }) =>
      lifecycle.state === 'active' && scope.entity({ kind: 'stage', id }) === null ? [id] : [],
    ),
  )
  const items = new Map<string, AttentionItem>(parts.attention.map((item) => [item.id, item]))
  const attention = attentionZone(source.model, run, parts, source.views.attention(run, origin)).flatMap(
    ({ item }) => {
      const value = items.get(item)
      return value === undefined || scope.entity({ kind: 'attention_item', id: value.id }) !== null
        ? []
        : [snapshotAttentionItem(value, value.stage !== null && stages.has(value.stage) ? value.stage : null)]
    },
  )
  const head = source.model.head(run)
  const recent = source.model
    .changes(run, ModelVersion.parse(Math.max(0, head - limits.focus)))
    .filter(({ target }) => journalKinds.has(target.kind) && scope.entity(target) === null)
    .map(journalEntry)
  return { kind: 'run', attention, recent_changes: last(recent, limits.focus) }
}

const historyOf = (source: ChatSource, run: RunId, limit: number): ChatTurn[] =>
  last(
    source.chat.messages(run).filter(({ status }) => status === 'answered'),
    limit,
  ).map(({ question, answer, version, asked_at: askedAt }) => ({ question, answer, version, asked_at: isoTime(askedAt) }))

const stageOf = (source: ChatSource, scope: InputScope, id: StageId): Stage => {
  const entity = source.model.entity(scope.run, { kind: 'stage', id })
  const exclusion = entity === null ? 'out_of_scope' : scope.entity({ kind: 'stage', id })
  if (entity?.kind !== 'stage' || exclusion !== null) {
    throw new ChatError('unknown_stage', `stage ${id} is not in the chat scope of run ${scope.run}`)
  }
  return entity.value
}

export const startChat = (transaction: Transaction, start: ChatStart): ChatTurnStart | null => {
  const limits = limitsOf(start.limits)
  const entity = transaction.model.entity(start.run, { kind: 'run', id: start.run })
  if (entity?.kind !== 'run') {
    return null
  }
  const run = entity.value
  const scope = inputScope(transaction, { run: run.id, backend: start.backend, crossVendor: start.crossVendor })
  const focus =
    start.stage === null
      ? runFocus(transaction, scope, limits)
      : stageFocus(transaction, scope, stageOf(transaction, scope, start.stage), limits.textLength)
  const base = {
    question: start.question,
    history: historyOf(transaction, run.id, limits.history),
    run: describeRun(transaction, scope, run),
    model: snapshotOf(transaction, scope),
    focus,
  }
  const render = ({ count, batchText, stateText }: Packing): ChatInput => ({
    question: base.question,
    history: base.history.map((turn) => clipTurn(turn, stateText)),
    run: clipRun(base.run, stateText),
    model: clipSnapshot(base.model, stateText),
    focus: clipFocus(narrowed(base.focus, count), batchText, stateText),
    materials: [],
  })
  const tokens = firstCallTokens(limits.inputTokens)
  const input = packInput(
    { count: focusSize(focus), minimumCount: 0, batchText: limits.textLength, stateText: longestText(base) },
    tokens,
    render,
  )
  if (input === null) {
    throw new ChatError('input_limit', `the question and the run do not fit the chat input limit of ${String(tokens)} tokens`)
  }
  const message = transaction.chat.ask({
    run: run.id,
    stage: start.stage,
    question: start.question,
    version: input.model.version,
    asked_at: start.at,
  })
  return { message, input }
}

export const followUpChat = (source: ChatSource, followUp: ChatFollowUp): ChatInput | null => {
  const limits = limitsOf(followUp.limits)
  const base = followUp.input
  const scope = inputScope(source, { run: base.run.id, backend: followUp.backend, crossVendor: followUp.crossVendor })
  const materials = (textLength: number) =>
    resolveChatNeeds(source, scope, followUp.needs, base.model.version, { needs: limits.needs, textLength })
  const render = ({ count, batchText, stateText }: Packing): ChatInput => ({
    ...base,
    history: base.history.map((turn) => clipTurn(turn, stateText)),
    run: clipRun(base.run, stateText),
    model: clipSnapshot(base.model, stateText),
    focus: clipFocus(base.focus, batchText, stateText),
    materials: materials(batchText).slice(0, count),
  })
  return packInput(
    { count: materials(limits.textLength).length, minimumCount: 1, batchText: limits.textLength, stateText: longestText(base) },
    limits.inputTokens,
    render,
  )
}
