import type { InputFact, ModelSnapshot, ObserverInput, RunDescription, Truncation } from '@aang/contract'
import { clipJson, jsonBytes, prefixOf } from './materials.js'

export interface Packing {
  readonly count: number
  readonly batchText: number
  readonly stateText: number
}

export interface PackingRange {
  readonly count: number
  readonly minimumCount: number
  readonly batchText: number
  readonly stateText: number
}

export const defaultInputTokens = 24_000

const bytesPerToken = 4

const materialShare = 8

const batchTextFloor = 256

const stateTextFloor = 64

const clipMark = '…'

export const observerInputTokens = (input: ObserverInput): number =>
  Math.ceil(Buffer.byteLength(JSON.stringify(input)) / bytesPerToken)

export const firstCallTokens = (tokens: number): number => tokens - Math.floor(tokens / materialShare)

const largest = (low: number, high: number, fits: (value: number) => boolean): number | null => {
  if (fits(high)) {
    return high
  }
  if (low >= high || !fits(low)) {
    return null
  }
  let found = low
  let upper = high - 1
  while (found < upper) {
    const middle = Math.ceil((found + upper) / 2)
    if (fits(middle)) {
      found = middle
    } else {
      upper = middle - 1
    }
  }
  return found
}

export const packObserverInput = (
  range: PackingRange,
  tokens: number,
  render: (packing: Packing) => ObserverInput,
): ObserverInput | null => {
  const attempt = (packing: Packing): ObserverInput | null => {
    const input = render(packing)
    return observerInputTokens(input) <= tokens ? input : null
  }
  const batchFloor = Math.min(batchTextFloor, range.batchText)
  const stateFloor = Math.min(stateTextFloor, range.stateText)
  const batchText = (count: number): number | null =>
    largest(batchFloor, range.batchText, (value) => attempt({ count, batchText: value, stateText: Infinity }) !== null)
  const stateText = (count: number): number | null =>
    largest(stateFloor, range.stateText, (value) => attempt({ count, batchText: batchFloor, stateText: value }) !== null)
  const full = batchText(range.count)
  if (full !== null) {
    return attempt({ count: range.count, batchText: full, stateText: Infinity })
  }
  const shortened = stateText(range.count)
  if (shortened !== null) {
    return attempt({ count: range.count, batchText: batchFloor, stateText: shortened })
  }
  for (let count = range.count - 1; count >= range.minimumCount; count -= 1) {
    const text = batchText(count)
    if (text !== null) {
      return attempt({ count, batchText: text, stateText: Infinity })
    }
  }
  if (range.minimumCount >= range.count) {
    return null
  }
  const last = stateText(range.minimumCount)
  return last === null ? null : attempt({ count: range.minimumCount, batchText: batchFloor, stateText: last })
}

const mergedTruncation = (previous: readonly Truncation[], next: readonly Truncation[]): Truncation[] => {
  const original = new Map(previous.map((entry) => [entry.path, entry.length]))
  const paths = new Set(next.map(({ path }) => path))
  return [
    ...previous.filter(({ path }) => !paths.has(path)),
    ...next.map(({ path, length }) => ({ path, length: original.get(path) ?? length })),
  ]
}

export const clipInputFact = (fact: InputFact, limit: number): InputFact => {
  const payload = clipJson(fact.payload, 'payload', limit)
  return { ...fact, payload: payload.value, truncated: mergedTruncation(fact.truncated, payload.truncated) }
}

const clipNote = (text: string, limit: number): string => {
  if (text.length <= limit) {
    return text
  }
  const clipped = `${prefixOf(text, limit)}${clipMark}`
  return jsonBytes(clipped) < jsonBytes(text) ? clipped : text
}

const clipOptional = (text: string | null, limit: number): string | null =>
  text === null ? null : clipNote(text, limit)

export const clipRun = (run: RunDescription, limit: number): RunDescription => ({
  ...run,
  goal: clipOptional(run.goal, limit),
  brief: clipOptional(run.brief, limit),
  agents: run.agents.map((agent) => ({ ...agent, description: clipOptional(agent.description, limit) })),
})

export const clipSnapshot = (model: ModelSnapshot, limit: number): ModelSnapshot => ({
  ...model,
  stages: model.stages.map((stage) => ({
    ...stage,
    title: clipNote(stage.title, limit),
    expected_result: clipOptional(stage.expected_result, limit),
    summary: clipOptional(stage.summary, limit),
  })),
  criteria: model.criteria.map((criterion) => ({ ...criterion, text: clipNote(criterion.text, limit) })),
  attention: model.attention.map((item) => ({ ...item, text: clipNote(item.text, limit) })),
})

export const clipAttempt = (attempt: ObserverInput['previous_attempt'], limit: number): ObserverInput['previous_attempt'] =>
  attempt === null ? null : { reasons: attempt.reasons.map((reason) => clipNote(reason, limit)) }

export const longestStateText = (input: Pick<ObserverInput, 'run' | 'model' | 'previous_attempt'>): number =>
  Math.max(
    0,
    ...[
      input.run.goal,
      input.run.brief,
      ...input.run.agents.map(({ description }) => description),
      ...input.model.stages.flatMap(({ title, expected_result, summary }) => [title, expected_result, summary]),
      ...input.model.criteria.map(({ text }) => text),
      ...input.model.attention.map(({ text }) => text),
      ...(input.previous_attempt?.reasons ?? []),
    ].map((text) => text?.length ?? 0),
  )
