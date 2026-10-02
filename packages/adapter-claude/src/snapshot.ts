import type {
  CollectedRecord,
  FactDraft,
  FactEntityKey,
  FilePosition,
  FileRemovedPosition,
  JsonSnapshotPayload,
  JsonValue,
  ParseResult,
} from '@aang/contract'
import { z } from 'zod'
import { startedAgent } from './agents.js'
import { fact, type FactOrigin, fileOrigin, invalid, parsed, schemaViolation, unknown } from './facts.js'
import { name, optionalText } from './fields.js'
import { isJsonObject, type JsonObject, parseJson, withinNestingLimit } from './json.js'
import { agentKey, sessionKey, teammateKey } from './keys.js'
import { type SnapshotFile, snapshotFile } from './paths.js'

const AgentMetaFile = z.looseObject({
  agentType: optionalText,
  description: optionalText,
  toolUseId: name.nullish(),
  spawnDepth: z.int().nonnegative().nullish(),
  requestShape: optionalText,
  name: name.nullish(),
  teamName: name.nullish(),
})
type AgentMetaFile = z.infer<typeof AgentMetaFile>

const TeamConfigFile = z.looseObject({
  name: name.nullish(),
  leadSessionId: name,
  members: z.array(z.looseObject({ name, agentId: name.nullish(), sessionId: name.nullish() })).nullish(),
})

const workflowSummaryFields: readonly string[] = [
  'runId',
  'taskId',
  'workflowName',
  'status',
  'summary',
  'agentCount',
  'totalTokens',
  'totalToolCalls',
  'durationMs',
  'startTime',
  'phases',
]

const backgroundByShape: ReadonlyMap<string, boolean> = new Map([
  ['background', true],
  ['foreground', false],
])

interface Snapshot {
  readonly record: CollectedRecord
  readonly path: string
  readonly removed: boolean
  readonly content: JsonValue
}

const snapshotFact = (
  origin: FactOrigin,
  entity: FactEntityKey,
  payload: JsonSnapshotPayload,
  verified: boolean,
): FactDraft =>
  fact(origin, { kind: 'json_snapshot', entity_key: entity, speaker: 'runtime', urgent: false, payload }, { verified })

const teammateOf = ({ name: member, teamName: team }: AgentMetaFile) =>
  typeof member === 'string' && typeof team === 'string' ? { name: member, team } : null

const agentMeta = (snapshot: Snapshot, file: Extract<SnapshotFile, { kind: 'agent_meta' }>): ParseResult => {
  const origin = fileOrigin(snapshot.record, file.session, file.agent)
  if (snapshot.removed) {
    return parsed(null, [
      snapshotFact(
        origin,
        agentKey(file.session, file.agent),
        { file: 'agent_meta', path: snapshot.path, removed: true, content: null },
        !file.workflow,
      ),
    ])
  }
  const meta = AgentMetaFile.safeParse(snapshot.content)
  if (!meta.success) {
    return schemaViolation('subagent meta', meta.error)
  }
  const teammate = teammateOf(meta.data)
  const entity =
    teammate === null ? agentKey(file.session, file.agent) : teammateKey(file.session, teammate.name, teammate.team)
  const verified = teammate === null && !file.workflow
  const { agentType, description, toolUseId, spawnDepth, requestShape } = meta.data
  return parsed(null, [
    snapshotFact(
      origin,
      entity,
      {
        file: 'agent_meta',
        path: snapshot.path,
        removed: false,
        content: {
          agent_type: agentType ?? null,
          description: description ?? null,
          tool_use_id: toolUseId ?? null,
          spawn_depth: spawnDepth ?? null,
        },
      },
      verified,
    ),
    fact(
      origin,
      {
        kind: 'agent_start',
        entity_key: entity,
        speaker: 'runtime',
        urgent: false,
        payload: startedAgent({
          role: teammate === null ? 'subagent' : 'teammate',
          agent_type: agentType ?? null,
          description: description ?? null,
          nickname: teammate?.name ?? null,
          spawned_by_call: toolUseId ?? null,
          background: (typeof requestShape === 'string' ? backgroundByShape.get(requestShape) : undefined) ?? null,
          depth: spawnDepth ?? null,
        }),
      },
      { verified },
    ),
  ])
}

const workflowSummary = (content: JsonObject): JsonObject =>
  Object.fromEntries(
    workflowSummaryFields.flatMap((field): [string, JsonValue][] => {
      const value = content[field]
      return value === undefined ? [] : [[field, value]]
    }),
  )

const workflow = (snapshot: Snapshot, file: Extract<SnapshotFile, { kind: 'workflow' }>): ParseResult => {
  const { content, removed } = snapshot
  if (!removed && !isJsonObject(content)) {
    return invalid('workflow snapshot is not a JSON object')
  }
  return parsed(null, [
    snapshotFact(
      fileOrigin(snapshot.record, file.session, null),
      sessionKey(file.session),
      {
        file: 'workflow',
        path: snapshot.path,
        removed,
        content: isJsonObject(content) ? workflowSummary(content) : null,
      },
      false,
    ),
  ])
}

const team = (snapshot: Snapshot, file: Extract<SnapshotFile, { kind: 'team' }>): ParseResult => {
  if (snapshot.removed) {
    return parsed(null, [])
  }
  const config = TeamConfigFile.safeParse(snapshot.content)
  if (!config.success) {
    return schemaViolation('team config', config.error)
  }
  const { leadSessionId: lead, members } = config.data
  return parsed(null, [
    snapshotFact(
      fileOrigin(snapshot.record, lead, null),
      sessionKey(lead),
      {
        file: 'team',
        path: snapshot.path,
        removed: false,
        content: {
          team: config.data.name ?? file.team,
          members: (members ?? []).map((member) => ({
            name: member.name,
            agent_id: member.agentId ?? null,
            session_id: member.sessionId ?? null,
          })),
        },
      },
      false,
    ),
  ])
}

export const parseSnapshot = (record: CollectedRecord, position: FilePosition | FileRemovedPosition): ParseResult => {
  const file = snapshotFile(position.path)
  if (file === null) {
    return unknown(null)
  }
  const removed = position.kind === 'file_removed'
  const content = removed ? null : parseJson(record.payload)
  if (content === undefined) {
    return invalid(`${file.kind} snapshot is not JSON`)
  }
  if (!withinNestingLimit(content)) {
    return unknown(null)
  }
  const snapshot: Snapshot = { record, path: position.path, removed, content }
  switch (file.kind) {
    case 'agent_meta':
      return agentMeta(snapshot, file)
    case 'workflow':
      return workflow(snapshot, file)
    case 'team':
      return team(snapshot, file)
  }
}
