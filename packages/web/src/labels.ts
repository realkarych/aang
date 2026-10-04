import type {
  ActionOutcome,
  AgentRole,
  AttentionAuthor,
  AttentionKind,
  BasisKind,
  Execution,
  Freshness,
  GapKind,
  HookInstallation,
  HumanDecision,
  NotObservableSurface,
  ObserverState,
  PlanItemStatus,
  PlanSource,
  QuestionKind,
  Runtime,
  ServiceAgent,
  SessionLaunch,
  Surface,
  SupportKey,
  SupportMode,
  SupportStatus,
} from '@aang/contract'
import { clockTime, plural } from './format.js'

export const runtimeLabel: Readonly<Record<Runtime, string>> = {
  claude: 'Claude Code',
  codex: 'Codex',
}

const waitingLabel: Readonly<Record<Extract<Execution, { state: 'waiting' }>['reason'], string>> = {
  human: 'ждёт человека',
  background: 'ждёт фоновую задачу',
  idle: 'ждёт ввода',
  unknown: 'ожидает',
}

const executionLabels: Readonly<Record<Exclude<Execution['state'], 'waiting'>, string>> = {
  planned: 'запланирован',
  running: 'выполняется',
  done: 'завершён',
  failed: 'ошибка',
  cancelled: 'отменён',
  unknown: 'неизвестно',
}

export const executionLabel = (execution: Execution): string =>
  execution.state === 'waiting' ? waitingLabel[execution.reason] : executionLabels[execution.state]

export const freshnessLabel: Readonly<Record<Freshness, string>> = {
  ok: 'события идут',
  quiet: 'нет новых событий',
  lost: 'источник потерян',
  hooks_inactive: 'hooks не активны',
}

export const supportModeLabel: Readonly<Record<SupportMode, string>> = {
  full: 'полный',
  files_only: 'только файлы',
  hooks_only: 'только hooks',
}

export const hookInstallationLabel: Readonly<Record<HookInstallation, string>> = {
  not_installed: 'не установлены',
  untrusted: 'не доверены',
  active: 'установлены',
  unknown: 'установка не проверена',
}

export const gapLabel: Readonly<Record<GapKind, string>> = {
  source_lost: 'источник потерян',
  unknown_records: 'нераспознанные записи',
  unknown_stream_layout: 'неизвестная раскладка потока',
  hooks_inactive: 'hooks не активны',
  spool_expired: 'файлы spool отброшены по сроку',
  spool_over_threshold: 'spool превысил порог',
  read_failed: 'ошибка чтения',
  stream_changed_after_prune: 'поток изменён после удаления',
  not_interpreted: 'факты не интерпретированы',
  summarized_backlog: 'очередь сведена в сводку',
  cross_vendor_excluded: 'не передано наблюдателю другого вендора',
}

export const notObservableLabel: Readonly<Record<NotObservableSurface, string>> = {
  claude_cowork: 'Claude Cowork',
  claude_cloud: 'облачный Claude Code',
  codex_cloud: 'облачный Codex',
  work_cloud: 'облачные задачи',
}

export const supportStatusLabel: Readonly<Record<SupportStatus, string>> = {
  full: 'поддерживается',
  limited: 'с ограничениями',
  unverified: 'не проверена',
}

export const surfaceLabel: Readonly<Record<Surface, string>> = {
  claude_cli: 'Claude Code CLI',
  claude_desktop: 'Claude Desktop',
  claude_sdk: 'Claude Agent SDK',
  codex_tui: 'Codex TUI',
  codex_exec: 'codex exec',
  codex_desktop: 'Codex Desktop',
  codex_sdk: 'Codex SDK',
}

export const supportKeyLabel = (key: SupportKey): string =>
  `${surfaceLabel[key.surface]} ${key.engine_version}, ${key.os}, ${key.placement}`

const unavailableReason: Readonly<Record<Extract<ObserverState, { state: 'unavailable' }>['reason'], string>> = {
  auth: 'нет авторизации CLI',
  auth_path_broken: 'путь авторизации нарушен',
  limit: 'исчерпан лимит подписки',
  transient: 'временный сбой',
  process_stuck: 'процесс завис',
}

const disabledReason: Readonly<Record<Extract<ObserverState, { state: 'disabled' }>['reason'], string>> = {
  isolation: 'изоляция не подтверждена',
  cli_missing: 'CLI не найден',
  version_not_admitted: 'версия CLI не допущена',
  admission_failed: 'допуск версии не пройден',
  self_check_failed: 'самопроверка не пройдена',
  unsafe_workdir: 'небезопасный рабочий каталог',
  launcher_unavailable: 'запуск недоступен',
}

const lagReason: Readonly<Record<Extract<ObserverState, { state: 'lagging' }>['reason'], string>> = {
  budget: 'исчерпан бюджет',
  backlog: 'большая очередь',
}

export const observerStateLabel = (state: ObserverState): string => {
  switch (state.state) {
    case 'ok':
      return 'работает'
    case 'lagging':
      return `отстаёт: ${lagReason[state.reason]}`
    case 'backoff':
      return `повтор в ${clockTime(state.until)}, попытка ${String(state.attempt)}`
    case 'unavailable':
      return `недоступен: ${unavailableReason[state.reason]}`
    case 'disabled':
      return `отключён: ${disabledReason[state.reason]}`
  }
}

export const basisLabel: Readonly<Record<BasisKind, string>> = {
  observed: 'наблюдаемое событие',
  claimed: 'заявление решателя',
  interpreted: 'интерпретация aang',
}

export const attentionKindLabel: Readonly<Record<AttentionKind, string>> = {
  question: 'Вопрос',
  permission: 'Запрос одобрения',
  review_request: 'Запрос ревью',
  blocker: 'Препятствие',
  failed_check: 'Упавшая проверка',
}

export const attentionAuthorLabel: Readonly<Record<AttentionAuthor, string>> = {
  rule: 'по правилу aang',
  observer: 'от наблюдателя',
}

export const questionKindLabel: Readonly<Record<QuestionKind, string>> = {
  permission: 'Запрос одобрения',
  ask_user_question: 'Вопрос',
  exit_plan_mode: 'План на одобрение',
  elicitation: 'Запрос данных',
  notification: 'Запрос из уведомления',
  agent_message: 'Вопрос агента',
}

export const decisionLabel: Readonly<Record<HumanDecision, string>> = {
  none: 'решения нет',
  requested: 'ждёт решения',
  approved: 'одобрено',
  rejected: 'отклонено',
  answered: 'отвечен',
  unknown: 'решение не видно',
}

export const outcomeLabel: Readonly<Record<ActionOutcome, string>> = {
  ok: 'успешно',
  error: 'ошибка',
  denied: 'отказ',
  interrupted: 'прервано',
  unknown: 'исход неизвестен',
}

export const planSourceLabel: Readonly<Record<PlanSource, string>> = {
  task_tool: 'Задачи решателя',
  task_hook: 'Задачи из hooks',
  exit_plan_mode: 'План на одобрение',
  thread_goal: 'Цель треда',
  rollout_plan: 'План Codex',
}

export const planItemLabel: Readonly<Record<PlanItemStatus, string>> = {
  pending: 'ожидает',
  in_progress: 'в работе',
  completed: 'выполнен',
  cancelled: 'отменён',
  unknown: 'статус неизвестен',
}

export const launchLabel: Readonly<Record<SessionLaunch, string>> = {
  startup: 'запуск',
  resume: 'продолжение',
  clear: 'после /clear',
  fork: 'ответвление',
  unknown: 'запуск без источника',
}

export const agentRoleLabel: Readonly<Record<AgentRole, string>> = {
  main: 'основной',
  subagent: 'субагент',
  teammate: 'teammate',
  service: 'служебный',
}

export const serviceAgentLabel: Readonly<Record<ServiceAgent, string>> = {
  guardian: 'guardian',
  compaction: 'сжатие контекста',
  desktop_summary: 'сводки Desktop',
}

export const sessionForms = { one: 'сессия', few: 'сессии', many: 'сессий' } as const
export const sessionInForms = { one: 'сессии', few: 'сессиях', many: 'сессиях' } as const
export const agentForms = { one: 'агент', few: 'агента', many: 'агентов' } as const
export const runForms = { one: 'прогон', few: 'прогона', many: 'прогонов' } as const
export const runInForms = { one: 'прогоне', few: 'прогонах', many: 'прогонах' } as const
export const factForms = { one: 'факт', few: 'факта', many: 'фактов' } as const
export const fileForms = { one: 'файл', few: 'файла', many: 'файлов' } as const
export const recordForms = { one: 'запись', few: 'записи', many: 'записей' } as const
export const versionForms = { one: 'версия', few: 'версии', many: 'версий' } as const
export const stepForms = { one: 'ранний шаг', few: 'ранних шага', many: 'ранних шагов' } as const

export const sessionsIn = (count: number): string => plural(count, sessionInForms)
