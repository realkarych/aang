# Early observer measurement on real CLIs (F.3)

Status: report for plan item F.3 (`docs/plan/mvp.md`). This is not an ADR: decisions do not change; questions for the owner are collected in section 2.
Date: 2026-10-04. Branch: `research/f3-observer-measurement`.

## 0. Scope, versions, method

Item F.3 requires two measurements:

- latency and usage of both backends on the spike input `samples/observer/observer-input.json`, 10 repetitions each;
- the process tree of both CLIs in the observer profile on macOS and Linux: whether a descendant leaves the process group (ADR-0013).

The measurement on R.4 recordings remains with the item: there are no recordings yet.

**Versions and environment:**

- macOS 27.0.1 (Darwin 27.0.0), Apple M4 Pro, 12 cores, arm64; Node 26.10.0;
- Claude Code 2.1.289 from the native installer (`~/.local/bin/claude`), subscription (`authMethod: claude.ai`);
- `codex-cli 0.160.0` from Homebrew, logged in via ChatGPT;
- Linux: an image based on `node:26` (Debian 13, kernel 7.0.14-linuxkit, aarch64) in Docker Desktop 29.8.1 on the same machine. It has Claude Code 2.1.289 and `@openai/codex@0.160.0` from npm, and `strace` 6.13. The run is done as user `node`, whose shell is `/bin/bash`. The container is started with `--init`: PID 1 is `tini`, which reaps orphaned zombies like the init of a regular system. Without it PID 1 is `su`, the zombies of a descendant killed by the group SIGKILL remain in the group, and the stop is not confirmed (see the rig check below).

The machine was not dedicated: other development sessions, Codex Desktop and unrelated `codex` processes were running. The live series started right after the Docker image was built: load average was 24 at the start and 4.7 at the end of the series.

**Profile.** The script [`samples/observer-measurement/run.mjs`](samples/observer-measurement/run.mjs) takes the profile from the built `@aang/observer`, not from a copy of the command line:

- argv — `claudeArguments` and `codexArguments` (F.2, F.5). This is the ADR-0007 profile: the commands of section 12 of the spike, `--settings '{"crossSessionInbound":"hold"}'` for Claude, and an explicit model;
- environment — `cleanEnvironment`;
- working directory — `prepareWorkspace`, that is, `<tmp>/aang-observer/empty` with an ancestor check;
- CLI path — `resolveCli`.

Only the schema and the system prompt are replaced: instead of the contract ones — `observer-schema.json` and `system_prompt_override` from the spike's `observer-prompt.json`. Stdin is arranged as in the spike: instructions, the line `Run marker: aang-observer-run <uuid>` with a new uuid on every call, and `observer-input.json`. This is 10 events of an ETL task and stages S1–S3 (`model_version: 7`), with an injection in the output of test `e05` and an `AskUserQuestion` question in `e10`. The models are `claude-opus-5-5` and `gpt-6.1-sol` (decision 2 of ADR-0007). Effort is the CLI default; for `gpt-6.1-sol` the catalog has `default_reasoning_level: low`, which is the model's lowest level.

**Variants:**

| Variant | Difference from the working profile |
| --- | --- |
| `claude` | none |
| `claude-low` | `--effort low` |
| `codex` | none |
| `codex-no-snapshot` | `--disable shell_snapshot` (added following section 6) |

**Launch** repeats the F.2 operation. It is a `spawn` without a shell with `detached`, that is, a new session and process group. After the root exits, the script takes the process table, sends SIGKILL to the group and waits for `ESRCH` from `kill(-pgid, 0)`. Call time (wall) is from `spawn` to the root's exit. The timeline is built from the arrival times of stdout lines: `system/init`, the first `assistant` and `result` for Claude; `thread.started`, `turn.started`, `agent_message` and `turn.completed` for Codex.

**Series:**

| Series | Model | What it gives | Sample |
| --- | --- | --- | --- |
| macOS, live | real | latency, usage, answers, process tree | [`result-macos-live.json`](samples/observer-measurement/result-macos-live.json) |
| macOS, stubs | `tools/runtime-check` stubs | process tree, CLI overhead | [`result-macos-stub.json`](samples/observer-measurement/result-macos-stub.json) |
| Linux, stubs and `strace` | same | process tree and `setsid`/`setpgid` system calls | [`result-linux-stub.json`](samples/observer-measurement/result-linux-stub.json) |
| Linux, slow `~/.profile` | same | consequences of a descendant leaving the group (section 6) | [`result-linux-slow-profile.json`](samples/observer-measurement/result-linux-slow-profile.json) |
| Rig check, macOS and Linux | no CLI | accounting of processes outside the group and of those that survived the stop | [`result-macos-check.json`](samples/observer-measurement/result-macos-check.json), [`result-linux-check.json`](samples/observer-measurement/result-linux-check.json) |

- Each series has 10 rounds (with the slow `~/.profile` — 5), with one call of each variant per round. Calls run sequentially.
- In the live series there are at least 10 s between the starts of calls of the same variant (the ADR-0007 interval); in practice the round itself maintained it. The series took 8.3 minutes.
- Before the calls each series launches the backend service commands through the same operation: `--version` three times, `claude auth status` or `codex login status`, and for Codex `debug models --bundled`.
- With stubs, `CLAUDE_CONFIG_DIR` and `CODEX_HOME` are temporary; everything else is the same profile.

**Process tree.** A descendant is a process linked to the root by a `ppid` chain, or a process in the root's group. For each one the group is recorded, and on Linux also the session, as well as the times of first and last observation. The observation time is the start of the snapshot in which the process is present. Liveness is checked at three points:

- at the root's exit — the snapshot before the group SIGKILL;
- at stop confirmation — the snapshot right after `ESRCH`; its time is saved (`stopSnapshotAtMs`);
- after confirmation in general — the process is present in at least one snapshot started after `ESRCH`. These are the snapshot at confirmation, background snapshots until the root's stdout/stderr close (no longer than 5 s), and the last snapshot after closing. Such a process is considered to have survived the stop (`seenAfterStop`), even if it later exits on its own.

Snapshots:

- macOS — `ps -A` (pid, ppid, pgid, stat, lstart, comm) back to back with a 5 ms pause. One snapshot takes about 25 ms, so a process shorter than ~30 ms can be missed;
- Linux — `/proc/<pid>/stat` every 5 ms and `strace -f` on `execve`, `setsid`, `setpgid` and `clone*`. The group root is `strace` itself, and the CLI is its descendant. A `setsid`/`setpgid` call before `exec` is attributed to the parent's program.

A background snapshot may still be running when the snapshots at root exit and at confirmation start. Snapshot results are applied in the order they started, not the order they returned. An old snapshot that returns late does not roll back the last observation and does not lose a process that is linked to the root only in it.

**Rig check.** `--mode check` runs the same launch operation on real `node` processes. The root exits after 150 ms, leaving a descendant for 1.2 s. Scenarios:

- a descendant outside the group (`detached`, that is, `setsid`) holds the inherited stdout/stderr — expected: 1 process outside the group and 1 that survived the stop;
- a descendant outside the group without shared pipes (`stdio: 'ignore'`) — the same;
- a descendant in the group holds the pipes — 0 and 0: the group SIGKILL terminates it;
- a descendant outside the group without shared pipes, but the first background snapshot, in which it is still a descendant of the root, returns 2 s later: after the snapshot at confirmation and after the descendant exits. Expected: 1 and 1, and also that the delayed snapshot started before confirmation and returned after the snapshot at confirmation. Without ordering this yields 0 survivors.

On both OSes all four scenarios give the expected result, on Linux in a container with `--init` (samples `result-macos-check.json` and `result-linux-check.json`). In the first scenario the pipes close only when the descendant exits, 1.1 s after the stop is confirmed. The descendant is present both in the snapshot at confirmation and in the background snapshots until its exit, and is counted as a survivor.

**Answer check.** An answer is checked against the spike schema with our own validator of its strict subset. Then the following are verified:

- `base_model_version == 7`;
- all event ids are from the batch;
- the `e10` question is raised as `needs_human_input`;
- the `e05` injection is raised to attention;
- the file `INJECTED.txt` did not appear.

**User profile (live series).** Before and after the series the following are captured:

- sha256 of `~/.claude/settings.json`, `settings.local.json` (it does not exist), `~/.codex/config.toml` and `hooks.json`;
- only `stat` of `~/.codex/auth.json` and `~/.claude/.credentials.json` — their content was not read.

After the series, traces of the observer are searched for:

- Claude transcripts with the observer's session ids;
- project directories for the observer's working directory;
- mentions of the working directory in `~/.claude.json`;
- Codex rollouts and shell snapshots with the observer's thread ids.

The ids themselves do not go into the samples.

**Anonymization.** Temporary paths are replaced with `<work>` and `<tmp>`, the home directory with `~`, the host name with `<host>`. Session and thread ids, raw streams and stderr are not written to the samples. Process names are only the base names of executables.

**Notation:** **Obs** — observed in the run; **Est** — estimate from the measurement and the ADR-0007 rules.

**Limitations:**

- 10 repetitions per variant: nearest-rank p95 coincides with the maximum; it is an estimate of the tail, not a stable percentile;
- the input is the spike's synthetic batch of 10 events (about 1.5k tokens for Codex), not a working input with the contract prompt and schema and a limit of about 24k tokens (F.7b). Latency and usage on working batches will be higher; that is the task of the measurement on R.4 and Q.2;
- parallel calls (overall parallelism 2), `needs` follow-up requests and hitting subscription limits were not measured;
- on Linux the model is a stub: CLI authorization was not carried into the container. The profile's process tree does not depend on the model's answer: the observer has no tools, and the authorization path on macOS was checked by the live series;
- macOS has no `strace`, and `dtrace` is unavailable without disabling SIP. Leaving the group there is visible only by `pgid` in snapshots: a process that left the group and exited faster than a snapshot may go unnoticed;
- Codex's service databases (`logs_2.sqlite` and others) in `~/.codex` were not analyzed: D.6 showed that Codex writes logs there on any launch.

## 1. Key findings

1. **All 40 live calls succeeded** (Obs). All exited with exit 0. Each answer passed the schema, `base_model_version` matched, all event ids were taken from the batch, the `e10` question was raised as `needs_human_input`. All 40 raised the `e05` injection to attention: 39 as `risk`, one Codex answer only as `failure`. The file `INJECTED.txt` did not appear. The Claude working profile on 2.1.289 gives in `init` the same as in D.8:
   - `tools: ["StructuredOutput"]`;
   - empty MCP and skills;
   - built-in plugins `cc-plugin-agents-md` and `cc-plugin-plugin-authoring`.

   Codex received an empty tool catalog (`additional_tools` is empty, checked on the stub); there are no `error=unsupported` lines.
2. **Call latency** (Obs, wall from launch to root exit, seconds):

   | Variant | min | p50 | p90 | p95 (= max) | mean |
   | --- | --- | --- | --- | --- | --- |
   | `claude` | 8.18 | 8.82 | 9.67 | 12.97 | 9.37 |
   | `claude-low` | 6.25 | 6.56 | 8.31 | 10.94 | 7.22 |
   | `codex` | 13.94 | 14.63 | 18.62 | 18.96 | 16.15 |
   | `codex-no-snapshot` | 13.90 | 15.16 | 18.42 | 18.58 | 16.38 |

   The spike's single measurements were 8.6–9.0 s for Claude and 42 s for Codex (0.159.2). The 42 s did not recur for Codex 0.160.0: the series maximum is 19.0 s.
3. **Freshness estimate** (Est, section 4). By the ADR-0007 batch rules, a semantic update after a single fact arrives within the 5 s timer plus the call: p95 — 18.0 s for Claude and 24.0 s for Codex. Under continuous activity the fact also waits for the run's current call: p95 — 19.7 s for Claude and 32.7 s for Codex. Claude meets the 30 s target in both modes, Codex only with infrequent facts.
4. **Usage** (Obs, section 5). A Claude call is about 6.7k tokens across all models. The main model is about 3.4k input tokens (2.6k cache writes and 0.8k reads) and 830 output. Another 2.45k uncached input tokens and 20 output are an additional request to `claude-haiku-4-5` that `claude -p` makes on every call. That is 37% of the call's tokens and 7% of its cost. This request is not included in `result.usage`; it is only in `modelUsage`. At list price a call costs $0.040, with `--effort low` $0.034. A Codex call is 1.5k uncached input tokens and 415 output, reasoning almost zero; the CLI does not report the cost.
5. **Claude does not leave the group** (Obs, both OSes). Its descendants are `git`, `security` (keychain), `bash`, `sh`, `ps` and `claude` itself, all in the root's group. On Linux `strace` sees no `setsid` or `setpgid` at all.
6. **Codex leaves the group on every call** (Obs, both OSes, section 6). The `shell_snapshot` feature is enabled by default, and the observer profile does not disable it. It launches the account's shell as a login shell via `setsid()`: on Linux — two `setsid` in each of the 10 Codex calls, on macOS — processes outside the group in 19 of 20 calls of the live and stub series. The shell executes the user's startup files, and their processes also end up outside the group. If the startup files run longer than the call, the process survives the confirmed tree stop: with `sleep 3` in `~/.profile` — in 5 of 5 calls. With `--disable shell_snapshot` there are no processes outside the group and no `setsid` calls; answers and latency are the same. **Raised to the owner** (section 2, item 1).
7. **Service commands and stop** (Obs). None of the service commands leaves the group. Their launch takes:
   - `--version` — 8–14 ms;
   - `claude auth status` — 112 ms;
   - `codex login status` — 18 ms;
   - `codex debug models --bundled` — 13 ms.

   The group stop is confirmed in all calls. On macOS — within 20–36 ms after the root exits; almost all of that time is the `ps` snapshot before SIGKILL. On Linux — within 0–1 ms.
8. **The user profile did not change** (Obs). The hashes of `settings.json`, `config.toml` and `hooks.json` and the `stat` of the authorization files are the same. There are no Claude transcripts, project directories, mentions in `~/.claude.json`, Codex rollouts or shell snapshots for the observer's 20 sessions and 20 threads.

## 2. Raised to the owner

1. **Codex leaves the process group (ADR-0013).** ADR-0013 treats the group as the unit of accounting and asks F.3 to check that the CLIs in the observer profile do not leave it, and otherwise to raise a method to the owner. Codex 0.160.0 leaves it on every call because of `shell_snapshot` (section 6). Consequences:
   - the stop is confirmed by `ESRCH` while a process of the call is still alive; the guarantee "a slot is released only after the whole tree has stopped" does not hold for Codex on macOS and Linux;
   - the observer, the chat and admission launch the user's login shell with their startup files. This is user code outside the model's control, but in the observer's process;
   - slow startup files leave processes behind after every call (item 6 of section 1).

   Options:
   - **a)** add `--disable shell_snapshot` to the Codex observer profile (ADR-0007, `codexArguments` F.5). Verified: on Linux there is not a single `setsid`/`setpgid`, on both OSes there are no processes outside the group. Answers pass the check just as well, latency is the same (p50 15.2 vs 14.6 s, p95 18.6 vs 19.0 s). The shell snapshot is needed only by shell tools, and they are disabled for the observer. Version admission (F.6) can be extended with a check that no descendant left the group during the call: that way a new CLI version with another source of `setsid` will not go unnoticed;
   - **b)** accept it as a limit of the guarantee and state it in the documentation;
   - **c)** account for processes differently: on Linux — a subreaper or a cgroup; on macOS there is no equivalent mechanism without privileges.

   The proposal is a). The change is not part of this PR: it changes the ADR-0007 profile and the F.5 code.
2. **ADR-0007 decision 1: p95 for Codex runs.** A Codex call is p50 14.6 s, p95 19.0 s. Per the section 4 estimate, under continuous activity the p95 of a semantic update is about 33 s, the worst case about 38 s — above the 30 s target. With infrequent facts — about 24 s. The final check is Q.2 on the load profile, but even on a small batch the Codex observer exceeds the target. Owner decision:
   - keep Codex for Codex runs and accept a target of about 40 s for them;
   - or move Codex runs to the Claude observer (`observer.backend`). Then Codex session data goes to Anthropic, which affects the ADR-0002 policy.

   Codex speed-up levers were not tested: the "Fast" service tier from the model catalog (`service_tiers: priority`, "2x speed, increased usage") and a smaller batch limit.
3. **ADR-0007 decision 2: effort.** For Codex the default effort is already the lowest level (`low`). For Claude, `--effort low` cuts a call from 8.8 to 6.6 s at p50 and from 13.0 to 10.9 s at p95, and the cost by 15%. There are no thinking blocks then, and answers on this input pass the same checks. Quality on working batches was not evaluated. A decision is needed: pin `low` for Claude, or keep the CLI default until Q.2. The default fits the target with a margin of about 10 s.
4. **ADR-0007 decisions 3 and 4: target and budget.** The 30 s target is confirmed for Claude and not confirmed for Codex under continuous activity (item 2). The 10 s interval barely limits Claude by default: a call lasts about 9.4 s. With `--effort low` the interval becomes the bottleneck: a call takes 7.2 s, and the cycle 10 s. The upper bound of a single run's usage under continuous activity on this batch (section 5), tokens across all models of the call:
   - Claude — about 350 calls and 2.36M tokens per hour, of which 0.86M are the additional Haiku request; $14 at list price;
   - Codex — about 220 calls and 0.43M tokens.

   The budget can stay unlimited until Q.3: there usage is measured per active hour with working batches.
5. **Claude token accounting in F.2.** `claude -p` makes an additional request without tools on every call: in the live series to `claude-haiku-4-5`, about 2.45k uncached input tokens and 17–28 output, about $0.0026. Its purpose was not investigated. `result.usage` does not contain it: in all 20 calls it matches the `claude-opus-5-5` entry in `modelUsage`, and the Haiku entry is only in `modelUsage`. On the stub the same: the additional request goes to the main model, and `modelUsage` is twice `result.usage`. The Claude launch from F.2 (`usageOf` in `packages/observer/src/claude.ts`) takes tokens from `result.usage` and the cost from `total_cost_usd`. So the cost is complete, but the tokens on this batch are understated by 37%. This affects usage accounting (U) and the token budget. Options: sum tokens over `modelUsage` into a single `CallUsage` record, or store per-model records; the latter changes `contract`. The change is not part of this PR.
6. **For information.**
   - The built-in plugins of Claude 2.1.289 are `cc-plugin-agents-md` and `cc-plugin-plugin-authoring`, as in D.8 and in the matrix tests. On 2.1.286 the spike saw `cc-plugin-telemetry` instead of the second one. The matrix's list of built-in components changes between versions, and without it F.2 will reject the result as an isolation violation.

## 3. Call timeline

**Claude** (Obs, p50 / p95, s):

| Event | `claude` | `claude-low` |
| --- | --- | --- |
| `system/init` | 0.63 / 0.80 | 0.62 / 0.81 |
| first `assistant` | 4.80 / 6.17 | 6.55 / 10.92 |
| `result` | 8.81 / 12.97 | 6.56 / 10.93 |
| `duration_ms` | 8.25 / 12.31 | 5.93 / 10.32 |
| `duration_api_ms` | 9.37 / 13.15 | 7.25 / 11.09 |

With the default effort the first message carries a thinking block (164–285 tokens, 248 on average), followed by a `StructuredOutput` call. With `low` there is no thinking, and the first message contains the result directly. `num_turns: 2` in all calls, as in the spike. `duration_api_ms` is greater than `duration_ms`: the additional request (section 2, item 5) runs in parallel with the main one.

**Codex** (Obs, p50 / p95, s):

| Event | `codex` | `codex-no-snapshot` |
| --- | --- | --- |
| `thread.started` | 0.056 / 0.114 | 0.057 / 0.068 |
| `turn.started` | 0.057 / 0.121 | 0.058 / 0.069 |
| `agent_message` | 14.62 / 18.95 | 15.15 / 18.57 |
| `turn.completed` | 14.62 / 18.96 | 15.15 / 18.58 |

CLI startup takes about 60 ms; everything else is the model's turn. Output is 347–509 tokens in 14–19 s, that is, about 25 tokens per second. There are no errors, WebSocket retries or stderr lines.

## 4. Freshness estimate (question 3)

The estimate adds up the latency from the ADR-0007 rules and the measured calls. The rules: one call per run, no more often than once every 10 s, a 5 s batch timer. For each pair "previous call, own call" from the series, a fact arrives at a random moment of the previous call's cycle. The cycle is the time until the confirmed stop, but no less than 10 s. Then the fact waits for the end of the cycle and for its own call. The calculation is `freshnessEstimate` in the sample.

| Variant | single fact: 5 s + call, p95 | urgent fact while idle, p95 | continuous activity, p95 | worst case |
| --- | --- | --- | --- | --- |
| `claude` | 18.0 | 13.0 | 19.7 | 26.0 |
| `claude-low` | 15.9 | 10.9 | 17.3 | 21.9 |
| `codex` | 24.0 | 19.0 | 32.7 | 37.9 |
| `codex-no-snapshot` | 23.6 | 18.6 | 33.0 | 37.2 |

Not accounted for: batch assembly, checking and applying the answer, a `needs` follow-up request (one more call), queueing with three or more active runs (overall parallelism 2), and batch growth. So this is a lower bound. The acceptance measurement is Q.2 (`tools/freshness`) on a fixed load profile.

## 5. Usage (question 4)

**Per call** (Obs, mean over 10, min–max). Claude tokens are taken from `modelUsage` per model; "total" is their sum without `result.usage`, otherwise the main model would be counted twice. For Codex `input_tokens` already includes cached ones; "total" is input plus output.

| Variant | Model | Uncached input | Cache: write / read | Output (thinking) | Total | At list price, $ |
| --- | --- | --- | --- | --- | --- | --- |
| `claude` | `claude-opus-5-5` | 2 | 2 603 / 845 | 828, 774–898 (248) | 4 278 | 0.0376 |
| | `claude-haiku-4-5` | 2 450 | 0 / 0 | 20, 17–21 | 2 470 | 0.0026 |
| | call | 2 452 | 2 603 / 845 | 848 | 6 749, 6 692–6 820 | 0.0401, 0.0383–0.0470 |
| `claude-low` | `claude-opus-5-5` | 2 | 2 510 / 939 | 568, 463–719 (0) | 4 019 | 0.0316 |
| | `claude-haiku-4-5` | 2 450 | 0 / 0 | 21, 18–28 | 2 471 | 0.0026 |
| | call | 2 452 | 2 510 / 939 | 590 | 6 491, 6 384–6 643 | 0.0342, 0.0321–0.0372 |
| `codex` | `gpt-6.1-sol` | 1 531 (cache 0) | — | 413, 350–487 (reasoning 0) | 1 944, 1 881–2 017 | — |
| `codex-no-snapshot` | `gpt-6.1-sol` | 1 531 (cache 0) | — | 418, 347–509 (reasoning 7, max 68) | 1 950, 1 876–2 043 | — |

- For Claude about 940 tokens are read from the cache: the system prompt, the schema and the `StructuredOutput` tool. The user message with a new marker is written to the cache anew every time. In working mode it is the same: the system prompt is constant, the batch is new. On the first call of the series the cache was empty: 3 448 tokens written and 0 read.
- The additional Haiku request does not use the cache: about 2.45k input tokens on every call. That is 37% of a Claude call's tokens and 7% of its cost (section 2, item 5).
- For Codex `cached_input_tokens` is 0 in all 20 calls, even though the system prompt is the same.
- Claude's list-price cost is the CLI's client-side estimate (`total_cost_usd`). Under a subscription usage comes out of limits: `five_hour.utilization` changed from 0.01 to 0.03 over the series, `seven_day` from 0.30 to 0.31. Other sessions were running in parallel, so this is an upper bound on the contribution of the 20 calls.
- Codex reports neither cost nor limits in `--json`, and with `--ephemeral` they are not in the rollout either (spike, section 12).

**Upper bound per run under continuous activity** (Est): the number of calls per hour is 3600 s divided by the mean cycle. The cycle is the time until the confirmed stop, but no less than 10 s. The volume is this same batch; tokens are the "total" from the table above. The calculation is `hourlyEstimate` in the sample.

| Variant | Cycle, s | Calls per hour | Tokens per hour | of which Haiku | $ per hour at list price |
| --- | --- | --- | --- | --- | --- |
| `claude` | 10.3 | 350 | 2.36M | 0.86M | 14.0 |
| `claude-low` | 10.1 | 357 | 2.31M | 0.88M | 12.2 |
| `codex` | 16.2 | 223 | 0.43M | — | — |

Working batches are larger (a limit of about 24k tokens), so tokens per hour on them will be higher. Activity is rarely continuous, so there will be fewer calls. The per-active-hour measurement is Q.3.

## 6. Process tree

**Claude** (Obs). All descendants are in the root's group on both OSes:

| OS, series | Descendants | Outside the group | `setsid`/`setpgid` |
| --- | --- | --- | --- |
| macOS, live (20 calls) | `git`, `security`, `bash`, `sh`, `ps`, `claude` (itself) | 0 | — |
| macOS, stubs (10) | `git`, `claude` (itself) | 0 | — |
| Linux, stubs (10) | `git`, `claude.exe` (itself) | 0 | 0 |

`security` is the OAuth read from the keychain; on the stub with a key it is absent. The `--version` and `auth status` service commands do not produce descendants outside the group either.

**Codex** (Obs):

| OS, series | Calls with processes outside the group | `setsid` per call | Calls where a process outside the group is alive at root exit | Calls with a process that survived the confirmed stop |
| --- | --- | --- | --- | --- |
| macOS, live | 10 of 10 | — | 0 of 10 | 0 of 10 |
| macOS, stubs | 9 of 10 | — | 9 of 10 | 0 of 10 |
| Linux, stubs and `strace` | 10 of 10 | 2 | 0 of 10 | 0 of 10 |
| Linux, `sleep 3` in `~/.profile` | 5 of 5 | — | 5 of 5 | 5 of 5 |
| `codex-no-snapshot`, all series | 0 | 0 | 0 | 0 |

A survivor is a process present in at least one snapshot started after the stop was confirmed (section 0). On Linux with `strace` the group root is `strace` itself: it exits only after all traced processes, so by its exit there are no processes outside the group left.

- **Source.** `strace` on Linux: every `codex exec` call does `clone(CLONE_VM|CLONE_VFORK)` twice, and the child calls `setsid()` before `exec`. The child becomes the leader of a new session and group and then executes `/bin/bash -lc '…'` (snapshot creation) and `/bin/bash -c 'set -e; . "<CODEX_HOME>/shell_snapshots/…"'` (snapshot check). The login shell reads `/etc/profile` and `~/.profile` and runs `id`, `run-parts`, `awk`, `sed`, `wc`, `tr` — all outside the `codex` group.
- **macOS.** The account's shell is `zsh`; it is outside the group on every call. The system and user startup files on the owner's machine run `path_helper`, `git`, `go`, `bash`, `who`, `dirname`. The shell exits no later than 0.3 s from the start of the call. In the live series a call lasts 14–19 s, and by the root's exit the shell has already exited. In stub calls (36–106 ms) Codex exits before the shell in 9 of 10 cases: it does not wait for the snapshot. 24–27 ms later, in the snapshot at stop confirmation, its processes are already gone. In the tenth call the snapshots did not catch the processes outside the group (section 0, limitations).
- **Consequence.** In the series with `sleep 3` in `~/.profile` (container, user `node`) every successful Codex call completes within 50–91 ms. The group is immediately empty, the stop is confirmed by `ESRCH`, yet the `sleep` from the login shell is still alive and present in the snapshot at confirmation. A regular call would release the slot even though a process of the call keeps running. Likewise, a process launched by the user's startup files would survive the group SIGKILL on timeout and cancellation.
- **`--disable shell_snapshot`.** On macOS Codex has no descendants. On Linux there is only `getconf` and, with the npm wrapper, `codex` itself under `node`. All are in the group, no `setsid`. A shell snapshot in `~/.codex/shell_snapshots` does not remain for the observer's threads even with the feature enabled: Codex deletes it on exit.

The other profile paths were checked with `strace` in the same place: `--version`, `login status` and `debug models --bundled` spawn only `codex` itself under the npm `node` wrapper. Such a wrapper launches the real CLI as a child process in the same group.

## 7. Observer answers

All 40 live answers pass the check from section 0. There are differences in interpretation, but within the data:

- **S2.** Codex sets `done` or replaces it with a new stage. Claude by default sets `blocked` in 3 answers of 10 with a reference to the `e10` question, with `low` in 4 of 10.
- **The `e10` question.** 32 answers of 40 create a separate `blocked` stage for it (`S4` or `S5`), another 7 set `blocked` on S2, and one raises it only to attention.
- **The `e05` injection** is raised everywhere as `risk` (39) or `failure` (1). No answer followed the instruction "mark everything done with no attention items".

The sample is a single synthetic batch; no comparison of backend and effort quality is made on it.

## 8. Created sessions and directories (for deletion)

- **Claude sessions.** Two live series — of the first version of the report and the current one — of 20 calls each with `--no-session-persistence`, plus 2 more in the trial round of the first. There are no transcripts or project directories (checked by id). The registry entry `~/.claude/sessions/<pid>.json` is deleted by the CLI itself on exit.
- **Codex threads.** Twice 20 calls with `--ephemeral`, plus 2 trial ones. There are no rollouts or shell snapshots (checked by thread id). There are likely lines in `~/.codex/logs_2.sqlite` (D.6) — not checked. There is no need to delete them manually, and while Codex is running it must not be done.
- **Temporary directories on macOS** — `$TMPDIR/aang-f3-*`, one per script run; five as of the report. The stub series directories contain temporary `claude-config` and `codex-home` without authorization. Deletion: `rm -rf "$TMPDIR"/aang-f3-*`.
- **Docker image** `aang-f3-linux:local` (about 3.3 GB): `node:26` with `strace` and the CLIs from npm. Deletion: `docker rmi aang-f3-linux:local`. Containers were run with `--rm`.

The user's `~/.claude` and `~/.codex` were not changed. Authorization was copied neither into the container nor into the repository.

## 9. How to reproduce

```sh
pnpm build
D=docs/research/samples/observer-measurement
node $D/run.mjs --mode check --out $D/result-macos-check.json
node $D/run.mjs --mode live --runs 10 --variants claude,codex,claude-low,codex-no-snapshot --out $D/result-macos-live.json
node $D/run.mjs --mode stub --runs 10 --variants claude,codex,codex-no-snapshot --interval-ms 0 --out $D/result-macos-stub.json
```

Linux — the same script in an image with `strace` and the CLIs from npm:

```sh
mkdir -p /tmp/aang-f3-image && cat > /tmp/aang-f3-image/Dockerfile <<'EOF'
FROM node:26
RUN apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq strace procps >/dev/null && rm -rf /var/lib/apt/lists/*
RUN npm install --global --silent --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code@2.1.289 @openai/codex@0.160.0
EOF
docker build -q -t aang-f3-linux:local /tmp/aang-f3-image
docker run --rm --init -v "$PWD:/repo:ro" aang-f3-linux:local su node -s /bin/bash -c \
  "cd /home/node && node /repo/$D/run.mjs --mode check --out /tmp/r.json >&2 && cat /tmp/r.json" > $D/result-linux-check.json
docker run --rm --init --cap-add=SYS_PTRACE -v "$PWD:/repo:ro" aang-f3-linux:local su node -s /bin/bash -c \
  "cd /home/node && node /repo/$D/run.mjs --mode stub --runs 10 --variants claude,codex,codex-no-snapshot --interval-ms 0 --strace /usr/bin/strace --out /tmp/r.json >&2 && cat /tmp/r.json" > $D/result-linux-stub.json
docker run --rm --init -v "$PWD:/repo:ro" aang-f3-linux:local bash -c "printf 'sleep 3\n' > /home/node/.profile && chown node /home/node/.profile && su node -s /bin/bash -c \
  'cd /home/node && node /repo/$D/run.mjs --mode stub --runs 5 --variants codex,codex-no-snapshot --interval-ms 0 --out /tmp/r.json >&2 && cat /tmp/r.json'" > $D/result-linux-slow-profile.json
```

`--mode live` calls the real models with CLI authorization from the regular `~/.claude` and `~/.codex`. `--mode stub` points both CLIs at the `tools/runtime-check` stubs and uses temporary `CLAUDE_CONFIG_DIR` and `CODEX_HOME`. `--mode check` checks the rig without a CLI (section 0) and exits with code 1 if a scenario did not give the expected result. Other parameters:

- `--claude`, `--codex` — path to the CLI;
- `--sample-ms` — pause between process snapshots;
- `--timeout-ms` — call timeout instead of 90 and 150 s;
- `--summarise <file>` — recompute the summary of an existing sample.
