import type {
  ActionEndPayload,
  ActionKey,
  ActionStartPayload,
  AgentKey,
  AgentRef,
  EpochNs,
  FactDraft,
  FactDraftOf,
  FactEntityKey,
  FactKind,
  FactPayload,
  MessageKey,
  QuestionKey,
  RuntimeEnv,
  RuntimeIds,
  SessionKey,
  Speaker,
  UsageKey,
} from '@aang/contract'
import type { RolloutLine } from './line.js'
import { isRoot, type ThreadStream } from './stream.js'

export interface LineContext {
  readonly stream: ThreadStream
  readonly line: RolloutLine
}

export type LineFacts = readonly FactDraft[] | null

export type LineParser = (context: LineContext) => LineFacts

const runtime = 'codex'

export const sessionEntity = ({ session }: ThreadStream): SessionKey => ({ kind: 'session', runtime, session })

export const agentRef = (stream: ThreadStream, thread: string): AgentRef =>
  thread === stream.session ? { kind: 'main' } : { kind: 'thread', thread_id: thread }

export const agentEntity = (stream: ThreadStream, thread: string = stream.thread): AgentKey => ({
  kind: 'agent',
  runtime,
  session: stream.session,
  agent: agentRef(stream, thread),
})

export const threadEntity = (stream: ThreadStream): FactEntityKey =>
  isRoot(stream) ? sessionEntity(stream) : agentEntity(stream)

export const actionEntity = ({ session }: ThreadStream, call: string): ActionKey => ({
  kind: 'action',
  runtime,
  session,
  call,
})

export const messageEntity = ({ session, thread }: ThreadStream, ordinal: number): MessageKey =>
  namedMessageEntity(session, `${thread}:${String(ordinal)}`)

export const namedMessageEntity = (session: string, message: string): MessageKey => ({
  kind: 'message',
  runtime,
  session,
  message,
})

export const usageEntity = ({ session, thread }: ThreadStream, response: string): UsageKey => ({
  kind: 'usage',
  runtime,
  session,
  usage: `${thread}:${response}`,
})

export const questionEntity = ({ session }: ThreadStream, question: string): QuestionKey => ({
  kind: 'question',
  runtime,
  session,
  question,
})

export const emptyIds: RuntimeIds = {
  session_id: null,
  agent_id: null,
  thread_id: null,
  turn_id: null,
  prompt_id: null,
  record_uuid: null,
  parent_uuid: null,
  message_id: null,
  call_id: null,
  ordinal: null,
}

export const runtimeIds = ({ stream, line }: LineContext, overrides: Partial<RuntimeIds> = {}): RuntimeIds => ({
  ...emptyIds,
  session_id: stream.session,
  thread_id: stream.thread,
  ordinal: line.ordinal,
  ...overrides,
})

export const emptyEnv: RuntimeEnv = {
  cwd: null,
  version: null,
  entrypoint: null,
  originator: null,
  git_branch: null,
}

export interface FactSpec {
  readonly entity: FactEntityKey
  readonly speaker: Speaker
  readonly urgent: boolean
  readonly at: EpochNs
  readonly ids: RuntimeIds
  readonly env?: RuntimeEnv
  readonly verified?: boolean
  readonly redelivery?: string
}

export const fact = <K extends FactKind>(kind: K, spec: FactSpec, payload: FactPayload<K>): FactDraft =>
  ({
    kind,
    entity_key: spec.entity,
    speaker: spec.speaker,
    urgent: spec.urgent,
    at: spec.at,
    runtime_ids: spec.ids,
    runtime_env: spec.env ?? emptyEnv,
    format_verified: spec.verified ?? true,
    redelivery_key: spec.redelivery ?? null,
    payload,
  }) as FactDraftOf<K>

export interface CallTiming {
  readonly at: EpochNs
  readonly turn: string | null
  readonly verified: boolean
}

export type ActionStart = Pick<ActionStartPayload, 'tool' | 'action_kind' | 'input'>

export type ActionEnd = Pick<ActionEndPayload, 'outcome' | 'output'> & Partial<ActionEndPayload>

const callSpec = (
  context: LineContext,
  call: string,
  timing: CallTiming,
  speaker: Speaker,
  urgent: boolean,
): FactSpec => ({
  entity: actionEntity(context.stream, call),
  speaker,
  urgent,
  at: timing.at,
  ids: runtimeIds(context, { turn_id: timing.turn, call_id: call }),
  verified: timing.verified,
})

export const actionStarted = (context: LineContext, call: string, timing: CallTiming, start: ActionStart): FactDraft =>
  fact('action_start', callSpec(context, call, timing, 'solver', false), {
    ...start,
    description: null,
    container_call: null,
  })

export const actionEnded = (context: LineContext, call: string, timing: CallTiming, end: ActionEnd): FactDraft =>
  fact('action_end', callSpec(context, call, timing, 'tool', end.outcome === 'error'), {
    persisted_output_path: null,
    exit_code: null,
    duration_ms: null,
    result: null,
    ...end,
  })

export const joinText = (parts: readonly { readonly text?: string | undefined }[]): string =>
  parts.flatMap(({ text }) => (text === undefined ? [] : [text])).join('')
