# aang

aang — демон с веб-интерфейсом рядом с агентным рантаймом. Он собирает события прогонов Claude Code и Codex и строит из них обновляемую карту смысловых этапов задачи: что выполняется, кем, что получилось, на каком основании и что требует внимания человека. Требования и границы MVP — в [RFC](rfc.md), архитектурные решения — в [`docs/adr/`](docs/adr/), план — в [`docs/plan/mvp.md`](docs/plan/mvp.md).

Ниже — установка, подключение рантаймов и удаление.

## Коротко

```sh
aang install
aang start
aang watch ~/src/my-project
aang open
```

1. `aang install` подключает hooks Claude Code и Codex. Записи aang в Codex нужно один раз доверить командой `/hooks` (раздел [«Codex»](#codex)).
2. `aang start` запускает демон.
3. `aang watch` добавляет проект в охват.
4. `aang open` печатает ссылку входа в UI.

## Требования

- macOS, Linux или Windows без WSL, архитектуры x64 и arm64 ([ADR-0013](docs/adr/0013-windows.md)).
- Node.js 26 или новее.
- Claude Code и/или Codex на том же хосте, что и aang. Демон читает файлы рантаймов и принимает их hooks локально.

## Установка пакета

Пакет aang ещё не опубликован в npm. Пакет `aang` в публичном registry — чужой, не ставьте его. До публикации пакеты собираются из исходников.

Для сборки нужны git, Node.js 26, pnpm версии из поля `packageManager` в [`package.json`](package.json) и Go версии из [`packages/hook/go.mod`](packages/hook/go.mod):

```sh
git clone https://github.com/realkarych/aang.git
cd aang
pnpm install --frozen-lockfile
pnpm build
pnpm package
```

`pnpm package` пишет в `dist/npm/` tarball публичного пакета `aang` и шести платформенных пакетов `aang-hook-<os>-<arch>`: `darwin`, `linux` и `win32` для `x64` и `arm64`. Выпускные tarball собирайте на macOS или Linux: Windows не хранит бит исполнения, и бинари для macOS и Linux, упакованные там, не запустятся.

Поставьте пакет `aang` вместе с платформенным пакетом своей машины. Суффикс платформы печатает `node -p "process.platform + '-' + process.arch"`. Например, на macOS arm64:

```sh
npm install --global dist/npm/aang-0.0.0.tgz dist/npm/aang-hook-darwin-arm64-0.0.0.tgz
```

Пакет даёт две команды:

- `aang` — CLI и демон;
- `aang-hook` — запускает обработчик hooks своей платформы. Это нативный бинарь на Go из пакета `aang-hook-<os>-<arch>`. Если пакета нет, `aang-hook` называет недостающий пакет и выходит с кодом 1, а `aang install` отказывает.

Данные aang лежат в `AANG_HOME`: по умолчанию `~/.aang`, на Windows `%USERPROFILE%\.aang`. На macOS и Linux у каталога права 0700, на Windows aang полагается на ACL профиля пользователя.

## Подключение рантаймов

```sh
aang install
```

Без флагов подключаются оба рантайма, на Windows — только Claude Code (раздел [«Windows»](#windows)). С `--claude` или `--codex` подключаются только выбранные. Рантаймы подключаются по отдельности: сбой одного не мешает другому, но команда завершается с кодом 1. Если на машине один рантайм, передайте его флаг.

Сначала `aang install` копирует бинарь `aang-hook` без изменений в `<AANG_HOME>/bin/`. Конфиги hooks вызывают эту копию по абсолютному пути и передают ей абсолютный путь spool. Поэтому окружение рантайма на работу hooks не влияет.

Hook пишет событие в spool и завершается с кодом 0 без вывода, даже при сбое. Он не обращается к сети и не ждёт демон. Пока демон не запущен, hooks ничего не пишут (раздел «Запуск»).

### Claude Code

- aang генерирует плагин в `<AANG_HOME>/claude-plugin/`. Он регистрирует hooks на все события, кроме `WorktreeCreate`, `WorktreeRemove`, `MessageDisplay` и `PreModelSwitch`, с `timeout: 2`. Команды заданы в exec form, без shell.
- Плагин ставится в пользовательский scope через локальный маркетплейс `aang`: `claude plugin marketplace add` и `claude plugin install aang@aang`.
- `aang install` печатает, включён ли плагин. Выключенный плагин включается командой `claude plugin enable aang@aang`.

Плагин загружают CLI, Desktop (Local и worktree) и Agent SDK с настройками по умолчанию (раздел [«Agent SDK и Codex SDK»](#agent-sdk-и-codex-sdk)). Команда — `cli.claude` из конфига aang или `claude` из `PATH`, профиль — `runtimes.claude.configDir`, `CLAUDE_CONFIG_DIR` или `~/.claude`.

### Codex

aang ставит hooks в профиль Codex: штатный `~/.codex` или профиль по другому пути, заданный через `runtimes.codex.home` или `CODEX_HOME`. С профилем по другому пути aang читает сессии и ставит hooks только в нём, поэтому Codex запускайте с тем же `CODEX_HOME`.

- aang дописывает свои записи в конец массивов всех 12 событий в `<codex>/hooks.json`. Trust Codex привязан к позиции записи, поэтому чужие записи и их позиции не меняются.
- Устаревшие записи aang прежних установок не удаляются, а нейтрализуются на месте: их команда заменяется на `true` (на Windows — `exit 0`).
- Перед изменением файла делается резервная копия `hooks.json.aang-backup-<время>-<суффикс>`, её путь печатается.
- `config.toml` и `hooks.state` aang не пишет: trust записям aang даёт пользователь.

После записи `aang install` печатает состояние записей aang. После первой установки они не доверены. Откройте Codex и доверьте их командой `/hooks`. До этого Codex их пропускает, и сессии Codex видны в режиме «только файлы».

До и после записи aang сверяет trust чужих записей собственным процессом `codex app-server`: `initialize`, затем `hooks/list`. Если trust чужой записи изменился, установка откатывается.

- Процесс работает в профиле Codex и завершается сразу после ответа.
- К общему демону Codex и к чужим тредам aang не подключается.
- При старте, ещё до ответа, `codex app-server` сам обращается к сервисам OpenAI от имени пользователя: remote control, список моделей, каталог плагинов. В `CODEX_HOME` он может оставить служебные файлы ([отчёт D.6](docs/research/d6-app-server-live.md)). Поэтому aang запускает его только по событию, а не по таймеру ([ADR-0004](docs/adr/0004-event-collection.md)).

Профиль Codex — `runtimes.codex.home` из конфига aang, `CODEX_HOME` или `~/.codex`, команда — `cli.codex` или `codex` из `PATH`.

### Windows

Решения по Windows и замеры — в [ADR-0013](docs/adr/0013-windows.md) и [проверке рантаймов на Windows](docs/research/windows-runtimes.md).

- **Claude Code** подключается так же, как на macOS и Linux. Claude запускает `aang-hook.exe` напрямую, без shell. Запуск hook на Windows — p95 18–24 мс против 1–4 мс на macOS и Linux: дорого само создание процесса Windows. Бюджет на Windows — p95 до 25 мс.
- **Codex.** Hooks Codex `aang install` без флагов на Windows не ставит. Codex запускает команду hook только через PowerShell, и каждое событие обходится в 0,25–0,4 с: сессия с 20 вызовами инструментов идёт 12–14 с вместо 1–2 с. Без hooks сессии Codex видны в режиме «только файлы»: содержимое, связи и usage есть, ожиданий одобрений нет. `aang install` и `aang status` об этом напоминают.
- `aang install --codex` ставит hooks Codex явно и предупреждает о замедлении. `aang status` повторяет предупреждение, пока записи стоят.
  - Команда записи — `& '<AANG_HOME>\bin\aang-hook.exe' 'codex' 'user' '<AANG_HOME>\spool'`. Оператор вызова `&` нужен PowerShell, одинарная кавычка в пути удваивается.
  - Trust чужих записей aang сверяет собственным `codex app-server`, как на macOS и Linux. На Windows он запускается через `aang-hook.exe launch`, который завершает всё дерево процессов CLI (Job Object).
  - Команду `codex` aang ищет как `codex.exe` в `PATH`. npm-установка Codex кладёт в `PATH` только шим `codex.cmd`, который без shell не запускается. Для неё укажите в конфиге `cli.codex` — абсолютный путь к настоящему `codex.exe` из пакета `@openai/codex-win32-x64` (`…\vendor\x86_64-pc-windows-msvc\bin\codex.exe`). Демон для `aang status` запускает npm-установку Codex сам: через `node` и скрипт пакета.
- `cli.claude` на Windows — путь к `claude.exe`. Без него `aang install` ищет `claude.exe` в `PATH`; нативный установщик Claude кладёт его в `%USERPROFILE%\.local\bin`, но в `PATH` этот каталог не добавляет.

### Повторная установка и обновление

`aang install` можно запускать повторно: результат тот же. После обновления пакета aang запустите его снова. Бинарь в `<AANG_HOME>/bin/` заменится на месте, а строки команд в плагине и `hooks.json` не изменятся, поэтому trust Codex сохранится.

Пути в конфигах hooks абсолютные. Если `AANG_HOME` изменился, запустите `aang install` заново и снова доверьте новые записи Codex через `/hooks`.

## Запуск

- `aang start` запускает демон в фоне и печатает его адрес, по умолчанию `http://127.0.0.1:4280`. С `--foreground` демон работает в текущем процессе.
- Демон создаёт аренду spool на 24 часа и продлевает её каждый час. Без действующей аренды hooks ничего не пишут. Если демон упал, события копятся в spool до конца аренды и принимаются после следующего `aang start`.
- `aang open` печатает одноразовую ссылку входа в UI. Ссылка ставит cookie, работает один раз и действует 5 минут. Для нового входа нужна новая ссылка. `aang token rotate` заменяет токен UI, после него нужно войти заново.
- `aang status` показывает `AANG_HOME`, состояние демона, число и объём файлов spool, срок аренды и маркер остановки.
- `aang stop` останавливает демон и сразу прекращает запись hooks. Маркер остановки действует, пока его не снимет следующий `aang start`.

Автозапуска через launchd, systemd или службы Windows в MVP нет.

### Охват: `watch`

aang собирает только сессии отслеживаемых проектов. Сессия отслеживается, если её первый рабочий каталог лежит внутри отслеживаемого каталога или в git worktree отслеживаемого репозитория. Продолжения и субагенты наследуют решение корневой сессии. Записи остальных сессий отбрасываются при приёме и не сохраняются.

- `aang watch <каталог>` добавляет каталог и перечитывает его сессии за `lookback`, по умолчанию 7 дней. Перечитываются и сессии, отброшенные раньше.
- `--lookback <дни>` задаёт срок перечитывания для этого вызова: `--lookback 30` или `--lookback 30d`.
- `aang watch --all` включает сбор всех сессий. Список отслеживаемых каталогов при этом сохраняется.
- `aang unwatch <каталог>` удаляет каталог из списка. Пока включён `watch --all`, сессии этого каталога по-прежнему собираются.
- `aang unwatch --all` выключает сбор всех сессий и возвращает охват к списку каталогов.
- Чтобы прекратить сбор полностью, выполните `aang unwatch --all` и `aang unwatch` для каждого каталога списка. `aang stop` тоже прекращает сбор, но после следующего `aang start` он возобновится по сохранённому охвату.

Записи сессий, вышедших из охвата, отбрасываются при приёме. Уже собранные данные остаются, удаляет прогоны `aang prune`. Команды обращаются к работающему демону. Список отслеживаемых каталогов хранится в базе aang и переживает перезапуск.

## Что видит aang

| Режим | Когда | Что видно |
| --- | --- | --- |
| Полный | hooks активны, файлы рантайма доступны | всё |
| Только файлы | hooks не активны: не установлены (на Windows так по умолчанию у Codex), плагин выключен, записи Codex не доверены | содержимое, связи и usage; ожидания одобрений не видны |
| Только hooks | рантайм не пишет транскрипт: Agent SDK с `persistSession: false`, `CLAUDE_CODE_SKIP_PROMPT_HISTORY` | живые события, ожидания, финальный текст; нет содержимого, usage и восстановления |

- UI показывает режим каждой сессии.
- Для профилей с интерактивными одобрениями режим «только файлы» — неполная поддержка. Это Claude CLI и Desktop, а также Codex TUI и Desktop с `on-request`. Для `codex exec` и SDK с `approval_policy=never` hooks только ускоряют сбор.
- Корпоративные политики Claude `allowManagedHooksOnly` и `disableAllHooks` отключают hooks aang. Сессии тогда видны в режиме «только файлы».

Поверхности:

- Claude Code — CLI, Desktop (Local и worktree) и Agent SDK;
- Codex — TUI, `exec`, Desktop и Codex SDK.

Desktop на Windows в MVP не проверяется. Cowork и облачные режимы (Claude Cloud, Codex Cloud, Work Cloud) aang не наблюдает. UI показывает их постоянным уведомлением «не наблюдаемо».

## Agent SDK и Codex SDK

### Claude Agent SDK

Без изменения кода aang видит приложения, которые:

- загружают пользовательские настройки: `settingSources` не задан (по умолчанию это `user`, `project` и `local`) или включает `'user'`;
- пишут транскрипт: `persistSession` не равен `false`.

В такие приложения плагин aang из пользовательского scope загружается так же, как в CLI.

Изолированное приложение без `'user'` в `settingSources` подключается одной строкой — плагином aang через `plugins`:

```ts
import { query } from '@anthropic-ai/claude-agent-sdk'

for await (const message of query({
  prompt: 'Run the checks',
  options: {
    settingSources: [],
    plugins: [{ type: 'local', path: '/Users/me/.aang/claude-plugin' }],
  },
})) {
  console.log(message)
}
```

В `path` укажите абсолютный путь `<AANG_HOME>/claude-plugin`, каталог создаёт `aang install --claude`. Приложению, которое уже загружает пользовательские настройки, `plugins` не нужен. Иначе каждое событие придёт от двух регистраций, а это ошибка конфигурации.

Ограничения:

- `persistSession: false`: транскрипта нет, и сессия видна только в режиме «только hooks»;
- resume из `sessionStore`: SDK отбрасывает `enabledPlugins` и работает во временном `CLAUDE_CONFIG_DIR`. Плагин из пользовательских настроек не загружается, а транскрипт пишется вне корней aang.

### Codex SDK

Codex SDK запускает `codex exec`. Rollout он пишет в `CODEX_HOME/sessions` всегда, а hooks берёт из `CODEX_HOME/hooks.json`. Приложение видно без изменения кода, если не переопределяет `CODEX_HOME`. Учтите, что `CodexOptions.env` заменяет окружение процесса целиком. Приложение, которое задаёт в нём другой `CODEX_HOME`, пишет сессии вне корней aang.

## OpenTelemetry Codex

Решение человека по одобрению в Codex видно только через OpenTelemetry. Без него UI показывает такое решение как «неизвестно». Подключение — по желанию, конфиг Codex aang не меняет.

```sh
aang otel-config
```

Команда берёт адрес у работающего демона и печатает в stdout секцию для `config.toml` Codex:

```toml
[otel]
exporter = { otlp-http = { endpoint = "http://127.0.0.1:4281/otel/<токен приёма>/v1/logs", protocol = "json" } }
```

Добавьте её в `<codex>/config.toml`. Если секция `[otel]` в файле уже есть, вторую не добавляйте:

- замените в ней только строку `exporter`, а прежнее значение сохраните, чтобы вернуть его при удалении aang;
- остальные параметры секции, например `trace_exporter` и `metrics_exporter`, не меняйте;
- экспортёр логов у Codex один: если он уже отправляет записи в ваш коллектор, выберите один из двух адресов.

Затем перезапустите демон TUI командой `codex app-server daemon restart` и перезапустите Codex Desktop.

- Приёмник слушает только loopback, порт `otel.port`, по умолчанию 4281. Он хранит только события `codex.tool_decision`, остальные записи отбрасываются до записи на диск.
- Токен приёма в адресе отделён от токена UI: `aang token rotate` его не меняет.
- `aang otel-config --rotate` выдаёт новый токен, и прежний адрес сразу перестаёт принимать записи. Замените строку `exporter` в `config.toml` и снова перезапустите Codex.

## Удалённый хост и SSH-туннель

aang работает на том же хосте, что и рантайм:

- на своей VM;
- в контейнере (раздел [«Docker»](#docker));
- на удалённом хосте в SSH-режиме Claude Desktop или Codex Desktop.

Там же выполняются `aang start`, `aang watch` и `aang install`. В контейнере `aang install` пока не работает (раздел «Docker»). На каждом хосте свой демон и свой UI, несколько хостов в один UI не сводятся.

Демон по умолчанию слушает только `127.0.0.1:4280`. Для доступа к UI с другой машины откройте SSH-туннель:

```sh
ssh -N -L 4280:127.0.0.1:4280 user@host
```

Затем выполните `aang open` на удалённом хосте и откройте ссылку `http://127.0.0.1:4280/auth/<код>` в локальном браузере. Если локальный порт туннеля другой, замените порт в ссылке.

Без туннеля можно задать явный адрес прослушивания: `aang start --bind <адрес>` в формате `<хост>`, `<хост>:<порт>` или `[<ipv6>]:<порт>`. Постоянный адрес задают `api.host` и `api.port` в конфиге. Токен обязателен и в этом режиме. Своего TLS в демоне нет, и ссылка входа и cookie передаются открытым текстом. Поэтому за пределами доверенной сети нужен SSH-туннель или внешний прокси с TLS. Для адресов `0.0.0.0` и `::` `aang open` печатает ссылку на loopback, и в ней нужно подставить адрес хоста.

## Docker

Образ `aang` — базовый слой для образа решателя. В производном образе ставятся `claude` и/или `codex`, а демон aang и решатель работают в одном контейнере. Отдельный контейнер aang с общими томами (sidecar) в MVP не поддерживается.

Базовый образ собирается из корня репозитория:

```sh
docker build --tag aang .
```

Состав образа:

- `node:26-slim` с командами `aang` и `aang-hook`, `git` и `tini`;
- пользователь `node`, `AANG_HOME` — `/home/node/.aang`;
- точка входа — `tini`. Он забирает завершившиеся процессы при любой команде контейнера, поэтому `aang stop` подтверждает остановку демона и `--init` не нужен.

Производный образ ставит CLI под `root` и возвращается к `node`:

```dockerfile
FROM aang
USER root
RUN npm install --global --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code @openai/codex
USER node
```

Соберите его и запустите контейнер с проектом и портом UI, опубликованным только на loopback хоста:

```sh
docker build --tag solver .
docker run --detach --name solver \
  --publish 127.0.0.1:4280:4280 \
  --mount type=bind,src="$HOME/src/my-project",dst=/home/node/work \
  --workdir /home/node/work \
  solver sleep infinity
```

В `src` укажите абсолютный путь проекта на хосте. Он монтируется в `/home/node/work`, этот каталог становится рабочим для `docker exec`, и решатель и aang работают с одним проектом.

Авторизуйте CLI внутри контейнера, например `docker exec --interactive --tty solver claude`. Путь OAuth через CLI на Linux ещё не проверен (план, Q.1). Затем запустите aang:

```sh
docker exec solver git config --global --add safe.directory /home/node/work
docker exec solver aang start --bind 0.0.0.0
docker exec solver aang watch /home/node/work
docker exec solver aang open
```

- `safe.directory` нужен, потому что владелец смонтированного каталога в контейнере обычно не пользователь `node`: Docker Desktop показывает его принадлежащим `root`. Без этой настройки git отвечает `detected dubious ownership` и не работает с репозиторием ни для решателя, ни для aang.
- `--bind 0.0.0.0` нужен, чтобы опубликованный порт доходил до демона. `--publish 127.0.0.1:4280:4280` открывает его только на loopback хоста.
- Ссылку из `aang open` откройте в браузере хоста. Если Docker работает на удалённой машине, добавьте SSH-туннель до неё.
- Docker на Windows запускает контейнеры Linux, поэтому внутри контейнера действуют правила Linux.

`aang install` в образе пока не работает. Установщик ищет бинарь `aang-hook` там, где его кладёт npm-пакет aang, а образ собран из исходников без npm-пакета: бинарь лежит только в `/usr/local/bin/aang-hook`, и установка завершается ошибкой `ENOENT`. Поэтому hooks в контейнере не подключаются, и сессии решателя видны в режиме «только файлы» (раздел [«Что видит aang»](#что-видит-aang)).

## Удаление

```sh
aang uninstall
aang stop
```

- `aang uninstall` удаляет плагин Claude и маркетплейс `aang` командами `claude plugin uninstall` и `claude plugin marketplace remove`, а также каталог `<AANG_HOME>/claude-plugin`.
- Записи aang в `hooks.json` Codex `aang uninstall` нейтрализует на месте (команда `true`, на Windows `exit 0`) и сохраняет резервную копию. Записи не удаляются, потому что trust Codex позиционный: если удалить запись aang вручную, записи после неё сдвинутся и потеряют trust.
- `<AANG_HOME>` при удалении остаётся. В нём лежат бинарь, база, spool и токены.

Чтобы удалить aang полностью:

1. Удалите пакеты: `npm uninstall --global aang aang-hook-<os>-<arch>`.
2. Удалите каталог `<AANG_HOME>`. Spool в нём хранит полные payload hooks, в том числе вывод инструментов с возможными секретами.
3. Если подключали OpenTelemetry, верните в секции `[otel]` `config.toml` Codex прежнее значение `exporter` или удалите строку, если его не было. Всю секцию удаляйте, только если её добавили для aang и других параметров в ней нет. Затем перезапустите Codex.
4. После проверки удалите резервные копии `hooks.json.aang-backup-*` из профиля Codex.

## Конфигурация

`<AANG_HOME>/config.json` можно не создавать. Все пути в нём должны быть абсолютными. Ключи, важные для установки:

| Ключ | По умолчанию | Назначение |
| --- | --- | --- |
| `cli.claude`, `cli.codex` | `claude` и `codex` из `PATH` | команды рантаймов |
| `runtimes.claude.configDir` | `CLAUDE_CONFIG_DIR` или `~/.claude` | профиль Claude |
| `runtimes.codex.home` | `CODEX_HOME` или `~/.codex` | профиль Codex |
| `api.host`, `api.port` | `127.0.0.1`, `4280` | адрес API и UI |
| `otel.port` | `4281` | порт приёмника OpenTelemetry на loopback |
| `watch.lookbackDays` | `7` | срок бэкфилла при первом старте и перечитывания по `aang watch` |

Переменная `AANG_HOME` переопределяет каталог aang. Схема конфига — [`packages/contract/src/config.ts`](packages/contract/src/config.ts).
