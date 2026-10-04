import type {
  ActionOutcome,
  AgentRole,
  AttentionAuthor,
  AttentionKind,
  AttentionResolution,
  BasisKind,
  CriterionStatus,
  Execution,
  FactKind,
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
  Speaker,
  Surface,
  SupportKey,
  SupportMode,
  SupportStatus,
  VersionRetention,
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

export const factKindLabel: Readonly<Record<FactKind, string>> = {
  session_start: 'начало сессии',
  session_end: 'конец сессии',
  turn_start: 'начало хода',
  turn_settings: 'настройки хода',
  turn_end: 'конец хода',
  prompt: 'промпт',
  message: 'сообщение',
  agent_start: 'запуск агента',
  agent_end: 'завершение агента',
  action_start: 'начало действия',
  action_end: 'итог действия',
  tool_batch_end: 'итог группы вызовов',
  permission_request: 'запрос одобрения',
  permission_denied: 'отказ в одобрении',
  permission_decision: 'решение по одобрению',
  notification: 'уведомление',
  question_asked: 'вопрос',
  question_answered: 'ответ на вопрос',
  plan_update: 'план',
  compaction: 'сжатие контекста',
  usage: 'расход токенов',
  usage_total: 'итог расхода',
  cost_state: 'состояние стоимости',
  instructions_loaded: 'загрузка инструкций',
  queue_operation: 'очередь промптов',
  runtime_error: 'ошибка рантайма',
  runtime_event: 'событие рантайма',
  json_snapshot: 'снимок файла',
  git_snapshot: 'снимок git',
  context: 'контекст',
  source_lost: 'потеря источника',
}

export const speakerLabel: Readonly<Record<Speaker, string>> = {
  human: 'человек',
  solver: 'решатель',
  tool: 'инструмент',
  runtime: 'рантайм',
}

export const criterionStatusLabel: Readonly<Record<CriterionStatus, string>> = {
  not_checked: 'не проверен',
  confirmed: 'подтверждён',
  passed_unversioned: 'пройден без версии',
  partial: 'подтверждён частично',
  failed: 'не выполнен',
  stale: 'устарел',
  reported_done: 'выполнен по словам решателя',
}

export const resolutionLabel: Readonly<Record<AttentionResolution, string>> = {
  open: 'открыт',
  answered: 'получен ответ',
  resolved: 'решён',
  ended_without_answer: 'ожидание прекращено без ответа',
}

export const retentionLabel: Readonly<Record<VersionRetention['kind'], string>> = {
  action_payload: 'версия сохранена из действия',
  file_read: 'версия сохранена при чтении файла',
  commit: 'версия в коммите',
  hash_only: 'сохранён только хэш содержимого',
  reference: 'только ссылка',
}

export const changeForms = { one: 'изменение', few: 'изменения', many: 'изменений' } as const
export const actionForms = { one: 'действие', few: 'действия', many: 'действий' } as const
