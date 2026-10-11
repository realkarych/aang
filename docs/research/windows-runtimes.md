# Runtime verification on Windows (D.8)

Status: report for plan item D.8 (`docs/plan/mvp.md`). This is not an ADR: discrepancies with ADR-0013 are recorded in ADR-0013, questions for the owner to decide are collected in section 2.
Date: 2026-10-02. Branch: `feat/d8-windows-ci-check`.

## 0. Scope, versions, method

The verification runs in GitHub Actions per the owner's decision of 2026-10-02 (ADR-0013, decisions 3–5): real `claude` and `codex` are installed on a `windows-latest` runner and pointed at local fake model endpoints. There are no secrets, real authorization is not used.

**Versions and environment** (runs of the `Runtime check` workflow on the branch: [1](https://github.com/realkarych/aang/actions/runs/37005795334), [2](https://github.com/realkarych/aang/actions/runs/37006364193), [3](https://github.com/realkarych/aang/actions/runs/37008157609), [4](https://github.com/realkarych/aang/actions/runs/37009527541) and PR run [5](https://github.com/realkarych/aang/actions/runs/37012137462) after rebasing onto `master` with the B.2 and C.4 adapters; the tables below are from runs 2–5, run 1 produced only the D.1 benchmark):

- Windows 10.0.26100 x64 (`windows-latest` runner), AMD EPYC 7763 or 9V74, Defender real-time protection disabled (`RealTimeProtectionEnabled: False`);
- Claude Code 2.1.286: the native installer (`install.ps1 2.1.286`) and npm `@anthropic-ai/claude-code@2.1.286`;
- Codex CLI 0.159.3: npm `@openai/codex@0.159.3` — the `bin/codex.js` wrapper and the native `codex.exe` from `@openai/codex-win32-x64`;
- Node 26.10.0, `aang-hook.exe` from this branch, Git for Windows 2.55, PowerShell 7 (`pwsh`) and Windows PowerShell 5.1;
- control — the same run on `ubuntu-latest`. This is not D.5: D.5 checks macOS and Linux locally.

**Method.** The `tools/runtime-check` tool (`node tools/runtime-check/dist/main.js --out <dir>`), the `.github/workflows/runtime-check.yml` workflow. The tool's report is `report.json` in the run artifact.

- The model is stubs inside the tool process: the Messages API for Claude (`ANTHROPIC_BASE_URL`, a stub key in `ANTHROPIC_API_KEY`) and the Responses API for Codex (provider `aang_stub` without authorization, as in the spike). The stubs respond by script: N tool calls, then text. Claude calls `Read`, Codex calls `apply_patch`, so that the tool itself spawns no processes.
- The profile is a directory `…\Users\Имя Фамилия` with a space and Cyrillic. Inside are `.claude`, `.codex`, `.aang` (a copy of `aang-hook.exe` and a spool with a lease) and the project `проект с пробелами`. `HOME` and `USERPROFILE` point to this directory, `CLAUDE_CONFIG_DIR` and `CODEX_HOME` are set explicitly. No Windows user account with this name was created.
- Claude hooks — the aang plugin in exec form on all events except `Worktree*`, `MessageDisplay` and `PreModelSwitch`, `timeout: 2`. The plugin is installed via a local marketplace (`claude plugin marketplace add`, `claude plugin install`), as D.2 will do. The probes are attached as a separate plugin via `--plugin-dir`.
- Codex hooks — `hooks.json` in a temporary `CODEX_HOME`; trust — via the test-only `--dangerously-bypass-hook-trust`.
- The probe is a Node script instead of the handler. It records argv, stdin size and the chain of parent processes: name and command line from `Win32_Process`.
- Latency is measured in two ways. The first is a series of `aang-hook` launches through the same launcher the runtime uses: the probe parent's command line is reproduced with the probe command replaced by the aang command. The second is series of real CLI sessions with and without aang hooks.
- The aang collector and adapters (`@aang/collector`, `@aang/adapter-claude`, `@aang/adapter-codex`) are run over the files written by the real CLIs.
- The process tree is checked by the harness `tools/runtime-check/assets/job-run.ps1` following the D.9 launcher scheme: a Job Object with `KILL_ON_JOB_CLOSE` without the right to break away from the job, starting the CLI suspended, assigning it to the job, resuming. Process starts across the system during the same time are recorded by `Win32_ProcessStartTrace`.

**Notation:** **Obs(CI)** — observed in a CI run; **Doc** — from binary strings or documentation.

**Limitations:**

- the model is fake: hook execution, files and processes are checked, not model behavior;
- storage of real OAuth authorization on Windows was not checked (decision 4): Claude works with a stub key, Codex with a provider without authorization;
- Claude Desktop and Codex Desktop on Windows were not checked (decision 3);
- the TUI was not launched, so `PermissionRequest`, `Notification` and questions were not triggered;
- the runner is a CI virtual machine. Absolute latencies on a user's machine will differ; on Windows this is a reference point (decision 5).

## 1. Key findings

1. **Claude: exec form works.** `claude.exe` launches `aang-hook.exe` directly; a path with a space and Cyrillic and the arguments arrive undistorted. The plugin is installed via a local marketplace and enabled.
2. **Codex executes the hook command only via PowerShell** (`pwsh.exe -NoProfile -Command`). The working string is `& '<path>\aang-hook.exe' 'codex' 'user' '<spool>'`; plain quoted strings do not launch. Codex hooks have no shell-less form.
3. **Latency above the 10 ms budget on Windows** (escalated to the owner; decisions of 2026-10-06 are in section 2):
   - direct launch of `aang-hook.exe` — p95 18–24 ms, almost all of it process creation;
   - Claude series overhead — 23–29 ms per event;
   - Codex hook — 0.25–0.4 s per event, a Codex session with aang hooks is 7–19 times longer.

   On Linux everything is within budget.
4. **A hook failure does not block the runtime.** A Codex timeout terminates the hook process with its descendants. `exit 2` through `pwsh` turns into 1 and does not block Codex.
5. **Files.**
   - Paths in the payload are native Windows paths;
   - the Claude project directory encodes `cwd` lossily;
   - JSONL is written with `\n`;
   - Claude takes its root from `USERPROFILE`, Codex from the OS account profile;
   - fs watch works, there are no exclusive locks;
   - the aang collector and adapters parse Windows files without `invalid`.
6. **Executables.** The npm shims `claude.cmd` and `codex.cmd` do not launch without a shell (`EINVAL`). The real files and the Codex wrapper have been found (section 8).
7. **Observer admission on Windows passes** with the ADR-0013 environment extended with `PATHEXT`: without it Codex does not run hooks, and the positive branch of admission fails.
8. **A Job Object following the D.9 scheme works with both CLIs.** All descendants stay in the job, stopping is confirmed. Codex leaves live `git` processes after it exits.

## 2. Escalated to the owner

Per ADR-0013, exceeding the hook budget is escalated to the owner. D.8 found no blocking runtime behavior and no CLI processes outside the job.

1. **Codex hooks on Windows — 0.25–0.4 s per event.** Codex starts PowerShell for every event, and this cannot be worked around by configuration: Codex 0.159 hooks have no shell-less form. A session with 20 tool calls with aang hooks takes 12–14 s instead of 0.8–1.7 s.

   Options:
   - a) install Codex hooks on Windows as on other OSes and show the cost in `aang install` and `status`;
   - b) do not install Codex hooks on Windows by default. Codex sessions then run in «только файлы» ("files only") mode ("approval waits are not visible", ADR-0004), and hooks are enabled explicitly;
   - c) wait for a shell-less launch form from OpenAI. Until then Codex on Windows works per option a or b.

   Without a decision, D.3 is not enabled on Windows.
2. **Direct launch of `aang-hook.exe` on Windows — p95 18–24 ms** (D.1 benchmark — 40–100 ms), Claude series overhead — 23–29 ms per event. Almost all the time is Windows process creation; without writing to the spool p95 is only 1–3 ms lower, so speeding up the binary itself will not change the value. A budget decision for Windows is needed (decision on PR #11): accept the measured value as the Windows budget or look for another hook transport.
3. **The observer environment list on Windows** is extended with `PATHEXT`, otherwise the positive branch of Codex admission fails. This is a refinement of ADR-0013 following D.8; it does not affect the working profile: hooks are disabled there.

**Owner decisions 2026-10-06** (ADR-0013, decisions 6 and 7):

- on item 2 — the `aang-hook.exe` budget for Claude on Windows is p95 up to 25 ms per event. On macOS and Linux the budget is still 10 ms;
- on item 1 — option "b": `aang install` on Windows does not install Codex hooks by default, and Codex sessions run in «только файлы» ("files only") mode (ADR-0004), approval waits are not visible. The explicit flag `aang install --codex` installs the hooks, and `aang install` and `aang status` warn about a 0.25–0.4 s per-event slowdown.

Per these decisions, hook installation on Windows is enabled (D.3, section 14).

## 3. Hook command execution

### Claude

- **Exec form works** (Obs(CI)). The aang plugin with `command` — the absolute path of `aang-hook.exe` — and `args` `["claude", "plugin", "<spool>"]` is installed via a local marketplace and enabled (`claude plugin list`: `enabled`). `claude.exe` launches `aang-hook.exe` directly, without a shell. The binary path and the spool path with a space and Cyrillic arrive undistorted: files appear in `spool\new` with the correct header.
- In a session with two `Read` calls, 10 events were delivered: `SessionStart`, `UserPromptSubmit`, two each of `PreToolUse`, `PostToolUse`, `PostToolBatch`, then `Stop`, `SessionEnd` — as on macOS and Linux.
- `CLAUDE_PLUGIN_ROOT` points to the plugin directory in the local marketplace (`<AANG_HOME>\claude-plugin\aang`); there is no copy in the plugin cache.
- **Without exec form** (`command` as a string without `args`) Claude runs the command via Git Bash: `claude.exe` → `C:\Program Files\Git\bin\bash.exe -c "<command>"` → `Git\usr\bin\bash.exe -c "<command>"` → the command process. A string with Windows paths in double quotes works in this case. The cost is two extra processes per event (section 4).

### Codex

- **Codex executes the hook command via PowerShell** (Obs(CI)): `codex.exe` → `"C:\Program Files\PowerShell\7\pwsh.exe" -NoProfile -Command "<command>"`. Codex finds `pwsh` even without the PowerShell 7 directory in PATH. What Codex launches on a machine without PowerShell 7 was not checked (probably Windows PowerShell 5.1).
- **Which string works.** Of six forms with paths in the `Имя Фамилия` profile, only two launch the binary — those with the call operator `&`:

  | Form | Example | Windows | Linux |
  | --- | --- | --- | --- |
  | double quotes | `"C:\…\aang-hook.exe" "codex" "user" "C:\…\spool"` | does not launch: PowerShell sees a string expression | works |
  | double quotes, forward slashes | `"C:/…/aang-hook.exe" …` | does not launch | works |
  | `&` operator, single quotes | `& 'C:\…\aang-hook.exe' 'codex' 'user' 'C:\…\spool'` | **works** | does not launch |
  | `&` operator, double quotes | `& "C:\…\aang-hook.exe" "codex" "user" "C:\…\spool"` | **works** | does not launch |
  | single quotes | `'C:\…\aang-hook.exe' 'codex' …` | does not launch | works |
  | no quotes | `C:\…\aang-hook.exe codex user C:\…\spool` | does not launch: the path with a space splits apart | does not launch |

  For installation, `& '<path>' 'codex' 'user' '<spool>'` should be used: inside single quotes PowerShell does not expand `$` or the backtick; only the single quote itself needs escaping (by doubling).
- **Codex hooks have no shell-less form** (Doc, binary strings of 0.160.0): `HookHandlerConfig::Command` has the fields `command`, `commandWindows`, `timeout`, `async`, `statusMessage`; there is no arguments field. `commandWindows` is a separate string for Windows; it also goes through PowerShell.
- **Exit code.** `pwsh -Command` converts a command exit code other than 0 and 1 into 1 (documented PowerShell behavior). Therefore on Windows `exit 2` from a hook does not block the action (section 5).

### Control on Linux

Claude without exec form goes through `sh -c`. For Codex the probe's parent is `codex` itself; this is compatible with the shell replacing itself with the command via `exec`, but the parent snapshot does not establish the original shell command. The working forms are in the table above.

## 4. Latency

The ADR-0013 budget is p95 ≤ 10 ms per event on the runtime side. Launch series — 500 after 20 warm-up runs, stdin — `PreToolUse.Bash.json`, environment — from the spike plugin envelope, as in the D.1 benchmark. Defender on the runner is disabled (`RealTimeProtectionEnabled: False`), so on a user's machine with protection enabled the values are probably higher.

**`aang-hook` launch latency** (ms, p50 / p95 / max). The launcher is reproduced from the probe parents' commands, except Codex on Linux: there only the binary with Codex arguments was measured, without the cost of the shell.

| Launch method | Windows, run 2 | Windows, run 3 | Windows, run 4 | Windows, run 5 | Linux, run 4 |
| --- | --- | --- | --- | --- | --- |
| direct launch (Claude exec form) | 17.6 / 19.9 / 27.6 | 18.9 / 22.8 / 31.6 | 21.5 / 24.3 / 34.3 | 14.2 / 17.6 / 140.3 | 2.8 / 3.3 / 7.2 |
| direct launch without a lease (no spool write) | — | 17.8 / 20.0 / 24.3 | 20.8 / 23.5 / 25.8 | 13.4 / 15.2 / 19.7 | 2.4 / 2.8 / 7.0 |
| Claude without exec form (Git Bash; on Linux — `sh`) | 53.4 / 60.4 / 95.7 | 55.0 / 59.5 / 265.1 | 79.0 / 140.9 / 575.0 | 43.4 / 522.3 / 686.2 | 3.2 / 3.6 / 5.4 |
| Codex command (`pwsh -NoProfile -Command`; on Linux — binary only) | 288.7 / 309.4 / 818.0 | 302.9 / 370.0 / 812.3 | 334.7 / 376.1 / 6306.7 | 239.6 / 276.8 / 1091.2 | 2.9 / 3.9 / 6.2 |
| Codex command without PowerShell 7 in PATH, 100 launches | — | 294.5 / 354.8 / 477.8 | 344.4 / 358.6 / 380.0 | 247.5 / 295.5 / 330.5 | — |

All 500 launches in each series exited with `exit 0` without output. With a valid lease each wrote a file to the spool; without a lease there are no files.

**Strict D.1 benchmark** (`pnpm benchmark`, the same measurement order inside Vitest) in runs 1 and 2 of this branch:

| Runner | p50 | p95 | max |
| --- | --- | --- | --- |
| `windows-latest`, run 1 | 10.82 | 101.63 | 457.47 |
| `windows-latest`, run 2 | 12.43 | 39.61 | 349.23 |
| `ubuntu-latest`, run 1 | 4.13 | 6.65 | 13.12 |
| `ubuntu-latest`, run 2 | 4.29 | 6.93 | 11.59 |

**Series overhead in the real CLI.** A session with 20 tool calls; five pairs of runs with and without aang hooks, medians (ms):

| CLI | OS, run | with hooks | without hooks | events per session | overhead per event |
| --- | --- | --- | --- | --- | --- |
| Claude (exec form) | Windows, 2 | 3151 | 1497 | 64 | 25.8 |
| Claude (exec form) | Windows, 3 | 3349 | 1473 | 64 | 29.3 |
| Claude (exec form) | Windows, 4 | 3627 | 1818 | 64 | 28.3 |
| Codex (`pwsh`) | Windows, 2 | 14,364 | 1598 | 44 | 290.2 |
| Codex (`pwsh`) | Windows, 3 | 13,708 | 1593 | 44 | 275.3 |
| Codex (`pwsh`) | Windows, 4 | 14,437 | 771 | 44 | 310.6 |
| Claude (exec form) | Windows, 5 | 2722 | 1256 | 64 | 22.9 |
| Codex (`pwsh`) | Windows, 5 | 11,584 | 1726 | 44 | 224.0 |
| Claude (exec form) | Linux, 4 | 1284 | 864 | 64 | 6.6 |
| Codex | Linux, 4 | 930 | 723 | 44 | 4.7 |

Conclusions:

- On Linux all methods fit the budget: p95 of direct launch 2.4–3.3 ms, D.1 benchmark — 6.7–6.9 ms, series overhead — 3–7 ms per event.
- On Windows a direct launch of `aang-hook.exe` takes 14–24 ms (p95 18–24 ms), and almost all of it is process creation: without writing to the spool p95 is only 1–3 ms lower. The D.1 benchmark gives p95 from 40 to 100 ms due to a long tail. This is above the 10 ms budget.
- A Codex hook on Windows costs 0.25–0.4 s per event due to starting PowerShell, with rare outliers up to seconds. Launching via Git Bash also gives a long tail (p95 up to 0.5 s in run 5), so exec form is mandatory for Claude. A Codex session with 20 `apply_patch` calls with aang hooks runs 7–19 times longer.
- Hooks do not block the runtime: not a single timeout and not a single error in the series.

## 5. Codex: hook timeout and non-zero exit code

The hook is a probe that exits with a given code or sleeps 20 s with `timeout: 2` (Obs(CI), runs 2–5):

| Case | Windows | Linux |
| --- | --- | --- |
| `PreToolUse`, `exit 1` | the action ran, the session ended normally | same |
| `PreToolUse`, `exit 2` | **the action ran**: `pwsh -Command` returned code 1 to Codex | the action was blocked (`Command blocked by PreToolUse hook`), as in the spike |
| `PreToolUse`, 2 s timeout | the hook process was terminated (the probe launched via `pwsh` too), the action ran, the session was about 2 s longer | same |
| `UserPromptSubmit`, 2 s timeout | the hook process was terminated, the turn continued | same |
| `Stop`, 2 s timeout | the hook process was terminated, the session ended normally | same |

Conclusions:

- A hook failure or hang does not block Codex: on timeout it terminates the hook process together with its descendant and keeps working.
- For aang, which always exits with code 0, the difference in handling `exit 2` on Windows does not matter.

## 6. File paths and formats

- **Paths in hook payloads** (Obs(CI)) are native Windows paths with `\` and Cyrillic, undistorted: `cwd` — `D:\…\Users\Имя Фамилия\проект с пробелами`, `transcript_path` — an existing file.
  - Claude: `<CLAUDE_CONFIG_DIR>\projects\<project dir>\<sessionId>.jsonl`.
  - Codex: `<CODEX_HOME>\sessions\YYYY\MM\DD\rollout-<time>-<thread_id>.jsonl`.
- **Claude project directory.** Every character of `cwd` other than Latin letters and digits is replaced with `-`: the drive colon, `\`, `_`, space and Cyrillic. Example: `D:\a\_temp\aang check 1790943995155\Users\Имя Фамилия\проект с пробелами` → `D--a--temp-aang-check-1790943995155-Users-------------------------------`. The rule is the same as on macOS. `cwd` cannot be recovered from the name; the adapter does not do that anyway (ADR-0013).
- **Line endings.** Both Claude transcripts and Codex rollouts on Windows are written with `\n`, without `\r\n` (0 of 80 and 0 of 25 lines). Parsing of `\r\n` in the collector remains in case files are edited by other means.
- **Default roots** (without `CLAUDE_CONFIG_DIR` and `CODEX_HOME`; `HOME` and `USERPROFILE` point to different temporary directories):
  - Claude writes the transcript and `.claude.json` to `%USERPROFILE%\.claude`, ignoring `HOME`;
  - Codex ignores both `HOME` and `USERPROFILE` and writes the rollout to the OS account profile (`C:\Users\runneradmin\.codex`).

  For a user both coincide with `%USERPROFILE%`, as in ADR-0013. Tests and tools that substitute the profile must set `CODEX_HOME` explicitly; the temporary HOME from T.1 does exactly that.
- The registry `<CLAUDE_CONFIG_DIR>\sessions\<pid>.json` exists during a session: an entry with `entrypoint: aang-observer` is visible for the observer. After the process exits, the entry is deleted.

## 7. File watching, locks, collector and adapters

During Claude and Codex sessions with aang hooks, the following ran concurrently (Obs(CI)):

- the aang collector (`createCollector`, `fsWatch: true`) on `<CLAUDE_CONFIG_DIR>`, `<CODEX_HOME>` and the spool;
- separate `fs.watch` with `recursive: true` on `projects`, `sessions` and `spool\new`;
- reading all `*.jsonl` every 50 ms.

Results:

- **fs watch.** Events with file names arrive for transcript appends, creation of `YYYY\MM\DD` directories and the rollout file, and renames of hook files in `spool\new`. There were no events without a name and no watcher errors.
- **Locks.** 730–840 reads per run of files that the CLIs were writing at the time — not a single failure. Neither Claude nor Codex holds an exclusive lock while writing.
- **Collector.** All spool files were accepted and deleted after `ack`, no gaps.
- **Adapters** (run 5, `master` adapters with B.2 and C.4). Records were parsed without `invalid`; `unknown` is for the same service types as on macOS and Linux.

  | Channel | Records | `parsed` | `unknown` |
  | --- | --- | --- | --- |
  | Claude transcript | 80 | 71 | 9 |
  | Claude hooks | 13 | 13 | 0 |
  | Codex rollout | 25 | 24 | 1 |
  | Codex hooks | 8 | 8 | 0 |

  The rollout stream is assigned the way `engine` does it: `streamKey` from the first lines of the file.

## 8. Executables and shims

Run 4: native installer and npm installation of Claude, npm installation of Codex (Obs(CI)).

| CLI | How installed | What is in PATH | Real executable |
| --- | --- | --- | --- |
| Claude | npm `@anthropic-ai/claude-code` | the shim `claude.cmd` and the sh script `claude` in `C:\npm\prefix`. The shim calls `node_modules\@anthropic-ai\claude-code\bin\claude.exe` directly, without `node` | `…\claude-code\bin\claude.exe` — a copy of the native binary from `@anthropic-ai\claude-code-win32-x64\claude.exe`, put there by `postinstall` |
| Claude | native installer (`install.ps1 2.1.286`) | nothing: the installer puts `claude.exe` in `%USERPROFILE%\.local\bin` and only suggests adding the directory to PATH | `%USERPROFILE%\.local\bin\claude.exe` |
| Codex | npm `@openai/codex` | the shim `codex.cmd` → `node …\@openai\codex\bin\codex.js` | `…\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe`; `codex.js` launches it as a child process |

- Launching from Node without a shell: `spawn('claude')` and `spawn('codex')` — `ENOENT`, `spawn('…\claude.cmd')` and `spawn('…\codex.cmd')` — `EINVAL`, the real `.exe` and `node codex.js` — work. This confirms ADR-0013: the daemon looks for the real executable or runs `node` with the package script.
- Installation specifics:
  - npm on the runner warns that the Claude Code `postinstall` is not covered by the `allowScripts` policy. If `postinstall` did not run (`--ignore-scripts`, a script policy), `bin\claude.exe` remains a stub — an sh script with an error message (Doc, package contents);
  - the native installer, run after the npm installation, removed the global npm copy of Claude: `bin\claude.exe` and the shims disappeared (Obs(CI), runs 2 and 3; in run 4 the order is reversed, and both copies are in place).

  The executable search in F.2 must check that the `claude.exe` found is the real binary, not the stub.
- Authorization storage was not checked (decision 4). Without signing in to an account, the CLIs worked only with model stubs.

## 9. Observer admission

The observer profiles from the spike (section 12) and ADR-0007 were launched from Node without a shell, with the real executable and the cleaned ADR-0013 environment: `USERPROFILE`, `HOMEDRIVE`, `HOMEPATH`, `APPDATA`, `LOCALAPPDATA`, `SystemRoot`, `TEMP`, `TMP`, `USERNAME`, the system `PATH` from the registry, and markers. For the stubs, `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY` and `CLAUDE_CONFIG_DIR` were added for Claude, and `CODEX_HOME` with the `aang_stub` provider in `-c` for Codex. The working directory is `os.tmpdir()\aang-observer\empty`; on the runner this is `C:\Users\RUNNER~1\AppData\Local\Temp\…`, with no `CLAUDE.md` or `AGENTS.md` in its ancestors. Results are the same in runs 2–5 (Obs(CI)).

**Claude** — the ADR-0007 automatic admission conditions were checked, including a rerun after review [6](https://github.com/realkarych/aang/actions/runs/37020675641) on commit `ac668df`:

- exit 0, `is_error: false`, `structured_output: {"ok": true}`;
- in `init` — `tools: ["StructuredOutput"]`, no MCP servers, only built-in plugins (`cc-plugin-agents-md`, `cc-plugin-plugin-authoring`), no skills; the model was given a single tool, `StructuredOutput`;
- the transcript was not written; the registry entry carries `entrypoint: aang-observer`;
- a control hook in the project `.claude/settings.json`: with `--setting-sources project` the marker appears, with `--setting-sources ""` it does not;
- in run 6 the Messages API first sends a `Write` call in a temporary directory, then `StructuredOutput`. With `Write` allowed, the marker appears; in the observer profile the CLI returns `No such tool available: Write` with `is_error: true`, no marker. Both sessions end with exit 0. This is confirmed on both Windows and Linux; the check is not limited to the tool list in `init`.

**Codex** — isolation is achieved, admission requires `PATHEXT`:

- the model catalog from `codex debug models --bundled`: 11 models, `gpt-6.1-sol` selected;
- exit 0, `turn.completed`, `last.json` — `{"ok":true}`; `originator: aang_observer`;
- no `body.tools`, `input[additional_tools].tools` is empty; trial calls to `exec`, `spawn_agent` and `request_user_input` got `unsupported`, stderr has `codex_core::tools::router: error=unsupported`;
- after `--ephemeral` there is no rollout; in run 6, before cleaning `CODEX_HOME`, the SQLite databases were also checked: `state_5.sqlite.threads` has 0 rows, `thread_history_1.sqlite` is absent. The result is the same on Windows and Linux and saved in `cleanEnv.sqlite`. If the history database exists, the harness checks all its data tables; the service table `_sqlx_migrations` is excluded. A read error or any session row fails admission;
- a control hook in `hooks.json` of the temporary `CODEX_HOME` with the test-only `--dangerously-bypass-hook-trust`:
  - with `--disable hooks` there is no marker;
  - **without `--disable hooks` in the ADR-0013 environment there is no marker either**, while with the full environment there is. Bisecting the variables showed that `PATHEXT` alone is enough; `ComSpec` is not needed. Without `PATHEXT` Codex cannot find what to launch the hook command with. The observer environment list on Windows is extended with `PATHEXT` (ADR-0013). With it, in run 5 the positive branch yields the marker, the negative one does not, and admission passes.

## 10. Process tree in a Job Object

The harness repeats the D.9 launcher scheme (ADR-0013) in PowerShell with C# via `Add-Type`. Steps:

1. A Job Object with `KILL_ON_JOB_CLOSE` without `BREAKAWAY_OK`.
2. `CreateProcessW` with `CREATE_SUSPENDED` and an explicit environment block; assignment to the job; resume.
3. Wait for the root to exit; list the job's processes.
4. `TerminateJobObject` and wait until no active processes remain in the job.

The job's process count (`TotalProcesses`) is matched against the tree reconstructed from `Win32_ProcessStartTrace`. The table is run 4; runs 3 and 5 give the same conclusions, the Claude observer profile in run 5 has 23 processes (Obs(CI)):

| Launch | Root | Processes in job | Tree from trace | Left after root exit | Active after job termination |
| --- | --- | --- | --- | --- | --- |
| Claude: session with hooks, `Read` and `Bash` | exit 0 | 90 | 90 | — | 0 |
| `codex.exe`: session with hooks and a shell command | exit 0 | 49 | 49 | 2 `git.exe` and `conhost.exe` | 0 |
| Codex via the npm wrapper (`node codex.js`) | exit 0 | 47 | 47 | 2 `git.exe` and `conhost.exe` | 0 |
| Claude: observer profile | exit 0 | 20 | 20 | — | 0 |
| Codex: observer profile | exit 0 | 1 | 1 | — | 0 |

- All descendants of both CLIs stay in the job. There are no attempts to break away from the job that would break `CreateProcess`: both CLIs work inside the job, including hooks, Git Bash, `pwsh`, `git` and `git-remote-https`.
- **Codex leaves live descendants after it exits**: two `git` processes (`git-remote-https`) were still running when `codex.exe` had already exited. The job terminated them. This confirms that the slot must not be released on root exit (ADR-0013).
- Stopping is confirmed immediately after `TerminateJobObject`: 0 active processes.
- Outside the tree, only unrelated processes started during the launches: `WmiPrvSE.exe` and `CompatTelRunner.exe` from `svchost.exe`, `wsl.exe` from the runner service `provjobd`, `BfeToolWin8.exe` from `WindowsAzureGuestAgent.exe` and the harness compiler `csc.exe`. No processes spawned by the CLIs via OS services were found.
- Tree composition:
  - Claude in a session launches `bash.exe` (Git Bash, 2 processes per command), `git.exe`, `reg.exe`, `where.exe`, `cmd.exe`, `conhost.exe` and itself (3 `claude.exe` processes);
  - Claude in the observer profile — the same `git`, `reg`, `where`, `cmd`, without Git Bash;
  - Codex in the observer profile — not a single descendant.

### 10.1. Investigation of the counter mismatch in PR #26

After rebasing, [run 37032768918](https://github.com/realkarych/aang/actions/runs/37032768918) failed the reconciliation twice. In the second attempt `codex.exe` gave 49 processes in the job and 48 in the trace tree: among the descendants there were seven `aang-hook.exe` instead of eight. In the first attempt the Codex wrapper had the same shortfall, 47/46. The old report saved only name histograms, so the PIDs of the missing processes cannot be recovered. For the Claude observer profile in the first attempt the Job contained 23 distinct PIDs and the trace 22 processes; the only histogram difference was a process with the unknown name `?`, which the harness managed to see in the job. This is evidence of an incomplete trace, not of a CLI process outside the job.

For the investigation, the report was extended with the raw events with PID, PPID, name, `TIME_CREATED` and receive time, as well as the list of PIDs observed in the Job. [Two full diagnostic runs](https://github.com/realkarych/aang/actions/runs/37036482283) and [a series of 12 repetitions](https://github.com/realkarych/aang/actions/runs/37039785212) passed. In [the next series](https://github.com/realkarych/aang/actions/runs/37041962910), repetition 12, `codex npm wrapper session`, it was possible to save the same tree right after the job was stopped, after the original 1.5 s and after 10 s:

| Snapshot after job stop | Total WMI events | CLI processes in trace | `TotalProcesses` | Active after `TerminateJobObject` |
| --- | --- | --- | --- | --- |
| 2 ms | 48 | 46 | 47 | 0 |
| 1,569 ms | 48 | 46 | 47 | 0 |
| 10,010 ms | 51 | 47 | 47 | 0 |

**The event not yet delivered at reconciliation time is `aang-hook.exe`, PID 6116.** Its parent chain: `node.exe` 9856 → `codex.exe` 2276 → `pwsh.exe` 2548 → `aang-hook.exe` 6116. `TIME_CREATED` and the event receive time matched: `134354372149021854`. In the late snapshot there were eight hooks, and the tree matched the Job. The two other late events are the unrelated `wsl.exe` 7288 and 8236 from the runner service `provjobd`; they are not part of the CLI tree. There is no PID reuse in this trace. The short-lived hook did not make it into the periodically sampled `Seen` list, but was counted in `TotalProcesses`.

Thus the proven cause of the reproduced failure is reading the asynchronous WMI trace prematurely after a fixed 1.5 s wait. The Job scheme terminated all processes, while the start event of one of them had not yet been delivered to the observer. This result explains the 47/46 mismatch; for the earlier attempts the exact PID and the distinction between a delayed and a lost event cannot be established from the saved histograms.

**Fix to the check.** After the original 1.5 s, PowerShell publishes snapshots until exact equality of the tree and `TotalProcesses` is confirmed, or until a limit of 10 s after the end of the launch in the Job. Node reconstructs the tree with one and the same function during the wait and the final check. The confirmation refers to a snapshot version; before exiting, PowerShell saves a new final snapshot, which Node re-reads after the process exits. A counter mismatch, a missing root event, an ambiguous tree, a trace error and a non-zero number of active processes remain errors. If an event is lost and does not arrive before the deadline, the check fails with the raw data; no ±1 tolerance is introduced.

Separately, a defect of accounting by PID alone was fixed: Windows can [reissue a PID after the process object is released](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/ns-processthreadsapi-process_information). The harness distinguishes events by the pair of PID and [`TIME_CREATED`](https://learn.microsoft.com/en-us/previous-versions/windows/desktop/krnlprov/win32-processstarttrace), stores the 64-bit value as a string and links a descendant to the latest preceding event of its parent. This is the event creation time, not a guaranteed process creation time. The root must match unambiguously by PID, the harness's parent PID and the executable name. This defect was not the cause of the reproduction described above.

The regression test uses [the raw events of repetition 12](../../tools/runtime-check/test/fixtures/delayed-trace.json): a separate process first publishes the 46/47 tree, then delivers event 6116 and the unrelated runner events. The check must wait for 47/47; an additional CLI event after confirmation must still fail the final reconciliation. Deadline expiry with an incomplete trace, PID reuse, reordering of events with identical times and ambiguous identities are also tested.

## 11. Not verified

- Claude Desktop and Codex Desktop on Windows — owner decision 3 (ADR-0013): in the support matrix the Desktop rows on Windows are `unverified`.
- Storage of real OAuth authorization on Windows — owner decision 4. Version admission (ADR-0007) checks authorization on the user's machine.
- The interactive TUI of both CLIs on Windows (ConPTY) — the owner checklist (D.7) and R.3.
- The D.9 launcher as a product: here the scheme was checked on a PowerShell harness; D.9 repeats it in Go with integration tests.

## 12. How to reproduce

- In CI: the `Runtime check` workflow runs on PRs that change `tools/runtime-check/**`, `packages/hook/**` or the workflow itself, and manually (`workflow_dispatch`). The result is the artifacts `runtime-check-Windows` and `runtime-check-Linux` (`report.json`, `summary.md`) and the job summary.
- Locally: `pnpm build`, then `node tools/runtime-check/dist/main.js --out <dir>` with `claude` and `codex` in PATH (or `--claude <path> --codex <path>`). The main sections work in a temporary profile with explicit `CLAUDE_CONFIG_DIR` and `CODEX_HOME`. The Job Object is checked only on Windows. The default-roots probe is skipped locally: without `CODEX_HOME` Codex uses the real OS account profile despite the `HOME`/`USERPROFILE` substitution. The `--disposable-profile` flag allows this probe only in a dedicated disposable account or CI environment; the workflow passes it on a disposable GitHub Actions runner.

## 13. Verification after the review of PR #26

[Run 6](https://github.com/realkarych/aang/actions/runs/37020675641), commit `ac668df`: both OSes passed the new explicit success conditions. A `checks` object with the statuses `passed`, `failed`, `skipped` and reasons was added to `report.json`; a mandatory check that did not pass yields a final exit 1. Skipping the Codex working form does not count as success. Negative probes of command syntax and hook codes are counted separately: on Linux a wrong form may block the test patch with code 2, even though the session and delivery via the working form succeed.

Checked are event delivery and session success, completeness of file reading by the collector, hook facts, both branches of the control markers, the attempt of the forbidden `Write`, the Codex SQLite and the confirmed Job Object stop. In run 6 all five Job Object roots exited with code 0, there are no active processes after the jobs were terminated; the number of processes in the job matched the trace: 90, 49, 47, 23 and 1. Exceeding the latency budget remains a finding for the owner from section 2.

The false-success regression is checked by a separate integration test: external CLI stubs respond to the version and model catalog requests but end all sessions with code 73. Before the fix the harness returned exit 0; now it must return exit 1 with a list of failed mandatory sections. A second integration test uses real SQLite and checks detection of session rows without a rollout and of database read errors.

## 14. Hook installation on Windows after the owner's decisions

The ban on installation on Windows was lifted in D.3 per the owner's decisions of 2026-10-06 (section 2).

- **Claude.** `aang install` installs the plugin in exec form, as on macOS and Linux.
- **Codex.**
  - Without flags, `aang install` on Windows does not install Codex hooks and prints that Codex sessions are visible only through files. `aang install --codex` writes the command `& '<path>\aang-hook.exe' 'codex' 'user' '<spool>'` (section 3).
  - Neutralized entries get the command `exit 0`: `true` is not a command in PowerShell.
- **`codex app-server` via the launcher.** Trust and hook state are checked by aang's own `codex app-server`, and on Windows any CLI is launched via the launcher `aang-hook launch` with a Job Object (ADR-0013, D.9). The launcher mode with input from the first n bytes does not suit the app-server.
  - Codex 0.160.0 (Obs, macOS), given the same three messages (`initialize`, `initialized`, `hooks/list`) in one batch, answers `hooks/list` only while the input is open. If the input is closed right after the batch, the app-server answers `initialize` and exits without answering `hooks/list`, with code 0.
  - Therefore the launcher got a `stream` mode: the launcher's stdin is passed to the CLI input as it arrives, and closing the launcher's stdin remains the stop command. The mode is not part of the 2026-10-06 decisions; it was accepted by the owner on 2026-10-07 (ADR-0013, technical decision 4).
  - A hung or lost launcher does not hold up the check: the deadline for stop confirmation is 10 s from the stop command, after which the check fails, and the next check of the same profile does not launch the CLI until confirmation (ADR-0013).
  - Integration tests check the mode on Windows. The daemon contract test checks installation and hook state with the real `codex` from CI (`AANG_ISOLATION_CODEX`) on three OSes.
- **CLI on Windows.**
  - The daemon finds the real Codex executable for the state check the same way as for Claude: `codex.exe` or `node` with the npm package script (ADR-0013).
  - `aang install --codex` runs `cli.codex` from the config or `codex` as is, while the launcher needs an absolute path to the executable. For an npm installation of Codex on Windows, `cli.codex` must point to the real `codex.exe` (section 8).
