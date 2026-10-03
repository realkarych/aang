import {
  type Agent,
  type AgentId,
  ChangeSeq,
  type RunId,
  type RunUsage,
  type Session,
  type SessionId,
  type SessionUsage,
  type StageId,
  type StageInspector,
  type TokenUsage,
  type UsageRecord,
  type UsageTotals,
} from '@aang/contract'
import { objectId } from '@aang/contract/ids'
import type { FactReader, ModelReader, Observation, ObservationReader, RawRecordReader } from '@aang/store'
import { compareText, type Evidence, ofKind } from '../observations/evidence.js'
import { latest } from '../observations/usage.js'
import { assignedStages, readSession, type SessionReading, stageAttribution, type StageOf } from './attribution.js'
import { activeMs, runTime, type RunTime } from './time.js'

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

const defaultPauseAfterMs = 300_000

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

const costStateFinal = (own: readonly Evidence[]): boolean => {
  const last = latest(ofKind(own, 'cost_state'))
  return (
    last !== null &&
    !own.some(({ raw }) => raw.stream === last.raw.stream && raw.seq > last.raw.seq && raw.source_ts !== null)
  )
}

const sessionUsage = (session: Session, records: readonly UsageRecord[], reading: SessionReading | undefined): SessionUsage => ({
  session: session.id,
  totals: usageTotals(records.filter((record) => record.session === session.id)),
  cost_state: session.cost_state,
  cost_state_final: session.cost_state !== null && costStateFinal(reading?.own ?? []),
})

const agentUsage = (agent: Agent, records: readonly UsageRecord[], reading: SessionReading | undefined): AgentUsage => {
  const own = reading === undefined ? [] : reading.own.filter(({ fact }) => objectId(reading.identity.of(fact)) === agent.id)
  return {
    agent: agent.id,
    session: agent.session,
    totals: usageTotals(records.filter((record) => record.agent === agent.id)),
    active_ms: activeMs(own),
  }
}

const byStage = (records: readonly UsageRecord[], stageOf: StageOf): Map<StageId | null, UsageRecord[]> => {
  const stages = new Map<StageId | null, UsageRecord[]>()
  for (const record of records) {
    const stage = stageOf(record)
    stages.set(stage, [...(stages.get(stage) ?? []), record])
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
  return {
    run,
    journal: {
      totals: usageTotals(records),
      stages: [...stages]
        .flatMap(([stage, members]) => (stage === null ? [] : [{ stage, totals: usageTotals(members) }]))
        .sort((left, right) => compareText(left.stage, right.stage)),
      unassigned: usageTotals(stages.get(null) ?? []),
      sessions: sessions.map((session) => sessionUsage(session, records, readings.get(session.id))),
    },
    agents: agents.map((agent) => agentUsage(agent, records, readings.get(agent.session))),
    time: runTime(
      sessions,
      [...readings.values()].flatMap(({ own }) => own.map(({ fact }) => fact.at)),
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
