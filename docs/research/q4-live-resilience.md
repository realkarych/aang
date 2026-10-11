# Resilience on live sessions (Q.4)

Status: report on plan item Q.4 (`docs/plan/mvp.md`). This is not an ADR: decisions do not change, questions to the owner are collected in section 2, manual checks are in [`q4-owner-checklist.md`](q4-owner-checklist.md).
Date: 2026-10-07, updated 2026-10-08 after the review of PR #161. Branch: `feat/q4-live-resilience`.

## 0. Scope, versions, method

Q.4 checks five areas:

- daemon restart;
- loss and move of sources;
- hook and trust failure;
- divergence between hooks and files;
- ambiguous lineage.

The check runs on the real CLIs and a built aang daemon. The scenarios are reproducible: they are run by the [`tools/resilience`](../../tools/resilience/README.md) tool. The `Resilience` workflow runs them on Linux, macOS and native Windows.

**Versions and environment:**

- macOS 27.0.1 (26A434), Apple M4 Pro, arm64; Node 26.10.0;
- Claude Code 2.1.292 from the native installer. The installer had already updated to 2.1.293, so the run is pinned to 2.1.292 via `--claude ~/.local/share/claude/versions/2.1.292`;
- `codex-cli 0.160.0` from Homebrew;
- the daemon and `aang-hook` are built from this branch;
- CI, the `Resilience` workflow on this branch: `ubuntu-latest` (kernel 6.17, x64), `macos-latest` (Darwin 25.6, arm64) and `windows-latest` (Windows Server 2025, 10.0.26100, x64). Claude Code 2.1.292 and `@openai/codex@0.160.0` from npm; on Windows Claude Code comes from the native installer.

The machine was not dedicated: other development sessions were running in parallel.

**Method.** Each scenario runs in its own temporary `@aang/testkit` profile:

- `HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `AANG_HOME` are temporary; the project is the directory `έργο q4` in the profile `Όνομα Επώνυμο`; the run used a Cyrillic profile name, the tools now use this Greek one;
- the runtime roots `~/.claude/projects` and `~/.codex/sessions` exist before the daemon starts, as on a machine where the runtime has already been used; the case without them is a separate scenario;
- hooks are installed by the product command `aang install`. Trust for Codex hooks is confirmed by writing `hooks.state` with hashes from `hooks/list`, as `/hooks` does;
- the model is the `tools/record` stubs: Anthropic Messages for Claude and Responses for Codex. The response is chosen by the `[aang:<key>]` tag in the prompt. The real model was not called; the cost is zero;
- instead of `cli.claude` and `cli.codex`, the daemon is given gateways. They pass only `plugin`, `app-server` and `--version` through to the real CLI. Therefore the hook state check works on the real CLIs, while the observer and the chat cannot start a model session: observer admission is rejected, and collection does not depend on it;
- daemon intervals are the defaults: root scan every 60 s, spool scan every 5 s. Exceptions are stated in the scenarios;
- the "mid-turn" step is done via a gate command: the stub asks the CLI to run `node gate.mjs <name>`, and the command waits until the scenario releases it. The paths in the command are written with `/` in quotes, so it works the same in bash and zsh, in Git Bash, where Claude on Windows runs Bash, and in PowerShell, where Codex on Windows runs commands;
- the checks read what the user sees: `/api/status`, `/api/runs`, `/api/runs/:run`. Raw record counts and cursors are read from the DB read-only. "The daemon has taken everything in" means: the spool is empty, the cursor of every session file has reached the end of the file, `change_seq` does not change for 1 s;
- scenarios run one at a time, so at most one solver CLI runs at once.

Run reports:

| OS | Where | Sample | Revision | Run time (UTC) |
| --- | --- | --- | --- | --- |
| macOS | owner's machine | [`samples/live-resilience/macos/`](samples/live-resilience/macos/report.json) | `f533b816` | 2026-10-07 21:09–21:13 |
| Linux | CI | [`samples/live-resilience/linux/`](samples/live-resilience/linux/report.json) | `5b6bf4f7` | 2026-10-07 22:11–22:15 |
| Windows | CI | [`samples/live-resilience/windows/`](samples/live-resilience/windows/report.json) | `5b6bf4f7` | 2026-10-07 21:56–22:02 |

The `macos-latest` run of the same workflow remains a CI artifact. In the samples, the temporary directory is replaced with `<tmp>` and the home directory with `~`, including inside the names of Claude project directories, which encode the project path. The tool does not write a report if a user path remains in it.

**Legend:** ✔ — the check passed; ⚑ — the check did not pass because of a finding from section 2, the scenario is not counted as failed; ✘ — an unexpected failure.

**Limitations:**

- the model is fake: the behavior of the CLI and the daemon is checked, not the model;
- Desktop, interactive TUIs and the `/hooks` dialog were not checked. That is the owner's checklist;
- Linux and Windows were checked only in CI (the `Resilience` workflow).

## 1. Summary

Result: 23 scenarios, not a single unexpected failure on any OS: on the owner's macOS 17 ✔ and 6 ⚑, the same on `macos-latest` in CI, on Linux and on Windows in CI 18 ✔ and 5 ⚑ each. The ⚑ scenarios hit the findings of section 2. The only difference between OSes is Q4-1, which exists only on macOS.

1. **Daemon restart without losses or duplicates.**
   - SIGKILL mid-turn for Claude and Codex: while the daemon is down, hooks keep writing to the spool because the lease is valid. After startup the daemon takes in the spool and the rest of the files once. A repeated restart adds nothing.
   - `aang stop` between turns: hooks stop writing immediately, and the turn made while stopped is recovered from the transcript.
2. **Loss and move of sources work per ADR-0004.**
   - A deleted Claude transcript and a rollout deleted via `codex delete` are marked "source lost". What was observed stays, and after a restart the mark is kept.
   - Moving a transcript to another project directory with the daemon running and with it stopped does not lose the session and does not add a single raw record. `codex archive` and `unarchive` do not lose the thread, and its calls are not duplicated.
   - Claude rewrites a transcript deleted mid-turn at the same path. The daemon briefly marks the loss, then closes it and takes in the new lines once.
3. **A hook failure is visible.**
   - Without the `aang-hook` binary, with the plugin disabled or with untrusted Codex hooks, the solver is not blocked. The session is shown in the "files only" mode, and `aang status` lists it among sessions without hooks.
   - Codex hook trust, its preservation on reinstallation and its loss when the positional key shifts are visible in `aang status` without a daemon restart.
4. **The "hooks only" mode works.** `claude -p --no-session-persistence` and `codex exec --ephemeral` write no files. Their sessions are shown in the "hooks only" mode, and actions are taken from hooks.
5. **Lineage without guesses.**
   - Two branches of one Claude session and a branch of a branch are separate runs with an "Common origin" link; no parent is assigned.
   - The copied history is inherited and not repeated as new actions.
   - A `fork_parent` binding assigns the parent; its retraction removes it.
   - A Codex branch is linked to its source.
6. **Native Windows behaves the same.** Claude runs Bash in Git Bash, Codex runs commands in PowerShell, Codex hooks are installed by `aang install --codex` per the owner's decisions of 2026-10-06 (PR #150). All 23 scenarios give the same results on Windows as on Linux.
7. **The main finding is Q4-1.** On macOS, appending to an open file produces no `fs.watch` events, and that is exactly how Codex writes the rollout. Therefore on macOS the daemon reads Codex rollout content not immediately but on the next event or on the scan every 60 s. During a long command the delay is 30 s or more. On Linux (inotify) and on Windows the rollout was read during the command in 27–28 ms. Put to the owner (section 2).
8. **Defect Q4-2 is fixed** (PR #159, merged): deleting the registry file `sessions/<pid>.json` at the end of every Claude session added a gap in `/api/status`. The check became an ordinary one and passes on all OSes.

## 2. Findings and questions to the owner

Q4-1, Q4-4 and Q4-5 need an owner decision: they change ADR-0004 rules — detection of file changes, a dynamic "hooks inactive" and use of process liveness. Implementation has not started before approval.

**Q4-1. `fs.watch` on macOS does not see appends to an open file.** Question to the owner (ADR-0004, "Discovery").

- What is seen: the probe sees 1 event for 9 writes, and the last write is not among them. Claude reopens the transcript for every write, and events arrive. Codex keeps the rollout open, and after the file is created there are no events until the end of the turn. The daemon reads the rest of the rollout only on the next event or on the scan every 60 s.
- Where: `sources/codex-rollout-read-during-command` — the lines of the running command were read after 30 s, at the moment the turn ended; without the end of the turn the delay is up to 60 s. The same on `macos-latest` in CI (Darwin 25.6): 1 event for 9 writes, 30.2 s. On Linux in CI the probe sees 9 events for 9 writes, the rollout was read in 28 ms, the check passes.
- Windows: the probe via `ReadDirectoryChangesW` also does not see the last write through an open handle (2 events, 1 write of 9 visible). But the Codex rollout was read during the command in 27 ms, the check passes: the rollout change notification does arrive on Windows. Why a Codex 0.160.0 write produces a notification and the probe's write does not was not investigated. Therefore in this version Q4-1 is visible only on macOS. The `stat` polling proposed below would cover Windows too if Codex behavior changes.
- Proposal: in addition to fs watch, every 1–2 s check via `stat` the files changed in the last few minutes. Alternatives: scan the roots more often (expensive on large trees) or set a separate watch on each active file (on macOS that is kqueue, but it consumes descriptors).

**Q4-2. A gap in `/api/status` from deleting a registry file.** Fixed in PR #159, merged into master and into this branch.

- What is seen: deleting `<claude>/sessions/<pid>.json` at the end of every Claude session produced an `unknown_records` gap "registry record (parsed) discarded: it names no session".
- Where: `restart/claude-stop-between-turns`, `hooks/claude-lease-lost-mid-session`.
- Fix: a record without an owner leaves a gap only if it is `unknown` or `invalid` or its facts are lost. The check `ended sessions leave no gap for their removed registry files` is no longer marked as a finding and passes on three OSes.

**Q4-3. A Codex thread start is listed twice.** Documented.

- What is seen: the start comes from the `SessionStart` hook and from the rollout's `session_meta` — `["startup","startup"]`, for a branch `["fork","fork"]`. The UI merges them by label and time; the API returns both.
- Where: `restart/codex-sigkill-mid-turn`, `lineage/codex-forks`, `sources/codex-archive-unarchive-delete`.
- Proposal: merge the start from `session_meta` with a start of the same kind from a hook, if there is one. The merge rule is chosen by the owner or aspect E.

**Q4-4. Loss of hooks mid-session is not marked.** Question to the owner.

- What is seen: if hooks disappeared mid-session (no lease, `aang stop`, an unavailable spool), the full-mode flag remains — it is "sticky", and a turn without hooks looks like an ordinary one. ADR-0004 defines "hooks inactive" only for the session as a whole.
- Where: `hooks/claude-lease-lost-mid-session`. `aang status` meanwhile shows that there is no lease.
- Proposal: open a session gap `hooks_inactive` if a turn is visible in the files but there have been no hook events of this turn for longer than N seconds, and close it on the next hook.

**Q4-5. A session with a killed process stays running.** Question to the owner.

- What is seen: a Claude session whose process was killed in the middle of a tool stays in the "turn in progress" state, the action stays "running". After 5 minutes freshness switches to "no new events", as ADR-0006 requires. ADR-0004 names process liveness as part of the registry hint, but the product does not use it.
- Where: `divergence/claude-killed-mid-tool`.
- Proposal: if the session process from the registry is dead and `SessionEnd` did not arrive, show the session state as "unknown" and running actions with outcome `unknown`.

**Q4-6. A runtime root created after the daemon started.** Documented, low priority.

- What is seen: if `~/.claude/projects` does not exist yet when the daemon starts (the first Claude session after installing aang), no watch is set on the root. Only the scan every 60 s finds the transcript — after 59.8 s; until then the session is visible only through hooks.
- Where: `sources/claude-projects-root-created-after-start`.
- Proposal: while the root does not exist, check for its appearance every few seconds.

**Q4-7. A momentary `hooks_inactive` gap at the start of a Codex session.** Documented.

- What is seen: if rollout lines are taken in before the session's first hook file, a `hooks_inactive` gap opens and closes an instant later. The closed gap stays in the session history. It does not happen in every run.
- Where: `restart/codex-sigkill-mid-turn`, `sources/codex-rollout-deleted-mid-turn`.
- Proposal: decide "hooks inactive" no earlier than a few seconds after the first line of the file.

**Q4-8. The outcome of a Codex command known only from hooks.** Documented as a limitation of Codex hooks.

- What is seen: a Codex command known only from hooks (`--ephemeral` or a lost rollout) is shown with execution and outcome `unknown`: Codex `PostToolUse` carries the output but not the exit code. Such a command is not considered running.
- Where: `divergence/codex-ephemeral`, `sources/codex-rollout-deleted-mid-turn`.

**Q4-9. The `stop_hook_summary` line is not parsed.** Known; parsing is planned in F.7d (PR #153).

- What is seen: Claude writes the `system/stop_hook_summary` line after a Stop hook, including the aang hook. Therefore every session with aang hooks gets an `unknown_records` gap.
- Where: all Claude scenarios.

## 3. Daemon restart

| Scenario | What is done | Result |
| --- | --- | --- |
| `restart/claude-sigkill-mid-turn` | A Claude turn `echo before` → gate → `echo after`. When the daemon shows the gate action running, the daemon gets SIGKILL. The gate is released, the turn and the session finish without the daemon. Then the daemon is started, then SIGKILL again and another start. | ✔ While the daemon was down, hooks wrote 7 files to the spool. After startup every transcript `tool_use` is exactly one action, all with outcome `ok`. A usage record for every message with usage, the session is `ended`, full mode, freshness `ok`, the spool is empty. The second restart changes no object counter. |
| `restart/claude-stop-between-turns` | Turn 1, then `aang stop`, turn 2 via `--resume` with aang stopped, then `aang start` and turn 3. | ✔ While stopped, hooks wrote no file: the marker and the removed lease. The action of turn 2 is recovered from the transcript, turn 3 came with hooks again, no duplicates. There is no gap from deleted registry files (Q4-2 fixed). |
| `restart/codex-sigkill-mid-turn` | The same for `codex exec` with trusted aang hooks. | ✔ 5 spool files during the downtime, each rollout call is one action with outcome `ok`, a repeated restart adds nothing. ⚑ Q4-3 and, in some runs, Q4-7. |

On Windows SIGKILL is `TerminateProcess`. The results are the same: 7 and 5 spool files during the downtime, not a single duplicate.

Limitations visible to the user do not violate the ADR:

- **a turn made during `aang stop` loses everything that only hooks provide:**
  - the `resume` start in the list of starts (after turn 3 it is shown once, although there were two `--resume`);
  - `SessionEnd` — until the next turn the session is shown as "turn done, waiting" (`turn_done`), although the process has already exited;
  - approval waits.

  This is a consequence of the intentional stop per ADR-0004: "the spool stops growing immediately". There is no explicit mark on the session (Q4-4).
- **the time from the end of a turn to full intake of the files** with the daemon running on macOS is about 0.3 s for Claude and 15–60 ms for Codex. For Codex this holds only if the rollout is written through to the end of the turn; otherwise see Q4-1.

## 4. Loss and move of sources

| Scenario | What is done | Result |
| --- | --- | --- |
| `sources/claude-transcript-deleted` | The transcript of a finished Claude session is deleted with the daemon running, then a restart. | ✔ The session is `lost`, a `source_lost` gap with the search path is open. The observed actions remain. After the restart everything is the same. |
| `sources/claude-transcript-moved` | The transcript is moved to `projects/<dir>-moved/` with the daemon running, then once more with it stopped. | ✔ After both moves the session is not lost, the actions are the same, the number of raw records did not change: the re-read was cut off by deduplication. |
| `sources/claude-transcript-deleted-mid-turn` | The transcript is deleted while the turn waits in the gate. After the gate Claude writes the rest of the turn. | ✔ Claude opens the file by path for every write and creates a new file with the rest of the turn (one `tool_use` line). The daemon first marks `source_lost`, then finds the stream by `sessionId` in the new file and closes the gap. The actions of the old and the new file appear once each, after a restart too. |
| `sources/claude-projects-root-created-after-start` | The daemon starts when `~/.claude/projects` does not exist yet, then the first session runs. | ✔ per the ADR: the transcript is found by the scan after 59.8 s. Until then the session is visible through hooks in the "hooks only" mode. ⚑ Q4-6. |
| `sources/codex-archive-unarchive-delete` | `codex archive` of thread A, `codex unarchive`, `codex exec resume` A. Then `codex delete --force` of thread B and a restart. | ✔ The archived thread A lies in `archived_sessions/` and is not lost. After unarchiving and continuing, each call is one action. Thread B is `lost`, after a restart too. ⚑ Q4-3 (A has starts `startup`, `startup`, `resume`). |
| `sources/codex-rollout-read-during-command` | While `codex exec` waits in the gate, it is measured when the daemon cursor reaches the end of the rollout. Separately, a probe: 9 appends to a file opened for every write, and 9 through an open handle. | ⚑ Q4-1: the cursor reached the end after 30.1 s, at the moment the turn ended. Codex returns control from `exec_command` no later than after 30 s. Probe: opening for every write — 9 events, the last write is visible; through an open handle — 1 event (creation), the last write is not there. |
| `sources/codex-rollout-deleted-mid-turn` | The rollout is deleted while the turn waits in the gate: on macOS the daemon had read its beginning, 35 888 of 41 728 bytes, on Windows the whole file. | ✔ Codex keeps writing to the deleted file; there is no new file. The session is `lost`, commands after the deletion are visible from hooks. Their outcome is `unknown` (Q4-8). On Windows, deleting a rollout opened by Codex also succeeds, and the result is the same. |

Confirmed along the way:

- **inode and size.** A cursor with a different inode or a smaller size starts a stream search. A re-read file produces no duplicates either for Claude (key `sessionId` and `uuid`) or for Codex (key `thread_id` and `ordinal`);
- **changes while the daemon is stopped.** A move or deletion that happened while the daemon was not running is detected at startup: the tree scan finds the missing cursor path and starts a search.

## 5. Hook and trust failure

| Scenario | What is done | Result |
| --- | --- | --- |
| `hooks/claude-hook-binary-missing` | `aang-hook` is removed from `<AANG_HOME>/bin`, a Claude session runs. Then the binary is put back, and another session runs. | ✔ Claude exits with code 0: a missing handler does not block. The first session is "files only", freshness `hooks_inactive`, a `hooks_inactive` gap is open, and in `aang status` it is among `hooks_inactive_sessions`. The second session is in full mode and not in that list. The static Claude state is `active` meanwhile: the plugin is enabled, the binary is missing. The missing binary is visible only through sessions. |
| `hooks/claude-lease-lost-mid-session` | Between the turns of one session the spool lease is deleted; the daemon's lease check is postponed (`spool.checkIntervalMs` = 10 min). Turn 2, then a daemon restart and turn 3. | ✔ Without a lease hooks write nothing, `aang status` shows `lease_expires_at: null`, turn 2 is recovered from the transcript. The restarted daemon issues a lease, turn 3 is again with hooks. ⚑ Q4-4: the session stays in full mode without a mark. |
| `hooks/codex-hooks-trust` | `aang install --codex`, a session without confirmed trust. Then trust via `hooks.state`, a session, a repeated `aang install --codex`, a session. At the end, another party's `PreToolUse` hook is inserted into `hooks.json` before the aang entry. | ✔ After installation — `untrusted`. Codex skips untrusted hooks, the spool is empty, the session is "files only". After trust, `aang status` shows `active` without a restart, the next session is in full mode. The repeated installation does not change a single byte of `hooks.json` and keeps the trust. The other entry before the aang entry shifts the positional key: the aang entry loses trust, the status is `untrusted`. |
| `hooks/claude-plugin-disabled` | `claude plugin disable aang@aang`, a session, then `claude plugin enable aang@aang`, a session. | ✔ `aang status` follows the state: `disabled` → `active`. The session with the plugin disabled is "files only", with it enabled — full mode. |
| `hooks/claude-duplicate-plugin` | The aang plugin is installed from the marketplace. Its copy lies in the fallback directory `<claude>/skills/aang`, another one is passed via `--plugin-dir`. | ✔ Claude 2.1.292 loads one plugin per name: with the copy in `skills` — `aang@aang` from the marketplace, with `--plugin-dir` — `aang@inline`. Each event is delivered once; there is no double registration. |

Conclusion on double registration (ADR-0004). The spike scenario — two identical payloads from two registrations — is not reproduced for the aang plugin in Claude 2.1.292: the engine does not load two plugins with the same name. The engine rule for double registration remains a safeguard in case the runtime behaves differently. The `hooks/claude-duplicate-plugin` scenario will catch such a change in a new version.

## 6. Divergence between hooks and files

| Scenario | What is done | Result |
| --- | --- | --- |
| `divergence/claude-no-session-persistence` | `claude -p --no-session-persistence`: no transcript. | ✔ "hooks only" mode, the action from hooks completed with `ok`, no gaps. |
| `divergence/codex-ephemeral` | `codex exec --ephemeral`: no rollout. | ✔ "hooks only" mode, the command from hooks is not considered running. Execution and outcome `unknown` (Q4-8). |
| `divergence/claude-killed-mid-tool` | The Claude process gets SIGKILL while a command waits in the gate. The hooks have `PreToolUse` without `PostToolUse`, the transcript has `tool_use` without a result, no end of turn. `freshness.quietAfterMs` = 5 s. | ✔ After 5 s of silence freshness is `quiet`; no action is shown as failed (ADR-0006). ⚑ Q4-5: the session and the action stay "running". |
| `divergence/claude-cwd-drift` | A session starts in the project with `--add-dir <outside root>` and runs `cd <outside root> && echo outside`, then `echo still`. Separately, a session started outside the root runs. | ✔ The transcript lines after `cd` carry a directory outside the root, but the session stays in scope by its first `cwd` (ADR-0004): both actions are in place, the session's `cwd` is the initial one. The session started outside the root is not accepted. Without `--add-dir` Claude returns the shell directory to the project, and there is no drift. On Windows `cd` runs in Git Bash, while the transcript records Windows paths; the result is the same. |

Merging hook and file records about one object gave exactly one action per `tool_use_id` or `call_id` in all scenarios. An action's start is no later than its end. Content and outcome are taken from the file if there is one: for Codex the outcome `ok` comes only from the rollout.

## 7. Ambiguous lineage

| Scenario | What is done | Result |
| --- | --- | --- |
| `lineage/claude-forks` | Session S. Two branches `--resume S --fork-session` (F1, F2) and a branch of a branch `--resume F1 --fork-session` (F3). Then a `fork_parent` binding F1 → S and its retraction. | ✔ Four runs, S has one session. Each session has one own action. Inherited: F1 and F2 have 1, F3 has 2. The "Common origin" link of each branch lists exactly the other three sessions, no candidate parent is assigned, grounds `observed`: the check compares the link as a whole. Claude branches have no `forked_from`. The binding makes run S the parent of F1, the retraction removes it. The branch starts are `fork` from the `SessionStart` hook. |
| `lineage/claude-fork-parent-unseen` | The daemon is killed. A session and its branch run, the parent's transcript is deleted, then the daemon is started. | ✔ The branch is recognized by its own file: the history before the start is inherited (1 inherited, 1 own action). The exact link is checked: exactly one "Common origin" with an empty session list, no candidate parent, grounds `observed`; no `forked_from`. The parent is visible only through its own hooks from the spool, in the "hooks only" mode. |
| `lineage/claude-resume-continue` | A session, then `--resume` and `--continue`. | ✔ One `sessionId`, one run, starts `startup`, `resume`, `resume`, three own actions. |
| `lineage/codex-forks` | `codex exec fork` of thread A. Then, with the daemon stopped, thread B and its branch; the rollout of B is deleted, the daemon is started. | ✔ The branch is its own run with `forked_from` pointing to run A, grounds `observed`. ⚑ Q4-3 (`["fork","fork"]`). The branch of an unseen source points `forked_from` to a run that is not in `/api/runs`. The run id is derived from the session key and does not depend on whether the source is visible. The UI shows such a link as "source run" without a link (`RunLink` with `unknown`), so this is not a defect. |

`codex delete --force` does not delete a thread that has a branch: "failed to delete session". Therefore the scenario deletes the branch's source as a file.

## 8. Runtime behavior noticed along the way

**Claude Code 2.1.292:**

- opens the transcript for every write. It recreates a deleted transcript at the same path and writes only new lines there;
- `--no-session-persistence` does not write a transcript, while hooks arrive in full, from `SessionStart` to `SessionEnd`;
- loads one plugin per name: the marketplace takes precedence over `<claude>/skills`, `--plugin-dir` (`@inline`) takes precedence over the marketplace;
- after every Stop hook writes the `system/stop_hook_summary` line to the transcript (Q4-9).

**codex-cli 0.160.0:**

- keeps the rollout open and appends whole lines: during a command the last line is always terminated with `\n`. When the rollout is deleted mid-turn, Codex keeps writing to the deleted file and does not create a new one;
- `exec_command` returns control to the model no later than after 30 s, even if `yield_time_ms: 60000` is requested;
- `codex exec` silently skips untrusted hooks;
- `codex archive` moves the rollout to the flat `archived_sessions/`, `codex unarchive` moves it back;
- `codex delete --force` does not delete a thread that has a branch.

**macOS 27.0.1, Node 26.10.0.** Recursive `fs.watch` reports file creation and a write through a new open, but not a write through an already open handle (Q4-1).

**Windows Server 2025, Node 26.10.0:**

- recursive `fs.watch` (`ReadDirectoryChangesW`) also does not report the last write through an open handle, but the Codex rollout is read immediately during a command (section 2, Q4-1);
- Claude runs Bash in Git Bash and writes Windows paths to the transcript, including after `cd`;
- Codex runs commands and hooks in PowerShell. aang's hooks for Codex are the commands `& '<aang-hook.exe>' codex user '<spool>'`; their trust and the positional key shift behave as on macOS and Linux.

## 9. What is not covered

- **Windows, the interactive part** — TUI in PowerShell, item B6 of the owner's checklist. The automatic part runs in CI.
- **Cleanup hang on Windows.** In the first run on Windows (CI, revision `b13b3c80`) the cleanup of the `lineage/claude-fork-parent-unseen` scenario hung after all its checks, and the workflow stopped on the 75-minute limit. The next two runs at revisions `f533b816` and `5b6bf4f7` passed in 6 minutes. The cause was not found. Now the daemon exit and each cleanup stage of a scenario are bounded by 60 s; if a stage did not finish, the scenario gets ✘. Cleanup stages run independently of errors in the previous ones. After a hung stage and at the end of every cleanup, the tool kills, until they are gone, and lists in the report: the scenario's running daemons, CLIs and `aang` commands with their descendants; on Linux and macOS, all processes of the process groups of the scenario's CLIs and `aang` commands, including after the command itself exited; processes whose command line or environment contains the profile path. If such a process is still running after 30 s, the scenario gets ✘. The only process not found is one outside these groups whose parent has exited and whose command line and environment do not contain the profile path. `ps` on macOS does not show the environment of system programs like `/bin/sleep`. On Windows there are no process groups and the tool does not read the environment, so there such a process is found only by its command line.
- **Desktop, interactive TUIs, the `/hooks` dialog, `/clear`** — the owner's checklist, sections A and B.
- **The real model** — optional, item C1 of the checklist. The behavior checked here (files, hooks, processes) does not depend on the model.
- **Without a live check:**
  - the spool retention (7 days) and the size threshold (1 GB) — by time and size they are inconvenient for a live run; they are held by the integration tests of the collector and the daemon;
  - the Codex OTel channel;
  - a restart in the middle of subagent work.
