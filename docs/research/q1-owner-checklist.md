# Чек-лист владельца Q.1: macOS, SSH-режим Desktop и OAuth на Linux

Статус: инструкция по пункту Q.1 плана (`docs/plan/mvp.md`). Выполняет владелец. Это не отчёт: итог кладётся в `docs/research/q1-owner-checklist-results.md` (раздел 7).
Дата: 2026-10-07. Инструкция для Windows — `docs/research/q1-owner-checklist-windows.md`. Автоматическая часть Q.1 и её результаты — `docs/research/q1-surface-matrix.md`.

## 0. Что проверяется и зачем

По ADR-0010 строка матрицы поддержки получает `full` или `limited` только после ручного чек-листа владельца: для Desktop — раздел 11 спайка на каждой ОС, где Desktop проверяется; для интерактивного TUI Claude — пункты (a)–(h) раздела 6. Записи движков Desktop в эмуляции ручную проверку не заменяют. Q.1 повторяет D.7 на выпускаемых версиях и добавляет то, чего автоматически не проверить:

| Часть | Что | Строки матрицы |
| --- | --- | --- |
| 1 | D.7 на текущих версиях: TUI Claude (a)–(h), Claude Desktop шаги 1–6, Codex в ChatGPT Desktop шаги 7–10 | `claude_cli`, `claude_desktop`, `codex_desktop` на macOS, `local` |
| 2 | Сквозная проверка с самим aang: Desktop и TUI видны в UI в обоих пользовательских сценариях | те же |
| 3 | SSH-режим обоих Desktop: aang на удалённом Linux-хосте | `claude_desktop`, `codex_desktop` на Linux, `desktop_ssh` |
| 4 | Путь OAuth на Linux: вход CLI в контейнере и наблюдатель aang с этой авторизацией | наблюдатель на Linux (`docker`, `vm`) |

Desktop на Windows в MVP не проверяется (ADR-0013, решение 3). Ограничения Desktop, найденные здесь, выносятся владельцу (RFC §4); известные на сейчас собраны в `docs/research/q1-surface-matrix.md`, раздел 5.

Автоматическая часть Q.1 уже прошла на CI без владельца (нативные Linux, macOS и Windows, Docker, VM, эмуляция SSH-режима), поэтому здесь только то, что требует GUI, интерактивного терминала, учётной записи или удалённой машины владельца.

## 1. Подготовка

Запишите версии до начала и после конца (Desktop обновляет движки сам):

- `claude --version` и `codex --version`;
- «О программе» Claude Desktop и ChatGPT;
- версия встроенного движка Claude Desktop — поле «Версии» таблицы транскриптов сводки D.7 или `version` строк транскрипта сессии Desktop;
- `cli_version` из `session_meta` rollout сессии Codex Desktop.

Это выпускаемые версии: строки матрицы заводятся именно для них. Если версия отличается от записанной в `support/matrix.json` (Claude 2.1.289, движок Desktop 2.1.286, Codex 0.160.0, движок Codex Desktop 0.159.2), отметьте это в отчёте: для новой версии нужны эталонные записи (ADR-0010, решение 1).

Сборка из репозитория:

```sh
cd ~/src/aang
git switch master && git pull
pnpm install --frozen-lockfile
pnpm build
alias aang="node $HOME/src/aang/packages/aang/dist/main.js"
```

До конца проверки не пересобирайте и не переключайте ветку: зонды D.7 и hooks aang ссылаются на файлы сборки.

## 2. Часть 1 — D.7 на выпускаемых версиях

Выполните `docs/research/d7-owner-checklist.md` целиком: подготовку (раздел 2), разделы A, B и C, сбор (раздел 6) и откат (раздел 8). Рабочий каталог — `/tmp/aang-q1-d7`, чтобы не смешать результаты с D.7:

```sh
node tools/owner-checklist/dist/main.js prepare --dir /tmp/aang-q1-d7 --codex-hooks
```

Отличия от D.7:

- результаты переносятся в `docs/research/samples/owner-checklist/q1-macos/`;
- в отчёт Q.1 (раздел 7) для каждого пункта добавьте сравнение с ожиданием D.7 и с прошлым прогоном D.7, если он был;
- выполните откат части 1 до начала части 2: плагин D.7 и плагин aang в пользовательском scope дали бы двойную регистрацию.

## 3. Часть 2 — сквозная проверка с aang на macOS

Здесь aang ставится продуктовым путём в пользовательский профиль: это то, что сделает пользователь.

### 3.1. Что меняется

| Что | Как откатывается |
| --- | --- |
| Маркетплейс `aang` и плагин `aang@aang` в пользовательском scope Claude | `aang uninstall` |
| Записи aang в конце массивов `~/.codex/hooks.json`, резервная копия рядом | `aang uninstall` нейтрализует записи на месте (`true`); резервную копию `hooks.json.aang-backup-*` удаляет владелец |
| Доверие к записям aang в `~/.codex/config.toml` | вручную, как в D.7 |
| Каталог `AANG_HOME` — `/tmp/aang-q1/aang`, а не `~/.aang` | удалить каталог |
| Сессии в `~/.claude/projects`, метафайлы Desktop, rollout в `~/.codex/sessions` | удаляет владелец |

Пока плагин и hooks установлены, aang получает события всех сессий Claude и Codex, но в охват попадает только пробный репозиторий (`aang watch`). Не работайте в других проектах до отката.

### 3.2. Установка и запуск

В отдельном терминале:

```sh
export AANG_HOME=/tmp/aang-q1/aang
mkdir -p /tmp/aang-q1/probe-repo && git -C /tmp/aang-q1/probe-repo init -q
git -C /tmp/aang-q1/probe-repo commit -q --allow-empty -m init
aang install
aang start
aang watch /tmp/aang-q1/probe-repo
aang open
```

- Откройте ссылку `aang open` в браузере.
- Доверьте записи aang в Codex: `/hooks` в терминальном `codex` или в ChatGPT. `aang status` должен показать hooks Claude и Codex как активные.
- Перезапустите Claude Desktop и ChatGPT (Cmd+Q и снова открыть): запущенные приложения набор плагинов и hooks не перечитывают.
- Наблюдатель aang вызывает ваш авторизованный CLI (ADR-0007): построение карты тратит токены подписки. Полоса состояния UI показывает версию CLI наблюдателя и исход его допуска; запишите их.

### 3.3. Сценарии

Для каждой поверхности: Claude Desktop Code в режимах Local и worktree, Codex в ChatGPT в режимах Local и Worktree, интерактивный TUI Claude (`claude` в Terminal.app). Все сессии — в `/tmp/aang-q1/probe-repo`, режим разрешений по умолчанию (Ask, on-request).

1. **Во время работы (E2E 1).** Промпт: «Create notes.txt containing one line about this repository, then use a subagent to list the files, then ask me one question with your question tool and wait for the answer». У Codex: «… then spawn a subagent that runs `ls` and ask me one question». Когда появится запрос разрешения на создание файла, подождите 10 с и посмотрите UI:
   - прогон этой сессии появился сам, без перезагрузки страницы, с подписью поверхности и версии;
   - открытый запрос разрешения виден в зоне внимания и закрывается после ответа;
   - действие и субагент видны в карте или в списке действий; у субагента своё место в карте (если наблюдатель работает);
   - вопрос модели виден в зоне внимания, пока вы не ответили.
2. **Переподключение.** Пока модель ждёт ответа на вопрос, выполните `aang stop`, затем `aang start`. Ответьте на вопрос. В UI нет дублей действий и вопросов, вопрос закрыт.
3. **После итерации (E2E 4).** Нажмите в UI «Отметить просмотренным». Продолжите сессию: у Claude Desktop и Codex закройте и снова откройте приложение и продолжите тот же чат (resume), у TUI — `claude --resume`. Промпт: «Append a second line to notes.txt». Затем во вкладке «С последнего просмотра»:
   - новая версия `notes.txt` и новое действие есть среди изменений;
   - карточки ведут к исходной записи (транскрипт или rollout).
4. **Сжатие.** `/compact` в Claude Desktop и TUI. В UI сессия продолжается без пробела; запишите, что видно о сжатии.

Запишите по каждой поверхности: прошёл ли каждый пункт, подпись поверхности в UI (например, Codex Desktop подписан «предположительно» — адаптер различает его только по `originator`), режим поддержки сессии (hooks и файлы), статус версии в полосе состояния, скриншоты.

### 3.4. Откат части 2

```sh
aang uninstall
aang stop
rm -rf /tmp/aang-q1
```

Затем вручную: доверие aang в `~/.codex/config.toml`, резервная копия `hooks.json.aang-backup-*`, сессии пробного репозитория и его worktree.

## 4. Часть 3 — SSH-режим Desktop

Нужен свой Linux-хост с доступом по SSH-ключу с этого Mac: своя VM или машина в сети. aang работает на том же хосте, что и движок Desktop (ADR-0004), UI открывается через SSH-туннель (ADR-0003).

Автоматическая часть Q.1 проверила это без Desktop: на VM под QEMU движки, запущенные через SSH с флагами и окружением Desktop, видны демону на VM, а UI работает через туннель с тем же портом (`docs/research/q1-surface-matrix.md`, раздел 3). Не проверено то, что делает сам Desktop: какой движок и какой версии он ставит на хост, с какими флагами, окружением и источниками настроек его запускает, загружается ли пользовательский плагин aang.

### 4.1. Удалённый хост

На хосте: Node.js 26, git, pnpm, Go (для сборки `aang-hook`) и, если Desktop этого требует, `codex`. Затем:

```sh
git clone https://github.com/realkarych/aang.git ~/aang && cd ~/aang
pnpm install --frozen-lockfile && pnpm build
alias aang="node $HOME/aang/packages/aang/dist/main.js"
mkdir -p ~/.aang && printf '{"placement":"desktop_ssh"}\n' > ~/.aang/config.json
mkdir -p ~/aang-q1-ssh && git -C ~/aang-q1-ssh init -q && git -C ~/aang-q1-ssh commit -q --allow-empty -m init
```

`placement` задаётся в конфиге: изнутри SSH-режим не отличить от локального запуска (`packages/daemon/README.md`). Без него сессии попадут в строку `local`.

Если Claude Code на хосте ещё не запускался, `aang install` не найдёт `claude`: тогда сначала подключите хост в Claude Desktop (раздел 4.2, шаг 1) и только потом ставьте aang.

```sh
aang install
aang start
aang watch ~/aang-q1-ssh
```

На Mac: `ssh -N -L 4280:127.0.0.1:4280 <пользователь>@<хост>`, на хосте `aang open`, ссылку откройте на Mac. Порт туннеля должен совпадать с портом демона: с другим локальным портом UI читает, но отметки, правила вида и чат отвечают 403 (ADR-0003, решение 1; раздел 4 отчёта Q.1).

### 4.2. Claude Desktop

1. Code → окружение SSH → ваш хост → папка `~/aang-q1-ssh`. Запишите, что Desktop поставил на хост: `ls -la ~/.claude` и каталоги, появившиеся в домашнем каталоге, путь и версию запущенного движка (`ps -eo pid,args | grep -i claude` на хосте во время сессии) и его окружение (`tr '\0' '\n' < /proc/<pid>/environ | grep -E 'CLAUDE|ANTHROPIC|PATH'`; значения токенов в отчёт не переносите).
2. Сценарии 1–4 из раздела 3.3. В UI aang на хосте сессия должна появиться с подписью Claude Desktop и строкой версии `desktop_ssh`. Если подпись другая (например, CLI или SDK) или hooks не приходят (режим «только файлы»), запишите это: от этого зависит, поддерживается ли SSH-режим тем же адаптером (`docs/research/integrations.md`, «Рекомендуемый способ сбора»).
3. Если плагин aang не загружается, проверьте источники настроек движка в его командной строке (`--setting-sources`) и запишите их.

### 4.3. Codex Desktop

1. В ChatGPT добавьте удалённое подключение к хосту и откройте `~/aang-q1-ssh`. Запишите, какой `codex app-server` запущен на хосте (путь, версия, `CODEX_INTERNAL_ORIGINATOR_OVERRIDE` в окружении процесса) и какой `CODEX_HOME` он использует.
2. Доверьте записи aang в Codex на хосте (`/hooks` в терминальном `codex` на хосте). `aang status` на хосте — hooks Codex активны.
3. Сценарии 1–3 из раздела 3.3. Ожидается подпись Codex Desktop и строка `desktop_ssh`.

### 4.4. Откат

На хосте `aang uninstall`, `aang stop`, `rm -rf ~/aang-q1-ssh ~/.aang`, доверие в `~/.codex/config.toml` хоста; на Mac — удалить подключения в Desktop, если они не нужны.

## 5. Часть 4 — путь OAuth на Linux

Автоматическая часть установила (`docs/research/q1-surface-matrix.md`, раздел 4):

- `claude auth login` в контейнере без браузера печатает ссылку с `redirect_uri=https://platform.claude.com/oauth/code/callback` и ждёт код: «Paste code here if prompted». Порт публиковать не нужно;
- `codex login` по умолчанию поднимает сервер входа на `localhost:1455` внутри контейнера, и браузер хоста до него не дойдёт: Codex сам предлагает `codex login --device-auth`. На VM без контейнера подходит и туннель `ssh -L 1455:127.0.0.1:1455`;
- до входа `claude auth status` — `loggedIn: false`, `codex login status` — `Not logged in`; наблюдатель aang в таком контейнере допуск не проходит, демон работает без карты.

Остальное требует вашей учётной записи. Используйте образ решателя из README (раздел «Docker») с настоящими CLI:

```sh
docker build --tag aang .
docker build --tag aang-solver - <<'EOF'
FROM aang
USER root
RUN npm install --global --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code @openai/codex
USER node
EOF
docker run --detach --name aang-q1-oauth --publish 127.0.0.1:4280:4280 aang-solver sleep infinity
docker exec --interactive --tty aang-q1-oauth claude auth login
docker exec --interactive --tty aang-q1-oauth codex login --device-auth
```

1. Откройте ссылки на Mac, войдите, вставьте код Claude в терминал. Запишите, сколько шагов понадобилось и были ли ошибки.
2. Где лежит авторизация и с какими правами: `docker exec aang-q1-oauth sh -c 'ls -la ~/.claude ~/.codex'`. Ожидается `~/.claude/.credentials.json` и `~/.codex/auth.json` с правами 0600; содержимое не копируйте и в отчёт не переносите.
3. `docker exec aang-q1-oauth sh -c 'claude auth status --text; codex login status'`.
4. `docker exec aang-q1-oauth aang start --bind 0.0.0.0`, затем `docker exec aang-q1-oauth aang status`: допуск наблюдателя Claude и Codex должен пройти (`admitted`). Допуск делает один синтетический вызов на CLI.
5. Если допуск прошёл, сессия решателя в контейнере видна в UI с картой: `docker exec aang-q1-oauth git -C /home/node init -q work`, `docker exec aang-q1-oauth aang watch /home/node/work`, `docker exec --workdir /home/node/work aang-q1-oauth claude -p "Create a.txt with hi"`, ссылка `docker exec aang-q1-oauth aang open` в браузере.
6. Откат: `docker exec aang-q1-oauth sh -c 'claude auth logout; codex logout'`, затем `docker rm --force aang-q1-oauth`.

## 6. Что не делать

- Не копируйте файлы авторизации из контейнера, с хоста или из `~/.claude` в репозиторий и в другие профили.
- Не переносите в отчёт промпты с личными данными, токены, адреса почты, идентификаторы аккаунта и организации. Сводки `tools/owner-checklist` уже обезличены; скриншоты UI просмотрите перед добавлением.

## 7. Отчёт

`docs/research/q1-owner-checklist-results.md`, по образцу `docs/research/windows-runtimes.md`:

- версии из раздела 1 до и после;
- часть 1 — по пунктам (a)–(h), 1–6 и 7–10: ожидание, наблюдение, отличие от D.7;
- части 2 и 3 — таблица «поверхность × пункт» с исходом и заметками; для SSH-режима — что ставит и запускает Desktop на хосте;
- часть 4 — шаги входа, расположение авторизации, исход допуска наблюдателя;
- ограничения Desktop для решения владельца (RFC §4).

Затем исполнитель вносит записи в `support/verification.json`, массив `owner_checklists` (`tools/support/README.md`): `checklist: "desktop"` для строк `claude_desktop` и `codex_desktop` macOS `local` и Linux `desktop_ssh` с версиями движков из отчёта, `checklist: "tui"` для `claude_cli` macOS `local`; `result` — `passed` или `failed`, `report` — путь отчёта. После этого `pnpm support:update` пересчитывает матрицу. Объявление `full` или `limited` по итогам — решение владельца (план, «Итог этапа»).
