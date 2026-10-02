import { join, sep } from 'node:path'
import type { Anonymize } from './anonymize.js'
import {
  callsOf,
  type ChecklistEvent,
  type FieldValue,
  isBatchCalls,
  isoTime,
  numberField,
  textField,
} from './events.js'
import type { ClaudeTranscript, CodexRollout, SessionFiles } from './files.js'
import { type EnvProbeRecord, probedEnvNames } from './probe-env.js'
import {
  countEvents,
  distinctEnv,
  distinctText,
  idleChains,
  permissionChains,
  type Session,
  surfaceOf,
  toolChains,
  toolPairs,
} from './sessions.js'
import type { ChecklistState } from './state.js'

export interface SummaryInput {
  readonly generatedAt: string
  readonly state: ChecklistState
  readonly events: readonly ChecklistEvent[]
  readonly scope: { readonly droppedEvents: number; readonly droppedSessions: number } | null
  readonly sessions: readonly Session[]
  readonly envProbes: readonly EnvProbeRecord[]
  readonly files: SessionFiles
  readonly codexHome: string
  readonly anonymize: Anonymize
}

interface Labeled {
  readonly label: string
  readonly session: Session
}

const detailFields = [
  'tool_name',
  'tool_use_id',
  'notification_type',
  'source',
  'reason',
  'agent_id',
  'agent_type',
  'trigger',
  'subagent_type',
  'run_in_background',
  'response_agent_id',
  'response_status',
  'questions',
  'answers',
  'afk_timeout_ms',
  'plan_length',
  'plan_file_path',
  'background_tasks',
  'permission_mode',
] as const

const cell = (value: string): string => value.replaceAll('|', '\\|').replaceAll(/\r?\n/g, ' ')

const code = (value: string): string => `\`${value.replaceAll('`', "'")}\``

const row = (values: readonly string[]): string => `| ${values.map(cell).join(' | ')} |`

const table = (header: readonly string[], rows: readonly (readonly string[])[], empty: string): string[] =>
  rows.length === 0 ? [empty] : [row(header), row(header.map(() => '---')), ...rows.map(row)]

const seconds = (milliseconds: number | null): string => (milliseconds === null ? 'нет' : (milliseconds / 1000).toFixed(2))

const offset = (session: Session, event: ChecklistEvent): string => {
  const first = session.events[0]
  return first === undefined ? '' : (Number(event.receivedNs - first.receivedNs) / 1e9).toFixed(2)
}

const yesNo = (value: boolean): string => (value ? 'да' : 'нет')

const formatValue = (value: FieldValue): string =>
  isBatchCalls(value)
    ? `[${value.map((call) => `${call.tool_name ?? '?'} ${call.tool_use_id ?? '?'} ${call.response}`).join('; ')}]`
    : String(value)

const numberText = (event: ChecklistEvent, name: string): string => {
  const value = numberField(event, name)
  return value === null ? 'нет' : String(value)
}

const details = (event: ChecklistEvent): string =>
  [
    ...detailFields.flatMap((name) => {
      const value = event.fields[name]
      return value === undefined ? [] : [`${name}=${formatValue(value)}`]
    }),
    ...(callsOf(event).length > 0 ? [`tool_calls=${formatValue(callsOf(event))}`] : []),
    ...(event.problem === null ? [] : [`проблема: ${event.problem}`]),
  ].join(', ')

const json = (value: unknown, anonymize: Anonymize): string => anonymize(JSON.stringify(value))

const sessionLabels = (sessions: readonly Session[]): Labeled[] =>
  [...sessions]
    .sort((left, right) => {
      const a = left.events[0]?.receivedNs ?? 0n
      const b = right.events[0]?.receivedNs ?? 0n
      return a === b ? 0 : a < b ? -1 : 1
    })
    .map((session, index) => ({ label: `S${String(index + 1)}`, session }))

const isClaudeWorktree = (cwd: string): boolean =>
  cwd.includes(`${sep}.claude${sep}worktrees${sep}`) || cwd.includes('/.claude/worktrees/')

const scopeLine = (scope: SummaryInput['scope']): string =>
  scope === null
    ? 'Учтены все сессии из spool (`collect --all-sessions`).'
    : `Учтены сессии, у которых \`cwd\` лежит в рабочем каталоге или в \`$CODEX_HOME/worktrees\`; остальные отброшены: событий ${String(scope.droppedEvents)}, сессий ${String(scope.droppedSessions)}.`

const header = ({ generatedAt, state, events, scope, sessions, anonymize }: SummaryInput): string[] => [
  '# Чек-лист владельца D.7: сводка',
  '',
  `Собрано командой \`collect\` ${generatedAt}. ОС: ${process.platform}. Рабочий каталог: ${code(anonymize(state.dir))} (в путях — \`<dir>\`, домашний каталог — \`~\`).`,
  `Регистрация Claude: \`${state.claude.mode}\`. Hooks Codex: ${state.codex === null ? 'не регистрировались' : 'зарегистрированы'}.`,
  '',
  `Событий: ${String(events.length)}, из них с проблемой разбора: ${String(events.filter((event) => event.problem !== null).length)}. Сессий: ${String(sessions.length)}.`,
  scopeLine(scope),
  '',
  'Пункты с пометкой «заполняет владелец» скрипт не проверяет: их результат записывается в отчёт вручную.',
  '',
]

const sessionFacts = (session: Session): (readonly [string, readonly string[]])[] => [
  ['cwd', distinctText(session, null, 'cwd')],
  ['transcript_path', distinctText(session, null, 'transcript_path')],
  ...(['CLAUDE_PLUGIN_ROOT', 'CLAUDE_PROJECT_DIR', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_HOST_SESSION_ID', 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE'] as const).map(
    (name) => [name, distinctEnv(session, name)] as const,
  ),
]

const sessionsOverview = (labeled: readonly Labeled[], anonymize: Anonymize): string[] => [
  '## Сессии',
  '',
  ...table(
    ['Сессия', 'Рантайм', 'Поверхность', 'Регистрация', 'Начало (UTC)', 'Событий', 'session_id'],
    labeled.map(({ label, session }) => [
      label,
      session.runtime,
      surfaceOf(session),
      [...new Set(session.events.map((event) => event.registration))].join(', '),
      session.events[0] === undefined ? '' : isoTime(session.events[0].receivedNs),
      String(session.events.length),
      session.sessionId ?? '(нет)',
    ]),
    'В spool нет событий.',
  ),
  '',
  ...labeled.flatMap(({ label, session }) => [
    `### ${label} — ${session.runtime}, ${surfaceOf(session)}`,
    '',
    ...sessionFacts(session).flatMap(([name, values]) =>
      values.length === 0 ? [] : [`- ${name}: ${values.map((value) => code(anonymize(value))).join(', ')}`],
    ),
    '',
    ...table(
      ['+t, с', 'Событие', 'Подробности'],
      session.events.map((event) => [offset(session, event), event.event ?? '(нет)', anonymize(details(event))]),
      'Событий нет.',
    ),
    '',
  ]),
]

const permissionSection = (claude: readonly Labeled[]): string[] => [
  '### (a) Notification(permission_prompt) после PermissionRequest',
  '',
  'Ожидание в TUI: около 6 с без ввода, каждое нажатие клавиши откладывает уведомление. Исход берётся по `tool_use_id` предыдущего PreToolUse с тем же инструментом.',
  '',
  ...table(
    ['Сессия', 'Поверхность', 'PermissionRequest, +t с', 'Инструмент', 'tool_use_id', 'Задержка permission_prompt, с', 'Исход'],
    claude.flatMap(({ label, session }) =>
      permissionChains(session).map((chain) => [
        label,
        surfaceOf(session),
        offset(session, chain.request),
        chain.toolName ?? '?',
        chain.toolUseId ?? '?',
        seconds(chain.promptDelayMs),
        chain.outcome,
      ]),
    ),
    'PermissionRequest не было.',
  ),
  '',
]

const idleSection = (claude: readonly Labeled[]): string[] => [
  '### (b) Notification(idle_prompt) после Stop',
  '',
  'Ожидание: около 60 с после ответа, если пользователь ничего не вводил. Учитывается первое `idle_prompt` до следующего UserPromptSubmit или SessionEnd.',
  '',
  ...table(
    ['Сессия', 'Поверхность', 'Stop, +t с', 'background_tasks', 'Задержка idle_prompt, с'],
    claude.flatMap(({ label, session }) =>
      idleChains(session).map((chain) => [
        label,
        surfaceOf(session),
        offset(session, chain.stop),
        chain.backgroundTasks === null ? '' : String(chain.backgroundTasks),
        seconds(chain.idleDelayMs),
      ]),
    ),
    'Stop не было.',
  ),
  '',
]

const toolSection = (title: string, toolName: string, claude: readonly Labeled[], planColumns: boolean): string[] => [
  title,
  '',
  ...table(
    [
      'Сессия',
      'Поверхность',
      'tool_use_id',
      ...(planColumns ? ['Длина plan', 'planFilePath'] : ['Вопросов']),
      'PermissionRequest',
      'Notification до PostToolUse',
      'PostToolUse',
      ...(planColumns ? [] : ['answers']),
      'PreToolUse → PostToolUse, с',
    ],
    claude.flatMap(({ label, session }) =>
      toolChains(session, toolName).map((chain) => [
        label,
        surfaceOf(session),
        chain.toolUseId ?? '?',
        ...(planColumns
          ? [
              numberText(chain.pre, 'plan_length'),
              yesNo(chain.pre.fields.plan_file_path === true || chain.post?.fields.plan_file_path === true),
            ]
          : [numberText(chain.pre, 'questions')]),
        yesNo(chain.permission),
        chain.notifications.join(', ') || 'нет',
        chain.post === null ? (chain.deniedInBatch ? 'нет, отказ в PostToolBatch' : 'нет') : (chain.post.event ?? ''),
        ...(planColumns ? [] : [yesNo(chain.post?.fields.answers === true)]),
        seconds(chain.durationMs),
      ]),
    ),
    `PreToolUse(${toolName}) не было.`,
  ),
  '',
]

const sessionEndSection = (claude: readonly Labeled[]): string[] => [
  '### (e) SessionEnd.reason',
  '',
  'Для сопоставления владелец записывает, как завершалась каждая сессия (`/exit`, двойной Ctrl+C, Ctrl+D, `/clear`, закрытие окна).',
  '',
  ...table(
    ['Сессия', 'Поверхность', 'SessionEnd, +t с', 'reason'],
    claude.flatMap(({ label, session }) =>
      session.events
        .filter((event) => event.event === 'SessionEnd')
        .map((event) => [label, surfaceOf(session), offset(session, event), textField(event, 'reason') ?? '(нет)']),
    ),
    'SessionEnd не было.',
  ),
  '',
]

const envProbeSection = (probes: readonly EnvProbeRecord[], labeled: readonly Labeled[]): string[] => {
  const labelOf = (sessionId: string | null): string =>
    labeled.find(({ session }) => session.runtime === 'claude' && session.sessionId === sessionId)?.label ??
    sessionId ??
    '(нет)'
  return [
    '### (f) Окружение процесса hook (`results/env-probe.jsonl`)',
    '',
    'Пишет зонд `probes/env-settings.json` на SessionStart; подключается флагом `--settings`.',
    '',
    ...table(
      ['Сессия', 'Время (UTC)', 'Событие', 'source', ...probedEnvNames],
      probes.map((probe) => [
        labelOf(probe.session_id),
        probe.received_at,
        probe.hook_event_name ?? '',
        probe.source ?? '',
        ...probedEnvNames.map((name) => probe.env[name] ?? '(нет)'),
      ]),
      'Записей зонда нет: TUI не запускался с `--settings probes/env-settings.json`.',
    ),
    '',
  ]
}

const notificationSection = (labeled: readonly Labeled[]): string[] => {
  const types = new Map<string, Set<string>>()
  const counts = new Map<string, number>()
  for (const { label, session } of labeled) {
    for (const event of session.events.filter((item) => item.event === 'Notification')) {
      const type = textField(event, 'notification_type') ?? '(нет)'
      types.set(type, (types.get(type) ?? new Set()).add(`${label} (${surfaceOf(session)})`))
      counts.set(type, (counts.get(type) ?? 0) + 1)
    }
  }
  return [
    '### (g) Типы Notification',
    '',
    ...table(
      ['notification_type', 'Количество', 'Сессии'],
      [...types].map(([type, sessions]) => [type, String(counts.get(type) ?? 0), [...sessions].join(', ')]),
      'Notification не было.',
    ),
    '',
    ...['elicitation_dialog', 'agent_needs_input'].map(
      (type) => `- \`${type}\`: ${types.has(type) ? 'встречен' : 'не встречен'}.`,
    ),
    '',
  ]
}

const pairsLine = (session: Session): string => {
  const pairs = toolPairs(session)
  const unpaired = pairs.unpaired.map(
    (item) => `${item.toolName ?? '?'} ${item.toolUseId}${item.deniedInBatch ? ' (отказ в PostToolBatch)' : ''}`,
  )
  return `- PreToolUse → PostToolUse по \`tool_use_id\`: пар ${String(pairs.paired)}, PostToolUseFailure ${String(pairs.failed)}, без Post*: ${unpaired.length === 0 ? 'нет' : unpaired.join('; ')}`
}

const permissionLine = (session: Session): string => {
  const chains = permissionChains(session)
  return `- PermissionRequest: ${chains.length === 0 ? 'нет' : chains.map((chain) => `${chain.toolName ?? '?'} → ${chain.outcome}`).join('; ')}`
}

const transcriptLines = (transcript: ClaudeTranscript | undefined, anonymize: Anonymize): string[] =>
  transcript === undefined || transcript.path === null
    ? ['- Транскрипт: не найден']
    : [
        `- Транскрипт: ${code(anonymize(transcript.path))}, каталог проекта ${code(anonymize(transcript.projectDir ?? ''))}`,
        `- entrypoint в записях: ${Object.entries(transcript.entrypoints).map(([name, count]) => `${name} ×${String(count)}`).join(', ') || 'нет'}; версии: ${transcript.versions.join(', ') || 'нет'}`,
        `- compact_boundary: ${String(transcript.compactBoundaries)}; файлов \`subagents/**/*.jsonl\`: ${String(transcript.subagentFiles)}`,
      ]

const desktopSection = (input: SummaryInput, labeled: readonly Labeled[]): string[] => {
  const { files, anonymize } = input
  const desktop = labeled.filter(({ session }) => session.runtime === 'claude' && surfaceOf(session) === 'claude-desktop')
  return [
    '## Claude Desktop (раздел 11 спайка, шаги 1–6)',
    '',
    ...(desktop.length === 0 ? ['Сессий с `CLAUDE_CODE_ENTRYPOINT=claude-desktop` нет.', ''] : []),
    ...desktop.flatMap(({ label, session }) => {
      const cwds = distinctText(session, null, 'cwd')
      return [
        `### ${label}`,
        '',
        `- CLAUDE_CODE_ENTRYPOINT: ${distinctEnv(session, 'CLAUDE_CODE_ENTRYPOINT').join(', ') || 'нет'}; CLAUDE_CODE_HOST_SESSION_ID: ${distinctEnv(session, 'CLAUDE_CODE_HOST_SESSION_ID').join(', ') || 'нет'}`,
        `- SessionStart.source: ${distinctText(session, 'SessionStart', 'source').join(', ') || 'нет SessionStart'}`,
        `- PreCompact: ${String(countEvents(session, 'PreCompact'))}, PostCompact: ${String(countEvents(session, 'PostCompact'))}`,
        `- SubagentStart: ${String(countEvents(session, 'SubagentStart'))}, SubagentStop: ${String(countEvents(session, 'SubagentStop'))}`,
        `- cwd в \`.claude/worktrees\`: ${yesNo(cwds.some(isClaudeWorktree))}`,
        pairsLine(session),
        permissionLine(session),
        ...transcriptLines(
          files.claudeTranscripts.find((transcript) => transcript.sessionId === session.sessionId),
          anonymize,
        ),
        '',
      ]
    }),
    '### Метаданные Desktop (`claude-code-sessions/**/local_*.json`)',
    '',
    'Только файлы сессий из spool. По ADR-0004 (решение 4) значения выводятся только для `cliSessionId`, `spawnSeed` и `lastSpawnRootDetected`; у остальных ключей — только тип. Длинный текст в `spawnSeed` заменён длиной.',
    '',
    ...(files.desktopSessions.length === 0 ? ['Метафайлов сессий из spool не найдено.', ''] : []),
    ...files.desktopSessions.flatMap((meta) => [
      `#### ${code(meta.file)}`,
      '',
      `- sessionId: ${meta.sessionId ?? '(нет)'}; cliSessionId: ${meta.cliSessionId ?? '(нет)'}; сессия в spool: ${labeled.find(({ session }) => session.sessionId === meta.cliSessionId)?.label ?? 'нет'}`,
      `- lastSpawnRootDetected: ${json(meta.lastSpawnRootDetected, anonymize)}`,
      `- spawnSeed: ${code(json(meta.spawnSeed, anonymize))}`,
      '',
      '```json',
      JSON.stringify(meta.shape, null, 1),
      '```',
      '',
    ]),
    '### Маркеры удаления `deleted_<uuid>`',
    '',
    ...table(
      ['Файл', 'Сессия Desktop', 'Содержимое'],
      files.desktopDeleted.map((marker) => [marker.file, marker.hostSessionId, marker.content]),
      'Маркеров удаления для сессий из spool нет.',
    ),
    '',
  ]
}

const rolloutLines = (rollout: CodexRollout | undefined, anonymize: Anonymize): string[] =>
  rollout === undefined || rollout.path === null
    ? ['- Rollout: не найден']
    : [
        `- Rollout: ${code(anonymize(rollout.path))}`,
        `- session_meta: originator ${code(json(rollout.originator, anonymize))}, source ${code(json(rollout.source, anonymize))}, thread_source ${code(json(rollout.thread_source, anonymize))}, parent_thread_id ${code(json(rollout.parent_thread_id, anonymize))}, cli_version ${code(json(rollout.cli_version, anonymize))}`,
        ...rollout.turnContexts.map(
          (context) =>
            `- turn_context: approval_policy ${code(json(context.approval_policy, anonymize))}, sandbox_policy ${code(json(context.sandbox_policy, anonymize))}, workspace_roots ${code(json(context.workspace_roots, anonymize))}; \`~/aang-desktop-probe-outside\` среди корней записи: ${yesNo(context.outside_probe_writable)}`,
        ),
      ]

const codexSection = (input: SummaryInput, labeled: readonly Labeled[]): string[] => {
  const codex = labeled.filter(({ session }) => session.runtime === 'codex')
  const worktrees = join(input.codexHome, 'worktrees')
  return [
    '## Codex (раздел 11 спайка, шаги 7–10)',
    '',
    ...(codex.length === 0 ? ['Событий Codex нет.', ''] : []),
    ...codex.flatMap(({ label, session }) => [
      `### ${label}`,
      '',
      `- SessionStart.source: ${distinctText(session, 'SessionStart', 'source').join(', ') || 'нет SessionStart'}`,
      `- SubagentStart: ${String(countEvents(session, 'SubagentStart'))}, SubagentStop: ${String(countEvents(session, 'SubagentStop'))}`,
      `- cwd в \`$CODEX_HOME/worktrees\`: ${yesNo(distinctText(session, null, 'cwd').some((cwd) => cwd.startsWith(worktrees)))}`,
      pairsLine(session),
      permissionLine(session),
      ...rolloutLines(
        input.files.codexRollouts.find((rollout) => rollout.sessionId === session.sessionId),
        input.anonymize,
      ),
      '',
    ]),
  ]
}

const transcriptsSection = (input: SummaryInput, labeled: readonly Labeled[]): string[] => [
  '## Транскрипты Claude',
  '',
  ...table(
    ['Сессия', 'Файл', 'Записей', 'entrypoint', 'Версии', 'compact_boundary', 'subagents'],
    input.files.claudeTranscripts.map((transcript) => [
      labeled.find(({ session }) => session.runtime === 'claude' && session.sessionId === transcript.sessionId)?.label ?? '',
      transcript.path === null ? 'не найден' : input.anonymize(transcript.path),
      String(transcript.lines),
      Object.entries(transcript.entrypoints).map(([name, count]) => `${name} ×${String(count)}`).join(', '),
      transcript.versions.join(', '),
      String(transcript.compactBoundaries),
      String(transcript.subagentFiles),
    ]),
    'Сессий Claude нет.',
  ),
  '',
]

const ownerSection = (): string[] => [
  '## Заполняет владелец',
  '',
  '- (d) Как TUI показал ошибку hook с кодом 1 на PreToolUse (текст, где выводится, выполнился ли инструмент) и зависший hook на UserPromptSubmit (спиннер, `statusMessage`, сообщение об отмене по таймауту через 2 с).',
  '- (a), (b) Был ли терминал в фокусе во время ожидания; когда было последнее нажатие клавиши в варианте с вводом.',
  '- (e) Как завершалась каждая сессия.',
  '- (g) Удалось ли вызвать `elicitation_dialog` и `agent_needs_input` и чем.',
  '- Desktop, шаг 3a: доступен ли spawn task или Dispatch; связь с родителем в метаданных.',
  '- Desktop, шаг 4: закрытие и повторное открытие приложения, продолжение той же сессии.',
  '- Desktop, шаг 6: что стало с транскриптом после архивации и удаления.',
  '- Codex, шаг 7: как выполнялся trust в UI, `trustStatus` в логах `~/Library/Logs/com.openai.codex/`.',
  '- Codex, шаг 8a: появился ли запрос одобрения; создан ли файл.',
  '- Codex, шаг 10: чат Cloud — нет ли новых rollout и событий в spool.',
  '- Ограничения Desktop для владельца до этапа 2 (RFC §4).',
  '',
]

export const renderSummary = (input: SummaryInput): string => {
  const labeled = sessionLabels(input.sessions)
  const claude = labeled.filter(({ session }) => session.runtime === 'claude')
  return [
    ...header(input),
    ...sessionsOverview(labeled, input.anonymize),
    '## Интерактивный TUI Claude (раздел 6 спайка, пункты a–h)',
    '',
    'Учитываются все сессии Claude; поверхность указана в колонке. Время — время приёма события `aang-hook` (mtime файла spool).',
    '',
    ...permissionSection(claude),
    ...idleSection(claude),
    ...toolSection('### (c) AskUserQuestion', 'AskUserQuestion', claude, false),
    '### (d) Ошибки hook и зависший hook — заполняет владелец',
    '',
    'Зонды `probes/failure-settings.json`: PreToolUse завершается с кодом 1, UserPromptSubmit висит дольше `timeout: 2`. Скрипт видит только события aang; что показал TUI, записывает владелец.',
    '',
    ...sessionEndSection(claude),
    ...envProbeSection(input.envProbes, labeled),
    ...notificationSection(claude),
    ...toolSection('### (h) ExitPlanMode', 'ExitPlanMode', claude, true),
    ...desktopSection(input, labeled),
    ...codexSection(input, labeled),
    ...transcriptsSection(input, labeled),
    ...ownerSection(),
  ].join('\n')
}
