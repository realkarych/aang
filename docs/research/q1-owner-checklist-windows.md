# Чек-лист владельца Q.1: Windows

Статус: инструкция по пункту Q.1 плана (`docs/plan/mvp.md`) для нативного Windows. Выполняет владелец. Итог входит в общий отчёт `docs/research/q1-owner-checklist-results.md` отдельным разделом.
Дата: 2026-10-07. Инструкция для macOS, SSH-режима Desktop и OAuth на Linux — `docs/research/q1-owner-checklist.md`.

## 0. Что проверяется

- Интерактивный TUI Claude: пункты (a)–(h) раздела 6 спайка на выпускаемой версии. Это D.7 повторно: строка `claude_cli` Windows `local` требует этого чек-листа (ADR-0010).
- Сквозная проверка с самим aang: сессии TUI Claude видны в UI в обоих пользовательских сценариях.
- Claude Desktop и Codex Desktop на Windows в MVP не проверяются (ADR-0013, решение 3). Интерактивный TUI Codex на Windows тоже не входит: эталонных записей TUI Codex для Windows нет (план, R.3), строка `codex_tui` Windows остаётся без записей.

CLI и SDK обоих рантаймов на Windows проверены без владельца на раннере `windows-latest` (`docs/research/q1-surface-matrix.md`, раздел 2). Здесь только интерактивный терминал и ваша учётная запись.

Все команды — PowerShell в нативной консоли (Windows Terminal или окно PowerShell). Прогон в WSL — это среда Linux (ADR-0013) и пункт не закрывает.

## 1. Подготовка

Нужны Node 26, pnpm, Go, Git for Windows и Claude Code. Запишите `claude --version` и способ установки (нативный установщик или npm). Если версия отличается от 2.1.289 из `support/matrix.json`, отметьте это: для новой версии нужны эталонные записи.

```powershell
Set-Location $HOME\src\aang
git switch master; git pull
pnpm install --frozen-lockfile
pnpm build
function aang { node "$HOME\src\aang\packages\aang\dist\main.js" @args }
```

Функцию `aang` объявите в каждом окне, где она нужна.

## 2. Часть 1 — D.7 на выпускаемой версии

Выполните `docs/research/d7-owner-checklist-windows.md` целиком (разделы 2–5) с рабочим каталогом `$env:TEMP\aang-q1-d7`:

```powershell
node tools\owner-checklist\dist\main.js prepare --dir "$env:TEMP\aang-q1-d7"
```

Результаты переносятся в `docs\research\samples\owner-checklist\q1-windows\`. Откат части 1 выполните до начала части 2.

## 3. Часть 2 — сквозная проверка с aang

### 3.1. Что меняется

| Что | Как откатывается |
| --- | --- |
| Маркетплейс `aang` и плагин `aang@aang` в пользовательском scope Claude | `aang uninstall` |
| Каталог `AANG_HOME` — `$env:TEMP\aang-q1\aang` | удалить каталог |
| Сессии в `%USERPROFILE%\.claude\projects` | удаляет владелец |

`aang install` без флагов на Windows ставит только плагин Claude; hooks Codex ставятся отдельно с `--codex` (README, раздел «Windows»), и здесь они не нужны. Пока плагин установлен, aang получает события всех сессий Claude, но в охват попадает только пробный репозиторий.

### 3.2. Установка и запуск

```powershell
$env:AANG_HOME = "$env:TEMP\aang-q1\aang"
$repo = "$env:TEMP\aang-q1\probe-repo"
New-Item -ItemType Directory -Force -Path $repo | Out-Null
git -C $repo init -q
git -C $repo commit -q --allow-empty -m init
aang install
aang start
aang watch $repo
aang open
```

Откройте ссылку в браузере. `aang status` должен показать hooks Claude как активные. Наблюдатель aang вызывает ваш авторизованный `claude` и тратит токены подписки; полоса состояния UI показывает исход его допуска — запишите его: хранение OAuth-авторизации на Windows проверяется здесь впервые (ADR-0013, решение 4).

### 3.3. Сценарии

В отдельном окне:

```powershell
Set-Location "$env:TEMP\aang-q1\probe-repo"
claude
```

1. **Во время работы (E2E 1).** Промпт: «Create notes.txt containing one line about this repository with your shell tool, then use a subagent to list the files, then ask me one question with AskUserQuestion». Когда появится запрос разрешения, подождите 10 с и посмотрите UI: прогон появился сам, запрос разрешения открыт в зоне внимания и закрывается после ответа, субагент и действия видны, вопрос виден до ответа.
2. **Переподключение.** Пока Claude ждёт ответа на вопрос, в окне подготовки `aang stop`, затем `aang start`. Ответьте. Дублей действий и вопросов нет, вопрос закрыт.
3. **После итерации (E2E 4).** «Отметить просмотренным» в UI. Выйдите из сессии (`/exit`) и продолжите её: `claude --resume`, та же сессия, промпт «Append a second line to notes.txt». Во вкладке «С последнего просмотра» есть новая версия `notes.txt` и новое действие, карточки ведут к транскрипту.
4. **Сжатие.** `/compact`. Сессия в UI продолжается без пробела.

Запишите по каждому пункту исход, подпись поверхности (`Claude Code CLI`), режим поддержки сессии, статус версии в полосе состояния, скриншоты.

### 3.4. Откат

```powershell
aang uninstall
aang stop
Remove-Item -Recurse -Force "$env:TEMP\aang-q1"
```

Сессии пробного репозитория в `%USERPROFILE%\.claude\projects` и запись проекта в `%USERPROFILE%\.claude.json` удаляет владелец.

## 4. Отчёт

Раздел Windows в `docs/research/q1-owner-checklist-results.md`:

- версия Windows, терминал, версия `claude` и способ установки, shell-инструмент Claude (`Bash` или `PowerShell`);
- часть 1 — пункты (a)–(h): ожидание, наблюдение, отличие от D.7;
- часть 2 — пункты 1–4 с исходом и заметками, исход допуска наблюдателя.

Исполнитель вносит запись `checklist: "tui"` для строки `claude_cli` Windows `local` в `support/verification.json` и пересчитывает матрицу (`docs/research/q1-owner-checklist.md`, раздел 7).
