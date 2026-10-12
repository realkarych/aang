import type {
  ActionOutcome,
  AgentRole,
  AttentionAuthor,
  AttentionKind,
  AttentionPriority,
  AttentionResolution,
  BasisKind,
  Execution,
  FactKind,
  Freshness,
  GapKind,
  HookInstallation,
  HumanDecision,
  Interpreter,
  NotObservableSurface,
  ObserverState,
  Runtime,
  ServiceAgent,
  Speaker,
  StageLifecycle,
  StageOrigin,
  Surface,
  SupportMode,
  SupportStatus,
  VersionKey,
  VersionRetention,
} from '@aang/contract'
import { clockTime, plural } from './format.js'

export const runtimeLabel: Readonly<Record<Runtime, string>> = {
  claude: 'Claude Code',
  codex: 'Codex',
}

const waitingLabel: Readonly<Record<Extract<Execution, { state: 'waiting' }>['reason'], string>> = {
  human: 'waiting for a human',
  background: 'waiting for a background task',
  idle: 'waiting for input',
  unknown: 'waiting',
}

const executionLabels: Readonly<Record<Exclude<Execution['state'], 'waiting'>, string>> = {
  planned: 'planned',
  running: 'running',
  done: 'done',
  failed: 'error',
  cancelled: 'cancelled',
  unknown: 'unknown',
}

export const executionLabel = (execution: Execution): string =>
  execution.state === 'waiting' ? waitingLabel[execution.reason] : executionLabels[execution.state]

export const freshnessLabel: Readonly<Record<Freshness, string>> = {
  ok: 'events flowing',
  quiet: 'no new events',
  lost: 'source lost',
  hooks_inactive: 'hooks inactive',
}

export const supportModeLabel: Readonly<Record<SupportMode, string>> = {
  full: 'full',
  files_only: 'files only',
  hooks_only: 'hooks only',
}

export const hookInstallationLabel: Readonly<Record<HookInstallation, string>> = {
  not_installed: 'not installed',
  untrusted: 'not trusted',
  disabled: 'disabled',
  active: 'installed',
  unknown: 'installation not checked',
}

export const gapLabel: Readonly<Record<GapKind, string>> = {
  source_lost: 'source lost',
  unknown_records: 'unrecognized records',
  unknown_stream_layout: 'unknown stream layout',
  hooks_inactive: 'hooks inactive',
  spool_expired: 'spool files expired',
  spool_over_threshold: 'spool over threshold',
  read_failed: 'read error',
  stream_changed_after_prune: 'stream changed after pruning',
  not_interpreted: 'facts not interpreted',
  summarized_backlog: 'backlog summarized',
  cross_vendor_excluded: 'not sent to another vendor’s observer',
}

export const notObservableLabel: Readonly<Record<NotObservableSurface, string>> = {
  claude_cowork: 'Claude Cowork',
  claude_cloud: 'Claude Code cloud',
  codex_cloud: 'Codex cloud',
  work_cloud: 'cloud tasks',
}

export const supportStatusLabel: Readonly<Record<SupportStatus, string>> = {
  full: 'supported',
  limited: 'limited',
  unverified: 'unverified',
}

const surfaceLabel: Readonly<Record<Surface, string>> = {
  claude_cli: 'Claude Code CLI',
  claude_desktop: 'Claude Desktop',
  claude_sdk: 'Claude Agent SDK',
  codex_tui: 'Codex TUI',
  codex_exec: 'codex exec',
  codex_desktop: 'Codex Desktop',
  codex_sdk: 'Codex SDK',
}

export const supportKeyLabel = ({ runtime, surface, engine_version: version, os, placement }: VersionKey): string =>
  surface === null
    ? `${runtimeLabel[runtime]} ${version} (surface unknown), ${os}, ${placement}`
    : `${surfaceLabel[surface]} ${version}, ${os}, ${placement}`

const unavailableReason: Readonly<Record<Extract<ObserverState, { state: 'unavailable' }>['reason'], string>> = {
  auth: 'CLI not authorized',
  auth_path_broken: 'authorization path broken',
  limit: 'subscription limit reached',
  transient: 'transient failure',
  process_stuck: 'process stuck',
}

const disabledReason: Readonly<Record<Extract<ObserverState, { state: 'disabled' }>['reason'], string>> = {
  isolation: 'isolation not confirmed',
  cli_missing: 'CLI not found',
  version_not_admitted: 'CLI version not admitted',
  admission_failed: 'version admission failed',
  self_check_failed: 'self-check failed',
  unsafe_workdir: 'unsafe working directory',
  launcher_unavailable: 'launcher unavailable',
}

const lagLabel: Readonly<Record<Extract<ObserverState, { state: 'lagging' }>['reason'], string>> = {
  budget: 'lagging: budget exhausted',
  backlog: 'catching up',
}

export const retryLabel: Readonly<Record<Extract<ObserverState, { state: 'unavailable' }>['reason'], string>> = {
  auth: 'Next CLI authorization check',
  auth_path_broken: 'Next CLI authorization check',
  limit: 'Next observer probe',
  transient: 'Next observer probe',
  process_stuck: 'Next observer probe',
}

export const observerStateLabel = (state: ObserverState): string => {
  switch (state.state) {
    case 'ok':
      return 'working'
    case 'lagging':
      return lagLabel[state.reason]
    case 'backoff':
      return `retry at ${clockTime(state.until)}, attempt ${String(state.attempt)}`
    case 'unavailable':
      return `unavailable: ${unavailableReason[state.reason]}`
    case 'disabled':
      return `disabled: ${disabledReason[state.reason]}`
  }
}

export const basisLabel: Readonly<Record<BasisKind, string>> = {
  observed: 'observed event',
  claimed: 'solver claim',
  interpreted: 'aang interpretation',
}

export const interpreterLabel = (interpreter: Interpreter): string =>
  interpreter.kind === 'rule' ? `rule ${interpreter.rule}` : `observer, call ${interpreter.call}`

export const attentionKindLabel: Readonly<Record<AttentionKind, string>> = {
  question: 'Question',
  permission: 'Approval request',
  review_request: 'Review request',
  blocker: 'Blocker',
  failed_check: 'Failed check',
}

export const attentionAuthorLabel: Readonly<Record<AttentionAuthor, string>> = {
  rule: 'by aang rule',
  observer: 'from the observer',
}

export const attentionPriorityLabel: Readonly<Record<AttentionPriority, string>> = {
  high: 'high priority',
  medium: 'medium priority',
  low: 'low priority',
}

const closedLabel: Readonly<Record<Exclude<AttentionResolution, 'open' | 'answered'>, string>> = {
  resolved: 'resolved',
  ended_without_answer: 'wait ended without an answer',
}

const answeredLabel: Readonly<Record<AttentionKind, string>> = {
  question: 'answered',
  permission: 'decision made',
  review_request: 'answered',
  blocker: 'resolved',
  failed_check: 'check passed',
}

export const attentionOutcomeLabel = (kind: AttentionKind, resolution: Exclude<AttentionResolution, 'open'>): string =>
  resolution === 'answered' ? answeredLabel[kind] : closedLabel[resolution]

export const decisionLabel: Readonly<Record<HumanDecision, string>> = {
  none: 'no decision',
  requested: 'awaiting decision',
  approved: 'approved',
  rejected: 'rejected',
  answered: 'answered',
  unknown: 'decision not visible',
}

export const outcomeLabel: Readonly<Record<ActionOutcome, string>> = {
  ok: 'succeeded',
  error: 'error',
  denied: 'denied',
  interrupted: 'interrupted',
  unknown: 'outcome unknown',
}

export const agentRoleLabel: Readonly<Record<AgentRole, string>> = {
  main: 'main',
  subagent: 'subagent',
  teammate: 'teammate',
  service: 'service',
}

export const serviceAgentLabel: Readonly<Record<ServiceAgent, string>> = {
  guardian: 'guardian',
  compaction: 'context compaction',
  desktop_summary: 'Desktop summaries',
}

export const stageOriginLabel: Readonly<Record<StageOrigin, string>> = {
  plan: 'from the plan',
  inferred: 'inferred by aang',
}

export const stageRevisionLabel: Readonly<Record<Exclude<StageLifecycle['state'], 'active'>, string>> = {
  replaced: 'replaced',
  merged: 'merged with others',
  split: 'split',
}

export const sessionForms = { one: 'session', other: 'sessions' } as const
export const sessionInForms = { one: 'session', other: 'sessions' } as const
export const agentForms = { one: 'agent', other: 'agents' } as const
export const runForms = { one: 'run', other: 'runs' } as const
export const runInForms = { one: 'run', other: 'runs' } as const
export const factForms = { one: 'fact', other: 'facts' } as const
export const earlyFactForms = { one: 'early fact', other: 'early facts' } as const
export const fileForms = { one: 'file', other: 'files' } as const
export const recordForms = { one: 'record', other: 'records' } as const
export const versionForms = { one: 'version', other: 'versions' } as const
export const stageForms = { one: 'stage', other: 'stages' } as const
export const substageForms = { one: 'substage', other: 'substages' } as const
export const actionForms = { one: 'action', other: 'actions' } as const
export const itemForms = { one: 'item', other: 'items' } as const

export const sessionsIn = (count: number): string => plural(count, sessionInForms)

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
