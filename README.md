# catacomb

catacomb is a daemon with a web interface that runs next to an agent runtime. It collects run events from Claude Code and Codex and builds from them a live map of the task's semantic stages: what is being executed, by whom, what came out, on what grounds and what needs human attention. Requirements and MVP boundaries are in the [RFC](rfc.md), architecture decisions are in [`docs/adr/`](docs/adr/), the plan is in [`docs/plan/mvp.md`](docs/plan/mvp.md).

Below: installation, connecting runtimes and removal.

## In short

```sh
catacomb install
catacomb start
catacomb watch ~/src/my-project
catacomb open
```

1. `catacomb install` connects the Claude Code and Codex hooks. catacomb's entries in Codex must be trusted once with the `/hooks` command (section ["Codex"](#codex)).
2. `catacomb start` starts the daemon.
3. `catacomb watch` adds a project to the scope.
4. `catacomb open` prints a UI login link.

## Requirements

- macOS, Linux or Windows without WSL, x64 and arm64 architectures ([ADR-0013](docs/adr/0013-windows.md)).
- Node.js 26 or newer.
- Claude Code and/or Codex on the same host as catacomb. The daemon reads the runtimes' files and receives their hooks locally.

## Installing the package

The catacomb package is not yet published to npm. The `catacomb` package in the public registry belongs to someone else; do not install it. Until publication, the packages are built from source.

Building requires git, Node.js 26, pnpm of the version from the `packageManager` field in [`package.json`](package.json) and Go of the version from [`packages/hook/go.mod`](packages/hook/go.mod):

```sh
git clone https://github.com/realkarych/catacomb.git
cd catacomb
pnpm install --frozen-lockfile
pnpm build
pnpm package
```

`pnpm package` writes to `dist/npm/` the tarball of the public `catacomb` package and of six platform packages `catacomb-hook-<os>-<arch>`: `darwin`, `linux` and `win32` for `x64` and `arm64`. Build release tarballs on macOS or Linux: Windows does not keep the executable bit, and macOS and Linux binaries packed there will not run.

Install the `catacomb` package together with the platform package for your machine. `node -p "process.platform + '-' + process.arch"` prints the platform suffix. For example, on macOS arm64:

```sh
npm install --global dist/npm/realkarych-catacomb-0.0.0.tgz dist/npm/realkarych-catacomb-hook-darwin-arm64-0.0.0.tgz
```

The package provides two commands:

- `catacomb` — the CLI and the daemon;
- `catacomb-hook` — runs the hook handler for its platform. It is a native Go binary from the `catacomb-hook-<os>-<arch>` package. If that package is missing, `catacomb-hook` names the missing package and exits with code 1, and `catacomb install` refuses.

catacomb's data lives in `CATACOMB_HOME`: `~/.catacomb` by default, `%USERPROFILE%\.catacomb` on Windows. On macOS and Linux the directory has permissions 0700; on Windows catacomb relies on the user profile ACL.

## Connecting runtimes

```sh
catacomb install
```

Without flags both runtimes are connected; on Windows only Claude Code (section ["Windows"](#windows)). With `--claude` or `--codex` only the selected ones are connected. Runtimes are connected separately: a failure of one does not prevent the other, but the command exits with code 1. If the machine has only one runtime, pass its flag.

First, `catacomb install` copies the `catacomb-hook` binary unchanged into `<CATACOMB_HOME>/bin/`. The hook configs call this copy by absolute path and pass it the absolute spool path. Therefore the runtime's environment does not affect how hooks work.

A hook writes the event to the spool and exits with code 0 without output, even on failure. It does not access the network and does not wait for the daemon. While the daemon is not running, hooks write nothing (section "Running").

### Claude Code

- catacomb generates a plugin in `<CATACOMB_HOME>/claude-plugin/`. It registers hooks for all events except `WorktreeCreate`, `WorktreeRemove`, `MessageDisplay` and `PreModelSwitch`, with `timeout: 2`. The commands are given in exec form, without a shell.
- The plugin is installed in the user scope via the local marketplace `catacomb`: `claude plugin marketplace add` and `claude plugin install catacomb@catacomb`.
- `catacomb install` prints whether the plugin is enabled. A disabled plugin is enabled with `claude plugin enable catacomb@catacomb`.

The plugin is loaded by the CLI, Desktop (Local and worktree) and the Agent SDK with default settings (section ["Agent SDK and Codex SDK"](#agent-sdk-and-codex-sdk)). The command is `cli.claude` from the catacomb config or `claude` from `PATH`; the profile is `runtimes.claude.configDir`, `CLAUDE_CONFIG_DIR` or `~/.claude`.

### Codex

catacomb installs hooks into the Codex profile: the regular `~/.codex` or a profile at another path set via `runtimes.codex.home` or `CODEX_HOME`. With a profile at another path, catacomb reads sessions and installs hooks only there, so run Codex with the same `CODEX_HOME`.

- catacomb appends its entries to the end of the arrays of all 12 events in `<codex>/hooks.json`. Codex trust is bound to the entry position, so other entries and their positions do not change.
- Stale catacomb entries from previous installations are not deleted but neutralized in place: their command is replaced with `true` (`exit 0` on Windows).
- Before the file is changed, a backup `hooks.json.catacomb-backup-<time>-<suffix>` is made, and its path is printed.
- catacomb does not write `config.toml` or `hooks.state`: trust for catacomb's entries is granted by the user.

After writing, `catacomb install` prints the state of catacomb's entries. After the first installation they are not trusted. Open Codex and trust them with the `/hooks` command. Until then Codex skips them, and Codex sessions are visible in the "files only" mode.

Before and after writing, catacomb verifies the trust of other entries with its own `codex app-server` process: `initialize`, then `hooks/list`. If the trust of another entry changed, the installation is rolled back.

- The process runs in the Codex profile and exits right after the response.
- catacomb does not connect to the shared Codex daemon or to other threads.
- At startup, even before responding, `codex app-server` itself contacts OpenAI services on behalf of the user: remote control, the model list, the plugin catalog. It may leave service files in `CODEX_HOME` ([D.6 report](docs/research/d6-app-server-live.md)). Therefore catacomb runs it only on an event, not on a timer ([ADR-0004](docs/adr/0004-event-collection.md)).

The Codex profile is `runtimes.codex.home` from the catacomb config, `CODEX_HOME` or `~/.codex`; the command is `cli.codex` or `codex` from `PATH`.

### Windows

Windows decisions and measurements are in [ADR-0013](docs/adr/0013-windows.md) and the [runtime check on Windows](docs/research/windows-runtimes.md).

- **Claude Code** is connected the same way as on macOS and Linux. Claude runs `catacomb-hook.exe` directly, without a shell. Hook startup on Windows is p95 18–24 ms versus 1–4 ms on macOS and Linux: Windows process creation itself is expensive. The budget on Windows is p95 up to 25 ms.
- **Codex.** `catacomb install` without flags does not install Codex hooks on Windows. Codex runs the hook command only through PowerShell, and each event costs 0.25–0.4 s: a session with 20 tool calls takes 12–14 s instead of 1–2 s. Without hooks, Codex sessions are visible in the "files only" mode: content, links and usage are there; approval waits are not. `catacomb install` and `catacomb status` remind about this.
- `catacomb install --codex` installs Codex hooks explicitly and warns about the slowdown. `catacomb status` repeats the warning while the entries are in place.
  - The entry command is `& '<CATACOMB_HOME>\bin\catacomb-hook.exe' 'codex' 'user' '<CATACOMB_HOME>\spool'`. PowerShell needs the call operator `&`; a single quote in the path is doubled.
  - catacomb verifies the trust of other entries with its own `codex app-server`, as on macOS and Linux. On Windows it is started via `catacomb-hook.exe launch`, which terminates the whole CLI process tree (Job Object).
  - catacomb looks for the `codex` command as `codex.exe` in `PATH`. An npm installation of Codex puts only the `codex.cmd` shim into `PATH`, which does not run without a shell. For it, set `cli.codex` in the config to the absolute path of the real `codex.exe` from the `@openai/codex-win32-x64` package (`…\vendor\x86_64-pc-windows-msvc\bin\codex.exe`). For `catacomb status`, the daemon runs an npm installation of Codex itself: via `node` and the package script.
- `cli.claude` on Windows is the path to `claude.exe`. Without it, `catacomb install` looks for `claude.exe` in `PATH`; the native Claude installer puts it in `%USERPROFILE%\.local\bin` but does not add that directory to `PATH`.

### Reinstalling and updating

`catacomb install` can be run repeatedly: the result is the same. After updating the catacomb package, run it again. The binary in `<CATACOMB_HOME>/bin/` is replaced in place, while the command lines in the plugin and `hooks.json` do not change, so Codex trust is kept.

The paths in the hook configs are absolute. If `CATACOMB_HOME` changed, run `catacomb install` again and trust the new Codex entries via `/hooks` again.

## Running

- `catacomb start` starts the daemon in the background and prints its address, `http://127.0.0.1:4280` by default. With `--foreground` the daemon runs in the current process.
- The daemon creates a 24-hour spool lease and renews it every hour. Without a valid lease, hooks write nothing. If the daemon crashed, events accumulate in the spool until the lease ends and are taken in after the next `catacomb start`.
- `catacomb open` prints a one-time UI login link. The link sets a cookie, works once and is valid for 5 minutes. A new login needs a new link. `catacomb token rotate` replaces the UI token; after it you need to log in again.
- `catacomb status` shows `CATACOMB_HOME`, the daemon state, the number and size of spool files, the lease expiry and the stop marker.
- `catacomb stop` stops the daemon and immediately stops hook writes. The stop marker stays in effect until the next `catacomb start` removes it.

There is no autostart via launchd, systemd or Windows services in the MVP.

### Scope: `watch`

catacomb collects only sessions of watched projects. A session is watched if its first working directory lies inside a watched directory or in a git worktree of a watched repository. Continuations and subagents inherit the decision of the root session. Records of other sessions are discarded at intake and not stored.

- `catacomb watch <dir>` adds a directory and re-reads its sessions for `lookback`, 7 days by default. Sessions discarded earlier are re-read too.
- `--lookback <days>` sets the re-read period for this call: `--lookback 30` or `--lookback 30d`.
- `catacomb watch --all` turns on collection of all sessions. The list of watched directories is kept.
- `catacomb unwatch <dir>` removes a directory from the list. While `watch --all` is on, sessions of this directory are still collected.
- `catacomb unwatch --all` turns off collection of all sessions and returns the scope to the directory list.
- To stop collection completely, run `catacomb unwatch --all` and `catacomb unwatch` for each directory in the list. `catacomb stop` also stops collection, but after the next `catacomb start` it resumes with the saved scope.

Records of sessions that left the scope are discarded at intake. Data already collected stays; `catacomb prune` deletes runs. The commands talk to the running daemon. The list of watched directories is stored in the catacomb database and survives a restart.

## What catacomb sees

| Mode | When | What is visible |
| --- | --- | --- |
| "full" | hooks are active, runtime files are available | everything |
| "files only" | hooks are not active: not installed (the default for Codex on Windows), the plugin is disabled, Codex entries are not trusted | content, links and usage; approval waits are not visible |
| "hooks only" | the runtime does not write a transcript: Agent SDK with `persistSession: false`, `CLAUDE_CODE_SKIP_PROMPT_HISTORY` | live events, waits, the final text; no content, usage or recovery |

- The UI shows the mode of each session.
- For profiles with interactive approvals, the "files only" mode is incomplete support. These are Claude CLI and Desktop, as well as Codex TUI and Desktop with `on-request`. For `codex exec` and the SDKs with `approval_policy=never`, hooks only speed up collection.
- The Claude enterprise policies `allowManagedHooksOnly` and `disableAllHooks` disable catacomb's hooks. Sessions are then visible in the "files only" mode.

Surfaces:

- Claude Code — CLI, Desktop (Local and worktree) and Agent SDK;
- Codex — TUI, `exec`, Desktop and Codex SDK.

Desktop on Windows is not checked in the MVP. catacomb does not observe Cowork and the cloud modes (Claude Cloud, Codex Cloud, Work Cloud). The UI shows them with a persistent notice "Not observable".

### Version support

Support is declared per exact engine version for each surface, OS and placement (local, Docker, VM, Desktop SSH mode) in [`support/matrix.json`](support/matrix.json) according to [ADR-0010](docs/adr/0010-format-versions.md). The status follows from check results (owner decision 2026-10-08); the UI shows it for an encountered version in the status bar:

- "supported" (`full`) — no gaps: the contract run of the reference recordings of this OS passes for all scenarios, E2E 1 runs on these recordings, the placement check and, where needed, the owner's checklist have passed;
- "limited" (`limited`) — the row is checked but has gaps, and the matrix lists them: no recording of a scenario, a scenario does not pass, E2E 1 does not run or does not pass;
- "unverified" (`unverified`) — the version is not in the matrix, the row has no recordings of its own OS or no passed placement check, it needs an owner's checklist that has not yet been passed, or it is Desktop on Windows.

An unverified version works in tolerant mode: sessions are collected and shown, unparsed records are stored.

Matrix for Claude Code 2.1.289, Claude Agent SDK with engine 2.1.289, Codex 0.160.0 and Codex SDK 0.160.0:

| Surface | `full` | `limited` | `unverified` |
| --- | --- | --- | --- |
| Claude Agent SDK, Codex SDK | macOS, Linux (local, Docker, VM), Windows | — | — |
| `codex exec` | macOS | Linux (local, Docker, VM), Windows: no `resume-compaction` recording with the real model | — |
| Claude CLI | — | Linux (local, Docker, VM): E2E 1 does not run on Linux recordings | macOS, Windows: no owner's TUI checklist |
| Codex TUI | — | macOS, Linux (local, Docker, VM): E2E 1 does not run on TUI recordings | Windows: no recordings |
| Claude Desktop (engine 2.1.286), Codex Desktop (engine 0.159.2) | — | — | macOS: no owner's Desktop checklist; Windows: not checked in the MVP |

### Desktop limitations

The owner accepted them on 2026-10-08 as known MVP limitations (RFC §4; [Q.1 report](docs/research/q1-surface-matrix.md), section 5):

1. Desktop on Windows is not checked in the MVP ([ADR-0013](docs/adr/0013-windows.md), decision 3).
2. The live GUI of Claude Desktop and Codex Desktop is not checked automatically: Desktop reference recordings and E2E run on Desktop engines in emulation, and only the owner's manual checklist makes a Desktop row verified.
3. The SSH mode of both Desktops is checked only by emulation: it is unknown which engine, of which version and with which settings sources Desktop starts on the remote host, and whether the catacomb plugin loads there. There are no Desktop engine recordings for Linux, so the `desktop_ssh` rows remain without contract columns.
4. catacomb distinguishes Codex Desktop from other Codex surfaces only by `originator`, and the UI labels such sessions "(assumed)".
5. Sessions spawned by Desktop (spawn task, Dispatch, scheduled tasks) are linked to the parent only through Desktop metadata; the owner's checklist verifies the link format.
6. Desktop engines are updated by the application itself and lag behind the CLI: currently 2.1.286 in Claude Desktop and 0.159.2 in Codex Desktop, with CLIs at 2.1.289 and 0.160.0. Each new engine version needs reference recordings; until then its row is `unverified`.

## Agent SDK and Codex SDK

### Claude Agent SDK

Without code changes, catacomb sees applications that:

- load user settings: `settingSources` is not set (by default it is `user`, `project` and `local`) or includes `'user'`;
- write a transcript: `persistSession` is not `false`.

Into such applications the catacomb plugin from the user scope is loaded the same way as into the CLI.

An isolated application without `'user'` in `settingSources` is connected with one line — the catacomb plugin via `plugins`:

```ts
import { query } from '@anthropic-ai/claude-agent-sdk'

for await (const message of query({
  prompt: 'Run the checks',
  options: {
    settingSources: [],
    plugins: [{ type: 'local', path: '/Users/me/.catacomb/claude-plugin' }],
  },
})) {
  console.log(message)
}
```

In `path`, give the absolute path `<CATACOMB_HOME>/claude-plugin`; the directory is created by `catacomb install --claude`. An application that already loads user settings does not need `plugins`. Otherwise every event will arrive from two registrations, which is a configuration error.

Limitations:

- `persistSession: false`: there is no transcript, and the session is visible only in the "hooks only" mode;
- resume from `sessionStore`: the SDK drops `enabledPlugins` and works in a temporary `CLAUDE_CONFIG_DIR`. The plugin from user settings is not loaded, and the transcript is written outside catacomb's roots.

### Codex SDK

The Codex SDK runs `codex exec`. It always writes the rollout to `CODEX_HOME/sessions` and takes hooks from `CODEX_HOME/hooks.json`. An application is visible without code changes if it does not override `CODEX_HOME`. Note that `CodexOptions.env` replaces the process environment entirely. An application that sets a different `CODEX_HOME` in it writes sessions outside catacomb's roots.

## Codex OpenTelemetry

A human's approval decision in Codex is visible only through OpenTelemetry. Without it, the UI shows such a decision as "unknown". Connecting it is optional; catacomb does not change the Codex config.

```sh
catacomb otel-config
```

The command takes the address from the running daemon and prints to stdout a section for the Codex `config.toml`:

```toml
[otel]
exporter = { otlp-http = { endpoint = "http://127.0.0.1:4281/otel/<intake token>/v1/logs", protocol = "json" } }
```

Add it to `<codex>/config.toml`. If the file already has an `[otel]` section, do not add a second one:

- replace only the `exporter` line in it, and keep the previous value so you can restore it when removing catacomb;
- do not change the other parameters of the section, such as `trace_exporter` and `metrics_exporter`;
- Codex has a single log exporter: if it already sends records to your collector, choose one of the two addresses.

Then restart the TUI daemon with `codex app-server daemon restart` and restart Codex Desktop.

- The receiver listens only on loopback, port `otel.port`, 4281 by default. It stores only `codex.tool_decision` events; other records are discarded before being written to disk.
- The intake token in the address is separate from the UI token: `catacomb token rotate` does not change it.
- `catacomb otel-config --rotate` issues a new token, and the previous address immediately stops accepting records. Replace the `exporter` line in `config.toml` and restart Codex again.

## Remote host and SSH tunnel

catacomb runs on the same host as the runtime:

- on your own VM;
- in a container (section ["Docker"](#docker));
- on a remote host in the SSH mode of Claude Desktop or Codex Desktop.

`catacomb start`, `catacomb watch` and `catacomb install` are run there too. Each host has its own daemon and its own UI; several hosts are not combined into one UI.

On your own VM and on a Desktop SSH-mode host, set the placement in `<CATACOMB_HOME>/config.json`: `"placement": "vm"` or `"placement": "desktop_ssh"`. From the inside they cannot be told apart from a local run, and support in the matrix is declared separately for each placement. catacomb recognizes a container by itself.

By default the daemon listens only on `127.0.0.1:4280`. To access the UI from another machine, open an SSH tunnel:

```sh
ssh -N -L 4280:127.0.0.1:4280 user@host
```

Then run `catacomb open` on the remote host and open the link `http://127.0.0.1:4280/auth/<code>` in the local browser. The local tunnel port must match the daemon port. The daemon accepts UI modifying requests (the view mark, dismissing attention items, view rules and chat) only from the page `http://127.0.0.1:<daemon port>` or `http://localhost:<daemon port>` ([ADR-0003](docs/adr/0003-ui-access.md), decision 1). Through a different local port the UI opens and shows runs, but changes get 403.

Without a tunnel, you can set an explicit listen address: `catacomb start --bind <address>` in the format `<host>`, `<host>:<port>` or `[<ipv6>]:<port>`. A permanent address is set by `api.host` and `api.port` in the config. The token is mandatory in this mode too. The daemon has no TLS of its own, and the login link and cookie are transmitted in clear text. Therefore outside a trusted network you need an SSH tunnel or an external proxy with TLS. For the addresses `0.0.0.0` and `::`, `catacomb open` prints a link to loopback, and the host address has to be substituted into it. From a page on the host address the UI is read-only: by the same ADR-0003 rule, changes get 403. A fully functional UI from another machine needs an SSH tunnel with the same port.

## Docker

The `catacomb` image is a base layer for the solver image. The derived image installs `claude` and/or `codex`, and the catacomb daemon and the solver run in one container. A separate catacomb container with shared volumes (sidecar) is not supported in the MVP.

The base image is built from the repository root:

```sh
docker build --tag catacomb .
```

Image contents:

- `node:26-slim` with the `catacomb` and `catacomb-hook` commands, `git` and `tini`;
- user `node`, `CATACOMB_HOME` is `/home/node/.catacomb`;
- the entry point is `tini`. It reaps exited processes under any container command, so `catacomb stop` confirms the daemon stop and `--init` is not needed.

The derived image installs the CLIs as `root` and switches back to `node`:

```dockerfile
FROM catacomb
USER root
RUN npm install --global --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code @openai/codex
USER node
```

Build it and run the container with the project and the UI port published only on the host's loopback:

```sh
docker build --tag solver .
docker run --detach --name solver \
  --publish 127.0.0.1:4280:4280 \
  --mount type=bind,src="$HOME/src/my-project",dst=/home/node/work \
  --workdir /home/node/work \
  solver sleep infinity
```

In `src`, give the absolute path of the project on the host. It is mounted at `/home/node/work`, this directory becomes the working directory for `docker exec`, and the solver and catacomb work with the same project.

Authorize the CLIs inside the container. `docker exec --interactive --tty solver claude auth login` prints a login link: open it in the host browser and paste the received code into the terminal. Codex logs in with a device code: `docker exec --interactive --tty solver codex login --device-auth`. A plain `codex login` waits for the browser's response on `localhost:1455` inside the container, and the host browser will not reach it. Login with a real account and observer admission with this authorization are verified by the owner ([Q.1 checklist](docs/research/q1-owner-checklist.md), section 5). Then start catacomb:

```sh
docker exec solver git config --global --add safe.directory /home/node/work
docker exec solver catacomb start --bind 0.0.0.0
docker exec solver catacomb watch /home/node/work
docker exec solver catacomb open
```

- `safe.directory` is needed because the owner of the mounted directory in the container is usually not the `node` user: Docker Desktop shows it as owned by `root`. Without this setting git answers `detected dubious ownership` and does not work with the repository, neither for the solver nor for catacomb.
- `--bind 0.0.0.0` is needed so that the published port reaches the daemon. `--publish 127.0.0.1:4280:4280` opens it only on the host's loopback. The port on the host must match the daemon port in the container: with a different port, changes in the UI get 403 (section ["Remote host and SSH tunnel"](#remote-host-and-ssh-tunnel)).
- Open the link from `catacomb open` in the host browser. If Docker runs on a remote machine, add an SSH tunnel to it.
- Docker on Windows runs Linux containers, so Linux rules apply inside the container.

Hooks are connected in the container the same way as on the host: `docker exec solver catacomb install` installs the Claude plugin and Codex hooks with the image's `catacomb-hook` binary; trust the Codex entries via `/hooks` in `docker exec --interactive --tty solver codex`. Without `catacomb install`, the solver's sessions are visible in the "files only" mode (section ["What catacomb sees"](#what-catacomb-sees)).

The runtime roots (`~/.claude/projects`, `~/.codex/sessions`) appear in a new container only with the first session. While they are absent, the daemon notices them by scanning the roots every 60 s (`collector.rootsScanIntervalMs`), and the files of the first session appear in the UI with this delay; hooks arrive immediately.

## Removal

```sh
catacomb uninstall
catacomb stop
```

- `catacomb uninstall` removes the Claude plugin and the `catacomb` marketplace with `claude plugin uninstall` and `claude plugin marketplace remove`, as well as the `<CATACOMB_HOME>/claude-plugin` directory.
- `catacomb uninstall` neutralizes catacomb's entries in the Codex `hooks.json` in place (command `true`, `exit 0` on Windows) and keeps a backup. The entries are not deleted because Codex trust is positional: if you delete an catacomb entry manually, the entries after it shift and lose trust.
- `<CATACOMB_HOME>` stays after removal. It holds the binary, the database, the spool and the tokens.

To remove catacomb completely:

1. Remove the packages: `npm uninstall --global catacomb catacomb-hook-<os>-<arch>`.
2. Delete the `<CATACOMB_HOME>` directory. The spool in it holds full hook payloads, including tool output with possible secrets.
3. If you connected OpenTelemetry, restore the previous `exporter` value in the `[otel]` section of the Codex `config.toml`, or delete the line if there was none. Delete the whole section only if it was added for catacomb and has no other parameters. Then restart Codex.
4. After checking, delete the `hooks.json.catacomb-backup-*` backups from the Codex profile.

## Configuration

`<CATACOMB_HOME>/config.json` need not be created. All paths in it must be absolute. Keys that matter for installation:

| Key | Default | Purpose |
| --- | --- | --- |
| `cli.claude`, `cli.codex` | `claude` and `codex` from `PATH` | runtime commands |
| `runtimes.claude.configDir` | `CLAUDE_CONFIG_DIR` or `~/.claude` | Claude profile |
| `runtimes.codex.home` | `CODEX_HOME` or `~/.codex` | Codex profile |
| `api.host`, `api.port` | `127.0.0.1`, `4280` | API and UI address |
| `otel.port` | `4281` | OpenTelemetry receiver port on loopback |
| `watch.lookbackDays` | `7` | backfill period at first start and re-read period for `catacomb watch` |

The `CATACOMB_HOME` variable overrides the catacomb directory. The config schema is [`packages/contract/src/config.ts`](packages/contract/src/config.ts).
