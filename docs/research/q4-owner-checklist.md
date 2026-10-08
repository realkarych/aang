# Чек-лист владельца по устойчивости (Q.4)

Статус: чек-лист к пункту Q.4 плана (`docs/plan/mvp.md`). Автоматическую часть выполняет `tools/resilience`, отчёт — [`q4-live-resilience.md`](q4-live-resilience.md). Здесь собрано то, что инструмент проверить не может: Desktop, интерактивные TUI на macOS и Windows, `/hooks` в настоящем интерфейсе и настоящая модель. Автоматические сценарии на нативном Windows идут в CI.

## Общие условия

Штатные профили владельца — `~/.claude`, `~/.codex`, `~/.aang` и вход в Desktop — чек-лист не меняет. На машине параллельно идут рабочие сессии Claude и Codex. Hooks aang в штатном профиле писали бы в spool полные payload всех этих сессий, а запись перед aang в `~/.codex/hooks.json` сдвинула бы позиционные ключи доверия у записей после неё.

**TUI и CLI (разделы B и C) — в отдельном профиле.** Все команды `aang`, `claude` и `codex` из этих разделов выполняются в одном терминале, в котором профиль переназначен.

macOS и Linux:

```sh
export AANG_Q4="$(mktemp -d)/Имя Фамилия"
mkdir -p "$AANG_Q4/проект q4"
export HOME="$AANG_Q4" CLAUDE_CONFIG_DIR="$AANG_Q4/.claude" CODEX_HOME="$AANG_Q4/.codex" AANG_HOME="$AANG_Q4/.aang"
```

Windows, PowerShell:

```powershell
$env:AANG_Q4 = Join-Path ([IO.Path]::GetTempPath()) "aang-q4-$(Get-Random)\Имя Фамилия"
New-Item -ItemType Directory -Force (Join-Path $env:AANG_Q4 'проект q4') | Out-Null
$env:HOME = $env:AANG_Q4; $env:USERPROFILE = $env:AANG_Q4
$env:CLAUDE_CONFIG_DIR = "$env:AANG_Q4\.claude"; $env:CODEX_HOME = "$env:AANG_Q4\.codex"; $env:AANG_HOME = "$env:AANG_Q4\.aang"
```

Затем в том же терминале:

1. Вход в тестовом профиле: `claude`, затем `/login`; `codex login`. Штатные логины в этот профиль не копируются.
2. Если в штатном профиле уже работает aang, тестовому демону нужны другие порты: `{"api":{"port":4290},"otel":{"port":4291}}` в `config.json` тестового `AANG_HOME` — `$AANG_HOME/config.json`, в PowerShell `$env:AANG_HOME\config.json`.
3. aang из этой ветки или выпуска: `aang install`, `aang start`, `aang watch` для каталога `проект q4`. Сессии B и C запускаются из этого каталога.
4. После раздела: `aang stop`, закрыть сессии и удалить временный каталог профиля вместе с тестовыми логинами.

Шаг 3 в macOS и Linux:

```sh
aang install && aang start
aang watch "$AANG_Q4/проект q4"
cd "$AANG_Q4/проект q4"
```

Шаг 3 в PowerShell:

```powershell
aang install; aang start
aang watch (Join-Path $env:AANG_Q4 'проект q4')
Set-Location (Join-Path $env:AANG_Q4 'проект q4')
```

Шаг 4 в macOS и Linux:

```sh
aang stop
rm -rf "$(dirname "${AANG_Q4:?}")"
```

Шаг 4 в PowerShell:

```powershell
aang stop
Set-Location ([IO.Path]::GetTempPath())
Remove-Item -Recurse -Force (Split-Path $env:AANG_Q4)
```

**Desktop (раздел A) — в отдельной учётной записи macOS.** Claude Desktop и ChatGPT читают только штатный профиль пользователя, переназначить его нельзя. Поэтому раздел A выполняется в тестовой учётной записи macOS: в ней ставится aang (`aang install`, `aang start`), выполняется вход в Claude Desktop и ChatGPT, создаётся тестовый проект для `aang watch`. В основной учётной записи aang для раздела A не устанавливается.

Для всех разделов:

- Сессии короткие: одна-две команды вида `echo`, расход — несколько тысяч токенов.
- Запросы разрешений рантаймов владелец решает сам. Инструмент и агенты их не одобряют.
- После каждого пункта: `aang status` (spool, аренда, состояние hooks, пробелы) и страница прогона в UI.
- Результат записывается в таблицу в конце: «как ожидалось» или наблюдение со снимком экрана.

## A. Desktop на macOS (Claude Desktop и Codex Desktop)

| № | Шаги | Ожидается |
| --- | --- | --- |
| A1 | Попросить сессию выполнить `sleep 20 && echo done`. Пока команда идёт, найти pid демона в `aang status` и выполнить `kill -9 <pid>`. Дождаться конца хода, затем `aang start`. | Действия хода видны по одному разу, ход и сессия в актуальном состоянии, `aang status` показывает пустой spool. События, пришедшие при упавшем демоне, не потеряны. |
| A2 | Выполнить `aang stop` между двумя ходами, сделать ход, затем `aang start`. | Ход при остановленном aang виден по файлам. Ожидания этого хода не видны: это известное ограничение, hooks при остановке не пишут. Следующий ход снова виден с hooks. |
| A3 | Codex Desktop: архивировать тред в интерфейсе, затем разархивировать и продолжить. | Тред не помечается «источник потерян», действия не дублируются (ср. `sources/codex-archive-unarchive-delete`). |
| A4 | Codex Desktop: удалить тред в интерфейсе. | Сессия остаётся видимой с пометкой «источник потерян». |
| A5 | Claude Desktop, режим worktree: начать сессию в worktree отслеживаемого репозитория. | Сессия попадает в охват по общему git-каталогу и образует свой прогон. Совпадение каталога с другой сессией её ни с чем не связывает. |
| A6 | Claude Desktop: если в версии есть ответвление разговора, сделать его. | Новый прогон со связью «общее происхождение», родитель не назначен (ср. `lineage/claude-forks`). |
| A7 | Закрыть Desktop посреди команды и не открывать его. | Сессия переходит в «нет новых событий» (`quiet`) через 5 минут. Действие остаётся идущим: это находка Q4-5 отчёта. |

## B. Интерактивные TUI: macOS и Windows

| № | Шаги | Ожидается |
| --- | --- | --- |
| B1 | Codex TUI после `aang install --codex`: открыть `/hooks`. | Записи aang перечислены как недоверенные. `aang status` показывает Codex hooks `untrusted`. Сессия до доверия идёт в режиме «только файлы». |
| B2 | Подтвердить доверие записям aang в `/hooks`. | Без перезапуска демона `aang status` показывает `active`, новая сессия получает полный режим. Инструмент проверяет это записью `hooks.state`, здесь проверяется настоящий диалог. |
| B3 | Повторить `aang install --codex`. Затем вставить в `hooks.json` тестового профиля (`$CODEX_HOME/hooks.json`, в PowerShell `$env:CODEX_HOME\hooks.json`) собственную запись `PreToolUse` перед записью aang. | После повторной установки доверие сохраняется. После вставки `/hooks` показывает запись aang недоверенной, `aang status` — `untrusted`. |
| B4 | Claude TUI: `/clear` посреди сессии, затем `/resume` прежней сессии. | После `/clear` — новый прогон без связи. После `/resume` прежний прогон получает запуск `resume`. |
| B5 | Claude TUI и Codex TUI: закрыть окно терминала во время команды. | Как в A7. |
| B6 | Только Windows, PowerShell: A1 и A2 для Claude CLI и Codex CLI, в профиле с пробелом и кириллицей в пути. Демон в A1 снимается командой `Stop-Process -Id <pid> -Force` вместо `kill -9 <pid>`. | Как в A1 и A2. Spool и аренда работают через `aang stop` и `aang start`. Codex hooks на Windows подключаются по решениям владельца от 2026-10-06 (PR #150). |

## C. Настоящая модель (по желанию)

| № | Шаги | Ожидается |
| --- | --- | --- |
| C1 | Один ход Claude CLI с настоящей моделью в тестовом профиле (вход через `/login` этого профиля): команда `sleep 15`, во время неё `kill -9` демона, затем `aang start`. | То же, что `restart/claude-sigkill-mid-turn` на заглушке. Расход — один короткий ход. |

## Результаты

| № | macOS | Windows | Замечания |
| --- | --- | --- | --- |
| A1–A7 | | — | |
| B1–B5 | | | |
| B6 | — | | |
| C1 | | — | |
