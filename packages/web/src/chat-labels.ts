import type { ArtifactContent, ChatCitation, Fact, FactKind, Speaker, VersionRetention } from '@aang/contract'
import { detailOf } from './action-input.js'

export const citationKindLabel: Readonly<Record<ChatCitation['kind'], string>> = {
  stage: 'Stage',
  fact: 'Fact',
  action: 'Action',
  artifact_version: 'Artifact version',
  question: 'Attention item',
}

export const factKindLabel: Readonly<Record<FactKind, string>> = {
  session_start: 'session start',
  session_end: 'session end',
  turn_start: 'turn start',
  turn_settings: 'turn settings',
  turn_end: 'turn end',
  prompt: 'prompt',
  message: 'message',
  agent_start: 'agent start',
  agent_end: 'agent end',
  action_start: 'action start',
  action_end: 'action result',
  tool_batch_end: 'tool batch result',
  permission_request: 'approval request',
  permission_denied: 'approval denied',
  permission_decision: 'approval decision',
  notification: 'notification',
  question_asked: 'question',
  question_answered: 'answer to a question',
  plan_update: 'plan',
  compaction: 'context compaction',
  usage: 'token usage',
  usage_total: 'usage total',
  cost_state: 'cost state',
  instructions_loaded: 'instructions loaded',
  hook_run: 'solver hook',
  definition_listing: 'definition listing',
  agent_prompt: 'agent system prompt',
  queue_operation: 'prompt queue',
  runtime_error: 'runtime error',
  runtime_event: 'runtime event',
  json_snapshot: 'file snapshot',
  git_snapshot: 'git snapshot',
  context: 'context',
  source_lost: 'source lost',
  process_exited: 'process exited',
}

export const speakerLabel: Readonly<Record<Speaker, string>> = {
  human: 'human',
  solver: 'solver',
  tool: 'tool',
  runtime: 'runtime',
}

export const retentionLabel: Readonly<Record<VersionRetention['kind'], string>> = {
  action_payload: 'version saved from an action',
  file_read: 'version saved on file read',
  commit: 'version in a commit',
  hash_only: 'only the content hash is saved',
  reference: 'reference only',
}

export const contentSourceLabel: Readonly<Record<Extract<ArtifactContent, { kind: 'stored' }>['source'], string>> = {
  action_payload: 'content written by the action',
  file_read: 'file state at the time of reading',
  commit: 'commit content',
}

export const contentMissingLabel: Readonly<Record<Extract<ArtifactContent, { kind: 'unavailable' }>['reason'], string>> =
  {
    reference_only: 'only the reference is known; aang did not save the content',
    hash_only: 'only the content hash is saved',
    commit_missing: 'this version’s commit is no longer in the repository',
    blob_missing: 'the content is missing from aang storage',
  }

const joined = (parts: readonly (string | null)[]): string | null => {
  const present = parts.filter((part): part is string => part !== null && part.trim() !== '')
  return present.length === 0 ? null : present.join(': ')
}

export const factGist = (fact: Fact): string | null => {
  switch (fact.kind) {
    case 'prompt':
    case 'message':
      return fact.payload.text
    case 'action_start':
      return joined([fact.payload.tool, detailOf(fact.payload.input) ?? fact.payload.description])
    case 'permission_request':
      return joined([fact.payload.tool, detailOf(fact.payload.input)])
    case 'question_asked':
      return fact.payload.questions.map(({ text }) => text).join('\n')
    default:
      return null
  }
}
