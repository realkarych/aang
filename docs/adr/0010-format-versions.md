# ADR-0010: Unstable formats and versions

Superseded in part by [ADR-0015](0015-ui-simplification.md).

Status: accepted by the owner 2026-10-01. TUI recordings in CI instead of the manual Claude TUI checklist on Linux (decision 4) and statuses from check results (decision 5) approved by the owner 2026-10-08.

## Context

Both documentations call the transcript and rollout formats internal. Record types and usage behavior change between versions; Codex already has flags for rollout compaction and migration. Desktop and the SDKs embed their own engine versions: Claude 2.1.284 alongside CLI 2.1.286, Codex SDK 0.159.3 alongside CLI 0.159.2 (spike, sections 1, 4, 5.2-F). After the spike the owner's Codex CLI was updated to 0.159.3.

RFC §7 allows declaring support only for a specific version and launch method after verification of: tool events, child agents, usage, continuation, compaction and reconnection. Each mandatory surface must pass both user scenarios. Unknown records are stored, gaps are visible in the UI. If Desktop does not pass, the limitation is put to the owner for a decision (RFC §4).

## Decision

### Tolerant parsers

- An adapter is a set of parsers keyed by `(runtime, channel, record type)`. These are `zod` schemas that pass unknown fields through.
- An unknown type or field does not interrupt intake: the raw record is always stored (ADR-0005), and an unparsed one gets `parse_state=unknown`. The UI shows an "unrecognized records" counter per session.
- Per-version parsing variants are introduced only where the behavior actually differs. The difference is detected by the presence of records, not by the version number. Example: Codex usage without `token_usage_record` (ADR-0009).
- An unknown file layout (for example, a compacted or migrated rollout) is recognized as an unrecognized stream and marked with a gap.
- The version is determined per stream:
  - Claude — the `version` field of records and `AI_AGENT` in the hook environment;
  - Codex — `session_meta.cli_version`;
  - Desktop and SDK — by the embedded engine version and the SDK environment variables.

### Reference sessions

- **Scenarios** (spike, section 13.3):
  - tool events;
  - subagent and parallel agents;
  - usage;
  - resume;
  - compaction;
  - fork;
  - plan;
  - approval request and the decision on it;
  - explicit question;
  - interruption;
  - reconnection: daemon restart during a session;
  - source loss: deletion, move, archive.
- **Recording.** The dev tool `tools/record` runs the real CLIs in a temporary project with a hooks recorder via `--plugin-dir` (Claude) and anonymizes the result according to the rules of the spike's appendix A, including Windows home paths.
  - The recorder is the real `catacomb-hook` into a temporary spool with a valid lease: without a lease it silently writes nothing (ADR-0004).
  - Recording happens on the OS it is meant for; WSL does not count as a Windows recording.
  - Codex scenarios with hooks (hooks, subagents, fork, TUI) are recorded with a Responses API stub in a temporary `CODEX_HOME`. The scenario with the real model is recorded without hooks, in the regular home with `--ignore-user-config`: copying the authorization into a temporary home is forbidden (spike, section 13.1).
  - Desktop engines are recorded in emulation mode (spike, section 11).
- **Storage:** `fixtures/sessions/<runtime>/<engine version>/<surface>/<OS>/<scenario>/` with a manifest:
  - versions, surface and recording OS (`macos`, `linux`, `windows`), which `tools/record` sets itself;
  - steps;
  - expected key facts;
  - control events with the expected map change for the freshness measurement: a predicate over the model or a description for the labeler (ADR-0007).

### Contract tests

- **Adapters.** The adapters and the object engine are run over the reference sessions. Checked:
  - a snapshot of normalized facts and objects;
  - no duplicate facts;
  - resolved links;
  - usage invariants — for example, the sum of a thread's `token_usage_record` equals the last `thread_token_usage`, except for forks: their counter inherits the parent's;
  - no `unknown` among the covered types.

  The tests run in CI on each OS over the recordings of all OSes: this checks the portability of parsing, but not support for an OS on which no recording was made.
- **Observer isolation on each supported CLI version (approved by the owner).**
  - Codex — on the Responses API stub, without authorization: empty `body.tools` and `input[additional_tools].tools`, call attempts get `unsupported`, `--ephemeral` writes nothing, the control hook does not execute with `--disable hooks` and executes without it; both branches use the same test trust bypass (ADR-0007). The test runs in CI with the CLI installed.
  - Claude — on the installed CLI, locally (authorization is needed): the automatic admission of ADR-0007 plus a check of `crossSessionInbound` by a peer session that sends a message to the observer.

  The result is written to the support matrix.
- **A new CLI version on the user's machine.** Before working calls, the daemon performs the automatic admission of ADR-0007 on a synthetic input. Without it, the observer is off on that version. Until the local contract run, a Claude version is used with a mark (ADR-0007, decision 7).

### Declaring support

- The matrix `support/matrix.json` in the repository. The row key is `(runtime, surface, OS, placement, engine version)`.
  - Surfaces: Claude CLI, Claude Desktop (Local and worktree), Claude Agent SDK, Codex TUI, Codex `exec`, Codex Desktop (Local and worktree), Codex SDK.
  - OS — macOS, Linux, Windows. Support on one OS does not carry over to another (ADR-0013).
  - Placement — local, Docker, VM, Desktop SSH mode, where applicable. Docker on any host OS counts as the Linux OS; Desktop SSH mode and VM belong to the OS of the remote machine.
  - For Desktop and the SDKs the key is the embedded engine version; the application version is stored for reference.
  - A row stores the results of both user scenarios, resume, compaction, child sessions and reconnection, as well as the observer admission result.
- Statuses:
  - `full` — no gaps;
  - `limited` — with a list of gaps;
  - `unverified`.
- The status follows from check results rather than being declared (approved by the owner 2026-10-08, decision 5). The row admission conditions are checked first, then the scenario gaps.
- Conditions for admission to `full` or `limited`; while at least one is not met (the check is missing or failed), the row is `unverified` (plan, R.5a):
  - reference recordings for this OS; recordings from another OS do not count;
  - for a placement other than local, a passed placement check (plan, Q.1); reference recordings are taken by OS;
  - for Desktop, the owner's manual checklist passed (spike, section 11) on each OS where Desktop is checked; for the interactive Claude TUI, checklist a–h passed (spike, section 6) on macOS and Windows. Recordings of the Desktop engine in emulation do not replace manual admission;
  - for the interactive Claude TUI on Linux, TUI recordings in CI are enough (scenarios `teammates` and `input-dialogs` via `expect`); the manual checklist is not needed (approved by the owner 2026-10-08, decision 4);
  - Desktop on Windows is not checked in the MVP, and its rows remain `unverified` (ADR-0013, decision 3).
- Scenario gaps of an admitted row: without them it is `full`, with them it is `limited` with their list:
  - contract tests for all scenarios above on recordings of this OS: a scenario is not recorded or does not pass;
  - E2E scenarios 1 and 4 (ADR-0012) on reference sessions of this surface and OS do not run or do not pass.
- If Desktop does not pass both scenarios, the limitation is put to the owner rather than silently excluded.
- Support is declared per exact engine version. An unverified version works in tolerant mode; the UI shows it in the status bar, without an alarming mark on every session. The status-bar display is superseded by ADR-0015: an unverified version does not light the health dot and is shown only in `catacomb status`.
- `catacomb doctor` lists the versions encountered and their status. The appearance of a new version is a signal to record reference sessions for it.

### Current state of versions

- The matrix starts empty: until the contract tests, all rows are `unverified`, and having an adapter does not count as support.
- The spike checked Codex CLI 0.159.2, Codex SDK 0.159.3 with its own binary and the 0.159.2 build embedded in Desktop. The owner already has Codex CLI 0.159.3. The spike's data on 0.159.2 are format samples for developing adapters, not evidence of support for 0.159.3. A matching number with the SDK proves nothing either: the SDK and the CLI are different surfaces with their own builds.
- The first reference sessions are recorded on the versions installed at the time of recording (plan, R.4): currently Claude 2.1.286 (CLI, SDK), the Claude Desktop engine, Codex CLI 0.159.3, Codex SDK 0.159.3 and the Codex Desktop build. They are recorded on each MVP OS for the surfaces available on it.
- The Codex observer profile and the spike measurements refer to 0.159.2. On 0.159.3 the model catalog is regenerated, and the observer is used only after the version is admitted (ADR-0007). This decision requires no new experiments: verification is done by admission and the contract run.

## Consequences

- Each new runtime version requires recording and running reference sessions. This is a permanent maintenance cost: Claude releases patches almost daily.
- A format update does not break collection: at worst the number of unrecognized records grows, and after the parser is fixed `catacomb reparse` parses them.

## Owner decisions

Accepted by the owner 2026-10-01:

1. Reference sessions are recorded for each new engine version encountered in the owner's environment.
2. The budget for recording with the real model is about $1–2 per runtime and version.
3. Reference sessions recorded by the tool and anonymized count as generated code. The project's PR size limit was cancelled by the owner; PRs remain logically cohesive (AGENTS.md).

Accepted by the owner 2026-10-08 based on the Q.1 report (`docs/research/q1-surface-matrix.md`, section 6, item 5, and section 7; PR #160):

4. For the interactive Claude TUI on Linux, TUI recordings in CI are enough; the manual checklist is not needed. Checklist a–h remains on macOS and Windows.
5. Statuses are declared from check results: `full` without gaps, `limited` with their list; rows that need a manual checklist only after the checklist. The `unverified` grounds from the plan (R.5a) are kept: an OS row without its own recordings, a placement row without the Q.1 check, Desktop on Windows.
