# Ранний ручной чек-лист владельца (D.7): macOS

Статус: инструкция по пункту D.7 плана (`docs/plan/mvp.md`). Выполняет владелец. Это не отчёт: результаты и выводы кладутся в отдельный отчёт (раздел 7).
Дата: 2026-10-03. Инструмент — `tools/owner-checklist`.

Инструкция для Windows — `docs/research/d7-owner-checklist-windows.md`.

## 0. Что проверяется

- **Раздел A — интерактивный TUI Claude**, пункты (a)–(h) раздела 6 спайка (`docs/research/integrations.md`, «Только по документации»). Спайк TUI не запускал: принятие диалога доверия меняет `~/.claude.json`.
- **Раздел B — Claude Desktop, вкладка Code**, шаги 1–6 раздела 11 спайка («Чек-лист ручного эксперимента»).
- **Раздел C — Codex в ChatGPT Desktop**, шаги 7–10 того же раздела.

Регистратор событий — настоящий `aang-hook` (ADR-0004, «Контракт hook-обработчика»). Он пишет во временный spool, в котором `prepare` создаёт действующую аренду; без неё hook ничего не пишет. Для того, чего `aang-hook` не фиксирует, есть два зонда на Node: окружение процесса hook (пункт f) и намеренные сбои hook (пункт d).

Desktop на Windows в MVP не проверяется (ADR-0013, решение 3). Ограничения Desktop, найденные здесь, выносятся владельцу до этапа 2 (RFC §4).

## 1. Что меняется в пользовательских настройках

| Что меняется | Когда | Как откатывается |
| --- | --- | --- |
| Маркетплейс `aang` и плагин `aang@aang` в пользовательском scope Claude (`~/.claude/settings.json`, `~/.claude/plugins/`) | `prepare` с `--claude marketplace` (по умолчанию на macOS): продуктовый `installClaudePlugin`, то есть `claude plugin marketplace add` и `claude plugin install --scope user` | `cleanup`: продуктовый `uninstallClaudePlugin` (`claude plugin uninstall`, `claude plugin marketplace remove`) |
| Записи aang в `~/.codex/hooks.json`: по одной группе в конце массивов всех 12 событий Codex. Команда — `'<dir>/aang-home/bin/aang-hook' codex user '<dir>/aang-home/spool'` | `prepare --codex-hooks` | `cleanup` удаляет группы aang по точной строке команды. Чужие записи и их позиции не меняются. Если кроме записей aang в файле ничего не менялось, он восстанавливается из резервной копии байт в байт. Если после записи aang кто-то дописал свою, запись aang не удаляется, а нейтрализуется на месте (`true`), чтобы не сдвинуть чужие позиции. Файл, созданный подготовкой, удаляется. Резервная копия `hooks.json.aang-d7-backup-<время>` остаётся рядом: её удаляет владелец |
| Доверие к hooks aang в `~/.codex/config.toml` (`hooks.state."<путь>:<событие>:i:j"`) | владелец подтверждает доверие (шаг 7) | вручную: aang не пишет `hooks.state` (ADR-0004) |
| Каталог `~/aang-desktop-probe-outside` | `prepare --codex-hooks` | `cleanup` |
| Запись проекта `probe-repo` в `~/.claude.json` | первый запуск TUI или Desktop в пробном репозитории, диалог доверия | вручную |
| Сессии: транскрипты в `~/.claude/projects/`, метафайлы Desktop, rollout в `~/.codex/sessions/`, worktree Codex | во время проверок | `cleanup` печатает список, удаляет владелец |

Пока подготовка не откачена и аренда действует (24 ч по умолчанию), плагин в пользовательском scope пишет в spool события **всех** сессий Claude, а hooks Codex — всех сессий Codex после доверия. Spool содержит полные payload, включая промпты и вывод инструментов (ADR-0004, «Последствия»). Поэтому:

- на время чек-листа не работайте в других проектах в Claude и Codex;
- `cleanup` выполняйте сразу после сбора: он удаляет spool;
- `collect` по умолчанию берёт только сессии, у которых `cwd` лежит в рабочем каталоге или в `~/.codex/worktrees`; остальные он отбрасывает и считает в сводке.

Устаревшие записи aang в `~/.codex/hooks.json` (например, `aang hook` прежних экспериментов) подготовка не трогает. Продуктовый `installCodexHooks` для чек-листа не используется: он нейтрализует устаревшие записи aang и сверяет доверие через `codex app-server`, а запускать app-server на штатном `~/.codex` до отчёта D.6 нельзя.

## 2. Подготовка

Перед подготовкой:

- закройте Claude Desktop и ChatGPT;
- проверьте, что в `permissions.allow` файла `~/.claude/settings.json` нет правила, разрешающего `touch`: иначе в пунктах (a) и 1a не будет запроса разрешения;
- запишите версии: `claude --version`, `codex --version`, «О программе» в Claude Desktop и ChatGPT.

```sh
cd ~/src/aang
pnpm install
pnpm build
node tools/owner-checklist/dist/main.js prepare --dir /tmp/aang-d7 --codex-hooks
```

Опции `prepare`:

| Опция | Значение |
| --- | --- |
| `--dir <путь>` | рабочий каталог; по умолчанию `$TMPDIR/aang-d7`. На macOS удобнее `/tmp/aang-d7`, как в спайке. Каталог должен быть пустым или отсутствовать |
| `--claude marketplace` | по умолчанию на macOS и Linux: установка плагина продуктовым путём; нужна для Claude Desktop, который запускается без флагов |
| `--claude plugin-dir` | ничего не регистрирует; TUI запускается с `--plugin-dir`. Достаточно, если проверяется только раздел A |
| `--codex-hooks` | записи aang в `~/.codex/hooks.json` и каталог `~/aang-desktop-probe-outside`; нужен для раздела C |
| `--hours <n>` | срок аренды spool, по умолчанию 24 |
| `--hook <путь>` | бинарь `aang-hook`, по умолчанию `packages/hook/bin/aang-hook` из сборки |
| `--claude-command <путь>`, `--codex-home <путь>` | другой `claude` для установки плагина и другой `CODEX_HOME` |

Если плагин `aang@aang` уже установлен, `prepare` отказывает и ничего не меняет в настройках Claude. Если подготовка прервалась, сделанное откатывает `cleanup` с тем же `--dir`.

Что создаётся в `/tmp/aang-d7`:

```
aang-home/bin/aang-hook          копия бинаря без изменений
aang-home/spool/{new,tmp}        spool и аренда spool/lease-<срок в секундах Unix>
aang-home/claude-plugin/         плагин, сгенерированный продуктовым writeClaudePlugin (exec form)
probes/env-settings.json         зонд окружения на SessionStart, пишет results/env-probe.jsonl
probes/failure-settings.json     PreToolUse завершается с кодом 1; UserPromptSubmit висит дольше timeout: 2
probe-repo/                      git-репозиторий с начальным коммитом
results/                         результаты collect
state.json                       что сделала подготовка; по нему работает cleanup
```

`prepare` печатает памятку с точными командами запуска. Зонды вызывают `node` из сборки (`tools/owner-checklist/dist/probe.js`), поэтому до `cleanup` не пересобирайте и не переключайте ветку репозитория.

Если аренда истекла раньше конца проверок, hook перестаёт писать. Новую аренду на сутки создаёт:

```sh
touch "/tmp/aang-d7/aang-home/spool/lease-$(( $(date +%s) + 86400 ))"
```

Результаты можно собирать в любой момент: `collect` только читает и перезаписывает файлы в `results/` (раздел 6). Записывайте местное время каждого действия: по нему сессии сопоставляются со сводкой.

## 3. Раздел A — интерактивный TUI Claude, пункты (a)–(h)

Терминал — Terminal.app или iTerm2. Все сессии — в пробном репозитории, в режиме разрешений по умолчанию:

```sh
cd /tmp/aang-d7/probe-repo
claude --settings /tmp/aang-d7/probes/env-settings.json
```

В режиме `plugin-dir` добавьте `--plugin-dir /tmp/aang-d7/aang-home/claude-plugin`; в режиме `marketplace` этот флаг не нужен: плагин уже загружается из пользовательского scope, а второй экземпляр даст двойную регистрацию. `--settings` передаётся один раз, поэтому зонды окружения и сбоев подключаются в разных сессиях. На первом запуске примите диалог доверия к каталогу.

По документации Claude Code уведомления `permission_prompt` и `idle_prompt` в терминале приходят, только когда пользователь «отошёл». Поэтому в (a) и (b) есть варианты с фокусом в терминале и вне его; записывайте, какой был.

**(a) Notification(`permission_prompt`) после PermissionRequest.**

- a1. Промпт: «Run `touch aang-perm-allow.txt` with Bash». Когда появится запрос разрешения, переключитесь в другое окно и не трогайте клавиатуру 15 с. Затем разрешите.
- a2. Промпт: «Run `touch aang-perm-allow-2.txt` with Bash». Оставьте фокус в терминале, 15 с нажимайте стрелку вверх или вниз примерно раз в 3 с. Запишите время последнего нажатия, подождите ещё 10 с и разрешите.
- a3. Промпт: «Run `touch aang-perm-deny.txt` with Bash». Откажите.

Ожидается:

- a1 — PreToolUse(Bash) → PermissionRequest → Notification(`permission_prompt`) примерно через 6 с → PostToolUse с тем же `tool_use_id`;
- a2 — уведомление позже, примерно через 6 с после последнего нажатия, или его нет;
- a3 — PermissionRequest есть, PostToolUse нет, отказ виден в PostToolBatch.

**(b) Notification(`idle_prompt`).** После любого ответа (Stop) переключитесь в другое окно и ничего не вводите 90 с. Ожидается Notification(`idle_prompt`) примерно через 60 с после Stop. Повторите с фокусом в терминале.

**(c) AskUserQuestion.** Промпт: «Ask me two questions at once with the AskUserQuestion tool, two options each, then reply OK». Перед ответом подождите 10 с, затем ответьте на оба вопроса. Ожидаются PreToolUse(AskUserQuestion) с двумя вопросами и PostToolUse с `answers`. Проверяется, есть ли между ними PermissionRequest и Notification.

**(d) Ошибки hook и зависший hook.** Выйдите из сессии и запустите отдельную:

```sh
claude --settings /tmp/aang-d7/probes/failure-settings.json
```

Промпт: «Run `echo hi` with Bash, then reply OK». Hook на UserPromptSubmit висит 30 с при `timeout: 2` и задаёт `statusMessage` «aang D.7: hook hangs longer than its 2 s timeout». Hook на PreToolUse завершается с кодом 1 и пишет в stderr «aang D.7: deliberate hook failure».

Запишите:

- что показывал спиннер и сколько длилось ожидание;
- было ли сообщение об отмене по таймауту;
- как выглядит ошибка `PreToolUse` (например, «PreToolUse:Bash hook error») и где она выводится; подробности открывает Ctrl+O;
- выполнилась ли команда.

Скриншоты приложите к отчёту. Этот пункт сводка не проверяет.

**(e) SessionEnd.reason.** Завершайте сессии разными способами и записывайте, какую как:

- `/exit`;
- двойной Ctrl+C на пустой строке;
- двойной Ctrl+D;
- `/clear` внутри сессии: это SessionEnd и новый SessionStart с `source: clear`.

Спайк ожидал `prompt_input_exit` при выходе с открытой строкой ввода. Документированные значения: `clear`, `resume`, `logout`, `prompt_input_exit`, `other`.

**(f) Окружение процесса hook.** Отдельных действий нет: каждая сессия, запущенная с `env-settings.json`, пишет в `results/env-probe.jsonl` значения `CLAUDE_CODE_SESSION_ATTENDED`, `CLAUDE_CODE_ENTRYPOINT` и соседних переменных. В спайке `CLAUDE_CODE_SESSION_ATTENDED=0` было и в stdio-хосте, и в SDK.

**(g) `elicitation_dialog` и `agent_needs_input`.** Сводка перечисляет все встреченные `notification_type`. По документации:

- `elicitation_dialog` приходит, когда MCP-сервер открывает форму elicitation и ввода нет около 6 с;
- `agent_needs_input` — когда фоновая сессия ждёт ввода при открытом agent view или teammate agent team задаёт вопрос.

Если такой MCP-сервер или режим уже есть, вызовите их и запишите как. Новые MCP-серверы для этого не ставьте. Если вызвать не удалось, пункт отмечается непроверенным.

**(h) ExitPlanMode.** Отдельная сессия в режиме плана:

```sh
claude --permission-mode plan --settings /tmp/aang-d7/probes/env-settings.json
```

Промпт: «Plan how to create the file aang-plan.txt containing hi, then present the plan for approval». Одобрите план, затем разрешите создание файла. Ожидаются:

- PreToolUse(ExitPlanMode) с `tool_input.plan` (в сводке — длина) и `planFilePath`;
- запрос подтверждения плана как PermissionRequest или без него;
- PostToolUse(ExitPlanMode).

## 4. Раздел B — Claude Desktop, вкладка Code, шаги 1–6

Нужен режим `marketplace`: Desktop запускает свой встроенный движок без флагов, плагин он берёт из пользовательского scope. После `prepare` перезапустите Claude Desktop (Cmd+Q и снова открыть): запущенные сессии загруженный набор плагинов не меняют.

Новая сессия: Code → Local, папка `/tmp/aang-d7/probe-repo` (в окне выбора Cmd+Shift+G и путь), режим разрешений Ask.

1. Промпт: «Run `echo hi` with Bash, then ask me one question with AskUserQuestion, then reply OK». Ожидаются:
   - SessionStart, UserPromptSubmit, PreToolUse(Bash), PostToolUse, PreToolUse(AskUserQuestion), Stop;
   - в окружении hook `CLAUDE_CODE_ENTRYPOINT=claude-desktop` и `CLAUDE_CODE_HOST_SESSION_ID=local_<uuid>` — имя метафайла.

   `echo` Claude Code одобряет сам, поэтому этот шаг проверяет только обычные события.
   - 1a. **Детерминированный запрос разрешения.** Промпт: «Run `touch aang-perm-allow.txt` with Bash». Подождите больше 6 с и разрешите. Ожидаются PermissionRequest, Notification(`permission_prompt`) и PostToolUse с тем же `tool_use_id`, что у PreToolUse. В Desktop, по документации, уведомление приходит через 6 с независимо от ввода. Повторите с «Run `touch aang-perm-deny.txt` with Bash» и откажите: PermissionRequest есть, PostToolUse нет, отказ виден в PostToolBatch.
2. `/compact`. Ожидаются PreCompact и `compact_boundary` в транскрипте.
3. Промпт: «Use the Agent tool to start a subagent that lists the files in this directory». Ожидаются SubagentStart и SubagentStop, а также файлы `subagents/agent-*.jsonl`.
   - 3a. Если в Desktop доступны spawn task или Dispatch, породите ими отдельную сессию. Ожидается, что связь с родителем есть только в `spawnSeed` и `lastSpawnRootDetected` метафайла. Формат этих полей — главный вопрос шага: от него зависит решение 4 ADR-0004.
4. Закройте Desktop (Cmd+Q), откройте снова и продолжите сессию шага 1 промптом «reply OK». Проверьте `SessionStart.source` и то, остался ли тот же `cliSessionId`, то есть тот же транскрипт.
5. Новая сессия в режиме worktree для того же репозитория, промпт «Run `pwd` with Bash». Ожидается `cwd` внутри `/tmp/aang-d7/probe-repo/.claude/worktrees/…`; каталог проекта в `~/.claude/projects` виден в сводке.
6. Сначала выполните `collect` (раздел 6) и сохраните копию сводки, потому что метафайл после удаления сессии исчезает:

   ```sh
   cp /tmp/aang-d7/results/summary.md /tmp/aang-d7/results/summary-before-step6.md
   cp /tmp/aang-d7/results/files.json /tmp/aang-d7/results/files-before-step6.json
   ```

   Затем заархивируйте сессию шага 1 и удалите её. Снова выполните `collect`. Проверьте маркер `deleted_<uuid>` (раздел «Маркеры удаления» сводки) и то, остался ли транскрипт (таблица «Транскрипты Claude»).

## 5. Раздел C — Codex в ChatGPT Desktop, шаги 7–10

Нужен `prepare --codex-hooks`. Сами не запускайте `codex app-server`: до отчёта D.6 это запрещено.

7. Откройте ChatGPT (Codex) и подтвердите доверие к hooks aang. Если приложение не предлагает этого само, используйте `/hooks` в терминальном Codex (`codex` в любом каталоге, без промпта): доверие хранится в общем `~/.codex/config.toml`. Проверьте `trustStatus` в ответах `hooks/list` в логах `~/Library/Logs/com.openai.codex/<ГГГГ>/<ММ>/<ДД>/codex-desktop-*.log`. Новые hooks без доверия Codex молча не выполняет, поэтому отсутствие событий Codex в сводке значит, что доверия нет.
8. Новый чат Local в `/tmp/aang-d7/probe-repo` с одобрением on-request. Промпт: «Run `echo hi`, then reply OK». Безопасная команда в песочнице может пройти без запроса, поэтому шаг проверяет только SessionStart, UserPromptSubmit, PreToolUse, PostToolUse и Stop. `originator` и `source` нового rollout видны в сводке.
   - 8a. **Детерминированный запрос одобрения.** Выполните `collect` и проверьте в разделе Codex сводки, что `~/aang-desktop-probe-outside` не входит в корни записи. Промпт: «Run `touch ~/aang-desktop-probe-outside/allow.txt` and request escalated permissions for it (`sandbox_permissions: require_escalated`)». Одобрите. Ожидаются PermissionRequest и PostToolUse, файл создан (`ls ~/aang-desktop-probe-outside`). Повторите с `deny.txt` и откажите: PermissionRequest есть, PostToolUse и файла нет. Если OTel-экспорт включён, сверьте `codex.tool_decision` по `call_id` с `tool_use_id` у PreToolUse. Если запрос одобрения не появился, шаг не пройден; это не подтверждение исправных hooks.
9. Повторите шаг 8 в чате Worktree: `cwd` должен лежать в `~/.codex/worktrees/…`. Затем попросите породить субагента: «Spawn a subagent that runs `echo sub` and reports back». Ожидаются SubagentStart, SubagentStop и rollout субагента с `parent_thread_id`: сводка показывает его строкой «Субагент» в разделе сессии и сверяет `parent_thread_id` с `session_id` родителя. Закройте и снова откройте приложение, продолжите чат. Ожидается `SessionStart.source=resume`.
10. Чат Cloud, если доступен, промпт «reply OK». Ожидается, что нет ни нового rollout, ни событий в spool. Запишите время чата: в сводке не должно быть сессии Codex с этим временем.

## 6. Сбор результатов

Сбор, перенос результатов и откат (раздел 8) выполняются из корня репозитория aang, а не из `probe-repo`, куда терминал переходил для сессий TUI:

```sh
cd ~/src/aang
node tools/owner-checklist/dist/main.js collect --dir /tmp/aang-d7
```

Команда только читает: spool `new/`, транскрипты Claude (`$CLAUDE_CONFIG_DIR` или `~/.claude`), rollout Codex (`$CODEX_HOME` или `~/.codex`) и метафайлы Claude Desktop (`~/Library/Application Support/Claude/claude-code-sessions`). Пишет она только в `/tmp/aang-d7/results/`. Её можно повторять.

| Файл | Содержимое |
| --- | --- |
| `events.jsonl` | событие на строку: время приёма (mtime файла spool), рантайм, тег, окружение из заголовка spool, `hook_event_name`, `session_id` и только безопасные поля. Например, `tool_name`, `tool_use_id`, `notification_type`, `source`, `reason`, `cwd`, число вопросов AskUserQuestion, наличие `answers`, длина `plan`, наличие `planFilePath`, состав PostToolBatch без текста ответа |
| `summary.md` | сессии по времени и пункты чек-листа. Задержки уведомлений, цепочки AskUserQuestion и ExitPlanMode, `SessionEnd.reason`, окружение hook, типы Notification, разделы Desktop и Codex. Пункты, которые проверяет только глаз владельца, помечены «заполняет владелец» |
| `files.json` | транскрипты Claude (`entrypoint`, версии, `compact_boundary`, файлы `subagents/`), rollout Codex и его субагентов (`originator`, `source`, `parent_thread_id`, `approval_policy`, `sandbox_policy`) и метафайлы Desktop |
| `env-probe.jsonl` | записи зонда окружения (пункт f) |

Промпты, ответы модели, вывод инструментов и содержимое файлов не сохраняются. Пути обезличены: рабочий каталог заменён на `<dir>`, домашний каталог — на `~`. Из метафайлов Desktop по решению 4 ADR-0004 берутся значения только `cliSessionId`, `spawnSeed` и `lastSpawnRootDetected`; у остальных ключей выводится только тип. Строки в `spawnSeed` и `lastSpawnRootDetected`, кроме идентификаторов UUID и `local_<uuid>`, заменены длиной. Метафайлы берутся только для сессий из spool, по `cliSessionId` или `CLAUDE_CODE_HOST_SESSION_ID`.

Сессии с `cwd` вне рабочего каталога и `~/.codex/worktrees` отбрасываются; их число указано в сводке. `--all-sessions` включает все сессии из spool; для `docs/research/` это не нужно.

Перед переносом просмотрите файлы. Затем:

```sh
cd ~/src/aang
mkdir -p docs/research/samples/owner-checklist/macos
cp /tmp/aang-d7/results/* docs/research/samples/owner-checklist/macos/
```

## 7. Отчёт

Итог оформляется в `docs/research/d7-owner-checklist-results.md`, по образцу `docs/research/windows-runtimes.md`:

- версии `claude`, Claude Desktop и его встроенного движка (поле «Версии» таблицы транскриптов), ChatGPT и Codex (`cli_version` rollout);
- по каждому пункту A, B и C — ожидание, наблюдение по сводке и заметки владельца из раздела «Заполняет владелец»;
- формат `spawnSeed` и `lastSpawnRootDetected`. Подтверждение формата снимает условие решения 4 ADR-0004, расхождение вносится в ADR-0004;
- ограничения Desktop, которые выносятся владельцу до этапа 2 (RFC §4).

## 8. Откат

```sh
cd ~/src/aang
node tools/owner-checklist/dist/main.js cleanup --dir /tmp/aang-d7
```

С `--keep-results` каталог `results/` остаётся, остальное удаляется. По `state.json` команда:

- удаляет плагин и маркетплейс aang из пользовательского scope Claude, если их ставила подготовка;
- удаляет записи aang из `~/.codex/hooks.json`, как описано в разделе 1;
- удаляет `~/aang-desktop-probe-outside` и рабочий каталог вместе со spool и пробным репозиторием.

Затем она печатает:

- что не откатывается автоматически: резервную копию `hooks.json`, доверие в `config.toml`, запись проекта в `~/.claude.json`;
- созданные сессии: транскрипты Claude проекта `probe-repo` и его worktree, метафайлы Desktop, rollout Codex и его субагентов, worktree Codex из spool.

Сессии удаляет владелец, как в спайке.
