import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { HookInstallation, Runtime, StatusResponse, SupportKey, SupportStatus, Surface } from '@aang/contract'
import { z } from 'zod'
import type { ApiClient } from './aang.js'

export type Counts = Readonly<Record<string, number>>

export interface Observation {
  readonly runs: number
  readonly sessions: Counts
  readonly agents: number
  readonly actions: Counts
  readonly questions: Counts
  readonly attention: Counts
}

export interface DaemonView extends Observation {
  readonly surfaces: Counts
  readonly hooks: Readonly<Partial<Record<Runtime, HookInstallation>>>
  readonly versions: readonly { readonly key: string; readonly status: SupportStatus; readonly sessions: number }[]
  readonly unknown_records: number
}

const count = (values: readonly string[]): Counts => {
  const counts: Record<string, number> = {}
  for (const value of [...values].sort()) {
    counts[value] = (counts[value] ?? 0) + 1
  }
  return counts
}

const uniqueById = <T extends { readonly id: string }>(items: readonly T[]): T[] => [
  ...new Map(items.map((item) => [item.id, item])).values(),
]

const sessionText = (session: { readonly version: string | null; readonly support_mode: string; readonly unknown_records: number }): string =>
  `${session.version ?? 'unknown'} ${session.support_mode} unknown=${String(session.unknown_records)}`

const actionText = (action: { readonly tool: string; readonly outcome: { readonly value: string } | null }): string =>
  `${action.tool} ${action.outcome?.value ?? 'none'}`

const questionText = (question: { readonly kind: string; readonly decision: { readonly value: string } }): string =>
  `${question.kind} ${question.decision.value}`

const attentionText = (item: { readonly kind: string; readonly author: string; readonly resolution: string }): string =>
  `${item.kind} ${item.author} ${item.resolution}`

export const versionKeyText = ({ runtime, surface, os, placement, engine_version }: SupportKey): string =>
  `${runtime} ${surface} ${os} ${placement} ${engine_version}`

export const observeDaemon = async (api: ApiClient, status: StatusResponse): Promise<DaemonView> => {
  const runs = await api.runs()
  const snapshots = await Promise.all(runs.map(({ id }) => api.run(id)))
  const sessions = uniqueById(snapshots.flatMap(({ objects }) => objects.sessions))
  return {
    runs: runs.length,
    sessions: count(sessions.map(sessionText)),
    surfaces: count(sessions.map(({ surface }) => surface?.surface ?? 'unknown')),
    agents: uniqueById(snapshots.flatMap(({ objects }) => objects.agents)).length,
    actions: count(uniqueById(snapshots.flatMap(({ objects }) => objects.actions)).map(actionText)),
    questions: count(uniqueById(snapshots.flatMap(({ objects }) => objects.questions)).map(questionText)),
    attention: count(uniqueById(snapshots.flatMap(({ attention }) => attention.items)).map(attentionText)),
    hooks: Object.fromEntries(status.runtimes.map(({ runtime, hooks }) => [runtime, hooks])),
    versions: status.versions.map(({ key, status: support, sessions: seen }) => ({
      key: key.surface === null ? `${key.runtime} unknown ${key.os} ${key.placement} ${key.engine_version}` : versionKeyText({ ...key, surface: key.surface }),
      status: support,
      sessions: seen,
    })),
    unknown_records: status.unknown_records,
  }
}

const owned = z.looseObject({ run: z.string().nullable() })

export interface RecordCount {
  readonly channel: string
  readonly type: string
  readonly parse_state: string
  readonly count: number
}

const RecordCountEntry = z.looseObject({ channel: z.string(), type: z.string(), parse_state: z.string(), count: z.int() })

const Snapshot = z.looseObject({
  records: z.array(RecordCountEntry),
  sessions: z.array(owned.extend({ version: z.string().nullable(), support_mode: z.string(), unknown_records: z.int() })),
  agents: z.array(owned),
  actions: z.array(owned.extend({ tool: z.string(), outcome: z.looseObject({ value: z.string() }).nullable() })),
  questions: z.array(owned.extend({ kind: z.string(), decision: z.looseObject({ value: z.string() }) })),
  runs: z.array(
    z.looseObject({
      entities: z.array(z.looseObject({ kind: z.string(), value: z.unknown() })),
    }),
  ),
})

const AttentionEntity = z.looseObject({ kind: z.string(), author: z.string(), resolution: z.string() })

export interface ReferenceKey {
  readonly runtime: Runtime
  readonly engineVersion: string
  readonly surface: Surface
  readonly os: string
  readonly scenario: string
}

export const referencePath = (support: string, key: ReferenceKey): string =>
  join(support, 'contract', key.runtime, key.engineVersion, key.surface, key.os, `${key.scenario}.json`)

export interface Reference {
  readonly observation: Observation
  readonly records: readonly RecordCount[]
}

export const readReference = async (path: string): Promise<Reference | null> => {
  const text = await readFile(path, 'utf8').catch(() => null)
  if (text === null) {
    return null
  }
  const snapshot = Snapshot.parse(JSON.parse(text))
  const inRun = <T extends { readonly run: string | null }>(items: readonly T[]): T[] => items.filter(({ run }) => run !== null)
  return { records: snapshot.records, observation: {
    runs: snapshot.runs.length,
    sessions: count(inRun(snapshot.sessions).map(sessionText)),
    agents: inRun(snapshot.agents).length,
    actions: count(inRun(snapshot.actions).map(actionText)),
    questions: count(inRun(snapshot.questions).map(questionText)),
    attention: count(
      snapshot.runs.flatMap(({ entities }) =>
        entities.flatMap((entity) => {
          const item = entity.kind === 'attention_item' ? AttentionEntity.safeParse(entity.value) : null
          return item?.success === true ? [attentionText(item.data)] : []
        }),
      ),
    ),
  } }
}

const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right)

const firstWords = (counts: Counts, words: number): Counts => {
  const projected: Record<string, number> = {}
  for (const [text, value] of Object.entries(counts)) {
    const key = text.split(' ').slice(0, words).join(' ')
    projected[key] = (projected[key] ?? 0) + value
  }
  return Object.fromEntries(Object.entries(projected).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)))
}

const compared = (observation: Observation) => ({
  runs: observation.runs,
  sessions: observation.sessions,
  agents: observation.agents,
  actions: observation.actions,
  questions: firstWords(observation.questions, 1),
  attention: firstWords(observation.attention, 2),
})

const describeDifference = (field: string, live: unknown, reference: unknown): string[] =>
  same(live, reference) ? [] : [`${field}: live ${JSON.stringify(live)}, reference ${JSON.stringify(reference)}`]

export interface Comparison {
  readonly failures: readonly string[]
  readonly notes: readonly string[]
}

export const compare = (live: Observation, reference: Observation): Comparison => {
  const [left, right] = [compared(live), compared(reference)]
  return {
    failures: (Object.keys(left) as (keyof typeof left)[]).flatMap((field) => describeDifference(field, left[field], right[field])),
    notes: [
      ...describeDifference('question decisions', live.questions, reference.questions),
      ...describeDifference('attention resolutions', live.attention, reference.attention),
    ],
  }
}

const comparedChannels: ReadonlySet<string> = new Set(['hook', 'transcript', 'rollout'])

const recordCounts = (records: readonly RecordCount[], compared: boolean): Counts =>
  Object.fromEntries(
    records
      .filter(({ channel }) => comparedChannels.has(channel) === compared)
      .map(({ channel, type, parse_state: state, count: records }) => [`${channel} ${type} ${state}`, records] as const)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  )

export const compareRecords = (live: readonly RecordCount[], reference: readonly RecordCount[]): Comparison => ({
  failures: describeDifference('raw records', recordCounts(live, true), recordCounts(reference, true)),
  notes: describeDifference('raw records of other channels', recordCounts(live, false), recordCounts(reference, false)),
})
