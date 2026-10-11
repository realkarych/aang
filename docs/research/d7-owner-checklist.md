# Early manual owner checklist (D.7): macOS

Status: instructions for plan item D.7 (`docs/plan/mvp.md`). Performed by the owner. This is not a report: results and conclusions go into a separate report (section 7).
Date: 2026-10-03. Tool — `tools/owner-checklist`.

Instructions for Windows — `docs/research/d7-owner-checklist-windows.md`.

## 0. What is checked

- **Section A — interactive Claude TUI**, items (a)–(h) of section 6 of the spike (`docs/research/integrations.md`, "Documentation only"). The spike did not run the TUI: accepting the trust dialog changes `~/.claude.json`.
- **Section B — Claude Desktop, Code tab**, steps 1–6 of section 11 of the spike ("Manual experiment checklist").
- **Section C — Codex in ChatGPT Desktop**, steps 7–10 of the same section.

The event recorder is the real `aang-hook` (ADR-0004, "Hook handler contract"). It writes to a temporary spool in which `prepare` creates a valid lease; without it the hook writes nothing. For what `aang-hook` does not capture, there are two Node probes: the hook process environment (item f) and deliberate hook failures (item d).

Desktop on Windows is not checked in the MVP (ADR-0013, decision 3). Desktop limitations found here are escalated to the owner before stage 2 (RFC §4).

## 1. What changes in user settings

| What changes | When | How it is rolled back |
| --- | --- | --- |
| The `aang` marketplace and the `aang@aang` plugin in the Claude user scope (`~/.claude/settings.json`, `~/.claude/plugins/`) | `prepare` with `--claude marketplace` (the default on macOS): the product `installClaudePlugin`, i.e. `claude plugin marketplace add` and `claude plugin install --scope user` | `cleanup`: the product `uninstallClaudePlugin` (`claude plugin uninstall`, `claude plugin marketplace remove`) |
| aang entries in `~/.codex/hooks.json`: one group at the end of the arrays of all 12 Codex events. The command is `'<dir>/aang-home/bin/aang-hook' codex user '<dir>/aang-home/spool'` | `prepare --codex-hooks` | `cleanup` removes the aang groups by the exact command string. Other entries and their positions do not change. If nothing but the aang entries changed in the file, it is restored from the backup byte for byte. If someone appended their own entry after the aang entry was written, the aang entry is not removed but neutralized in place (`true`), so as not to shift other positions. A file created by the preparation is deleted. The backup `hooks.json.aang-d7-backup-<time>` stays next to it: the owner deletes it |
| Trust in the aang hooks in `~/.codex/config.toml` (`hooks.state."<path>:<event>:i:j"`) | the owner confirms trust (step 7) | manually: aang does not write `hooks.state` (ADR-0004) |
| The `~/aang-desktop-probe-outside` directory | `prepare --codex-hooks` | `cleanup` |
| The `probe-repo` project entry in `~/.claude.json` | the first TUI or Desktop launch in the probe repository, the trust dialog | manually |
| Sessions: transcripts in `~/.claude/projects/`, Desktop metafiles, rollouts in `~/.codex/sessions/`, Codex worktrees | during the checks | `cleanup` prints a list, the owner deletes |

While the preparation is not rolled back and the lease is valid (24 h by default), the user-scope plugin writes the events of **all** Claude sessions to the spool, and the Codex hooks those of all Codex sessions after trust. The spool contains full payloads, including prompts and tool output (ADR-0004, "Consequences"). Therefore:

- for the duration of the checklist, do not work in other projects in Claude and Codex;
- run `cleanup` right after collection: it deletes the spool;
- by default `collect` takes only sessions whose `cwd` lies in the working directory or in `~/.codex/worktrees`; it discards the rest and counts them in the summary.

The preparation does not touch stale aang entries in `~/.codex/hooks.json` (for example, `aang hook` from earlier experiments). The product `installCodexHooks` is not used for the checklist: it neutralizes stale aang entries and verifies trust via `codex app-server`, and running the app-server on the regular `~/.codex` is not allowed before the D.6 report.

## 2. Preparation

Before preparation:

- close Claude Desktop and ChatGPT;
- check that `permissions.allow` in `~/.claude/settings.json` has no rule allowing `touch`: otherwise items (a) and 1a will have no permission prompt;
- write down the versions: `claude --version`, `codex --version`, "About" in Claude Desktop and ChatGPT.

```sh
cd ~/src/aang
pnpm install
pnpm build
node tools/owner-checklist/dist/main.js prepare --dir /tmp/aang-d7 --codex-hooks
```

`prepare` options:

| Option | Meaning |
| --- | --- |
| `--dir <path>` | working directory; by default `$TMPDIR/aang-d7`. On macOS `/tmp/aang-d7` is more convenient, as in the spike. The directory must be empty or absent |
| `--claude marketplace` | the default on macOS and Linux: installs the plugin via the product path; needed for Claude Desktop, which launches without flags |
| `--claude plugin-dir` | registers nothing; the TUI is launched with `--plugin-dir`. Sufficient if only section A is checked |
| `--codex-hooks` | aang entries in `~/.codex/hooks.json` and the `~/aang-desktop-probe-outside` directory; needed for section C |
| `--hours <n>` | spool lease duration, 24 by default |
| `--hook <path>` | the `aang-hook` binary, by default `packages/hook/bin/aang-hook` from the build |
| `--claude-command <path>`, `--codex-home <path>` | a different `claude` for plugin installation and a different `CODEX_HOME` |

If the `aang@aang` plugin is already installed, `prepare` refuses and changes nothing in the Claude settings. If the preparation was interrupted, `cleanup` with the same `--dir` rolls back what was done.

What is created in `/tmp/aang-d7`:

```
aang-home/bin/aang-hook          unmodified copy of the binary
aang-home/spool/{new,tmp}        spool and the lease spool/lease-<expiry in Unix seconds>
aang-home/claude-plugin/         plugin generated by the product writeClaudePlugin (exec form)
probes/env-settings.json         environment probe on SessionStart, writes results/env-probe.jsonl
probes/failure-settings.json     PreToolUse exits with code 1; UserPromptSubmit hangs longer than timeout: 2
probe-repo/                      git repository with an initial commit
results/                         collect results
state.json                       what the preparation did; cleanup works from it
```

`prepare` prints a memo with the exact launch commands. The probes call `node` from the build (`tools/owner-checklist/dist/probe.js`), so do not rebuild or switch the repository branch before `cleanup`.

If the lease expires before the checks are over, the hook stops writing. A new lease for a day is created by:

```sh
touch "/tmp/aang-d7/aang-home/spool/lease-$(( $(date +%s) + 86400 ))"
```

Results can be collected at any time: `collect` only reads and overwrites files in `results/` (section 6). Write down the local time of every action: sessions are matched against the summary by it.

## 3. Section A — interactive Claude TUI, items (a)–(h)

Terminal — Terminal.app or iTerm2. All sessions are in the probe repository, in the default permission mode:

```sh
cd /tmp/aang-d7/probe-repo
claude --settings /tmp/aang-d7/probes/env-settings.json
```

In `plugin-dir` mode add `--plugin-dir /tmp/aang-d7/aang-home/claude-plugin`; in `marketplace` mode this flag is not needed: the plugin is already loaded from the user scope, and a second instance would cause a double registration. `--settings` is passed once, so the environment and failure probes are attached in different sessions. On the first launch, accept the directory trust dialog.

According to the Claude Code documentation, the `permission_prompt` and `idle_prompt` notifications in the terminal arrive only when the user has "stepped away". Therefore (a) and (b) have variants with focus in the terminal and outside it; write down which one it was.

**(a) Notification(`permission_prompt`) after PermissionRequest.**

- a1. Prompt: "Run `touch aang-perm-allow.txt` with Bash". When the permission prompt appears, switch to another window and do not touch the keyboard for 15 s. Then allow.
- a2. Prompt: "Run `touch aang-perm-allow-2.txt` with Bash". Keep focus in the terminal, for 15 s press the up or down arrow about once every 3 s. Write down the time of the last keypress, wait another 10 s and allow.
- a3. Prompt: "Run `touch aang-perm-deny.txt` with Bash". Deny.

Expected:

- a1 — PreToolUse(Bash) → PermissionRequest → Notification(`permission_prompt`) about 6 s later → PostToolUse with the same `tool_use_id`;
- a2 — the notification later, about 6 s after the last keypress, or none;
- a3 — PermissionRequest present, no PostToolUse, the denial is visible in PostToolBatch.

**(b) Notification(`idle_prompt`).** After any response (Stop), switch to another window and type nothing for 90 s. Expected: Notification(`idle_prompt`) about 60 s after Stop. Repeat with focus in the terminal.

**(c) AskUserQuestion.** Prompt: "Ask me two questions at once with the AskUserQuestion tool, two options each, then reply OK". Wait 10 s before answering, then answer both questions. Expected: PreToolUse(AskUserQuestion) with two questions and PostToolUse with `answers`. Check whether there are PermissionRequest and Notification between them.

**(d) Hook errors and a hung hook.** Exit the session and start a separate one:

```sh
claude --settings /tmp/aang-d7/probes/failure-settings.json
```

Prompt: "Run `echo hi` with Bash, then reply OK". The UserPromptSubmit hook hangs for 30 s with `timeout: 2` and sets `statusMessage` "aang D.7: hook hangs longer than its 2 s timeout". The PreToolUse hook exits with code 1 and writes "aang D.7: deliberate hook failure" to stderr.

Write down:

- what the spinner showed and how long the wait lasted;
- whether there was a timeout cancellation message;
- what the `PreToolUse` error looks like (for example, "PreToolUse:Bash hook error") and where it is shown; Ctrl+O opens the details;
- whether the command ran.

Attach screenshots to the report. The summary does not check this item.

**(e) SessionEnd.reason.** End sessions in different ways and write down which was ended how:

- `/exit`;
- double Ctrl+C on an empty line;
- double Ctrl+D;
- `/clear` inside a session: this is SessionEnd and a new SessionStart with `source: clear`.

The spike expected `prompt_input_exit` when exiting with the input line open. Documented values: `clear`, `resume`, `logout`, `prompt_input_exit`, `other`.

**(f) Hook process environment.** No separate actions: every session started with `env-settings.json` writes the values of `CLAUDE_CODE_SESSION_ATTENDED`, `CLAUDE_CODE_ENTRYPOINT` and neighboring variables to `results/env-probe.jsonl`. In the spike, `CLAUDE_CODE_SESSION_ATTENDED=0` was present both in the stdio host and in the SDK.

**(g) `elicitation_dialog` and `agent_needs_input`.** The summary lists all encountered `notification_type` values. According to the documentation:

- `elicitation_dialog` arrives when an MCP server opens an elicitation form and there is no input for about 6 s;
- `agent_needs_input` — when a background session waits for input while the agent view is open, or an agent team teammate asks a question.

If such an MCP server or mode already exists, trigger them and write down how. Do not install new MCP servers for this. If triggering failed, the item is marked unchecked.

**(h) ExitPlanMode.** A separate session in plan mode:

```sh
claude --permission-mode plan --settings /tmp/aang-d7/probes/env-settings.json
```

Prompt: "Plan how to create the file aang-plan.txt containing hi, then present the plan for approval". Approve the plan, then allow the file creation. Expected:

- PreToolUse(ExitPlanMode) with `tool_input.plan` (in the summary — its length) and `planFilePath`;
- the plan confirmation request as a PermissionRequest or without one;
- PostToolUse(ExitPlanMode).

## 4. Section B — Claude Desktop, Code tab, steps 1–6

`marketplace` mode is required: Desktop launches its built-in engine without flags and takes the plugin from the user scope. After `prepare`, restart Claude Desktop (Cmd+Q and open again): running sessions do not change their loaded plugin set.

New session: Code → Local, folder `/tmp/aang-d7/probe-repo` (in the picker, Cmd+Shift+G and the path), permission mode Ask.

1. Prompt: "Run `echo hi` with Bash, then ask me one question with AskUserQuestion, then reply OK". Expected:
   - SessionStart, UserPromptSubmit, PreToolUse(Bash), PostToolUse, PreToolUse(AskUserQuestion), Stop;
   - in the hook environment `CLAUDE_CODE_ENTRYPOINT=claude-desktop` and `CLAUDE_CODE_HOST_SESSION_ID=local_<uuid>` — the metafile name.

   Claude Code approves `echo` by itself, so this step checks only the regular events.
   - 1a. **Deterministic permission prompt.** Prompt: "Run `touch aang-perm-allow.txt` with Bash". Wait more than 6 s and allow. Expected: PermissionRequest, Notification(`permission_prompt`) and PostToolUse with the same `tool_use_id` as PreToolUse. In Desktop, according to the documentation, the notification arrives after 6 s regardless of input. Repeat with "Run `touch aang-perm-deny.txt` with Bash" and deny: PermissionRequest present, no PostToolUse, the denial is visible in PostToolBatch.
2. `/compact`. Expected: PreCompact and `compact_boundary` in the transcript.
3. Prompt: "Use the Agent tool to start a subagent that lists the files in this directory". Expected: SubagentStart and SubagentStop, as well as `subagents/agent-*.jsonl` files.
   - 3a. If spawn task or Dispatch is available in Desktop, spawn a separate session with them. Expected: the link to the parent exists only in the metafile's `spawnSeed` and `lastSpawnRootDetected`. The format of these fields is the main question of the step: decision 4 of ADR-0004 depends on it.
4. Close Desktop (Cmd+Q), open it again and continue the step 1 session with the prompt "reply OK". Check `SessionStart.source` and whether the same `cliSessionId` remained, i.e. the same transcript.
5. A new session in worktree mode for the same repository, prompt "Run `pwd` with Bash". Expected: `cwd` inside `/tmp/aang-d7/probe-repo/.claude/worktrees/…`; the project directory in `~/.claude/projects` is visible in the summary.
6. First run `collect` (section 6) and save a copy of the summary, because the metafile disappears after the session is deleted:

   ```sh
   cp /tmp/aang-d7/results/summary.md /tmp/aang-d7/results/summary-before-step6.md
   cp /tmp/aang-d7/results/files.json /tmp/aang-d7/results/files-before-step6.json
   ```

   Then archive the step 1 session and delete it. Run `collect` again. Check the `deleted_<uuid>` marker (the summary section «Маркеры удаления» ("Deletion markers")) and whether the transcript remained (the table «Транскрипты Claude» ("Claude transcripts")).

## 5. Section C — Codex in ChatGPT Desktop, steps 7–10

`prepare --codex-hooks` is required. Do not run `codex app-server` yourself: it is forbidden before the D.6 report.

7. Open ChatGPT (Codex) and confirm trust in the aang hooks. If the app does not offer this by itself, use `/hooks` in terminal Codex (`codex` in any directory, without a prompt): trust is stored in the shared `~/.codex/config.toml`. Check `trustStatus` in the `hooks/list` responses in the logs `~/Library/Logs/com.openai.codex/<YYYY>/<MM>/<DD>/codex-desktop-*.log`. Codex silently does not run new hooks without trust, so the absence of Codex events in the summary means there is no trust.
8. A new Local chat in `/tmp/aang-d7/probe-repo` with on-request approval. Prompt: "Run `echo hi`, then reply OK". A safe command in the sandbox may pass without a prompt, so the step checks only SessionStart, UserPromptSubmit, PreToolUse, PostToolUse and Stop. The `originator` and `source` of the new rollout are visible in the summary.
   - 8a. **Deterministic approval request.** Run `collect` and check in the summary's Codex section that `~/aang-desktop-probe-outside` is not among the writable roots. Prompt: "Run `touch ~/aang-desktop-probe-outside/allow.txt` and request escalated permissions for it (`sandbox_permissions: require_escalated`)". Approve. Expected: PermissionRequest and PostToolUse, the file is created (`ls ~/aang-desktop-probe-outside`). Repeat with `deny.txt` and deny: PermissionRequest present, no PostToolUse and no file. If OTel export is enabled, match `codex.tool_decision` by `call_id` against the PreToolUse `tool_use_id`. If the approval request did not appear, the step failed; this is not confirmation of working hooks.
9. Repeat step 8 in a Worktree chat: `cwd` must lie in `~/.codex/worktrees/…`. Then ask to spawn a subagent: "Spawn a subagent that runs `echo sub` and reports back". Expected: SubagentStart, SubagentStop and a subagent rollout with `parent_thread_id`: the summary shows it as a «Субагент» ("Subagent") line in the session section and matches `parent_thread_id` against the parent's `session_id`. Close and reopen the app, continue the chat. Expected: `SessionStart.source=resume`.
10. A Cloud chat, if available, prompt "reply OK". Expected: neither a new rollout nor events in the spool. Write down the chat time: the summary must not have a Codex session with this time.

## 6. Collecting results

Collection, moving results and rollback (section 8) are run from the aang repository root, not from `probe-repo`, where the terminal went for the TUI sessions:

```sh
cd ~/src/aang
node tools/owner-checklist/dist/main.js collect --dir /tmp/aang-d7
```

The command only reads: spool `new/`, Claude transcripts (`$CLAUDE_CONFIG_DIR` or `~/.claude`), Codex rollouts (`$CODEX_HOME` or `~/.codex`) and Claude Desktop metafiles (`~/Library/Application Support/Claude/claude-code-sessions`). It writes only to `/tmp/aang-d7/results/`. It can be repeated.

| File | Contents |
| --- | --- |
| `events.jsonl` | one event per line: receive time (spool file mtime), runtime, tag, environment from the spool header, `hook_event_name`, `session_id` and only safe fields. For example, `tool_name`, `tool_use_id`, `notification_type`, `source`, `reason`, `cwd`, the number of AskUserQuestion questions, presence of `answers`, `plan` length, presence of `planFilePath`, PostToolBatch composition without the response text |
| `summary.md` | sessions by time and checklist items. Notification latencies, AskUserQuestion and ExitPlanMode chains, `SessionEnd.reason`, hook environment, Notification types, Desktop and Codex sections. Items that only the owner's eye checks are marked «заполняет владелец» ("filled in by the owner") |
| `files.json` | Claude transcripts (`entrypoint`, versions, `compact_boundary`, `subagents/` files), Codex rollouts and their subagents (`originator`, `source`, `parent_thread_id`, `approval_policy`, `sandbox_policy`) and Desktop metafiles |
| `env-probe.jsonl` | environment probe records (item f) |

Prompts, model responses, tool output and file contents are not saved. Paths are anonymized: the working directory is replaced with `<dir>`, the home directory with `~`. Per decision 4 of ADR-0004, only the values of `cliSessionId`, `spawnSeed` and `lastSpawnRootDetected` are taken from Desktop metafiles; for the other keys only the type is output. Strings in `spawnSeed` and `lastSpawnRootDetected`, except UUID identifiers and `local_<uuid>`, are replaced with their length. Metafiles are taken only for sessions from the spool, by `cliSessionId` or `CLAUDE_CODE_HOST_SESSION_ID`.

Sessions with `cwd` outside the working directory and `~/.codex/worktrees` are discarded; their number is given in the summary. `--all-sessions` includes all sessions from the spool; this is not needed for `docs/research/`.

Review the files before moving them. Then:

```sh
cd ~/src/aang
mkdir -p docs/research/samples/owner-checklist/macos
cp /tmp/aang-d7/results/* docs/research/samples/owner-checklist/macos/
```

## 7. Report

The outcome is written up in `docs/research/d7-owner-checklist-results.md`, following the example of `docs/research/windows-runtimes.md`:

- versions of `claude`, Claude Desktop and its built-in engine (the «Версии» ("Versions") field of the transcripts table), ChatGPT and Codex (rollout `cli_version`);
- for each item of A, B and C — the expectation, the observation from the summary and the owner's notes from the «Заполняет владелец» ("Filled in by the owner") section;
- the format of `spawnSeed` and `lastSpawnRootDetected`. Confirmation of the format lifts the condition of decision 4 of ADR-0004; a discrepancy is recorded in ADR-0004;
- Desktop limitations that are escalated to the owner before stage 2 (RFC §4).

## 8. Rollback

```sh
cd ~/src/aang
node tools/owner-checklist/dist/main.js cleanup --dir /tmp/aang-d7
```

With `--keep-results` the `results/` directory stays, the rest is deleted. Based on `state.json`, the command:

- removes the aang plugin and marketplace from the Claude user scope, if the preparation installed them;
- removes the aang entries from `~/.codex/hooks.json`, as described in section 1;
- deletes `~/aang-desktop-probe-outside` and the working directory together with the spool and the probe repository.

Then it prints:

- what is not rolled back automatically: the `hooks.json` backup, the trust in `config.toml`, the project entry in `~/.claude.json`;
- the created sessions: Claude transcripts of the `probe-repo` project and its worktree, Desktop metafiles, Codex rollouts and their subagents, Codex worktrees from the spool.

The owner deletes the sessions, as in the spike.
