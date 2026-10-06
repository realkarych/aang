import type { ArtifactRef, ArtifactVersionId, FactId, RunId } from '@aang/contract'
import type { MapPredicate } from '@aang/record'
import type { Store } from '@aang/store'
import type { PlayedStep, PlayerRoots } from '@aang/testkit'
import { controlRecords, deliveryOf, type IndexedRecord, indexRecords } from './control.js'
import type { Candidate, Evaluation, MeasuredEvent } from './files.js'
import { describeChange, emptyModel, type VersionState, versionStates } from './journal.js'
import { holds, type PredicateScope } from './predicate.js'
import type { Recording } from './recording.js'

export interface Played {
  readonly recording: Recording
  readonly startsAt: number
  readonly steps: readonly PlayedStep[]
}

export interface EvaluationOptions {
  readonly store: Store
  readonly played: readonly Played[]
  readonly roots: PlayerRoots
  readonly windowMs: number
}

const nanosecondsPerMillisecond = 1_000_000n

const millisecondsOf = (value: bigint): number => Number(value / nanosecondsPerMillisecond)

const referenceText = (ref: ArtifactRef): string => (ref.kind === 'file' ? ref.path : ref.kind === 'commit' ? ref.sha : ref.url)

const judge = (
  run: RunId,
  states: readonly VersionState[],
  start: bigint,
  predicate: MapPredicate,
  scope: PredicateScope,
): Evaluation | null => {
  const baseline = states.findLast(({ record }) => record.created_at < start)
  if (holds(predicate, baseline?.model ?? emptyModel, scope)) {
    return { kind: 'held_before', run, version: baseline?.record.version ?? 0 }
  }
  const first = states.find(({ record, model }) => record.created_at >= start && holds(predicate, model, scope))
  return first === undefined
    ? null
    : {
        kind: 'satisfied',
        run: first.record.run,
        version: first.record.version,
        at: millisecondsOf(first.record.created_at),
        author: first.record.author,
        observer_call: first.record.observer_call,
      }
}

export const evaluateEvents = ({ store, played, roots, windowMs }: EvaluationOptions): MeasuredEvent[] => {
  const index: IndexedRecord[] = indexRecords(store)
  const journals = new Map<RunId, VersionState[]>()
  const statesOf = (run: RunId): VersionState[] => {
    const states = journals.get(run) ?? versionStates(store, run)
    journals.set(run, states)
    return states
  }
  const artifact = (version: ArtifactVersionId): string | null => {
    const found = store.artifacts.getVersion(version)
    return found === null ? null : referenceText(found.ref)
  }

  const predicateEvaluation = (predicate: MapPredicate, start: bigint, runs: readonly RunId[], facts: ReadonlySet<FactId>): Evaluation => {
    const scope: PredicateScope = { eventFacts: facts, artifact }
    const judged = runs.flatMap((run) => {
      const evaluation = judge(run, statesOf(run), start, predicate, scope)
      return evaluation === null ? [] : [evaluation]
    })
    const held = judged.find(({ kind }) => kind === 'held_before')
    const satisfied = judged
      .flatMap((evaluation) => (evaluation.kind === 'satisfied' ? [evaluation] : []))
      .toSorted((left, right) => left.at - right.at)[0]
    return held ?? satisfied ?? { kind: 'unsatisfied' }
  }

  const candidates = (start: bigint, runs: readonly RunId[]): Candidate[] => {
    const end = start + BigInt(windowMs) * nanosecondsPerMillisecond
    return runs
      .flatMap((run) =>
        statesOf(run).filter(({ record }) => record.created_at >= start && record.created_at <= end),
      )
      .map(({ record, changes }) => ({
        run: record.run,
        version: record.version,
        at: millisecondsOf(record.created_at),
        after_ms: millisecondsOf(record.created_at - start),
        author: record.author,
        observer_call: record.observer_call,
        changes: changes.map(describeChange),
      }))
      .toSorted((left, right) => left.at - right.at)
  }

  return played.flatMap(({ recording, startsAt, steps }) =>
    recording.events.map((event): MeasuredEvent => {
      const records = controlRecords(index, deliveryOf(recording, event.step, roots, startsAt), steps[event.index - 1], startsAt)
      const { description, predicate } = event.expected
      const start = records.observedAt
      const evaluation: Evaluation =
        start === null
          ? { kind: 'unmatched' }
          : predicate === undefined
            ? { kind: 'annotation', candidates: candidates(start, records.runs) }
            : predicateEvaluation(predicate, start, records.runs, records.facts)
      return {
        recording: recording.path,
        runtime: recording.manifest.runtime,
        label: event.label,
        description,
        predicate: predicate ?? null,
        played_at: steps[event.index]?.playedAt ?? startsAt,
        observed_at: start === null ? null : millisecondsOf(start),
        source_at: records.sourceAt === null ? null : millisecondsOf(records.sourceAt),
        runs: [...records.runs],
        evaluation,
      }
    }),
  )
}
