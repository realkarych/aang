import type { ArtifactRef, ArtifactVersionId, FactId, ObserverCallId, RunId } from '@aang/contract'
import type { MapPredicate } from '@aang/record'
import type { Store } from '@aang/store'
import type { PlayerRoots } from '@aang/testkit'
import { controlRecords, indexRecords, type Played, stepRecords } from './control.js'
import type { Candidate, Evaluation, MeasuredCall, MeasuredEvent } from './files.js'
import { describeChange, emptyModel, type VersionState, versionStates } from './journal.js'
import { holds, type PredicateScope } from './predicate.js'

export interface EvaluationOptions {
  readonly store: Store
  readonly played: readonly Played[]
  readonly calls: readonly MeasuredCall[]
  readonly roots: PlayerRoots
  readonly windowMs: number
  readonly timeScale: number
}

const nanosecondsPerMillisecond = 1_000_000n

const millisecondsOf = (value: bigint): number => Number(value / nanosecondsPerMillisecond)

const referenceText = (ref: ArtifactRef): string => (ref.kind === 'file' ? ref.path : ref.kind === 'commit' ? ref.sha : ref.url)

const playbackTime = ({ recording, shift, startsAt }: Played, timeScale: number, sourceAt: bigint): number => {
  const origin = Date.parse(recording.manifest.recorded_at) + (recording.playback.steps[0]?.at ?? 0)
  return Math.round(startsAt + (millisecondsOf(sourceAt) - shift.ms - origin) * timeScale)
}

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
        observer_call: first.call,
      }
}

export const evaluateEvents = ({ store, played, calls, roots, windowMs, timeScale }: EvaluationOptions): MeasuredEvent[] => {
  const delivered = stepRecords(indexRecords(store), played, roots)
  const results = new Map(
    calls.flatMap(({ id, result_version: last }): [ObserverCallId, number][] => (last === null ? [] : [[id, last]])),
  )
  const journals = new Map<RunId, VersionState[]>()
  const statesOf = (run: RunId): VersionState[] => {
    const states = journals.get(run) ?? versionStates(store, run, results)
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
      .map(({ record, call, changes }) => ({
        run: record.run,
        version: record.version,
        at: millisecondsOf(record.created_at),
        after_ms: millisecondsOf(record.created_at - start),
        author: record.author,
        observer_call: call,
        changes: changes.map(describeChange),
      }))
      .toSorted((left, right) => left.at - right.at)
  }

  return played.flatMap((playback) => {
    const { recording, startsAt, steps } = playback
    return recording.events.map((event): MeasuredEvent => {
      const records = controlRecords(delivered.get(playback)?.get(event.index) ?? [])
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
        source_at: records.sourceAt === null ? null : playbackTime(playback, timeScale, records.sourceAt),
        runs: [...records.runs],
        evaluation,
      }
    })
  })
}
