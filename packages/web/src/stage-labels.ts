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
  not_checked: 'не проверен',
  confirmed: 'подтверждён',
  passed_unversioned: 'проверка прошла, версия не установлена',
  partial: 'подтверждён частично',
  failed: 'не выполнен',
  stale: 'проверен на другой версии',
  reported_done: 'агент сообщил о завершении',
}

export const criterionSourceLabel: Readonly<Record<CriterionSource, string>> = {
  task: 'из задания',
  plan: 'из плана',
  contract: 'по контракту проверки',
}

export const stageOriginLabel: Readonly<Record<StageOrigin, string>> = {
  plan: 'из плана решателя',
  inferred: 'восстановлен наблюдателем',
}

export const speakerLabel: Readonly<Record<Speaker, string>> = {
  human: 'человек',
  solver: 'решатель',
  tool: 'инструмент',
  runtime: 'рантайм',
}

export const factKindLabel: Readonly<Record<FactKind, string>> = {
  session_start: 'Начало сессии',
  session_end: 'Конец сессии',
  turn_start: 'Начало хода',
  turn_settings: 'Настройки хода',
  turn_end: 'Конец хода',
  prompt: 'Промпт',
  message: 'Сообщение',
  agent_start: 'Запуск агента',
  agent_end: 'Завершение агента',
  action_start: 'Начало действия',
  action_end: 'Конец действия',
  tool_batch_end: 'Конец пакета вызовов',
  permission_request: 'Запрос одобрения',
  permission_denied: 'Отказ в одобрении',
  permission_decision: 'Решение по одобрению',
  notification: 'Уведомление',
  question_asked: 'Вопрос',
  question_answered: 'Ответ на вопрос',
  plan_update: 'План',
  compaction: 'Сжатие контекста',
  usage: 'Расход',
  usage_total: 'Итог расхода',
  cost_state: 'Итог Claude Code',
  instructions_loaded: 'Загружены инструкции',
  queue_operation: 'Очередь промптов',
  runtime_error: 'Ошибка рантайма',
  runtime_event: 'Событие рантайма',
  json_snapshot: 'Снимок файла',
  git_snapshot: 'Снимок рабочего дерева',
  context: 'Контекст наблюдателя',
  source_lost: 'Источник потерян',
}

export const rawChannelLabel: Readonly<Record<RawChannel, string>> = {
  hook: 'hook',
  transcript: 'транскрипт',
  rollout: 'rollout',
  otel: 'OTel',
  registry: 'реестр',
  snapshot: 'снимок aang',
  context: 'контекст aang',
}

export const parseStateLabel: Readonly<Record<ParseState, string>> = {
  parsed: 'разобрана',
  unknown: 'не распознана',
  invalid: 'не разобрана',
}

export const snapshotTriggerLabel: Readonly<Record<SnapshotTrigger, string>> = {
  check: 'при проверке',
  fs_watch: 'после изменения файлов',
  turn_end: 'в конце хода',
  restart: 'после перезапуска',
}

export const changeAuthorLabel: Readonly<Record<ChangeAuthor, string>> = {
  rule: 'правило aang',
  observer: 'наблюдатель',
  user: 'пользователь',
}

export const operationLabel: Readonly<Record<ModelOperation, string>> = {
  'stage.create': 'создание этапа',
  'stage.update': 'описание этапа',
  'stage.state': 'состояние этапа',
  'stage.replace': 'замена этапа',
  'stage.merge': 'объединение этапов',
  'stage.split': 'разделение этапа',
  'stage.nest': 'вложенность этапа',
  'stage.depends': 'зависимость этапов',
  'actions.assign': 'привязка действий',
  'agents.participate': 'участие агентов',
  'artifact.link': 'привязка артефакта',
  'criterion.add': 'новый критерий',
  'criterion.assess': 'оценка критерия',
  'card.add': 'карточка результата',
  'brief.update': 'описание прогона',
  'question.add': 'вопрос наблюдателя',
  'attention.add': 'новый пункт внимания',
  'attention.resolve': 'разрешение пункта',
  'attention.likely_resolved': 'пункт вероятно отвечен',
  'attention.priority': 'рекомендованный приоритет',
  'run.create': 'создание прогона',
  'run.goal': 'цель прогона',
  'stage.execution': 'выполнение по событиям',
  'criterion.status': 'статус критерия по проверке',
  'attention.open': 'пункт внимания открыт',
  'attention.wait': 'ожидание рантайма',
  'attention.close': 'пункт внимания закрыт',
  'link.add': 'новая связь',
  'link.retarget': 'связь перенесена',
  'link.remove': 'связь снята',
  'session.move': 'перенос сессии',
  'binding.add': 'привязка сессии',
  'binding.revoke': 'отмена привязки',
}

export const entityKindLabel: Readonly<Record<ModelEntityRef['kind'], string>> = {
  run: 'прогон',
  stage: 'этап',
  criterion: 'критерий',
  card: 'карточка',
  attention_item: 'пункт внимания',
  link: 'связь',
  binding: 'привязка',
  session_membership: 'сессия прогона',
}

export const rejectionCauseLabel: Readonly<Record<ObserverRejectionCause, string>> = {
  schema: 'не соответствует схеме',
  version: 'устаревшая версия карты',
  conflict: 'конфликт с изменениями',
  reference: 'ссылка на несуществующее',
  scope: 'вне области прогона',
  invariant: 'нарушает правила модели',
  limit: 'превышен предел',
}

export const resolutionLabel: Readonly<Record<AttentionResolution, string>> = {
  open: 'открыт',
  answered: 'отвечен',
  resolved: 'разрешён',
  ended_without_answer: 'ожидание прекращено без ответа',
}

export const priorityLabel: Readonly<Record<AttentionPriority, string>> = {
  high: 'высокий',
  medium: 'средний',
  low: 'низкий',
}
