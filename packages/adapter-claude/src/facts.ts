import type {
  CollectedRecord,
  EpochNs,
  FactDraft,
  FactDraftOf,
  FactKind,
  ParseResult,
  RuntimeEnv,
  RuntimeIds,
} from '@aang/contract'
import { z } from 'zod'

export interface FactOrigin {
  readonly at: EpochNs
  readonly ids: RuntimeIds
  readonly env: RuntimeEnv
  readonly redeliveryKey: string | null
}

export type FactSpec = {
  [K in FactKind]: Pick<FactDraftOf<K>, 'kind' | 'entity_key' | 'speaker' | 'urgent' | 'payload'>
}[FactKind]

export interface FactOptions {
  readonly ids?: Partial<RuntimeIds>
  readonly verified?: boolean
}

export const noRuntimeIds: RuntimeIds = {
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

export const noRuntimeEnv: RuntimeEnv = {
  cwd: null,
  version: null,
  entrypoint: null,
  originator: null,
  git_branch: null,
}

export const fileOrigin = (record: CollectedRecord, session: string, agent: string | null): FactOrigin => ({
  at: record.observed_at,
  ids: { ...noRuntimeIds, session_id: session, agent_id: agent },
  env: noRuntimeEnv,
  redeliveryKey: null,
})

export const fact = (origin: FactOrigin, spec: FactSpec, options: FactOptions = {}): FactDraft => ({
  ...spec,
  at: origin.at,
  runtime_ids: { ...origin.ids, ...options.ids },
  runtime_env: origin.env,
  format_verified: options.verified ?? true,
  redelivery_key: origin.redeliveryKey,
})

export const parsed = (sourceTs: EpochNs | null, facts: readonly FactDraft[]): ParseResult => ({
  parse_state: 'parsed',
  source_ts: sourceTs,
  facts,
})

export const unknown = (sourceTs: EpochNs | null): ParseResult => ({ parse_state: 'unknown', source_ts: sourceTs })

export const invalid = (reason: string): ParseResult => ({ parse_state: 'invalid', reason })

export const schemaViolation = (subject: string, error: z.ZodError): ParseResult =>
  invalid(`${subject}: ${z.prettifyError(error)}`)
