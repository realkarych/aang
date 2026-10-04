# Docker-образ

`Dockerfile` в корне репозитория собирает образ `aang` на `node:26-slim` (ADR-0011, «Упаковка»). Это базовый слой для образа решателя: в производном образе пользователь ставит `claude` и/или `codex` и авторизует их внутри контейнера, а демон aang и решатель работают в одном контейнере. Образ собирается из исходников монорепозитория и от публикации в npm не зависит:

```sh
docker build --tag aang .
```

## Стадии

| Стадия | Что делает |
| --- | --- |
| `hook` | собирает `aang-hook` для платформы образа (`TARGETOS`, `TARGETARCH`) кросс-компиляцией на платформе сборки: `go build -trimpath -ldflags="-s -w"` с `CGO_ENABLED=0`, как бинари платформенных пакетов npm (P.1) |
| `build` | ставит pnpm версии из `packageManager`, выполняет `pnpm install --frozen-lockfile` и `tsc -b packages/aang`, затем `pnpm deploy --prod` пакета `aang` в `/opt/aang`: собранные внутренние пакеты, миграции `store`, статика `web` и `zod` |
| `aang` (итоговая) | `node:26-slim` с `/opt/aang`, командами `aang` и `aang-hook` в `/usr/local/bin` и `tini` |

В итоговом образе:

- пользователь `node`, рабочий каталог `/home/node`, `AANG_HOME` по умолчанию — `/home/node/.aang`;
- точка входа — `tini -s -- docker-entrypoint.sh`, команда по умолчанию — `node`, как у `node:26-slim`.

`tini` нужен потому, что `aang start` порождает демон отсоединённым процессом и тот переходит к PID 1 контейнера. Если PID 1 не забирает завершившиеся процессы (`sleep`, процесс Node и т. п.), остановленный демон остаётся зомби, и `aang stop` не может подтвердить остановку. `tini` забирает их при любой команде контейнера, поэтому `docker run --init` не нужен. С `--init` он работает как subreaper (`-s`) под init Docker и не выдаёт предупреждений.

## Образ решателя

Производный образ переключается на `root` для установки CLI и возвращается к `node`:

```dockerfile
FROM aang
USER root
RUN npm install --global --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code @openai/codex
USER node
```

Демон по умолчанию слушает `127.0.0.1` внутри контейнера. Доступ к UI — SSH-туннель или явный bind с тем же токеном (ADR-0003), например `aang start --bind 0.0.0.0` в контейнере, запущенном с `--publish 127.0.0.1:4280:4280`; ссылку входа выдаёт `aang open`.

## Проверка

`pnpm test:docker` (тег `docker`, задание `docker` в CI на Linux) после `pnpm build`:

1. собирает образ `aang`, стадию `build` и производный образ решателя `tools/docker-image/solver.Dockerfile`. Производный образ добавляет к `aang` поддельные CLI `claude` и `codex` из `testkit` в `/usr/local/bin`, проигрыватель и образцы сценариев;
2. проверяет образ `aang`: пользователь `node` с `--init` и без него, Node 26, `aang status` и запуск `aang-hook`;
3. в контейнере производного образа запускает `aang start --bind 0.0.0.0` и публикует порт API на loopback хоста. Поддельные CLI отвечают на `--version`. API без токена отвечает 401, ссылка `aang open` через опубликованный порт даёт cookie. Проигрыватель пишет образец `claude-subagent`, и `GET /api/runs` отдаёт его прогон: два агента, режим `files_only`. Затем `aang stop` останавливает демон;
4. в отдельном контейнере `aang-hook` образа пишет в spool событие `SessionStart`, и демон показывает прогон этой сессии в режиме `hooks_only`.

Внутри контейнера проигрыватель и установку поддельных CLI выполняет `dist/main.js` этого пакета (`install-clis`, `play`). Он не входит в образ `aang`. Покрытие `c8` пакет не собирает (`.c8rc.json`): его код работает только внутри контейнера.
