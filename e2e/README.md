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

Сессии образцов и их файлы в профиле — в `e2e/samples.ts` (`hookFields` даёт `session_id`, `cwd` и `transcript_path` для hook-событий этих сессий), общие локаторы экрана — в `e2e/screens.ts`. Эталонные записи R.4 выбирает `e2e/recordings.ts`: запись ОС раннера, а если её нет — macOS; `through` и `after` режут запись по метке контрольного события, `withoutHooks` убирает из неё hook-события, `threadsOf` перечисляет треды Codex в порядке их rollout.

| Опция (`test.use`) | По умолчанию | Смысл |
| --- | --- | --- |
| `config` | `{}` | конфиг демона поверх тестовых значений `testkit` (порты 0) |
| `claudeScenario`, `codexScenario` | `{}` | сценарии поддельных CLI |
| `signedIn` | `true` | `false` оставляет `context` и `page` анонимными |

- Корни рантаймов в свежем профиле ещё не существуют, поэтому их обход ускорен: `collector.rootsScanIntervalMs` — 250 мс, если тест не задал свой.
- Путь поддельного CLI попадает в `cli.claude` и `cli.codex` конфига, когда для запуска хватает одного пути (macOS и Linux). На Windows поддельный `claude` запускается как `node <скрипт> <состояние>` и в конфиг не записывается, а поддельный `codex` ставится в раскладке npm-пакета (`codex.cmd` и `node_modules/@openai/codex/bin/codex.js`), которую находит `observer`; лаунчер наблюдателя `aang-hook.exe` копируется в `AANG_HOME/bin`, как это делает `aang install`.
- Токен приёмника OTel наружу отдаст `otel-config` (G.12). До него `otelEndpoint()` читает токен из настроек хранилища демона (только чтение), а порт — из `/api/status`.

## Покрытие

`pnpm coverage` сводит V8-покрытие в один отчёт `c8`:

1. `coverage:test` — Vitest под `c8`, сырые данные в `coverage/tmp`;
2. `coverage:e2e` — Playwright под `c8 --clean=false`. Демоны и `aang open` наследуют `NODE_V8_COVERAGE` через окружение профиля и пишут покрытие при штатной остановке. Фикстура `page` снимает JS-покрытие Chromium и пишет его для сборки `web` в тот же каталог; `c8` переводит его в исходники через source map;
3. `coverage:report` — общий отчёт и покрытие `aang-hook`.

В CI это шаги задания `check` на macOS, Linux и Windows. При падении выкладываются `test-results/` с трассами Playwright.
