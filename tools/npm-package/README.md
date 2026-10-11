# npm package build

`pnpm package` after `pnpm build` assembles in `dist/npm/` the public `aang` package and six platform packages `aang-hook-<os>-<arch>`, and packs each one with `npm pack` (ADR-0011, ADR-0013). Intermediate package directories live in `dist/npm/stage/`. The tool does not publish to npm.

## The `aang` package

- `dist/aang.js` and `dist/aang-hook.js` — the `aang` and `aang-hook` commands. These are `esbuild` bundles of the `aang` package entry points (`packages/aang/dist/main.js` and `hook.js`) with all internal packages and third-party dependencies (`zod`, `smol-toml`, `yaml`); `node:*` modules stay external. The ESM bundle declares `require` via `createRequire(import.meta.url)`: the CommonJS dependency (`yaml`) loads Node built-in modules through it. An `esbuild` warning aborts the build.
- `dist/registry-watch.js` — a bundle of the worker thread module in which the Claude admission watches the session registry (`packages/observer/dist/registry-watch.js`, the admission section in `packages/observer/README.md`). `observer` launches it as `./registry-watch.js` relative to itself, and in the package that module is `dist/aang.js`.
- `dist/web/` — the `web` build, the export directory of `@aang/web`.
- `schema/` — `store` migrations. The `store` module reads `../schema/` relative to itself, and in the package that module is `dist/aang.js`.
- `support/matrix.json` — the support matrix (ADR-0010) from which the daemon takes version status. The `aang` command reads `../support/matrix.json` relative to itself, and if there is no such file, `../../../support/matrix.json`, where the matrix lives in the working tree and in the Docker image.
- `THIRD_PARTY_LICENSES` — licenses of the third-party packages included in the bundle. A package without a license file aborts the build.
- `package.json`: `bin` with both commands, `engines.node` — `>=26`, `optionalDependencies` on the six platform packages of the same version, the `imports` field. The version is taken from `packages/aang/package.json`.

The `aang-hook` command runs the binary of its platform with the same arguments and standard streams and returns its exit code. If there is no binary (the platform is not supported or optional dependencies were skipped at install), it writes the reason to stderr and exits with code 1. Hook configs do not call it: per ADR-0013 they call, by absolute path, the copy of the binary in `<AANG_HOME>/bin` made by `aang install`. Without the binary, `aang install` reports the same reason and exits with code 1.

## Locating static files and the binary

The entry points find the `web` directory and the `aang-hook` binary via Node subpath imports. The binary is located by the shared module `packages/aang/src/hook-binary.ts`: it is used both by the `aang-hook` command and by `aang install`. The code is the same in the working tree and in the installed package; only the mappings in `package.json` differ:

| Specifier | Working tree (`packages/aang/package.json`) | Installed package |
| --- | --- | --- |
| `#web` | `@aang/web` | `./dist/web/<@aang/web export file>` |
| `#aang-hook-<os>-<cpu>` | `@aang/hook/bin/aang-hook` (`aang-hook.exe` for `win32`) | the `aang-hook-<os>-<cpu>` package, its `exports` is the binary |

The `aang/dependency-direction` rule checks `imports` targets against the ADR-0011 table: the `aang` package may only locate `web` and `hook`, not import their code.

## Platform packages

- Names and the `os` and `cpu` fields use Node notation, as in `esbuild`: `darwin`, `linux`, `win32` and `x64`, `arm64`. npm installs only the package matching the machine.
- The binary is built with `go build -trimpath -ldflags=-s -w` with `CGO_ENABLED=0` and the required `GOOS` and `GOARCH`; the platform package contains only it and `package.json`.
- `npm pack` takes file permissions in the tarball from disk. Windows does not store the executable bit, so macOS and Linux packages packed on Windows contain a non-executable binary. Release tarballs are built on macOS or Linux.

## Verification

`pnpm test:package` (tag `package`, the `package` job in CI on three OSes) builds the packages into a temporary directory and starts a minimal loopback registry that serves only them. The test checks that:

- `npm install --global` into a temporary prefix installs `aang` with `engines.node` `>=26` and only the platform package of its machine;
- in a temporary HOME, the installed `aang-hook` writes an event to the spool, `aang start` starts the daemon and it receives the event, `aang status` shows the daemon, `aang open` prints a login link, the daemon serves the `web` build byte for byte, `aang stop` stops the daemon;
- in a temporary HOME with fake `claude` and `codex`, the installed `aang install` copies the platform package binary byte for byte into `<AANG_HOME>/bin` (`aang-hook.exe` on Windows), calls `claude plugin` and `codex app-server`, and registers the Claude plugin and the Codex `hooks.json` entries with this binary. The commands from both configs, executed the way the runtime executes them, deliver `SessionStart` to the running daemon: it shows the Claude and Codex runs. The Claude plugin is executed in exec form, the Codex line via `sh -c` on macOS and Linux and via `pwsh -NoProfile -Command` on Windows. The Codex profile is a separate directory from the aang config;
- on Windows, `aang install` without flags installs only the Claude plugin: `codex app-server` is not started, the Codex `hooks.json` does not appear, and the output names `aang install --codex` and the per-event cost. Codex hooks are installed by `aang install --codex`, and its command in PowerShell form delivers the event (owner decisions on D.3 and D.8, ADR-0013);
- when installed into a project with `--omit=optional`, `aang-hook` and `aang install` name the missing binary, while `aang` works. A global npm install does not honor `--omit=optional`;
- each platform package declares its `os` and `cpu`, and its binary is built for them (Mach-O, ELF and PE headers).

The tool does not collect `c8` coverage (`.c8rc.json`): its code runs only in the `package` job.
