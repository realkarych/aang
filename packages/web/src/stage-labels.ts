import type {
  AttentionPriority,
  AttentionResolution,
  ChangeAuthor,
  CriterionSource,
  CriterionStatus,
  FactKind,
  ModelEntityRef,
  ModelOperation,
  ObserverRejectionCause,
  ParseState,
  RawChannel,
  SnapshotTrigger,
  Speaker,
  StageOrigin,
} from '@aang/contract'

export const criterionStatusLabel: Readonly<Record<CriterionStatus, string>> = {
  not_checked: 'not checked',
  confirmed: 'confirmed',
  passed_unversioned: 'check passed, version not established',
  partial: 'partially confirmed',
  failed: 'failed',
  stale: 'checked on another version',
  reported_done: 'agent reported done',
}

export const criterionSourceLabel: Readonly<Record<CriterionSource, string>> = {
  task: 'from the task',
  plan: 'from the plan',
  contract: 'by the check contract',
}

export const stageOriginLabel: Readonly<Record<StageOrigin, string>> = {
  plan: 'from the solver plan',
  inferred: 'inferred by the observer',
}

export const speakerLabel: Readonly<Record<Speaker, string>> = {
  human: 'human',
  solver: 'solver',
  tool: 'tool',
  runtime: 'runtime',
}

export const factKindLabel: Readonly<Record<FactKind, string>> = {
  session_start: 'Session start',
  session_end: 'Session end',
  turn_start: 'Turn start',
  turn_settings: 'Turn settings',
  turn_end: 'Turn end',
  prompt: 'Prompt',
  message: 'Message',
  agent_start: 'Agent start',
  agent_end: 'Agent end',
  action_start: 'Action start',
  action_end: 'Action end',
  tool_batch_end: 'Tool batch end',
  permission_request: 'Approval request',
  permission_denied: 'Approval denied',
  permission_decision: 'Approval decision',
  notification: 'Notification',
  question_asked: 'Question',
  question_answered: 'Answer to a question',
  plan_update: 'Plan',
  compaction: 'Context compaction',
  usage: 'Usage',
  usage_total: 'Usage total',
  cost_state: 'Claude Code total',
  instructions_loaded: 'Instructions loaded',
  hook_run: 'Solver hook',
  definition_listing: 'Definition listing',
  agent_prompt: 'Agent system prompt',
  queue_operation: 'Prompt queue',
  runtime_error: 'Runtime error',
  runtime_event: 'Runtime event',
  json_snapshot: 'File snapshot',
  git_snapshot: 'Working tree snapshot',
  context: 'Observer context',
  source_lost: 'Source lost',
  process_exited: 'Process exited',
}

export const rawChannelLabel: Readonly<Record<RawChannel, string>> = {
  hook: 'hook',
  transcript: 'transcript',
  rollout: 'rollout',
  otel: 'OTel',
  registry: 'registry',
  snapshot: 'aang snapshot',
  context: 'aang context',
}

export const parseStateLabel: Readonly<Record<ParseState, string>> = {
  parsed: 'parsed',
  unknown: 'unrecognized',
  invalid: 'invalid',
}

export const snapshotTriggerLabel: Readonly<Record<SnapshotTrigger, string>> = {
  check: 'on check',
  fs_watch: 'after file changes',
  turn_end: 'at turn end',
  restart: 'after restart',
}

export const changeAuthorLabel: Readonly<Record<ChangeAuthor, string>> = {
  rule: 'aang rule',
  observer: 'observer',
  user: 'user',
}

export const operationLabel: Readonly<Record<ModelOperation, string>> = {
  'stage.create': 'stage created',
  'stage.update': 'stage description',
  'stage.state': 'stage state',
  'stage.replace': 'stage replaced',
  'stage.merge': 'stages merged',
  'stage.split': 'stage split',
  'stage.nest': 'stage nesting',
  'stage.depends': 'stage dependency',
  'actions.assign': 'actions assigned',
  'agents.participate': 'agent participation',
  'artifact.link': 'artifact linked',
  'criterion.add': 'new criterion',
  'criterion.assess': 'criterion assessment',
  'card.add': 'result card',
  'brief.update': 'run description',
  'question.add': 'observer question',
  'attention.add': 'new attention item',
  'attention.resolve': 'item resolved',
  'attention.likely_resolved': 'item likely answered',
  'attention.priority': 'recommended priority',
  'run.create': 'run created',
  'run.goal': 'run goal',
  'stage.execution': 'execution from events',
  'criterion.status': 'criterion status from a check',
  'attention.open': 'attention item opened',
  'attention.wait': 'runtime wait',
  'attention.close': 'attention item closed',
  'link.add': 'new link',
  'link.retarget': 'link retargeted',
  'link.remove': 'link removed',
  'session.move': 'session moved',
  'binding.add': 'session bound',
  'binding.revoke': 'binding revoked',
}

export const entityKindLabel: Readonly<Record<ModelEntityRef['kind'], string>> = {
  run: 'run',
  stage: 'stage',
  criterion: 'criterion',
  card: 'card',
  attention_item: 'attention item',
  link: 'link',
  binding: 'binding',
  session_membership: 'run session',
}

export const rejectionCauseLabel: Readonly<Record<ObserverRejectionCause, string>> = {
  schema: 'does not match the schema',
  version: 'stale map version',
  conflict: 'conflicts with changes',
  reference: 'reference to something missing',
  scope: 'outside the run scope',
  invariant: 'violates model rules',
  limit: 'limit exceeded',
}

export const resolutionLabel: Readonly<Record<AttentionResolution, string>> = {
  open: 'open',
  answered: 'answered',
  resolved: 'resolved',
  ended_without_answer: 'wait ended without an answer',
}

export const priorityLabel: Readonly<Record<AttentionPriority, string>> = {
  high: 'high',
  medium: 'medium',
  low: 'low',
}
