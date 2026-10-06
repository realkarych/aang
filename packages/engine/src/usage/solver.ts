import {
  type Agent,
  type AgentId,
  ChangeSeq,
  type EpochNs,
  type RawSeq,
  type RunId,
  type RunUsage,
  type Session,
  type SessionId,
  type SessionUsage,
  type StageId,
  type StageInspector,
  type StreamKey,
  type ThreadTotal,
  type UsageRecord,
  type UsageTotals,
} from '@aang/contract'
import { canonicalJson, objectId } from '@aang/contract/ids'
import type { FactReader, ModelReader, Observation, ObservationReader, RawRecordReader } from '@aang/store'
import { byTime, compareText, type Evidence, grouped, type KindEvidence, ofKind } from '../observations/evidence.js'
import { byAccumulation, lastCostState } from '../observations/usage.js'
import { assignedStages, readSession, type SessionReading, stageAttribution, type StageOf } from './attribution.js'
import { hoursOf, type UsagePeriod, within, wholeTime } from './period.js'
import { activeMs, isActivity, runTime, type RunTime } from './time.js'
import { addTokens, noTokens } from './totals.js'

export interface UsageSource {
  readonly observations: ObservationReader
  readonly facts: FactReader
  readonly rawRecords: RawRecordReader
  readonly model: ModelReader
}

export interface SolverUsageOptions {
  readonly pauseAfterMs?: number
  readonly period?: UsagePeriod
}

export interface AgentUsage {
  readonly agent: AgentId
  readonly session: SessionId
  readonly totals: UsageTotals
  readonly active_ms: number
}

export interface SolverUsage {
  readonly run: RunId
  readonly journal: RunUsage['solver']
  readonly agents: readonly AgentUsage[]
  readonly time: RunTime
  readonly active_hours: readonly number[]
}

export type StageUsage = StageInspector['usage']

interface RunObservations {
  readonly sessions: readonly Session[]
  readonly agents: readonly Agent[]
  readonly records: readonly UsageRecord[]
  readonly readings: ReadonlyMap<string, SessionReading>
  readonly stageOf: StageOf
}

interface StreamLine {
  readonly path: string
  readonly line: number
  readonly at: EpochNs | null
}

interface CostLine {
  readonly state: string
  readonly path: string
  readonly line: number
  readonly item: KindEvidence<'cost_state'>
}

interface CostState {
  readonly copies: readonly [CostLine, ...CostLine[]]
  readonly writtenAfter: EpochNs | null
  readonly readBy: EpochNs
}

const defaultPauseAfterMs = 300_000

const pageSize = 256

const everything = ChangeSeq.parse(0)

export const usageTotals = (records: readonly UsageRecord[]): UsageTotals => ({
  tokens: records.reduce((sum, { tokens }) => addTokens(sum, tokens), noTokens),
  records: records.length,
  output_lower_bound: records.some(({ output_lower_bound: lowerBound }) => lowerBound),
  cost_usd: null,
})

export const counted = (record: UsageRecord): boolean => !record.inherited && !record.synthetic

const byId = <T extends { readonly id: string }>(left: T, right: T): number => compareText(left.id, right.id)

const isSession = (object: Observation): object is Session => object.key.kind === 'session'

const isAgent = (object: Observation): object is Agent => object.key.kind === 'agent'

const isUsage = (object: Observation): object is UsageRecord => object.key.kind === 'usage'

const observationsOf = (source: UsageSource, run: RunId): RunObservations => {
  const objects = source.observations.ofRun(run, everything, ['session', 'agent', 'usage'])
  const sessions = objects.filter(isSession).sort(byId)
  const readings = new Map(sessions.map((session) => [session.id, readSession(source, session)]))
  return {
    sessions,
    agents: objects.filter(isAgent).sort(byId),
    records: objects.filter(isUsage).filter(counted).sort(byId),
    readings,
    stageOf: stageAttribution(readings, assignedStages(source.model, run)),
  }
}

const streamLines = (rawRecords: RawRecordReader, stream: StreamKey): StreamLine[] => {
  const lines: StreamLine[] = []
  let after: RawSeq | null = null
  for (;;) {
    const page = rawRecords.ofStream(stream, after, pageSize)
    if (page.length === 0) {
      return lines
    }
    for (const { seq, position, source_ts: at } of page) {
      after = seq
      if (position.kind === 'line') {
        lines.push({ path: position.path, line: position.line, at })
      }
    }
  }
}

const latestOf = (times: readonly (EpochNs | null)[]): EpochNs | null =>
  times.reduce<EpochNs | null>((latest, at) => (at !== null && (latest === null || at > latest) ? at : latest), null)

const later = (at: EpochNs | null, than: EpochNs | null): boolean => at !== null && (than === null || at > than)

const costLines = (own: readonly Evidence[], stream: StreamKey): CostLine[] =>
  ofKind(own, 'cost_state').flatMap((item) => {
    const { fact, raw } = item
    return raw.stream === stream && raw.position.kind === 'line'
      ? [{ state: canonicalJson(fact.payload), path: raw.position.path, line: raw.position.line, item }]
      : []
  })

const linesBelow = (numbers: readonly number[], line: number): number => {
  let low = 0
  let high = numbers.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if ((numbers[middle] ?? line) < line) {
      low = middle + 1
    } else {
      high = middle
    }
  }
  return low
}

const latestBefore = (lines: readonly StreamLine[]): ((copy: CostLine) => EpochNs | null) => {
  const files = new Map(
    [...grouped(lines, ({ path }) => path)].map(([path, held]) => {
      const ordered = held.toSorted((left, right) => left.line - right.line)
      const prefix: (EpochNs | null)[] = []
      for (const { at } of ordered) {
        prefix.push(latestOf([prefix.at(-1) ?? null, at]))
      }
      return [path, { numbers: ordered.map(({ line }) => line), prefix }]
    }),
  )
  return ({ path, line }) => {
    const file = files.get(path)
    return file === undefined ? null : (file.prefix[linesBelow(file.numbers, line) - 1] ?? null)
  }
}

const costStates = (lines: readonly StreamLine[], costs: readonly CostLine[]): CostState[] => {
  const writtenAfter = latestBefore(lines)
  return [...grouped(costs, ({ state }) => state).values()]
    .map((copies) => ({
      copies,
      writtenAfter: latestOf(copies.map(writtenAfter)),
      readBy: copies
        .map(({ item }) => item.raw.observed_at)
        .reduce((earliest, seen) => (seen < earliest ? seen : earliest)),
    }))
    .sort((left, right) => byAccumulation(left.copies[0].item, right.copies[0].item))
}

const launchedBy = (starts: readonly Evidence[], ends: readonly CostState[]): boolean => {
  let next = 0
  for (const { fact } of starts.toSorted(byTime)) {
    const index = ends.findIndex(({ readBy }, position) => position >= next && fact.at < readBy)
    if (index < 0) {
      return false
    }
    next = index + 1
  }
  return true
}

const costStateFinal = (rawRecords: RawRecordReader, own: readonly Evidence[]): boolean => {
  const last = lastCostState(own)
  const stream = last?.raw.stream ?? null
  if (last === null || stream === null) {
    return false
  }
  const lines = streamLines(rawRecords, stream)
  const states = costStates(lines, costLines(own, stream))
  const total = states.find(({ copies }) => copies[0].state === canonicalJson(last.fact.payload))
  if (total === undefined) {
    return false
  }
  const { copies, writtenAfter, readBy } = total
  const holders = new Set(copies.map(({ path }) => path))
  const continued = lines.some(
    ({ path, line, at }) =>
      later(at, readBy) ||
      (holders.has(path) ? at !== null && copies.some((copy) => copy.path === path && line > copy.line) : later(at, writtenAfter)),
  )
  const ended = states.filter((state) => !later(writtenAfter, state.writtenAfter))
  const starts = ofKind(own, 'session_start').filter(({ fact }) => later(fact.at, writtenAfter))
  return !continued && launchedBy(starts, ended.slice(1))
}

const threadTotals = (agents: readonly Agent[], session: SessionId): ThreadTotal[] =>
  agents.flatMap(({ id, session: owner, thread_total: tokens }) =>
    owner === session && tokens !== null ? [{ agent: id, tokens }] : [],
  )

const sessionUsage = (
  rawRecords: RawRecordReader,
  session: Session,
  records: readonly UsageRecord[],
  agents: readonly Agent[],
  reading: SessionReading | undefined,
): SessionUsage => ({
  session: session.id,
  fork: reading?.fork ?? false,
  totals: usageTotals(records.filter((record) => record.session === session.id)),
  cost_state: session.cost_state,
  cost_state_final: session.cost_state !== null && costStateFinal(rawRecords, reading?.own ?? []),
  thread_totals: threadTotals(agents, session.id),
})

const agentFacts = (readings: ReadonlyMap<string, SessionReading>): Map<string, Evidence[]> => {
  const facts = new Map<string, Evidence[]>()
  for (const { own, identity } of readings.values()) {
    for (const item of own) {
      const agent = objectId(identity.of(item.fact))
      const items = facts.get(agent)
      if (items === undefined) {
        facts.set(agent, [item])
      } else {
        items.push(item)
      }
    }
  }
  return facts
}

const agentUsage = (agent: Agent, records: readonly UsageRecord[], own: readonly Evidence[]): AgentUsage => ({
  agent: agent.id,
  session: agent.session,
  totals: usageTotals(records.filter((record) => record.agent === agent.id)),
  active_ms: activeMs(own),
})

const byStage = (records: readonly UsageRecord[], stageOf: StageOf): Map<StageId | null, UsageRecord[]> => {
  const stages = new Map<StageId | null, UsageRecord[]>()
  for (const record of records) {
    const stage = stageOf(record)
    const members = stages.get(stage)
    if (members === undefined) {
      stages.set(stage, [record])
    } else {
      members.push(record)
    }
  }
  return stages
}

export const solverUsage = (
  source: UsageSource,
  run: RunId,
  { pauseAfterMs = defaultPauseAfterMs, period = wholeTime }: SolverUsageOptions = {},
): SolverUsage => {
  const { sessions, agents, records: all, readings, stageOf } = observationsOf(source, run)
  const records = all.filter(({ at }) => within(period, at))
  const stages = byStage(records, stageOf)
  const facts = agentFacts(readings)
  const inPeriod = ({ fact }: Evidence): boolean => within(period, fact.at)
  const activity = [...readings.values()].flatMap(({ own }) =>
    own.filter((item) => isActivity(item) && inPeriod(item)).map(({ fact }) => fact.at),
  )
  return {
    run,
    journal: {
      totals: usageTotals(records),
      stages: [...stages]
        .flatMap(([stage, members]) => (stage === null ? [] : [{ stage, totals: usageTotals(members) }]))
        .sort((left, right) => compareText(left.stage, right.stage)),
      unassigned: usageTotals(stages.get(null) ?? []),
      sessions: sessions.map((session) =>
        sessionUsage(source.rawRecords, session, records, agents, readings.get(session.id)),
      ),
    },
    agents: agents.map((agent) => agentUsage(agent, records, (facts.get(agent.id) ?? []).filter(inPeriod))),
    time: runTime(activity, pauseAfterMs),
    active_hours: hoursOf(activity),
  }
}

export const usageByStage = (source: UsageSource, run: RunId): Map<StageId | null, UsageRecord[]> => {
  const { records, stageOf } = observationsOf(source, run)
  return byStage(records, stageOf)
}

const stageSessions = (source: UsageSource, run: RunId, stage: StageId): Set<SessionId> => {
  const sessions = new Set<SessionId>()
  for (const entity of source.model.entities(run)) {
    const link = entity.kind === 'link' ? entity.value : null
    const session =
      link?.kind === 'assignment' && link.stage === stage
        ? source.observations.getAction(link.action)?.session
        : link?.kind === 'participation' && link.stage === stage
          ? source.observations.getAgent(link.agent)?.session
          : undefined
    if (session !== undefined) {
      sessions.add(session)
    }
  }
  return sessions
}

export const stageUsage = (source: UsageSource, run: RunId, stage: StageId): StageUsage => {
  const sessions = stageSessions(source, run, stage)
  const stages = usageByStage(source, run)
  return {
    stage: usageTotals(stages.get(stage) ?? []),
    unassigned_in_sessions: usageTotals((stages.get(null) ?? []).filter((record) => sessions.has(record.session))),
  }
}
