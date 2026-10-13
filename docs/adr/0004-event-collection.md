# ADR-0004: Event collection

Superseded in part by [ADR-0015](0015-ui-simplification.md).

Status: accepted by the owner 2026-10-01; the `stat` check of active files (decision 14) and Claude session process liveness (decision 13) approved by the owner 2026-10-07. The addendum on the Codex hooks check after the Q.1 finding (section "Channels") approved by the owner 2026-10-08.

## Context

RFC §4, §7 and §8 require observing Claude Code and Codex on all local surfaces, showing an explicit input request without an LLM, not blocking the solver when aang fails, bounding queues and recovering without duplicates. The spike (`docs/research/integrations.md`, sections 1–3, 5.1, 5.3) showed:

- live events and approval waits come only from hooks; explicit questions are also visible in files;
- content, links, usage and recovery come from Claude transcripts and Codex rollouts;
- the human's approval decision in Codex is visible only in OpenTelemetry;
- the Codex app-server interferes with other sessions.

## Decision

### Channels

| Channel | Runtime | Role |
| --- | --- | --- |
| hooks → spool → daemon | both | live events: tool start, approval and input waits, subagents, Stop, Interrupt |
| tail of `<claude>/projects/**`: `*.jsonl`, `subagents/**`, `*.meta.json`, `workflows/*.json`, `journal.jsonl`; the `tool-results/*` files referenced by `persistedOutputPath` | Claude | content, links, usage, backfill; source of truth for content |
| `<claude>/teams/*/config.json` | Claude | teammate links |
| tail of `<codex>/sessions/**` and `archived_sessions/` | Codex | content, links, usage, backfill |
| OTLP/HTTP JSON, `/v1/logs` only | Codex | `codex.tool_decision`, at the user's option |
| `<claude>/sessions/<pid>.json` | Claude | hint: `status`, `waitingFor`, process liveness (decisions 3 and 13) |

- `<claude>` is `$CLAUDE_CONFIG_DIR` or `~/.claude`, `<codex>` is `$CODEX_HOME` or `~/.codex`; on Windows `~` is `%USERPROFILE%` (ADR-0013). The list of roots is set in the aang config.
- Hook and file records about the same object are merged by object keys (ADR-0006). On disagreement, content comes from files, time is the earliest observed, and human waits come from hooks and the registry.
- The Codex app-server is not used for sessions not launched by aang:
  - aang does not connect to the user's shared daemon;
  - does not call `thread/resume` on other threads;
  - does not answer server requests;
  - does not use the app-server as a rollout parser.

  A dedicated stdio `codex app-server` process is allowed only for `hooks/list` during the trust check, with no thread operations. D.6 checked it in the standard `~/.codex` (`docs/research/d6-app-server-live.md`):
  - `initialize` and `hooks/list` create no threads, change no configs or trust, start no MCP and do not touch the user's daemon;
  - at startup, even before `initialize`, the process itself contacts OpenAI services on the user's behalf: remote control, model list, plugin catalog and sync. It writes logs and caches to `CODEX_HOME`, and without remote plugins it leaves `.tmp/git-*` after each short run.

  Therefore the process exits right after the `hooks/list` response, and the check runs only on an event: install and uninstall, `aang status`, `doctor`, daemon start, a change to `hooks.json` or `config.toml`. The daemon keeps the last state and does not start the app-server on every state request or on a timer.

  The addendum after the Q.1 finding (PR #160, "Needs attention", item 4: on Windows the daemon's and the installer's app-servers interfered with each other) was approved by the owner 2026-10-08 and refines the rules above:
  - without the command line of the current aang installation in `hooks.json`, the app-server is not started on any event, and the state is "not installed". This is the default for Codex on Windows (ADR-0013, decision 7);
  - the daemon's check and the installer hold the same `.aang-lock` lock next to `hooks.json` and do not run concurrently;
  - the daemon checks file changes after 2 s without new changes, but no later than 10 s after the first one, and one check covers them all;
  - the installer writes the result of its control `hooks/list` reconciliation, with a fingerprint of `hooks.json` and `config.toml`, to `<AANG_HOME>/codex-hooks.json`. On a file change the daemon takes the state from there or from its own previous check if the fingerprint matches, and does not start the app-server. Daemon start and `aang status` check afresh;
  - after a failed check the daemon takes the state neither from its memory nor from the installer's record until a check via `hooks/list` passes again. "Not installed" due to the absence of aang entries in `hooks.json` does not replace it: when the entries come back, even with the same bytes, the check is full again. Every event leads to a full check, and while the stop of the previous app-server's tree is not confirmed, the check fails without starting the CLI, and the state stays `unknown` (ADR-0013).
- Not used in the MVP:
  - Codex internal sqlite (`state_5`, `thread_history_1`) and `thread-writer-locks`;
  - `claude agents --json` — the wait status would require starting a CLI process on every poll (decision 3);
  - Claude Agent SDK OTel;
  - a wrapper around the SDK.

  Support without internal indexes is mandatory.

### Hook handler contract

- **Handler:** a single one, the native executable `aang-hook <runtime> <registration tag> <spool>` in Go for macOS, Linux and Windows (ADR-0013). The tag distinguishes registration places: `plugin` for the Claude plugin, `user` for the Codex `hooks.json`.
  - `aang install` copies it unchanged to `<AANG_HOME>/bin/` and passes the absolute spool path as a command argument: the solver's environment does not contain `AANG_HOME`.
  - Hook configs call the binary by absolute path; Claude in exec form, without a shell (ADR-0013). The command does not change between aang versions, the binary is updated in place; this way Codex's trust in the hook is preserved.
- **Mode:** synchronous hook, `timeout: 2` s, no `async`, no network and no waiting for the daemon.
- **Write:** one event — one file. The handler creates a temporary file in `spool/tmp/` and renames it into `spool/new/`.
  - The file name is the deduplication key of the raw record: receiving the same file again adds nothing.
  - A hook may be registered twice: the plugin and `plugins` in an SDK application, or `CLAUDE_CODE_PLUGIN_DIRS`. The spike saw identical payloads from two registrations. The rule is conservative:
    - Events with an occurrence identifier (`tool_use_id`) are merged by it and the event name.
    - Events without such an identifier (`PermissionRequest`, `Notification`, `Stop` and others) are never merged: each file is a separate episode, and its identifier is the file name.
    - Identical events from different registrations (the tag and `CLAUDE_PLUGIN_ROOT` from the header) no more than 2 s apart are linked as a "possible redelivery". The UI shows them as a group with a counter and an ambiguity mark; none is hidden.
    - If events from two registrations are seen in a session, `aang status` and `doctor` report the double registration as a configuration problem: the cause has to be removed, not the copies guessed.
  - The receive time is the file `mtime` with nanoseconds.
- **File format** — the boundary between `hook` and `collector`:
  - the first line is `aang-spool/1 <runtime> <registration tag>`;
  - then `KEY=value` records, each terminated by a NUL byte; values are passed as is in UTF-8;
  - an empty record (an extra NUL) terminates the header;
  - then stdin follows unchanged.

  Variables: `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_AGENT_SDK_VERSION`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_HOST_SESSION_ID`, `CLAUDE_PID`, `CLAUDE_PROJECT_DIR`, `CLAUDE_PLUGIN_ROOT`, `AI_AGENT`, `CODEX_HOME`, `CODEX_INTERNAL_ORIGINATOR_OVERRIDE`.
- **Exit:** the handler always exits with `exit 0`, never produces `exit 2` or a `decision` JSON, and writes nothing to stdout or stderr: both runtimes add the stdout of some events to the context.
  - How this is ensured in Go (argument errors, panic, memory) and what the binary cannot guarantee (external termination, a fatal environment error) is described in ADR-0013.
- **Exit without writing:**
  - with `AANG_OBSERVER=1` or `CLAUDE_CODE_ENTRYPOINT=aang-observer`;
  - with the intentional stop marker `spool/stopped` — even with a valid lease;
  - if there is no valid spool lease. The lease is the file `spool/lease-<expiry in Unix seconds>`.
    - `aang start` removes the marker and creates a 24-hour lease; the running daemon renews it every hour. `aang stop` writes the marker and deletes the lease — including when the daemon has crashed or hung. While the marker exists, the daemon neither creates nor renews the lease (ADR-0013).
    - The handler finds the marker and the lease file with a single listing of the spool directory and compares the expiry with the system time.
    - On an intentional aang stop the spool stops growing immediately. After a daemon crash, events are still kept for 24 hours for recovery, after which writing stops.

  Stdin is still read to the end in this case, so that the solver does not get a pipe write error.
- **Unavailable spool:** the event is lost, the handler still exits with `exit 0`. Content is then recovered from files, and the lost wait is marked as a gap.
- **A file with an unrecognized header** (wrong signature, unknown runtime or tag, no empty record at the end of the header, a record without `=`) does not become a raw record and is not deleted after `ack` (decision 11):
  - the collector writes an `unknown_records` gap with the subject `spool:<file name>`; after a restart the gap comes again with the same key;
  - the file stays in the spool and is visible in its statistics;
  - it is discarded together with the other files by the `spool.maxAgeDays` age.
- **Budget:** p95 per event on the runtime side — including the launcher and stdin transfer (ADR-0013): on macOS and Linux ≤ 10 ms, for Claude on Windows ≤ 25 ms (ADR-0013, decision 6). There is no budget for Codex hooks on Windows: PowerShell costs 0.25–0.4 s per event, so they are installed only explicitly (ADR-0013, decision 7). The binary benchmark runs locally on each OS, the integration test in CI holds thresholds with a per-OS margin; the final value comes from measurements of the installed configuration on the real CLIs.
- **Directory:** the spool lives in `AANG_HOME`: permissions 0700 on macOS and Linux, the user profile ACL on Windows (ADR-0013). A file is deleted after commit to the store (ADR-0005).
- **Queue bounding:**
  - with a dead daemon the lease bounds writing to one day of solver activity without scanning the directory in the hook;
  - at startup the daemon discards spool files older than 7 days (configurable), recording a gap, and removes leftovers in `spool/tmp` from processes killed by timeout;
  - the running daemon checks the spool size once a minute. If it exceeds the threshold (1 GB by default), the daemon immediately deletes the lease, writes a gap and restores the lease after the queue is drained. This is a reaction threshold, not a hard limit: during the minute between checks and during unfinished writes the queue can grow beyond the threshold;
  - `aang status` shows the number and size of spool files, the lease expiry and the stop marker.
- **Registered events:**
  - Claude — all except `WorktreeCreate`/`WorktreeRemove` (the hook replaces worktree creation), `MessageDisplay` (frequent deltas; the content is in the transcript and `Stop`) and `PreModelSwitch` (a hook cancelled by timeout blocks the model switch; the switch is shown by `PostModelSwitch` and the transcript);
  - Codex — all 12.
- **There is no HTTP intake of hooks.**
  - HTTP hooks are not used: they are not called on `SessionStart`, and they lose events when the daemon is unavailable.
  - The daemon watches `spool/new` via fs watch, with a latency of milliseconds. The watch is only a signal: the directory is listed every 5 s and right after a watcher error or overflow, so a lost notification delays an event by no more than the scan interval (ADR-0013).
  - The intake token from ADR-0003 is used only by the OTel receiver.

### Installation

- **Claude — via the aang plugin (approved by the owner).**
- **Codex — `aang install` writes `~/.codex/hooks.json`, the user confirms trust via `/hooks` (approved by the owner).** Write method:
  - aang entries are only appended to the end of arrays, because the trust key is positional (`hooks.state."<path>:<event>:i:j"`);
  - stale aang entries (for example, `aang hook` from earlier installations) are not removed but neutralized in place: a modified entry loses trust and is silently skipped, and the positions of other entries do not shift;
  - `hooks/list` is reconciled before and after installation: the `trustStatus` of other entries must not change;
  - a backup is made;
  - its own changes are serialized via `.aang-lock`; protection against external writers without this lock is best effort: changes made before the control reconciliation are preserved on retry, but a write between the last reconciliation and `rename` may be lost (known limitation);
  - aang does not write `hooks.state` to `config.toml`.

  Trust preservation when the binary is updated in place is known only from documentation and is checked by a contract test.
- **"hooks inactive" (approved by the owner).** The UI and `aang status` show it per runtime and per session:
  - statically — the plugin is not enabled, or the Codex entry's `trustStatus` is not `trusted` according to `hooks/list`;
  - dynamically — session lines appear in files, but there are no hook events from it;
  - mid-session (approved by the owner 2026-10-07) — the session already had hook events, a human prompt is visible in files, and there are no hook events for this turn for longer than `freshness.hooksInactiveAfterMs` (30 s by default). Details:
    - a prompt is a `prompt` fact of the main agent from the transcript or rollout, from the human; command prompts (`/model` and the like) and runtime service prompts do not open a turn;
    - a hook event of this turn is a session hook fact with the same turn identifier (`prompt_id` for Claude, `turn_id` for Codex) or not earlier than the prompt;
    - while there are no hook events, the session mode is "files only", freshness is `hooks_inactive`, and `aang status` lists it among `hooks_inactive_sessions`;
    - each such period is a separate `hooks_inactive` gap of the session. The gap starts at the prompt time; several consecutive turns without hooks give one gap;
    - the next hook event of the session closes the gap at its time, and the mode is full again. Closed gaps remain in the session history;
    - a period shorter than the threshold leaves no gap;
    - prompts before the first hook event of the session are covered by the rule of the previous item.
- **Delivery and removal:**
  - `aang install` generates the plugin in `~/.aang/claude-plugin/` and installs it in the user scope via a local marketplace and `claude plugin` commands (decision 1);
  - the expected plugin coverage is CLI, Desktop Local/worktree and Agent SDK with default `settingSources`. Loading of the marketplace plugin and of the fallback directory in CLI 2.1.288 and Agent SDK 0.3.288 was confirmed by D.5 (`docs/research/d5-plugin-delivery-live.md`); Desktop is checked by the owner's checklist (D.7). Exceptions:
    - resume from `sessionStore`: the SDK strips `enabledPlugins` and runs in a temporary `CLAUDE_CONFIG_DIR`;
    - `persistSession: false`: there is no transcript, the "hooks only" mode remains;
  - isolated SDK applications (`settingSources: []`) are connected with the line `plugins: [{type: 'local', path}]` (spike 5.3-L);
  - `--plugin-dir` is used only by the dev tool for recording reference sessions (ADR-0010);
  - `aang uninstall` removes the plugin and neutralizes aang entries in `hooks.json`.

### Session support modes

| Mode | When | What is visible | UI mark |
| --- | --- | --- | --- |
| Full | active hooks and files | everything | — |
| Files only | hooks inactive | content, links, usage | "approval waits are not visible" (spike 5.2-I) |
| Hooks only | no transcript is written: SDK with `persistSession: false`, `CLAUDE_CODE_SKIP_PROMPT_HISTORY` | live events, waits, final text from `Stop` | "no content, usage or recovery" |

- For profiles with interactive approvals (Claude CLI/Desktop, Codex TUI/Desktop with `on-request`), the "files only" mode is not full support.
- For Codex `exec` and the SDK with `approval_policy=never`, hooks only speed up collection. `exec --approve-for-me` enables `on-request` with the guardian and `PermissionRequest`, so hooks are needed for it.

### Codex OpenTelemetry (opt-in)

- `aang otel-config` prints an `[otel]` section with the address `http://127.0.0.1:<port>/otel/<intake token>/v1/logs` and reminds to restart the TUI daemon (`codex app-server daemon restart`) and Desktop.
  - aang does not change the user's config.
  - The intake token is separate from the UI token: `aang token rotate` does not change it, `aang otel-config --rotate` changes it and prints a new section.
  - The spike checked the address `…/v1/logs` without a token in the path; the path with the token is checked before use (plan, A.5).
  - `aang doctor` only reads `config.toml` and warns if `exporter` is already taken by the user's own collector.
- The receiver is a separate loopback-only listener. It responds `200` before processing and does not hold the connection.
- Only `codex.tool_decision` is stored. Other records, including `codex.tool_result`, are discarded before being written to disk.
- Without OTel, the approval decision in Codex is shown as "unknown".

### Files: cursors, deduplication, backfill

- **Discovery:** recursive fs watch over the roots and a full `stat` scan at startup, every 60 s and right after a watcher error or overflow.
- **A root that does not exist yet (approved by the owner 2026-10-08, decision 15).** In a fresh profile, container or VM, the runtime roots (`<claude>/projects`, `<codex>/sessions` and others) do not exist until the first session. While a root is missing, the collector puts a non-recursive fs watch on the nearest existing parent directory of the root. The reason is finding Q4-6: the files of the first session waited for the 60 s scan, even though hooks arrived immediately.
  - An event in the parent after which the next directory on the path to the root exists moves the watch to it. A root that has appeared gets its own recursive watch and an immediate scan, and the parent watch is removed.
  - The existence of the root is also checked on every scan. A root that has disappeared by the scan is awaited via the parent again.
  - The parent watch is also only a signal: the appearance of the root is guaranteed to be found by the 60 s scan. With `collector.fsWatch: false` the parent is not watched.
- **Active file check (approved by the owner 2026-10-07, decision 14).** In addition, once per 1 s the collector checks by `stat` the tail files — Claude transcripts and Codex rollouts — modified in the last 10 minutes. The reason is finding Q4-1: FSEvents on macOS does not report appends to a file that the writer keeps open, and Codex writes rollouts exactly this way. Without the check, rollout lines waited for the next event or the 60 s scan.
  - A file counts as modified if its `mtime` is younger than 10 minutes or if the collector noticed a new size or a new `(dev, inode)` identity in the last 10 minutes. The write time of an open file may lag: Windows guarantees it is current only after the handle is closed. Therefore growth noticed by the check or by a read extends the window even with an old `mtime`; a scan and an unchanged `stat` do not extend the window.
  - The check does not list directories. The list of active files is filled by the scan and by reading a file on a watch event, so a new file is still found by the watch or the scan.
  - A modified or vanished active file is handled the same way as after a watch event: new lines are read; an inode change, shrinking and disappearance trigger a stream search.
  - The read latency of lines appended without a watch event is up to 1 s plus the read time. A file that has not changed for more than 10 minutes drops out of the check: the first append after such idleness is found by the scan or by any watch event in the roots, the following ones by the check again.
  - JSON file snapshots are not part of the check: they are rewritten whole, and the watch sees them.
- **Stream** is a logical source: `(runtime, sessionId, agentId or main)` for Claude, the thread id for Codex. A file path is not a stream.
- **File cursor:** `(path, dev, inode, stream, offset after the last '\n', line number, size)`, for Codex additionally the last `ordinal`. Only complete lines are parsed.
- **Whole JSON files** (`*.meta.json`, `teams/*/config.json`, `workflows/*.json`, the registry) are read whole on change as snapshots. The snapshot deduplication key is `(path, content hash)`.
- **An inode change, shrinking or disappearance of a file** triggers a stream search: Claude — by `sessionId` across all of `projects/` (relocate, superseded, orphaned), Codex — by thread id in `archived_sessions/`. The stream key from the first lines of the file is provided by the adapter.
  - File found — it is re-read from the beginning with deduplication.
  - Not found — a `source_lost` fact (ADR-0006).
- **Raw record deduplication keys:**
  - Claude with `uuid` — `(sessionId, uuid)`;
  - Claude without `uuid` — `(stream, line number, line hash)`;
  - Codex — `(thread_id, ordinal)`;
  - hooks — the spool file name;
  - OTel — `(conversation.id, call_id, decision, timeUnixNano)`.

  Records copied by a Claude fork are kept as lines of the new stream. They are marked as inherited by `engine` at the object level (ADR-0006, ADR-0009).
- **Backfill.** Files without a cursor modified within `lookback` (7 days by default) are read from the beginning; files with a cursor, from the cursor. This applies to the first start, to `aang watch` and to new files. Hook events that arrive while the daemon is stopped wait in the spool.
- **Scope.** Only root sessions whose first `cwd` lies inside a tracked root or in a git worktree of a tracked repository (by the common git directory) are collected. Continuations and agents inherit the root's decision (ADR-0006). Records of other sessions are discarded at intake without being stored.
  - The scope decision is stored per stream next to the cursor, so after a restart lines appended to the stream do not require determining it again.
  - After `aang watch`, streams previously discarded as external are re-read from the beginning within `lookback`.
- **Self-exclusion.** Sessions with `entrypoint: aang-observer`, `thread_source: aang-observer` or `originator: aang_observer` are discarded.

### Claude session process liveness (approved by the owner 2026-10-07)

Q.4 showed (`docs/research/q4-live-resilience.md`, finding Q4-5): a Claude session whose process is killed in the middle of a tool stays in the "turn in progress" state, and the action stays "in progress". `SessionEnd` does not arrive on SIGKILL, and the registry file `<claude>/sessions/<pid>.json`, which Claude deletes on a normal exit, remains.

- **Check.** Once per `collector.processCheckIntervalMs` (5 s by default) the collector checks the processes of registry files already emitted as a snapshot:
  - the pid is taken from the file name, the check is signal 0 (`process.kill(pid, 0)`; on Windows Node checks the process via `OpenProcess`);
  - no process (`ESRCH`) — the process has exited; any other response, including `EPERM`, counts as a live process;
  - first the process is checked, then the file is re-read. A file deleted by that moment is a normal Claude exit: there is no record.
- **Record.** If the process has exited and the file is still there, the collector emits a `registry` channel record with the `process_exited` position (path, pid, content hash) and the file content. The receive time is the moment of detection. The deduplication key includes the content hash, so after a daemon restart the same file does not produce a repeated record. While the file is tracked, the record is emitted once.
- **Fact.** The Claude adapter turns the record into a `process_exited` fact of the session from the file: pid, path and process start time from `startedAt`. The fact time is the moment of detection.
- **`engine` rule.** Process P is superseded by a new process of the same session if, after P started, the session has a registry record with a different pid or a hook event with a different `CLAUDE_PID`. The boundary of P is the moment of detection or the earlier first sign of the new process.
  - If no new process appeared before detection and `SessionEnd` did not arrive, the session is in the "unknown" state from the moment of detection, with execution `unknown`. The next launch returns it to the normal rules.
  - An action started before the boundary of P and without an end gets the outcome `unknown` with the basis `observed` on the `process_exited` fact; the end is the moment of detection. Such an action is not shown as failed (`error`, `failed`) (ADR-0006).
  - An agent started before the boundary and not finished gets execution `unknown`.
  - A blocking human wait opened before the boundary is ended by the `process_exited` fact, as by a session end: the question is closed without an answer, the stage does not remain in `waiting`.
- **Limitations.**
  - A pid taken by another process before the check looks like a live process. The session then stays "turn in progress" until freshness turns `quiet` (ADR-0006).
  - The pid is checked in the daemon's process namespace, so the daemon runs on the same host and in the same container as the solver (ADR-0011).
  - Codex has no registry file, so the rule does not apply to it.

### Surfaces

- Claude CLI, Desktop Local/worktree and Agent SDK are served by one adapter. The surface is determined by `entrypoint` and the hook environment.
- Codex TUI, `exec`, Desktop Local/worktree and SDK are served by one adapter. By `originator`/`source` only `exec`, subagents and the guardian are reliably distinguished. The SDK is recognized by `originator: codex_sdk_ts` unless the application has overridden the environment. TUI and Desktop are shown as a guess.
- Sessions spawned by Desktop (spawn task, Dispatch, scheduled tasks) are linked to the parent only via Desktop metadata (decision 4) or an explicit binding. Until then the link is shown as unknown.
- SSH modes of both Desktops and one's own VM/Docker: the aang daemon runs on the same host as the solver (ADR-0011), the UI is reachable via an SSH tunnel (ADR-0003). Merging several hosts into one UI is not offered.
- **Cowork and cloud modes (Claude Cloud, Codex Cloud, Work Cloud) are excluded; the UI shows them as "Not observable" (approved by the owner).** Display method: a persistent notice in the status bar and in `/api/status`. The status-bar notice is superseded by ADR-0015: coverage does not light the health dot, and "Not observable" stays in `/api/status` and `aang status`. aang does not read Cowork and cloud session directories, so individual such sessions are not listed (decision 10).

## Consequences

- Collection does not depend on the daemon's lifetime and does not require attaching to vendor processes.
- Completeness of waits depends on hooks. Enterprise `allowManagedHooksOnly`/`disableAllHooks` and missing trust in Codex move sessions to the "files only" mode. On Windows Codex hooks are not installed by default, so Codex sessions there run in the "files only" mode until the user enables hooks explicitly (ADR-0013, decision 7).
- The Go handler is an exception to ADR-0001 for the sake of latency on the solver's critical path and Windows support (ADR-0013).
- Until processed, the spool contains full payloads, including secrets from tool output.
- There is no quantitative spool limit. With a dead daemon, growth is bounded only by the lease expiry; a running daemon reacts to the threshold. This is an exception to the RFC §8 requirement "queues are bounded", approved by the owner (decision 7).
- A full tree scan costs only `stat`; only new bytes are read.
- The active file check costs one `stat` per second for each tail file modified in the last 10 minutes; it does not depend on the tree size.

## Owner decisions

Accepted by the owner 2026-10-01:

1. The Claude plugin is delivered via a local marketplace and `claude plugin install`; the `~/.claude/skills/aang/.claude-plugin/` directory is the fallback. Both are checked in the plan (D.5).
2. Codex OTel is opt-in by instruction; aang does not change the user's config.
3. The registry `<claude>/sessions/<pid>.json` is a wait hint via fs watch; `claude agents --json` is used only in `aang doctor`.
4. From the Desktop metadata `claude-code-sessions/**/local_*.json`, only `cliSessionId`, `spawnSeed` and `lastSpawnRootDetected` are read, and only after the format is checked by the owner's checklist.
5. The hook handler is a native Go binary for all OSes (ADR-0013). The former sh variant is cancelled by the decision to support Windows.
6. Scope is by tracked projects with a 7-day `lookback`; `aang watch --all` is for all sessions.
7. The RFC §8 exception for the spool is approved. There is no quantitative size limit; there is a 24-hour lease, a 1 GB reaction threshold and discarding of files older than 7 days, and the size and lease expiry are visible in `aang status`. A transport with a quantitative limit — after the MVP, based on measurements.
8. MVP platforms are macOS, Linux and native Windows, including Claude Desktop and Codex Desktop without WSL (ADR-0013). By the owner's decision of 2026-10-02, Desktop on Windows is not checked in the MVP (ADR-0013, decision 3).
9. The SDK "no code changes" boundary is recorded in the README and shown by the session mode in the UI.
10. "Not observable" for Cowork and cloud modes is a persistent notice without reading their directories.

Accepted by the owner 2026-10-02:

11. A spool file with an unrecognized header stays in the spool with an `unknown_records` gap and is discarded by the `spool.maxAgeDays` age. It is not stored as a raw record and is not moved to a separate directory.

Accepted by the owner 2026-10-07 based on the Q.4 report (`docs/research/q4-live-resilience.md`, finding Q4-4):

12. Loss of hooks mid-session is visible: a turn visible in files without hook events for longer than `freshness.hooksInactiveAfterMs` opens a `hooks_inactive` gap of the session and moves it to the "files only" mode; the next hook event closes the gap (section "Installation", "hooks inactive"). The full mode flag is no longer "sticky". The fix is part of the MVP.

Accepted by the owner 2026-10-07 based on the Q.4 report (`docs/research/q4-live-resilience.md`, section 2, finding Q4-5):

13. Process liveness from the Claude registry is used: if the session process is dead and `SessionEnd` did not arrive, the session is shown in the "unknown" state, and in-progress actions get the outcome `unknown`. No action is shown as failed (ADR-0006). The check method and the rule are in the section "Claude session process liveness".

Accepted by the owner 2026-10-07 based on the Q.4 report (`docs/research/q4-live-resilience.md`, section 2, finding Q4-1; PR #161):

14. Appends to an open file on macOS are fixed in the MVP: in addition to fs watch, source files modified in the last minutes are checked by `stat` every 1–2 s, without a full scan of the roots. The read latency of Codex rollouts on macOS is no more than 2 s. The implementation values are 1 s and 10 minutes (section "Files: cursors, deduplication, backfill").

Accepted by the owner 2026-10-08 based on the Q.4 report (`docs/research/q4-live-resilience.md`, finding Q4-6) and the "Fresh profile" finding of the Q.1 report (PR #160):

15. A runtime root created after the daemon starts is fixed in the MVP: while the root is missing, the daemon watches the nearest existing parent and puts a watch on the root as soon as it appears. The first session in a fresh container or VM is visible without a delay of up to 60 s (section "Files: cursors, deduplication, backfill").
