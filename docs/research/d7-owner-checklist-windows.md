# Ранний ручной чек-лист владельца (D.7): Windows

Статус: инструкция по пункту D.7 плана (`docs/plan/mvp.md`) для нативного Windows. Выполняет владелец. Это не отчёт: итог кладётся в общий отчёт D.7 (раздел 6).
Дата: 2026-10-03. Инструмент — `tools/owner-checklist`. Инструкция для macOS — `docs/research/d7-owner-checklist.md`.

## 0. Что проверяется

- Только интерактивный TUI Claude: пункты (a)–(h) раздела 6 спайка (`docs/research/integrations.md`, «Только по документации»). D.8 проверила CLI на Windows без TUI (`docs/research/windows-runtimes.md`), интерактивный TUI там остался непроверенным.
- Claude Desktop и Codex Desktop на Windows в MVP не проверяются (ADR-0013, решение 3).
- Все команды — PowerShell. Вместо `/tmp` — `$env:TEMP`, файлы создаются через `New-Item`; Bash и `touch` не нужны.
- TUI запускается в нативной консоли Windows: Windows Terminal или окно PowerShell. Прогон в WSL — это среда Linux (ADR-0013), он пункт не закрывает.

Регистратор событий — настоящий `aang-hook.exe` в exec form, как у плагина aang (D.8: Claude запускает его напрямую, без shell). Он пишет во временный spool, в котором `prepare` создаёт действующую аренду; без неё hook ничего не пишет.

## 1. Что меняется в пользовательских настройках

На Windows продуктовая установка плагина закрыта (`installClaudePlugin` отказывает с `unsupported_platform`). Поэтому `prepare` работает в режиме `--claude plugin-dir`, и TUI подключает плагин флагом `--plugin-dir`.

| Что меняется | Когда | Как откатывается |
| --- | --- | --- |
| Пользовательские настройки Claude и Codex | не меняются | — |
| Запись проекта `probe-repo` в `%USERPROFILE%\.claude.json` | первый запуск TUI в пробном репозитории, диалог доверия | вручную |
| Транскрипты в `%USERPROFILE%\.claude\projects\` | во время проверок | `cleanup` печатает список, удаляет владелец |

`--claude marketplace` и `--codex-hooks` на Windows `prepare` отвергает до любых изменений.

## 2. Подготовка

Нужны Node 26, pnpm, Go (для сборки `aang-hook.exe`), Git for Windows и Claude Code. Запишите версию: `claude --version`. Проверьте, что в `permissions.allow` файла `%USERPROFILE%\.claude\settings.json` нет правила, разрешающего создание файлов командой оболочки: иначе в пункте (a) не будет запроса разрешения.

Из каталога репозитория aang:

```powershell
pnpm install
pnpm build
node tools\owner-checklist\dist\main.js prepare
```

Рабочий каталог по умолчанию — `$env:TEMP\aang-d7`; другой задаёт `--dir`. Каталог должен быть пустым или отсутствовать. Бинарь по умолчанию — `packages\hook\bin\aang-hook.exe` из сборки, другой задаёт `--hook`. Срок аренды по умолчанию 24 ч, другой задаёт `--hours`.

Что создаётся в `$env:TEMP\aang-d7`:

```
aang-home\bin\aang-hook.exe      копия бинаря без изменений
aang-home\spool\{new,tmp}        spool и аренда spool\lease-<срок в секундах Unix>
aang-home\claude-plugin\         плагин, сгенерированный продуктовым writeClaudePlugin (exec form)
probes\env-settings.json         зонд окружения на SessionStart, пишет results\env-probe.jsonl
probes\failure-settings.json     PreToolUse завершается с кодом 1; UserPromptSubmit висит дольше timeout: 2
probe-repo\                      git-репозиторий с начальным коммитом
results\                         результаты collect
state.json                       что сделала подготовка; по нему работает cleanup
```

`prepare` печатает памятку с точными командами. Зонды вызывают `node.exe` со скриптом `tools\owner-checklist\dist\probe.js`, поэтому до `cleanup` не пересобирайте и не переключайте ветку репозитория.

Если аренда истекла раньше конца проверок, новую на сутки создаёт:

```powershell
$expires = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() + 86400
New-Item -ItemType File -Path "$env:TEMP\aang-d7\aang-home\spool\lease-$expires"
```

Записывайте местное время каждого действия.

## 3. TUI Claude, пункты (a)–(h)

Для сессий откройте отдельное окно Windows Terminal или PowerShell. Окно подготовки оставьте в корне репозитория aang: в нём выполняются сбор и откат (разделы 4 и 5). Запустите сессию в пробном репозитории:

```powershell
Set-Location "$env:TEMP\aang-d7\probe-repo"
claude --plugin-dir "$env:TEMP\aang-d7\aang-home\claude-plugin" --settings "$env:TEMP\aang-d7\probes\env-settings.json"
```

На первом запуске примите диалог доверия к каталогу. `--settings` передаётся один раз, поэтому зонды окружения и сбоев подключаются в разных сессиях.

Claude на Windows выполняет команды своим shell-инструментом: Git Bash или PowerShell, в зависимости от установки. Промпты ниже просят создать файл командой `New-Item`; в сводке это видно как `tool_name` (`Bash` или `PowerShell`). Запишите, какой инструмент использовался.

По документации Claude Code уведомления `permission_prompt` и `idle_prompt` в терминале приходят, только когда пользователь «отошёл». Поэтому в (a) и (b) есть варианты с фокусом в окне терминала и вне его; записывайте, какой был.

**(a) Notification(`permission_prompt`) после PermissionRequest.**

- a1. Промпт: «Create the file aang-perm-allow.txt by running `New-Item -ItemType File -Path aang-perm-allow.txt` with your shell tool». Когда появится запрос разрешения, переключитесь в другое окно и не трогайте клавиатуру 15 с. Затем разрешите.
- a2. То же с `aang-perm-allow-2.txt`. Оставьте фокус в терминале, 15 с нажимайте стрелку вверх или вниз примерно раз в 3 с. Запишите время последнего нажатия, подождите ещё 10 с и разрешите.
- a3. То же с `aang-perm-deny.txt`. Откажите.

Ожидается:

- a1 — PreToolUse → PermissionRequest → Notification(`permission_prompt`) примерно через 6 с → PostToolUse с тем же `tool_use_id`;
- a2 — уведомление позже, примерно через 6 с после последнего нажатия, или его нет;
- a3 — PermissionRequest есть, PostToolUse нет, отказ виден в PostToolBatch.

**(b) Notification(`idle_prompt`).** После любого ответа (Stop) переключитесь в другое окно и ничего не вводите 90 с. Ожидается Notification(`idle_prompt`) примерно через 60 с после Stop. Повторите с фокусом в терминале.

**(c) AskUserQuestion.** Промпт: «Ask me two questions at once with the AskUserQuestion tool, two options each, then reply OK». Перед ответом подождите 10 с, затем ответьте на оба вопроса. Ожидаются PreToolUse(AskUserQuestion) с двумя вопросами и PostToolUse с `answers`. Проверяется, есть ли между ними PermissionRequest и Notification.

**(d) Ошибки hook и зависший hook.** Выйдите из сессии и запустите отдельную:

```powershell
claude --plugin-dir "$env:TEMP\aang-d7\aang-home\claude-plugin" --settings "$env:TEMP\aang-d7\probes\failure-settings.json"
```

Промпт: «Run `Get-Date` with your shell tool, then reply OK». Hook на UserPromptSubmit висит 30 с при `timeout: 2` и задаёт `statusMessage` «aang D.7: hook hangs longer than its 2 s timeout». Hook на PreToolUse завершается с кодом 1 и пишет в stderr «aang D.7: deliberate hook failure».

Запишите:

- что показывал спиннер и сколько длилось ожидание;
- было ли сообщение об отмене по таймауту;
- как выглядит ошибка `PreToolUse` и где она выводится; подробности открывает Ctrl+O;
- выполнилась ли команда.

Зонд сам завершается через 30 с. Проверьте в диспетчере задач, завершил ли Claude процесс `node.exe` зонда по таймауту или тот дожил до 30 с. Скриншоты приложите к отчёту.

**(e) SessionEnd.reason.** Завершайте сессии разными способами и записывайте, какую как:

- `/exit`;
- двойной Ctrl+C на пустой строке;
- двойной Ctrl+D;
- `/clear` внутри сессии: это SessionEnd и новый SessionStart с `source: clear`;
- закрытие вкладки Windows Terminal.

Документированные значения: `clear`, `resume`, `logout`, `prompt_input_exit`, `other`.

**(f) Окружение процесса hook.** Отдельных действий нет: каждая сессия, запущенная с `env-settings.json`, пишет в `results\env-probe.jsonl` значения `CLAUDE_CODE_SESSION_ATTENDED`, `CLAUDE_CODE_ENTRYPOINT` и соседних переменных.

**(g) `elicitation_dialog` и `agent_needs_input`.** Сводка перечисляет все встреченные `notification_type`. Если MCP-сервер с elicitation или режим agent view уже есть, вызовите их и запишите как; новые MCP-серверы не ставьте. Если вызвать не удалось, пункт отмечается непроверенным.

**(h) ExitPlanMode.** Отдельная сессия в режиме плана:

```powershell
claude --permission-mode plan --plugin-dir "$env:TEMP\aang-d7\aang-home\claude-plugin" --settings "$env:TEMP\aang-d7\probes\env-settings.json"
```

Промпт: «Plan how to create the file aang-plan.txt containing hi, then present the plan for approval». Одобрите план, затем разрешите создание файла. Ожидаются:

- PreToolUse(ExitPlanMode) с `tool_input.plan` (в сводке — длина) и `planFilePath`;
- запрос подтверждения плана как PermissionRequest или без него;
- PostToolUse(ExitPlanMode).

## 4. Сбор результатов

Сбор, перенос результатов и откат выполняются в окне подготовки, из корня репозитория aang. Если оно закрыто, сначала перейдите в корень репозитория в новом окне: из `probe-repo` относительные пути команд не работают.

```powershell
node tools\owner-checklist\dist\main.js collect --dir "$env:TEMP\aang-d7"
```

Команда только читает spool и транскрипты Claude (`$env:CLAUDE_CONFIG_DIR` или `%USERPROFILE%\.claude`), пишет только в `results\` и может повторяться. Состав файлов — как на macOS (`docs/research/d7-owner-checklist.md`, раздел 6). Разделы Desktop и Codex в сводке на Windows пустые.

Промпты, ответы, вывод инструментов и содержимое файлов не сохраняются. Пути обезличены: рабочий каталог заменён на `<dir>`, `%USERPROFILE%` — на `~`. Сессии с `cwd` вне рабочего каталога отбрасываются; их число указано в сводке.

Перед переносом просмотрите файлы. Затем:

```powershell
New-Item -ItemType Directory -Force -Path docs\research\samples\owner-checklist\windows
Copy-Item "$env:TEMP\aang-d7\results\*" docs\research\samples\owner-checklist\windows\
```

## 5. Откат

В окне подготовки, из корня репозитория aang:

```powershell
node tools\owner-checklist\dist\main.js cleanup --dir "$env:TEMP\aang-d7"
```

С `--keep-results` каталог `results\` остаётся. Команда удаляет рабочий каталог со spool и пробным репозиторием, затем печатает:

- что не откатывается автоматически: запись проекта в `%USERPROFILE%\.claude.json`;
- транскрипты Claude проекта `probe-repo`, которые владелец удаляет вручную.

## 6. Отчёт

Итог Windows входит в общий отчёт `docs/research/d7-owner-checklist-results.md` отдельным разделом:

- версия Windows, терминал (Windows Terminal или консоль PowerShell), версия `claude` и способ установки (нативный установщик или npm);
- shell-инструмент Claude (`Bash` или `PowerShell`);
- по каждому пункту (a)–(h) — ожидание, наблюдение по сводке и заметки владельца.

Расхождения с ADR-0013 вносятся в ADR-0013.
