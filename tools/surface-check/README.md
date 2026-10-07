# Surface check (Q.1)

`tools/surface-check` checks a surface end to end on the host it runs on: the real CLI or SDK of the surface works against the model stub of `tools/record`, aang is connected by the product commands (`aang install`, `aang start`, `aang watch`), and the running daemon has to show the session the way the reference recording of the same version, surface and OS shows it. The same command runs natively, inside a Docker container, inside a VM and on the remote host of the Desktop SSH mode; the placement is the one of the row of the support matrix (ADR-0010) the check is about.

```sh
pnpm build
node tools/surface-check/dist/main.js run [--placement local|docker|vm|desktop_ssh] [--surfaces <surface,...>] [--require <surface,...>]
  [--scenarios core|all|<name,...>] [--emulate-desktop] [--out <directory>] [--work <directory>] [--support <directory>]
  [--aang <main.js|command>] [--hook <aang-hook>] [--bind <address>] [--port <port>] [--keep-daemon]
  [--claude <executable>] [--codex <executable>] [--claude-sdk <package>] [--codex-sdk <package>]
node tools/surface-check/dist/main.js access --link <sign-in link> [--origin <origin>] [--expect-write <status>] [--out <file>] [--into <report.json>]
```

Engines are found like the recorder finds them: the options, then `AANG_RECORD_CLAUDE`, `AANG_RECORD_CODEX`, `AANG_RECORD_CLAUDE_SDK`, `AANG_RECORD_CODEX_SDK`, then `PATH`. The default surfaces are `claude_cli`, `claude_sdk`, `codex_exec`, `codex_sdk` and `codex_tui`; a surface whose engine is missing is skipped unless `--require` names it. The default scenarios (`core`) are the catalog scenarios `tools`, `subagents`, `resume`, `compaction`, `reconnect`, `approval` and `question` that the surface has on this OS; `all` runs every stub scenario of the surface. `--aang` defaults to the built `packages/aang/dist/main.js`, `--hook` to the built `aang-hook`, `--support` to the repository's `support`.

## What one scenario does

Each scenario gets its own temporary profile: `HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `AANG_HOME` inside it, the project directory and a scratch directory. Variables of the caller that would change the runtimes or aang (`ANTHROPIC_*`, `OPENAI_*`, `CLAUDE_CODE_*`, `CLAUDE_AGENT_SDK_*`, `CODEX_*`, `AANG_*`, `CLAUDE_CONFIG_DIR`) are dropped. Nothing of the user's profiles is read or changed, and no real model is called: the observer of the daemon has no authorization in the temporary profile.

1. `config.json` of aang names the CLIs (`cli.claude`, `cli.codex`), the runtime roots of the profile, a free API port (or `--port`) and, for `vm` and `desktop_ssh`, the placement. `docker` is not written: the daemon detects it by `/.dockerenv`, and `--placement docker` refuses to run outside a container.
2. `aang start` (with `--bind` when given), `aang watch <project>`, `aang otel-config` for the OTLP endpoint and `aang open` for the sign-in.
3. The catalog scenario of `tools/record` runs as it runs for a recording, with its own assertions: the CLI or SDK host, the model stub, the scenario's recording plugin (`--plugin-dir`, renamed `aang-scenario`) and spool, and its hook binary copied as `scenario-hook`: `aang install` neutralizes every `aang-hook` entry of `hooks.json` that is not its own, and the scenario's entries would be such entries. Before the first command of the scenario aang is connected the product way and in the order of the README: `aang stop`, `aang install --claude` or `aang install --codex`, `aang start`. That is the Claude plugin from the local marketplace into the user scope of the profile, or the Codex hooks at the end of the `hooks.json` the scenario wrote. Codex scenarios that trust their hooks through `hooks/list` trust the aang entries too, `codex exec` runs with the bypass flag of the recorder. The Codex OTel exporter of the scenario forwards to the receiver of the daemon. At the `daemon-restart` checkpoint of `reconnect` the daemon stops and starts again.
4. Before every command of the scenario `aang status` runs the hook check of the daemon to the end. The daemon starts `codex app-server` for that check whenever `hooks.json` or `config.toml` changes, and on Windows a `codex app-server` started next to another one on the same `CODEX_HOME` failed to initialize its state or timed out (`docs/research/q1-surface-matrix.md`, section 6); the barrier keeps the check of the daemon and the commands of the scenario apart.
5. When the spool is empty and the change sequence of the daemon stays still for two seconds, the check reads `/api/status`, `/api/runs` and every run. After the daemon stops, it opens the store of the daemon and counts the raw records by channel, record type and parse state, as the contract snapshot does.

The scenario passes when the scenario itself passed and:

- the daemon shows a run, every session reads as the surface of the scenario, and `/api/status` lists the version `(runtime, surface, OS, placement, engine version)`;
- the Claude hooks of aang are `active`;
- `reconnect` restarted the daemon once;
- the runs, the sessions (version, support mode, unparsed records), the number of agents, the actions by tool and outcome, the questions by kind and the attention items by kind and author equal those of the contract snapshot of the reference recording of the same runtime, engine version, surface, OS and scenario in `support/contract` (R.5a), and so do the raw records of events by record type and parse state: every hook and rollout record and the `user`, `assistant`, `attachment` and `system` lines of transcripts. Without such a snapshot the comparison is skipped and the report says so. The surface is compared with the scenario, not with the snapshot.

Two differences are notes rather than failures. The decisions of questions and the resolutions of attention items depend on the time of the replay in the contract run: it keeps the recorded times of transcript and rollout lines while hooks arrive at replay time, so a permission request of Claude reads there as ended without an answer while the live daemon sees it approved or rejected (`docs/research/q1-surface-matrix.md`, section 6). So do the other raw records, whose number depends on when the engines and the collector write and read: the registry and OTLP channels, the state lines of Claude transcripts (`last-prompt`, `cost-state`, `queue-operation` and similar, written a different number of times from run to run) and `system:stop_hook_summary`, which depends on how long the hooks of a turn take (two plugins run them here).

After the last scenario the check signs in with a new link of `aang open` and marks a run viewed: this is the UI access through the loopback origin of the daemon. With `--keep-daemon` that daemon keeps running and the report names its `AANG_HOME` and `HOME`, so that an access check from outside can ask it for a new link and stop it afterwards.

`--emulate-desktop` runs the `claude_desktop` and `codex_desktop` scenarios of the catalog with the CLIs as engines, on any OS: the Claude engine with the Desktop flags and environment, `codex app-server` with the Desktop client and originator. This is what the remote host of the Desktop SSH mode is expected to run; the engine the real Desktop installs there, its version and its environment are checked only by the owner (`docs/research/q1-owner-checklist.md`). An emulated surface is never compared with a snapshot and never counts as the placement check of the matrix.

## Access from outside

`access` signs in with the link through `--origin` (the origin the browser would use, the origin of the link by default), lists the runs and marks the first one viewed with `Origin: <origin>`. It passes when the run list is not empty and the mark answers `--expect-write` (200 by default). `--into` writes the result into the `access` field of a report and rewrites its summary next to it.

By ADR-0003 (decision 1 of 2026-10-04) writes authorized by the cookie are accepted only from `http://127.0.0.1:P` and `http://localhost:P`, where P is the port the daemon listens on. A tunnel or a published port with the same port therefore works for reading and writing, while another local port or the address of an explicit `--bind` works for reading only and answers 403 to writes; the CI scripts check both and expect 403 for the second.

## Report

`--out` (default `surface-check-report`) receives `report.json` and `summary.md`; in GitHub Actions the summary is appended to the job summary.

```json
{
  "format": "aang-surface-check/1",
  "started_at": "…", "finished_at": "…",
  "os": "linux", "placement": "docker",
  "access": { "result": "passed", "origin": "http://127.0.0.1:4280", "runs": 1, "write": 200, "expected_write": 200, "error": null },
  "kept": { "aang_home": "…", "home": "…" },
  "results": [
    { "key": { "runtime": "claude", "surface": "claude_cli", "os": "linux", "placement": "docker", "engine_version": "2.1.289" },
      "surface": "claude_cli", "app_version": null, "emulated": false, "result": "passed", "error": null,
      "scenarios": [ { "name": "tools", "result": "passed", "error": null, "failures": [], "installed": ["…"], "restarts": 0, "daemon": { }, "reference": { } } ] }
  ]
}
```

A non-local, non-emulated result that passed together with `access` is the placement check of its row: `node tools/support/dist/main.js placement import <report.json>...` records it in `support/verification.json` (`tools/support/README.md`). The command exits with 1 when a result or the access failed.

## CI

The `Surface matrix` workflow (`.github/workflows/surfaces.yml`) runs on pull requests that touch this tool, the recorder sources or the `Dockerfile`, and by hand. Versions are pinned in its environment (`AANG_CLAUDE_CODE_VERSION`, `AANG_CLAUDE_AGENT_SDK_VERSION`, `AANG_CODEX_VERSION`, `AANG_CODEX_SDK_VERSION`); the names carry the `AANG_` prefix because `CLAUDE_AGENT_SDK_VERSION` in the environment of a Claude engine makes its sessions read as Agent SDK sessions.

- `native` — Linux, macOS and Windows runners with the CLIs and SDKs installed the way the Scenarios workflow installs them; placement `local`. The interactive Codex TUI runs on Linux and macOS (`expect`).
- `docker` — `ci/docker.sh`: the `aang` image, a derived image `surface.Dockerfile` with the CLIs, SDKs and this tool, the check inside the container with `--placement docker --bind 0.0.0.0 --keep-daemon`, then `access` from the runner through the published port 4280 (writes pass), another published port 4380 and the address of the container (writes answer 403).
- `vm` — `ci/vm.sh`: an Ubuntu cloud image under QEMU/KVM on the runner with a cloud-init user and SSH key. aang is deployed into it the way the `Dockerfile` lays it out, Node, the CLIs and the SDKs are installed there, and the check runs over SSH with `--placement vm --keep-daemon`. The UI is reached through `ssh -L 4280:127.0.0.1:4280` (writes pass) and `ssh -L 4380:127.0.0.1:4280` (writes answer 403). Then `--placement desktop_ssh --emulate-desktop` runs on the same VM over SSH, with access through the tunnel.

Each job uploads its reports as an artifact (`surface-check-<os>`, `surface-check-docker`, `surface-check-vm`).
