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
  type TokenUsage,
  type UsageRecord,
  type UsageTotals,
} from '@aang/contract'
import { canonicalJson, objectId } from '@aang/contract/ids'
import type { FactReader, ModelReader, Observation, ObservationReader, RawRecordReader } from '@aang/store'
import { compareText, type Evidence, grouped, ofKind } from '../observations/evidence.js'
import { redeliveries } from '../observations/redelivery.js'
import { lastCostState } from '../observations/usage.js'
import { assignedStages, readSession, type SessionReading, stageAttribution, type StageOf } from './attribution.js'
import { activeMs, isActivity, runTime, type RunTime } from './time.js'

export interface UsageSource {
  readonly observations: ObservationReader
  readonly facts: FactReader
  readonly rawRecords: RawRecordReader
  readonly model: ModelReader
}

export interface SolverUsageOptions {
  readonly pauseAfterMs?: number
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
}

interface CostState {
  readonly copies: readonly CostLine[]
  readonly writtenAfter: EpochNs | null
}

const defaultPauseAfterMs = 300_000

const pageSize = 256

const everything = ChangeSeq.parse(0)

const noTokens: TokenUsage = {
  uncached_input_tokens: 0,
  cache_read_input_tokens: 0,
  cache_write_input_tokens: 0,
  output_tokens: 0,
  reasoning_output_tokens: null,
}

const addTokens = (sum: TokenUsage, tokens: TokenUsage): TokenUsage => ({
  uncached_input_tokens: sum.uncached_input_tokens + tokens.uncached_input_tokens,
  cache_read_input_tokens: sum.cache_read_input_tokens + tokens.cache_read_input_tokens,
  cache_write_input_tokens: sum.cache_write_input_tokens + tokens.cache_write_input_tokens,
  output_tokens: sum.output_tokens + tokens.output_tokens,
  reasoning_output_tokens:
    tokens.reasoning_output_tokens === null
      ? sum.reasoning_output_tokens
      : (sum.reasoning_output_tokens ?? 0) + tokens.reasoning_output_tokens,
})

const usageTotals = (records: readonly UsageRecord[]): UsageTotals => ({
  tokens: records.reduce((sum, { tokens }) => addTokens(sum, tokens), noTokens),
  records: records.length,
  output_lower_bound: records.some(({ output_lower_bound: lowerBound }) => lowerBound),
  cost_usd: null,
})

const counted = (record: UsageRecord): boolean => !record.inherited && !record.synthetic

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
  ofKind(own, 'cost_state').flatMap(({ fact, raw }) =>
    raw.stream === stream && raw.position.kind === 'line'
      ? [{ state: canonicalJson(fact.payload), path: raw.position.path, line: raw.position.line }]
      : [],
  )

const latestBefore = (lines: readonly StreamLine[]): ((line: number) => EpochNs | null) => {
  const sorted = lines.toSorted((left, right) => left.line - right.line)
  const latest: (EpochNs | null)[] = []
  for (const { at } of sorted) {
    latest.push(latestOf([latest.at(-1) ?? null, at]))
  }
  return (line) => {
    let low = 0
    let high = sorted.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if ((sorted[middle]?.line ?? line) < line) {
        low = middle + 1
      } else {
        high = middle
      }
    }
    return latest[low - 1] ?? null
  }
}

const costStates = (lines: readonly StreamLine[], costs: readonly CostLine[]): Map<string, CostState> => {
  const inStream = latestBefore(lines)
  const inFile = new Map([...grouped(lines, ({ path }) => path)].map(([path, members]) => [path, latestBefore(members)]))
  const writtenAfter = ({ path, line }: CostLine): EpochNs | null => inFile.get(path)?.(line) ?? inStream(line)
  return new Map(
    [...grouped(costs, ({ state }) => state)].map(([state, copies]) => [
      state,
      { copies, writtenAfter: latestOf(copies.map(writtenAfter)) },
    ]),
  )
}

const launches = (starts: readonly Evidence[]): number => {
  const delivered = new Map(redeliveries(starts).flatMap(({ id, facts }) => facts.map((fact) => [fact, id])))
  return new Set(starts.map(({ fact }) => delivered.get(fact.id) ?? fact.id)).size
}

const costStateFinal = (rawRecords: RawRecordReader, own: readonly Evidence[]): boolean => {
  const last = lastCostState(own)
  const stream = last?.raw.stream ?? null
  if (last === null || stream === null) {
    return false
  }
  const lines = streamLines(rawRecords, stream)
  const states = costStates(lines, costLines(own, stream))
  const total = states.get(canonicalJson(last.fact.payload))
  if (total === undefined) {
    return false
  }
  const { copies, writtenAfter } = total
  const holders = new Set(copies.map(({ path }) => path))
  const continued = lines.some(({ path, line, at }) =>
    holders.has(path) ? at !== null && copies.some((copy) => copy.path === path && line > copy.line) : later(at, writtenAfter),
  )
  const ended = [...states.values()].filter((state) => !later(writtenAfter, state.writtenAfter)).length
  const started = launches(ofKind(own, 'session_start').filter(({ fact }) => later(fact.at, writtenAfter)))
  return !continued && started < ended
}

const sessionUsage = (
  rawRecords: RawRecordReader,
  session: Session,
  records: readonly UsageRecord[],
  reading: SessionReading | undefined,
): SessionUsage => ({
  session: session.id,
  totals: usageTotals(records.filter((record) => record.session === session.id)),
  cost_state: session.cost_state,
  cost_state_final: session.cost_state !== null && costStateFinal(rawRecords, reading?.own ?? []),
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
  { pauseAfterMs = defaultPauseAfterMs }: SolverUsageOptions = {},
): SolverUsage => {
  const { sessions, agents, records, readings, stageOf } = observationsOf(source, run)
  const stages = byStage(records, stageOf)
  const facts = agentFacts(readings)
  return {
    run,
    journal: {
      totals: usageTotals(records),
      stages: [...stages]
        .flatMap(([stage, members]) => (stage === null ? [] : [{ stage, totals: usageTotals(members) }]))
        .sort((left, right) => compareText(left.stage, right.stage)),
      unassigned: usageTotals(stages.get(null) ?? []),
      sessions: sessions.map((session) => sessionUsage(source.rawRecords, session, records, readings.get(session.id))),
    },
    agents: agents.map((agent) => agentUsage(agent, records, facts.get(agent.id) ?? [])),
    time: runTime(
      [...readings.values()].flatMap(({ own }) => own.filter(isActivity).map(({ fact }) => fact.at)),
      pauseAfterMs,
    ),
  }
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
  const { records, stageOf } = observationsOf(source, run)
  const sessions = stageSessions(source, run, stage)
  const stages = byStage(records, stageOf)
  return {
    stage: usageTotals(stages.get(stage) ?? []),
    unassigned_in_sessions: usageTotals((stages.get(null) ?? []).filter((record) => sessions.has(record.session))),
  }
}
