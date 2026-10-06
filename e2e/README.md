# E2E (T.4)

E2E идут в Playwright поверх собранного демона (`packages/aang/dist/main.js`), проигрывателя и поддельных CLI (ADR-0012). Перед запуском нужна сборка: `pnpm build`, затем `pnpm e2e`.

```ts
import { endpoints } from '@aang/contract'
import { sampleScenarioManifest } from '@aang/testkit'
import { expect, test } from './fixtures.js'

test.use({ config: { watch: { all: true } } })

test('прогон из образца виден в API', async ({ player, page }) => {
  await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
  await expect
    .poll(async () => endpoints.runs.response.parse(await (await page.request.get('/api/runs')).json()).runs.length)
    .toBe(1)
})
```

## Фикстуры `e2e/fixtures.ts`

Все фикстуры — на один тест: у каждого теста свой временный HOME и свой демон.

| Фикстура | Что даёт |
| --- | --- |
| `profile` | временный HOME из `testkit` (`createProfile`): `.claude`, `.codex`, `.aang`, конфиг и окружение профиля |
| `fakeClaude`, `fakeCodex` | поддельные CLI из `testkit`, установленные в профиль; сценарий задаётся опциями или `setScenario`, входы — `calls()` |
| `daemon` | демон, запущенный из собранного `aang` в профиле; после теста останавливается через shutdown API и должен выйти с кодом 0 |
| `baseURL` | адрес демона: относительные пути встроенных `page`, `context` и `request` идут к нему |
| `context`, `page` | вошедший пользователь: одноразовая ссылка настоящего `aang open` открыта через `context.request`, cookie лежит в контексте браузера |
| `request` | встроенный анонимный `APIRequestContext`, для проверок 401 |
| `aang(...args)` | команда собранного `aang` в окружении профиля; возвращает stdout |
| `signInLink()` | новая неиспользованная одноразовая ссылка от `aang open` |
| `player(manifest, { timeScale, recordTime, otlp })` | проигрыватель `testkit` с корнями профиля и настоящим `aang-hook`, который пишет в spool профиля; `manifest` — путь или загруженный манифест; `recordTime: 'playback'` сдвигает время записей к моменту проигрывания, `{ startsAt }` — к заданному моменту |
| `otelEndpoint()` | адрес приёмника OTel запущенного демона с его токеном приёма — для `otlp` проигрывателя |
| `hook.claude(sample, fields)`, `hook.codex(sample, fields)` | вызов настоящего `aang-hook` с payload образца из `docs/research/samples/claude-code-hooks` или `codex-cli/hooks` (поле `stdin`), поля которого заменены на `fields` |

Сессии образцов и их файлы в профиле — в `e2e/samples.ts` (`hookFields` даёт `session_id`, `cwd` и `transcript_path` для hook-событий этих сессий), общие локаторы экрана — в `e2e/screens.ts`. Эталонные записи R.4 выбирает `e2e/recordings.ts`: запись ОС раннера, а если её нет — macOS; `through` и `after` режут запись по метке контрольного события, `filesOnly` оставляет в ней только файлы сессии, без hook-событий и OTLP, `threadsOf` перечисляет треды Codex в порядке их rollout.

| Опция (`test.use`) | По умолчанию | Смысл |
| --- | --- | --- |
| `config` | `{}` | конфиг демона поверх тестовых значений `testkit` (порты 0) |
| `claudeScenario`, `codexScenario` | `{}` | сценарии поддельных CLI |
| `signedIn` | `true` | `false` оставляет `context` и `page` анонимными |

- Перезапуск демона: `daemon.stop()` штатно или `daemon.kill()` — SIGKILL (`TerminateProcess` на Windows); тогда фикстура после теста его не останавливает. Новый демон запускает `profile.startDaemon({ entry: aangEntry })` после `profile.configure` с тем же конфигом и `api.port` прежнего демона: открытая страница переподключается к тому же адресу. Перезапущенный демон тест останавливает сам.
- Корни рантаймов в свежем профиле ещё не существуют, поэтому их обход ускорен: `collector.rootsScanIntervalMs` — 250 мс, если тест не задал свой.
- Допускной вызов поддельного Claude длится 1 с (`admissionMs`), если сценарий не задал своё, в том числе после `setScenario`. Пока идёт вызов, существует его запись реестра `~/.claude/sessions/<pid>.json`, и проверка допуска замечает её опросом в цикле событий демона. По умолчанию у `testkit` вызов длится 100 мс; под нагрузкой браузера и приёма записей цикл демона бывает занят дольше, проверка не видит запись, и допуск отклоняется как нарушение изоляции. Поэтому тесты с работающим наблюдателем (`map.test.ts`) в `beforeEach` ждут исхода допуска Claude в `/api/status` и требуют `admitted`: допуск проходит до проигрывания записей и открытия страницы, а не одновременно с ними.
- Путь поддельного CLI (`fakeClaude.path`, `fakeCodex.path`) записан в `cli.claude` и `cli.codex` конфига на всех ОС, и демон запускает его как настоящий CLI. На macOS и Linux это исполняемый скрипт. На Windows поддельный `claude` — `claude.exe` (exe-шим `testkit` запускает `node` со скриптом поддельного CLI), а поддельный `codex` — раскладка npm-пакета (`codex.cmd` и `node_modules/@openai/codex/bin/codex.js`), которую наблюдатель запускает как `node` со скриптом пакета (ADR-0013).
- Лаунчер `aang-hook` лежит в `AANG_HOME/bin`, как после `aang install`: через него наблюдатель запускает CLI на Windows (`aang-hook launch`, Job Object, ADR-0013).
- Токен приёмника OTel наружу отдаст `otel-config` (G.12). До него `otelEndpoint()` читает токен из настроек хранилища демона (только чтение), а порт — из `/api/status`.
- E2E с наблюдателем (`inspector.test.ts`) ставят сценарий поддельного `claude` через `fakeClaude.setScenario` и поэтому идут только на macOS и Linux. Образцы спайка датированы 2026-10-01, а очередь наблюдателя держит факты 24 часа по их времени (F.9), поэтому такие тесты проигрывают образец через `freshManifest` из `e2e/fresh.ts`: копия источников, в строках JSONL которой отметки `timestamp` сдвинуты так, что последняя приходится на текущий момент, а интервалы сохраняются.
- E2E 3 (`inspector.test.ts`) идёт на временном git-репозитории в каталоге `realpath(tmpdir())`: корень наблюдения с контрактом задаётся в `config` до старта демона. Правка входа между снимками проверки делается после того, как в `GET /api/raw/:seq` появилась сырая запись канала `snapshot` для начала проверки.

## Покрытие

`pnpm coverage` сводит V8-покрытие в один отчёт `c8`:

1. `coverage:test` — Vitest под `c8`, сырые данные в `coverage/tmp`;
2. `coverage:e2e` — Playwright под `c8 --clean=false`. Демоны и `aang open` наследуют `NODE_V8_COVERAGE` через окружение профиля и пишут покрытие при штатной остановке. Фикстура `page` снимает JS-покрытие Chromium и пишет его для сборки `web` в тот же каталог; `c8` переводит его в исходники через source map;
3. `coverage:report` — общий отчёт и покрытие `aang-hook`.

В CI это шаги задания `check` на macOS, Linux и Windows. При падении выкладываются `test-results/` с трассами Playwright.
