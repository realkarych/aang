# Plugin delivery on live CLIs (D.5)

Status: report on plan item D.5 (`docs/plan/mvp.md`). This is not an ADR: factual clarifications have been made in ADR-0004 and ADR-0013; questions for the owner are collected in section 2.
Date: 2026-10-03. Branch: `feat/d5-d7-live-plugin-checklist`.

## 0. Scope, versions, method

The check is local: macOS on the owner's machine and Linux in a Docker container on the same machine. The user's `~/.claude`, `~/.claude.json` and `~/.codex` were not changed: all runs go in a temporary profile, and a separate section of the tool verifies they are unchanged (section 8). No real model was called: both CLIs are pointed at local stubs, as in D.8.

**Versions and environment:**

- macOS 27.0.1 (26A434), Apple M4 Pro, arm64; Claude Code 2.1.288 from the native installer (`~/.local/bin/claude`); codex-cli 0.160.0 from Homebrew; account shell — `/bin/zsh`;
- Linux: container `node:26` (Debian 13 trixie, kernel 7.0.14-linuxkit, aarch64) in Docker Desktop 29.8.1 on the same machine; Claude Code 2.1.288 and `@openai/codex@0.160.0` from npm; run as user `node` with account shell `/bin/bash`;
- `@anthropic-ai/claude-agent-sdk` 0.3.288 with the bundled engine 2.1.288 — the tool installs it into the run's temporary directory;
- Node 26.10.0, `aang-hook` from this branch (for Linux — `GOOS=linux GOARCH=arm64`).

**Method.** The `tools/runtime-check` tool, `delivery` suite (`node tools/runtime-check/dist/main.js --suite delivery`). Run reports — [`samples/plugin-delivery/macos/report.json`](samples/plugin-delivery/macos/report.json) and [`samples/plugin-delivery/linux/report.json`](samples/plugin-delivery/linux/report.json); temporary paths are replaced with `<work>`, the home directory with `~`.

- Profile — the directory `<work>/Users/Όνομα Επώνυμο` with a space and Greek letters: inside are `.claude`, `.codex`, `.aang` (binary and spool with a lease) and the project `έργο με κενά`. `HOME`, `CLAUDE_CONFIG_DIR` and `CODEX_HOME` are set explicitly; the parent environment's `ANTHROPIC_*`, `CLAUDE*`, `CODEX_*`, `OPENAI_*` and `AANG_*` variables are removed. These runs used a Cyrillic profile name; the tools now use the Greek name shown here, which keeps the path non-ASCII and outside Latin-1.
- Installation — by the product code of `@aang/hook` (D.2–D.4), not by a copy of the configuration: `installClaudePlugin`, `claudePluginState`, `uninstallClaudePlugin`, `installCodexHooks`, `codexHooksState`. The fallback directory is built by the same `writeClaudePlugin` that generates the marketplace plugin.
- Model: Claude — a Messages API stub (`ANTHROPIC_BASE_URL`, stub key), Codex — a Responses API stub (provider without authorization). The scenario is N `Read` calls for Claude and `apply_patch` for Codex, then text.
- Codex hook trust was not confirmed: the aang installer does not write `hooks.state`, so Codex sessions run with the test flag `--dangerously-bypass-hook-trust`, as in D.8.
- Latency: a benchmark of launching `aang-hook` with the same launcher as the runtime (500 launches after 20 warm-up ones, stdin — `PreToolUse.Bash.json`), and the series increment in the real CLI — 15 pairs of sessions with and without aang hooks, 20 tool calls per session.

**Notation:** **Obs** — observed in a run; "both OSes" — on macOS and in the Linux container.

**Limitations:**

- the model is fake: delivery, hook execution and processes are checked, not model behavior;
- Linux is a container in the Docker Desktop virtual machine on the same machine, not a separate host; absolute latencies on native Linux will differ (D.8 gives measurements on `ubuntu-latest`);
- Desktop and the interactive TUI were not launched — that is the owner's D.7 checklist;
- Codex trust via `/hooks` was not checked (see above).

## 1. Key findings

1. **ADR-0004 decision 1 is confirmed.** The plugin installed by the product's `installClaudePlugin` via a local marketplace loads both in CLI 2.1.288 and in Agent SDK 0.3.288 with default `settingSources`; events reach the spool. Uninstalling and repeated installation and uninstallation work on the real CLI. There is no need to switch delivery to the fallback method.
2. **The fallback directory `<claude>/skills/aang/` also works** in the CLI and the SDK: the plugin loads without installation as `aang@skills-dir`.
3. **Exec form works on the installed version 2.1.288:** the binary and spool paths with a space and Greek letters arrive undistorted, `claude` launches `aang-hook` itself, without a shell.
4. **Latency is within the 10 ms budget on both OSes:**
   - macOS — p95 2.5–3.6 ms for Claude (exec form) and 5.2–6.2 ms for Codex (via the account shell); series increment — 3.7–5.6 ms per event for Claude and 4–6.4 ms for Codex;
   - Linux container — p95 1.4 and 1.7 ms; series increment — 2.1 ms per event for Claude, about 1 ms for Codex, at noise level.
5. **Codex executes the hook via the account shell** (`/bin/zsh -c` on macOS, `/bin/bash -c` on Linux), not via `sh`. A hook timeout does not block Codex for longer than 2 s, and the hook process is terminated; `exit 1` does not block; `exit 2` in `PreToolUse` blocks the call — `aang-hook` has no such code.
6. **Installing Codex hooks with the product code** on a real `codex app-server` in a temporary `CODEX_HOME`: the command line is stable across reinstallation, the state before trust is `untrusted`.
7. The user's `~/.claude` and `~/.codex` did not change.

## 2. Raised to the owner

D.5 found no budget overruns and no blocking runtime behavior, so no latency decisions are required. For information:

1. **The user's `~/.zshenv` is part of the latency of every Codex hook** on macOS: Codex runs the command via the account shell, and zsh reads this file on every launch. The owner's machine has no such file, and p95 is 5–6 ms. For a user with a heavy `~/.zshenv` the value will be higher, and aang has no influence on this: Codex hooks have no shell-less launch form (D.8). This changes neither installation nor the budget; the proposal is to show the actual latency in dynamic hook diagnostics, if it is ever needed.
2. **The `claudePluginState` enablement check knows only `aang@aang`.** As long as delivery goes through the marketplace (decision 1), this is correct. If delivery switches to the fallback directory, the check must be extended to `aang@skills-dir`.

## 3. Claude plugin delivery

**Marketplace (ADR-0004 decision 1)** (Obs, both OSes). `installClaudePlugin` generates the plugin in `<AANG_HOME>/claude-plugin` and runs `claude plugin marketplace add … --scope user --json` and `claude plugin install aang@aang --scope user --json` on the real CLI 2.1.288:

- both commands finish with `outcome: ok`; reinstallation passes without error;
- `claudePluginState` returns `enabled`; `claude plugin list --json` shows `aang@aang`, `scope: user`, `enabled: true`;
- `installPath` in the list points to the copy in `plugins/cache/aang/aang/1.0.0`, but in `init.plugins` and in the hook's `CLAUDE_PLUGIN_ROOT` it is the original marketplace directory `<AANG_HOME>/claude-plugin`: the CLI executes hooks from it, as on Windows in D.8;
- `uninstallClaudePlugin` removes the plugin and the marketplace, a repeated removal also passes without error; afterwards `claudePluginState` is `not_installed`, the plugin directory is removed, and a CLI session produces no events.

**Fallback directory** `<claude>/skills/aang/.claude-plugin/` (Obs, both OSes). The same plugin, written by `writeClaudePlugin` into `<CLAUDE_CONFIG_DIR>/skills/aang`, loads without installation as `aang@skills-dir`; `claude plugin list --json` shows it as `enabled`, `scope: user`. The directory is looked up relative to `CLAUDE_CONFIG_DIR`: in the run this is a separate directory, not `$HOME/.claude`.

**Events.** A session with two `Read` calls in each of the four variants produces 10 spool files: `SessionStart`, `UserPromptSubmit`, two each of `PreToolUse`, `PostToolUse`, `PostToolBatch`, then `Stop` and `SessionEnd` — as in D.8. All files carry the `plugin` tag; `CLAUDE_PLUGIN_ROOT` is the directory of the corresponding plugin.

| Method | CLI 2.1.288 (`-p`) | Agent SDK 0.3.288, default `settingSources` |
| --- | --- | --- |
| marketplace, `aang@aang` | 10 events, `CLAUDE_CODE_ENTRYPOINT=sdk-cli` | 10 events, `CLAUDE_CODE_ENTRYPOINT=sdk-ts`, `CLAUDE_AGENT_SDK_VERSION=0.3.288` |
| fallback directory, `aang@skills-dir` | 10 events | 10 events |

The SDK was called via `query()` without `settingSources`, `plugins` and `pathToClaudeCodeExecutable`: with the bundled engine 2.1.288 and the temporary profile's `CLAUDE_CONFIG_DIR` in `env`. In the SDK's `system/init` message, in both cases, there is the `aang` plugin with the same source as in the CLI. This closes the ADR-0004 question about loading `enabledPlugins` in the SDK.

Conclusion: ADR-0004 decision 1 is confirmed, there is no need to switch delivery to the fallback method. The fallback directory also works, but `claudePluginState` from D.2 looks only for `aang@aang`; if delivery is ever switched to the fallback method, the enablement check will have to be extended to `aang@skills-dir`.

## 4. Exec form

The aang plugin writes the hook as `command` — the absolute path of `aang-hook` — and `args`: `["claude", "plugin", "<spool>"]`, `timeout: 2`. The binary and spool paths lie in the `Όνομα Επώνυμο` profile, i.e. they contain a space and Greek letters.

- Without exec form such a command would produce no events: `command` would go to `sh -c` and split at the space, and without `args` `aang-hook` exits without writing. All sessions from section 3 delivered events with the correct tag and spool (Obs, both OSes).
- A probe in exec form (`command` — `node`, the log path with a space in `args`) receives its arguments without word splitting; its parent is the `claude` process itself (`~/.local/bin/claude` on macOS, `claude.exe` from the npm package on Linux).
- For comparison, the same command as a string without `args` is launched via `/bin/sh -c`. On Linux the probe's parent is `sh`; on macOS `sh` replaces itself with the command via `exec`, so the parent again appears as `claude`. On macOS exec form cannot be told apart by the parent; delivery with paths containing a space does tell it apart.

Exec form works on the installed version 2.1.288 on both OSes.

## 5. Codex hooks installed by aang

`installCodexHooks` in a temporary `CODEX_HOME` with a real `codex app-server` (`initialize`, `hooks/list` before and after writing) appends aang entries to all 12 events (Obs, both OSes):

- the command line is `'<AANG_HOME>/bin/aang-hook' codex user '<AANG_HOME>/spool'`, paths in POSIX single quotes. Exactly this line was measured in the latency benchmark; the series and the timeout check used the same quoting form;
- reinstallation changes neither the command line nor the bytes of `hooks.json`;
- `codexHooksState` returns `untrusted`: all 12 entries are `trustStatus: untrusted`, `enabled: true`, no warnings. This is expected: the user confirms trust via `/hooks`; aang does not write `hooks.state`;
- a `codex exec` session with `--dangerously-bypass-hook-trust` applies the patch and delivers 6 events with the `user` tag: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `SessionEnd`.

**What Codex executes the hook command with** (Obs). A probe with a compound command (`<probe>; true`), which the shell cannot replace via `exec`, shows the parent:

- macOS — `/bin/zsh -c '<command>'`;
- Linux — `/bin/bash -c '<command>'`.

This is the account shell from the user database, not `sh` and not `$SHELL`: on macOS with `SHELL=/bin/sh`, `SHELL=/bin/bash` and without `SHELL`, Codex still launched `/bin/zsh` (a separate experiment with the same probe). There is no `-l` flag, so login and interactive files are not read. But zsh reads `$ZDOTDIR/.zshenv` (by default `~/.zshenv`) on every launch: if the user has one, its time is part of the latency of every Codex event. The owner's machine has neither `~/.zshenv` nor `/etc/zshenv`. Both zsh and bash run the simple aang command via `exec`, so in the process tree the parent of `aang-hook` remains `codex`.

ADR-0013 spoke of `sh` on macOS and Linux; the wording has been clarified. POSIX quoting works the same in `sh`, `bash` and `zsh`; other account shells (for example, `fish`) were not checked.

## 6. Latency

The ADR-0013 budget is p95 ≤ 10 ms per event on the runtime side. The benchmark is 500 launches after 20 warm-up ones, stdin — `PreToolUse.Bash.json`, environment — from the spike plugin's envelope, as in D.1 and D.8. The launcher is reproduced from the observed processes:

- Claude — direct launch of `aang-hook` (exec form, section 4);
- Codex — `<account shell> -c '<aang command string>'` (section 5): `/bin/zsh -c` on macOS, `/bin/bash -c` on Linux. On macOS the benchmark runs with the owner's real `HOME`, i.e. with their zsh environment.

On macOS the machine was not dedicated: other development sessions were running in parallel. So two full runs are given, with the load average (`loadavg`) at start and end; the sample contains run 2. The Linux container gets its share of the same cores.

**Launching `aang-hook`** (ms, p50 / p95 / max):

| Launch method | macOS, run 1 (load 3.8 → 37) | macOS, run 2 (load 7.8 → 5.8) | Linux container |
| --- | --- | --- | --- |
| Claude: direct launch (exec form) | 2.63 / 3.60 / 6.67 | 2.16 / 2.48 / 2.82 | 0.89 / 1.44 / 2.01 |
| Claude: without a lease (no spool write) | 2.25 / 2.66 / 5.96 | 1.73 / 1.98 / 2.66 | 0.81 / 1.27 / 1.67 |
| Codex: aang command via the account shell | 5.25 / 6.16 / 7.77 | 4.14 / 5.17 / 6.68 | 1.10 / 1.66 / 2.50 |
| Codex: `aang-hook` alone with Codex arguments | 2.62 / 3.59 / 6.82 | 1.98 / 2.35 / 3.60 | 0.86 / 1.42 / 2.61 |

All launches finished with `exit 0` and no output; with a lease each wrote exactly one file, without a lease none. Launching zsh adds 2–3 ms on macOS on top of the binary itself, bash on Linux 0.2–0.3 ms.

**Series increment in the real CLI.** A session with 20 tool calls: 64 events for Claude, 44 for Codex. 15 pairs of launches with and without aang hooks, the order within a pair alternates. Given are the difference of medians and the median of within-pair differences, both divided by the number of events (ms):

| CLI | Environment | median with hooks | median without hooks | per event, by medians | per event, by pairs |
| --- | --- | --- | --- | --- | --- |
| Claude | macOS, run 1 | 824 | 463 | 5.64 | 4.42 |
| Claude | macOS, run 2 | 612 | 375 | 3.69 | 3.75 |
| Claude | Linux container | 491 | 358 | 2.09 | 2.04 |
| Codex | macOS, run 1 | 1552 | 1377 | 3.99 | 6.36 |
| Codex | macOS, run 2 | 1181 | 970 | 4.81 | 5.04 |
| Codex | Linux container | 1147 | 1112 | 0.81 | 1.11 |

Conclusions:

- On both OSes the latency of the installed configuration is within budget: launch p95 is at most 3.6 ms for Claude and 6.2 ms for Codex on macOS, about 1.5 ms in the Linux container.
- The series increment for Claude (3.7–5.6 ms per event on macOS) is larger than the binary's launch p95: it includes process creation, passing stdin and waiting for exit on the CLI side. It is also within budget.
- For Codex the spread of session durations (hundreds of milliseconds) is comparable to the total increment (44 events of a few milliseconds each), so the series estimates are rough: 4–6.4 ms on macOS and about 1 ms on Linux. The main reference for Codex is the benchmark with the same launcher.
- Not a single timeout and not a single hook error in the series.

## 7. Codex: hook timeout and non-zero exit code

A probe in the same form as the aang command, on one event: exit with a code or a 20 s sleep with `timeout: 2` (Obs, both OSes, identical):

| Case | Result |
| --- | --- |
| `PreToolUse`, `exit 1` | patch applied, session finished normally |
| `PreToolUse`, `exit 2` | **patch not applied**: Codex blocks the call, the turn finishes without a session error |
| `PreToolUse`, 2 s timeout | hook process terminated, patch applied, session about 2 s longer |
| `UserPromptSubmit`, 2 s timeout | hook process terminated, the turn continued |
| `Stop`, 2 s timeout | hook process terminated, session finished normally |

The conclusions are the same as in D.8 for Linux: a hanging or failing hook does not block Codex for longer than `timeout`, and the hook process does not stay alive after the timeout; `exit 2` in `PreToolUse` blocks the action. `aang-hook` always exits with code 0 (ADR-0013), so it has no blocking branch. The cost of a hang is up to 2 s per event; this is the limit of the ADR-0004 guarantee, not new behavior.

## 8. User profile left unchanged

The `user profile untouched` section compares SHA-256 of files before and after the run and looks for traces of the working directory (Obs, both OSes):

- `~/.claude/settings.json`, `settings.local.json`, `plugins/known_marketplaces.json`, `plugins/installed_plugins.json`, `~/.codex/hooks.json`, `config.toml`, `auth.json` did not change; the content was not read, only hashes were compared;
- no directories appeared in `~/.claude/skills`;
- `~/.claude/projects` has no project directory for the run's working directory, and `~/.claude.json` does not mention it;
- among the rollouts in `~/.codex/sessions` modified during the run, there are no mentions of the working directory.

For the duration of calls to product functions that launch `claude plugin` and `codex app-server` with the process environment, the tool replaces the process environment with the temporary profile's environment.

## 9. Not checked

- Claude Desktop (Local and worktree) and the interactive TUI — the owner's D.7 checklist (`docs/research/d7-owner-checklist.md`): there the plugin is installed by the same marketplace into the owner's real profile.
- Codex hook trust via `/hooks` and preservation of trust when the binary is updated in place — a contract test (ADR-0004) and D.7.
- Latency with a real model and with the user's `~/.zshenv`; account shells other than `zsh` and `bash`.
- Native Linux outside a container: here it is a container on macOS; reference values for native Linux are in D.8 (`ubuntu-latest`).
- The SDK exceptions from ADR-0004 (resume from `sessionStore`, `persistSession: false`, `settingSources: []` with `plugins`) — outside D.5.

## 10. How to reproduce

On macOS from the repository root with `claude` and `codex` on PATH (or `--claude <path> --codex <path>`):

```sh
pnpm install --frozen-lockfile
pnpm build
node tools/runtime-check/dist/main.js --suite delivery --agent-sdk 0.3.288 --out <report dir>
```

`--agent-sdk` is the version of `@anthropic-ai/claude-agent-sdk` that the tool installs via `npm` into the run's temporary directory (default `latest`). The output is `report.json` and `summary.md`; if a mandatory check fails, the tool exits with code 1. The temporary profile is created in `os.tmpdir()`; user configs are not changed.

Linux — the same suite in a container after building on the host and cross-compiling the binary:

```sh
OUT=$(mktemp -d) && chmod 777 "$OUT"
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -C packages/hook -o "$OUT/aang-hook" ./cmd/aang-hook
docker run --rm -v "$PWD:/repo:ro" -v "$OUT:/out" node:26 bash -c '
  npm install --global --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code@2.1.288 @openai/codex@0.160.0 &&
  su node -s /bin/bash -c "cd /home/node && node /repo/tools/runtime-check/dist/main.js --suite delivery --agent-sdk 0.3.288 --hook /out/aang-hook --out /out/report"'
```

The report will appear in `$OUT/report`.
