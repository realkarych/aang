import type { ArtifactContent, ChatCitation, Fact, FactKind, Speaker, VersionRetention } from '@aang/contract'
import { detailOf } from './action-input.js'

export const citationKindLabel: Readonly<Record<ChatCitation['kind'], string>> = {
  stage: 'Этап',
  fact: 'Факт',
  action: 'Действие',
  artifact_version: 'Версия артефакта',
  question: 'Пункт внимания',
}

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
  hook_run: 'hook решателя',
  definition_listing: 'перечень определений',
  queue_operation: 'очередь промптов',
  runtime_error: 'ошибка рантайма',
  runtime_event: 'событие рантайма',
  json_snapshot: 'снимок файла',
  git_snapshot: 'снимок git',
  context: 'контекст',
  source_lost: 'потеря источника',
  process_exited: 'процесс завершился',
}

export const speakerLabel: Readonly<Record<Speaker, string>> = {
  human: 'человек',
  solver: 'решатель',
  tool: 'инструмент',
  runtime: 'рантайм',
}

export const retentionLabel: Readonly<Record<VersionRetention['kind'], string>> = {
  action_payload: 'версия сохранена из действия',
  file_read: 'версия сохранена при чтении файла',
  commit: 'версия в коммите',
  hash_only: 'сохранён только хэш содержимого',
  reference: 'только ссылка',
}

export const contentSourceLabel: Readonly<Record<Extract<ArtifactContent, { kind: 'stored' }>['source'], string>> = {
  action_payload: 'содержимое, которое записало действие',
  file_read: 'состояние файла на момент чтения',
  commit: 'содержимое коммита',
}

export const contentMissingLabel: Readonly<Record<Extract<ArtifactContent, { kind: 'unavailable' }>['reason'], string>> =
  {
    reference_only: 'известна только ссылка, содержимое aang не сохранял',
    hash_only: 'сохранён только хэш содержимого',
    commit_missing: 'коммита этой версии больше нет в репозитории',
    blob_missing: 'содержимое пропало из хранилища aang',
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
