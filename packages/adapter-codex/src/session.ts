import type { AgentStartPayload, RuntimeEnv, SessionStartPayload } from '@aang/contract'
import { z } from 'zod'
import {
  agentEntity,
  agentRef,
  emptyEnv,
  type FactSpec,
  fact,
  type LineContext,
  type LineFacts,
  runtimeIds,
  sessionEntity,
  threadEntity,
} from './facts.js'
import { instantFromIso } from './line.js'
import { isRoot, type ThreadStream } from './stream.js'
import { surfaceOf } from './surface.js'

const observerThreadSource = 'aang-observer'
export const observerOriginator = 'aang_observer'
const guardianThreadSource = 'guardian_review'
const interruptedReason = 'interrupted'

const id = z.string().min(1)
const optionalText = z.string().nullish()

const ThreadSpawn = z.looseObject({
  parent_thread_id: id.optional(),
  depth: z.int().nonnegative().optional(),
  agent_path: optionalText,
  agent_nickname: optionalText,
  agent_role: optionalText,
})

const SubagentSource = z.looseObject({
  subagent: z.looseObject({
    thread_spawn: ThreadSpawn.optional(),
    other: z.string().optional(),
  }),
})

const SessionMeta = z.looseObject({
  id,
  session_id: id.optional(),
  timestamp: z.string().optional(),
  cwd: z.string().optional(),
  originator: z.string().optional(),
  cli_version: z.string().optional(),
  source: z.unknown(),
  thread_source: z.string().optional(),
  parent_thread_id: id.optional(),
  agent_path: optionalText,
  agent_nickname: optionalText,
  agent_role: optionalText,
  forked_from_id: id.optional(),
  forked_from_ordinal_exclusive: z.int().nonnegative().optional(),
  git: z.looseObject({ branch: optionalText }).nullish(),
})
type SessionMeta = z.infer<typeof SessionMeta>

const Turn = z.looseObject({ turn_id: id.optional() })

const TaskComplete = Turn.extend({ last_agent_message: optionalText })

const TurnAborted = Turn.extend({ reason: optionalText })

const TurnContext = Turn.extend({
  cwd: z.string().optional(),
  model: optionalText,
  effort: optionalText,
  approval_policy: z.unknown(),
  sandbox_policy: z.looseObject({ type: z.string() }).nullish(),
  collaboration_mode: z
    .looseObject({ settings: z.looseObject({ reasoning_effort: optionalText }).nullish() })
    .nullish(),
})

const sessionStart = (meta: SessionMeta): SessionStartPayload => ({
  launch: meta.forked_from_id === undefined ? 'startup' : 'fork',
  surface: surfaceOf(meta.originator ?? null, meta.source),
  cwd: meta.cwd ?? null,
  forked_from:
    meta.forked_from_id === undefined
      ? null
      : { session: meta.forked_from_id, ordinal: meta.forked_from_ordinal_exclusive ?? null },
  observer_marker: meta.thread_source === observerThreadSource || meta.originator === observerOriginator,
})

const agentStart = (stream: ThreadStream, meta: SessionMeta): AgentStartPayload => {
  const { thread_spawn: spawn, other } = SubagentSource.safeParse(meta.source).data?.subagent ?? {}
  const guardian = meta.thread_source === guardianThreadSource
  const parent = spawn?.parent_thread_id ?? meta.parent_thread_id
  return {
    role: guardian || other !== undefined ? 'service' : 'subagent',
    service: guardian ? 'guardian' : null,
    agent_type: other ?? null,
    agent_role: spawn?.agent_role ?? meta.agent_role ?? null,
    description: spawn?.agent_path ?? meta.agent_path ?? null,
    nickname: spawn?.agent_nickname ?? meta.agent_nickname ?? null,
    parent: parent === undefined ? null : agentRef(stream, parent),
    spawned_by_call: null,
    background: null,
    depth: spawn?.depth ?? null,
  }
}

export const sessionMeta = (context: LineContext): LineFacts => {
  const parsed = SessionMeta.safeParse(context.line.payload)
  if (!parsed.success) {
    return null
  }
  const meta = parsed.data
  const env: RuntimeEnv = {
    ...emptyEnv,
    cwd: meta.cwd ?? null,
    version: meta.cli_version ?? null,
    originator: meta.originator ?? null,
    git_branch: meta.git?.branch ?? null,
  }
  const spec = {
    speaker: 'runtime',
    urgent: false,
    at: (meta.timestamp === undefined ? null : instantFromIso(meta.timestamp)) ?? context.line.at,
    ids: runtimeIds(context),
    env,
  } as const
  const { stream } = context
  return isRoot(stream)
    ? [fact('session_start', { ...spec, entity: sessionEntity(stream) }, sessionStart(meta))]
    : [fact('agent_start', { ...spec, entity: agentEntity(stream) }, agentStart(stream, meta))]
}

const turnSpec = (context: LineContext, turn: string | undefined, urgent: boolean): FactSpec => ({
  entity: threadEntity(context.stream),
  speaker: 'runtime',
  urgent,
  at: context.line.at,
  ids: runtimeIds(context, { turn_id: turn ?? null }),
})

export const taskStarted = (context: LineContext): LineFacts => {
  const parsed = Turn.safeParse(context.line.payload)
  return parsed.success ? [fact('turn_start', turnSpec(context, parsed.data.turn_id, false), {})] : null
}

export const taskComplete = (context: LineContext): LineFacts => {
  const parsed = TaskComplete.safeParse(context.line.payload)
  if (!parsed.success) {
    return null
  }
  const { turn_id: turn, last_agent_message: finalMessage } = parsed.data
  return [
    fact('turn_end', turnSpec(context, turn, true), {
      outcome: 'completed',
      reason: null,
      final_message: finalMessage ?? null,
      background_tasks: [],
    }),
  ]
}

export const turnAborted = (context: LineContext): LineFacts => {
  const parsed = TurnAborted.safeParse(context.line.payload)
  if (!parsed.success) {
    return null
  }
  const { turn_id: turn, reason } = parsed.data
  return [
    fact('turn_end', turnSpec(context, turn, true), {
      outcome: reason === interruptedReason ? 'interrupted' : 'unknown',
      reason: reason ?? null,
      final_message: null,
      background_tasks: [],
    }),
  ]
}

const policyName = (policy: unknown): string | null => {
  if (typeof policy === 'string') {
    return policy
  }
  const keys = z.record(z.string(), z.unknown()).safeParse(policy).data
  const names = keys === undefined ? [] : Object.keys(keys)
  return names.length === 1 ? (names[0] ?? null) : null
}

export const turnContext = (context: LineContext): LineFacts => {
  const parsed = TurnContext.safeParse(context.line.payload)
  if (!parsed.success) {
    return null
  }
  const settings = parsed.data
  return [
    fact(
      'turn_settings',
      { ...turnSpec(context, settings.turn_id, false), env: { ...emptyEnv, cwd: settings.cwd ?? null } },
      {
        model: settings.model ?? null,
        effort: settings.effort ?? settings.collaboration_mode?.settings?.reasoning_effort ?? null,
        approval_policy: policyName(settings.approval_policy),
        sandbox: settings.sandbox_policy?.type ?? null,
      },
    ),
  ]
}

const Compacted = z.looseObject({ message: z.string() })

export const compacted = (context: LineContext): LineFacts => {
  const parsed = Compacted.safeParse(context.line.payload)
  if (!parsed.success) {
    return null
  }
  const { message } = parsed.data
  return [
    fact('compaction', turnSpec(context, undefined, true), {
      phase: 'boundary',
      trigger: 'unknown',
      summary: message === '' ? null : message,
      tokens_before: null,
    }),
  ]
}
