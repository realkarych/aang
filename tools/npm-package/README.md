# Сборка npm-пакета

`pnpm package` после `pnpm build` собирает в `dist/npm/` публичный пакет `aang` и шесть платформенных пакетов `aang-hook-<os>-<arch>` и упаковывает каждый `npm pack` (ADR-0011, ADR-0013). Промежуточные каталоги пакетов лежат в `dist/npm/stage/`. Публикации в npm инструмент не выполняет.

## Пакет `aang`

- `dist/aang.js` и `dist/aang-hook.js` — команды `aang` и `aang-hook`. Это бандлы `esbuild` точек входа пакета `aang` (`packages/aang/dist/main.js` и `hook.js`) со всеми внутренними пакетами и сторонними зависимостями (`zod`, `smol-toml`, `yaml`); модули `node:*` остаются внешними. Бандл в формате ESM объявляет `require` через `createRequire(import.meta.url)`: зависимость в формате CommonJS (`yaml`) загружает через него встроенные модули Node. Предупреждение `esbuild` прерывает сборку.
- `dist/web/` — сборка `web`, каталог экспорта `@aang/web`.
- `schema/` — миграции `store`. Модуль `store` читает `../schema/` относительно себя, а в пакете этот модуль — `dist/aang.js`.
- `support/matrix.json` — матрица поддержки (ADR-0010), из которой демон берёт статус версий. Команда `aang` читает `../support/matrix.json` относительно себя, а если такого файла нет — `../../../support/matrix.json`, где матрица лежит в рабочем дереве и в образе Docker.
- `THIRD_PARTY_LICENSES` — лицензии сторонних пакетов, попавших в бандл. Пакет без файла лицензии прерывает сборку.
- `package.json`: `bin` с обеими командами, `engines.node` — `>=26`, `optionalDependencies` на шесть платформенных пакетов той же версии, поле `imports`. Версия берётся из `packages/aang/package.json`.

Команда `aang-hook` запускает бинарь своей платформы с теми же аргументами и стандартными потоками и возвращает его код выхода. Если бинаря нет (платформа не поддержана или optional-зависимости пропущены при установке), она пишет причину в stderr и выходит с кодом 1. Конфиги hooks её не вызывают: по ADR-0013 они вызывают по абсолютному пути копию бинаря в `<AANG_HOME>/bin`, которую делает `aang install`. Без бинаря `aang install` сообщает ту же причину и выходит с кодом 1.

## Поиск статики и бинаря

Точки входа находят каталог `web` и бинарь `aang-hook` через subpath imports Node. Бинарь ищет общий модуль `packages/aang/src/hook-binary.ts`: его используют и команда `aang-hook`, и `aang install`. Код одинаков в рабочем дереве и в установленном пакете, различаются только сопоставления в `package.json`:

| Спецификатор | Рабочее дерево (`packages/aang/package.json`) | Установленный пакет |
| --- | --- | --- |
| `#web` | `@aang/web` | `./dist/web/<файл экспорта @aang/web>` |
| `#aang-hook-<os>-<cpu>` | `@aang/hook/bin/aang-hook` (`aang-hook.exe` для `win32`) | пакет `aang-hook-<os>-<cpu>`, его `exports` — бинарь |

Правило `aang/dependency-direction` проверяет цели `imports` по таблице ADR-0011: пакет `aang` может только находить `web` и `hook`, но не импортировать их код.

## Платформенные пакеты

- Имена и поля `os` и `cpu` — в обозначениях Node, как у `esbuild`: `darwin`, `linux`, `win32` и `x64`, `arm64`. npm ставит только пакет, подходящий машине.
- Бинарь собирается `go build -trimpath -ldflags=-s -w` с `CGO_ENABLED=0` и нужными `GOOS` и `GOARCH`; платформенный пакет содержит только его и `package.json`.
- Права файлов в tarball `npm pack` берёт с диска. Windows не хранит бит исполнения, поэтому пакеты для macOS и Linux, упакованные на Windows, содержат неисполняемый бинарь. Выпускные tarball собираются на macOS или Linux.

## Проверка

`pnpm test:package` (тег `package`, задание `package` в CI на трёх ОС) собирает пакеты во временный каталог и поднимает на loopback минимальный registry, который отдаёт только их. Тест проверяет:

- `npm install --global` во временный префикс ставит `aang` с `engines.node` `>=26` и только платформенный пакет своей машины;
- во временном HOME установленный `aang-hook` пишет событие в spool, `aang start` запускает демон и тот принимает событие, `aang status` показывает демон, `aang open` выдаёт ссылку входа, демон раздаёт сборку `web` побайтно, `aang stop` останавливает демон;
- во временном HOME с поддельными `claude` и `codex` установленный `aang install` копирует в `<AANG_HOME>/bin` бинарь платформенного пакета побайтно (`aang-hook.exe` на Windows), вызывает `claude plugin` и `codex app-server` и регистрирует плагин Claude и записи `hooks.json` Codex с этим бинарём. Команды из обоих конфигов, исполненные так, как их исполняет рантайм, доставляют `SessionStart` запущенному демону: он показывает прогоны Claude и Codex. Плагин Claude исполняется в exec form, строка Codex — через `sh -c` на macOS и Linux и через `pwsh -NoProfile -Command` на Windows. Профиль Codex — отдельный каталог из конфига aang;
- на Windows `aang install` без флагов ставит только плагин Claude: `codex app-server` не запускается, `hooks.json` Codex не появляется, вывод называет `aang install --codex` и цену события. Hooks Codex ставит `aang install --codex`, и его команда в форме PowerShell доставляет событие (решения владельца по D.3 и D.8, ADR-0013);
- при установке в проект с `--omit=optional` `aang-hook` и `aang install` называют отсутствующий бинарь, а `aang` работает. Глобальная установка npm `--omit=optional` не учитывает;
- каждый платформенный пакет объявляет свои `os` и `cpu`, и его бинарь собран для них (заголовки Mach-O, ELF и PE).

Покрытие `c8` инструмент не собирает (`.c8rc.json`): его код работает только в задании `package`.
