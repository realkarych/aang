# Contract run and support matrix (R.5a, R.5b)

`tools/support` replays the reference sessions of `fixtures/sessions` through the real collector, adapters and `engine`, compares the result with stored snapshots, checks the invariants of ADR-0010 and generates `support/matrix.json`.

```sh
pnpm build
pnpm support:check
pnpm support:update
```

Both commands accept `--fixtures <directory>` (default `fixtures/sessions`), `--support <directory>` (default `support`) and `--hook <aang-hook>` (default the built binary). `check` exits with 1 and lists the problems; `update` writes the snapshots and the matrix, and refuses to write anything when an invariant is violated. Both read the placement checks and owner checklists of `verification.json` from the support directory (see [Placement checks and owner checklists](#placement-checks-and-owner-checklists-q1)).

CI runs the same check as contract tests: `tools/support/test/contract.test.ts` has one test per recording and fails when a snapshot differs, a snapshot is missing or stale, an invariant is violated (an unparsed record among them), or `support/matrix.json` is not the matrix of the run. A pull request that adds or re-records reference sessions (R.4) or changes the normalized output runs `pnpm support:update` and commits the regenerated files.

## Which recordings run

Every recording under `fixtures/sessions/<runtime>/<engine-version>/<surface>/<os>/<scenario>/` is verified with the recorder's `verifyRecording` and replayed on every OS, whatever OS recorded it. Every scenario of ADR-0010 is in the run and mandatory (R.5b): the R.5a subset left out `plan` and `question` (plans and answers to questions), C.6 added them for Codex and B.7 for Claude. Teammates, workflows and MCP elicitation (`teammates`, `input-dialogs`, `workflow`, `elicitation`) are mandatory too: R.2b added the scenarios, R.4b recorded them and B.8 added them to the run. Plugin agents and skills, agents passed with `--agents`, user hooks with output and Codex agent roles (`plugin`, `agents-flag`, `user-hooks`, `agent-role`) followed the same path: R.2c added the scenarios, R.4b recorded them, and F.7d made them mandatory. A scenario that is recorded but not yet parsed stays out of the run through `pendingScenarios` in `src/run.ts`; no scenario is pending now. The Codex Desktop `question` (R.2d) is mandatory from the start, like the other Codex questions: until R.4b records it, the Codex Desktop row lists it as missing.

## Playback

Each recording plays into a temporary HOME with the testkit player, the real `aang-hook` with a leased spool, and the collector's OTLP receiver. The collector scans every 10 ms and its batches go through `engine.ingest` with `watch.all`, wired as the daemon wires them: acknowledgements, rescans requested by the engine, and open `source_lost` gaps passed to the collector at start.

A step labelled `daemon-restart` (the reconnect scenario) restarts the ingestion once the step is reflected: the collector and the engine stop, the store closes and reopens from the same directory, and a new collector starts from the cursors and open gaps saved in the store, with the same spool and OTLP port. A `reconnect` recording without such a step fails the run, so `reconnect` is `passed` only after a real restart.

Steps play one at a time. The next step starts only after the collector has reflected the previous one:

| Step | Reflected when |
| --- | --- |
| `hook` | the spool has no unread files |
| `otlp` | every `codex.tool_decision` log record of the request has been collected and the OTLP queue is empty |
| `append` or `write` of a transcript or rollout | the collector's cursor for the file reaches its size |
| `write` of a registry, team, subagent meta or workflow JSON | the collector has emitted the file's current content hash |
| `remove` of a JSON snapshot | the collector has emitted the removal |
| `remove` of a transcript or rollout | the stream is lost, or the collector has re-read the same stream from another path since the step |
| a file the collector does not collect | immediately |

Which files count as collected mirrors the collector's roots and tail filter (`packages/collector/src/roots.ts`, `packages/collector/src/tail.ts`): nothing under a Claude `tool-results` directory is collected, and `.jsonl.superseded-*` transcripts are tailed. A step that is never reflected fails the run after 30 seconds instead of producing a different snapshot.

## Snapshot

The snapshot holds the normalized facts (ordered by raw record), sessions, agents, actions, questions, usage records, artifact versions and Git snapshots, gaps, removals, runs and the model entities of each run, plus a count of raw records by channel, record type and parse state. It is canonical:

- times are `<time>`; `change_seq` is left out;
- hook spool file names, which carry the receipt time, become `spool#<n>` in the order the hooks were collected;
- values of fields typed as ids in the `@aang/contract` schemas (derived and assigned) become `#<n>` in order of first appearance, and lists of ids are ordered by these labels; any other text, including text shaped like a hash, stays as it is;
- object lists are ordered by their keys with ids and times masked;
- the temporary playback directory becomes `<base>` with `/` separators, including JSON-escaped Windows paths.

## Invariants

- No two facts have the same kind, entity, time, runtime ids and payload.
- Every id that an object, gap, run or model entity refers to through a field typed as an id in the `@aang/contract` schemas is stored: facts, observations, artifact versions and their artifacts, Git snapshots, gaps, runs, model entities (including assigned ids such as stage ids) and observer calls. Content and runtime identifiers are never read as references.
- For every Codex thread with `token_usage_record` facts, their sum equals the last `thread_token_usage`. Forked threads are skipped: their counter inherits the parent.
- Every raw record is parsed (R.5b, ADR-0010: no `unknown` among the covered types). An `invalid` or `unknown` record breaks the run and is reported by its record type, the one of the snapshot's record counts: the hook event name or the record `type`, followed by its `subtype` or `payload.type`. The covered types are all types of the reference sessions: the last type left unparsed, the Claude transcript record `system:stop_hook_summary`, is parsed since F.7d. A new type in a new recording breaks the run until the adapter parses it.

## Matrix

`support/matrix.json` follows `SupportMatrix` from `@aang/contract`. Rows come from the recordings (local placement), from the previous matrix, from every key of `support/verification.json`, and, for every Desktop engine version, an explicit Windows row. For each row:

- `resume`, `compaction`, `child_sessions` (`subagents`, `fork`) and `reconnect` are `passed`, `failed` or `not_run` from the recordings of the row's own OS, whatever its placement; recordings of another OS never count;
- `during_work` and `after_iteration` (E2E 1 and 4) are kept from the previous matrix. A row with a placement other than local takes them from the local row of the same runtime, surface, OS and engine version in the previous matrix, because E2E 1 and 4 run on the reference recordings of the OS (ADR-0010); without such a row it keeps its own values, and a new row starts with `not_run`. `e2e/support-matrix.test.ts` keeps the local columns in line with the E2E variants (`e2e/README.md`);
- `observer` is kept from the previous matrix;
- the gaps are the reasons below that hold, in the order they are listed, and the status follows from them, whatever the previous matrix claimed (owner decision of 2026-10-08): the row is `unverified` while a reason of the row itself or of the owner checklist holds, otherwise `full` without gaps and `limited` with them;
- `verified_on` of a `full` or `limited` row is the latest date of the evidence it rests on: the UTC day of its latest recording, its placement check and the owner checklist it needs; an `unverified` row has none.

The reasons, in the order they are listed:

| Reason | Gap | Status |
| --- | --- | --- |
| Desktop runs on Windows (ADR-0013, decision 3) | `Desktop on Windows is not verified in the MVP (ADR-0013, decision 3)` | `unverified` |
| the placement is not local and `verification.json` has no placement check of the exact key | `the placement is not verified until the surface matrix check (Q.1)` | `unverified` |
| the placement check of the exact key failed | `the placement check fails (Q.1)` | `unverified` |
| the OS has no recordings | `no reference recordings on this OS` | `unverified` |
| a recording fails | `the contract run fails on: <scenarios>` | `limited` |
| a scenario that the recorder's catalog has for the surface and OS and that the run includes is not recorded | `no reference recordings of: <scenarios>` | `limited` |
| E2E 1 or 4 has failed | `user scenarios fail: <E2E 1, E2E 4>` | `limited` |
| E2E 1 or 4 has not run | `user scenarios are not verified (E2E 1 and 4)` | `limited` |
| Claude or Codex Desktop on macOS or Linux has no passed Desktop checklist of the exact key | `the owner checklist of Desktop (spike, section 11) is not passed` | `unverified` |
| the Desktop checklist of the exact key failed | `the owner checklist of Desktop (spike, section 11) fails` | `unverified` |
| Claude CLI on macOS or Windows, in every placement, has no passed TUI checklist of the exact key | `the owner checklist of the interactive TUI (spike, section 6, a–h) is not passed` | `unverified` |
| the TUI checklist of the exact key failed | `the owner checklist of the interactive TUI (spike, section 6, a–h) fails` | `unverified` |

Desktop on Windows needs no checklist: it is not verified in the MVP. Claude CLI on Linux needs no TUI checklist either: the TUI recordings of CI (`teammates` and `input-dialogs` through `expect`) are enough (ADR-0010, owner decision 4), and like every catalog scenario they are listed as missing when not recorded. Recordings of a Desktop engine in emulation never replace the owner's checklist (ADR-0010).

A key outside the matrix reads as `unverified` through `supportStatusOf` from `@aang/contract`.

## Placement checks and owner checklists (Q.1)

`support/verification.json` holds the evidence that the contract run cannot produce: placement checks and the owner's checklists. The file belongs to this tool, not to `@aang/contract`. A missing file reads as empty lists; a file off its schema stops `check`, `update` and `placement import` with its path and the problems.

```json
{
  "format": "aang-support-verification/1",
  "placements": [
    { "runtime": "claude", "surface": "claude_cli", "os": "linux", "placement": "docker", "engine_version": "2.1.289", "result": "passed", "checked_on": "2026-10-07" }
  ],
  "owner_checklists": [
    { "runtime": "claude", "surface": "claude_desktop", "os": "macos", "placement": "local", "engine_version": "2.1.286", "checklist": "desktop", "result": "passed", "checked_on": "2026-10-08", "report": "docs/research/q1-owner-checklist-results.md" }
  ]
}
```

- Each entry carries the support key of its row. A key appears at most once in each list, and only an entry of the exact key counts: a Docker check says nothing about a VM, and a checklist of one OS, placement or engine version says nothing about another.
- `placements`: a placement other than local, `result` `passed` or `failed`, and `checked_on`.
- `owner_checklists`: `checklist` `desktop` for `claude_desktop` and `codex_desktop` or `tui` for `claude_cli`, `result` `passed` or `failed`, `checked_on`, and `report`, the path of the owner's report.

```sh
node tools/support/dist/main.js placement import <report.json>... [--support <directory>]
```

`placement import` records placement checks from the reports of `tools/surface-check` (format `aang-surface-check/1`; fields the tool does not read are allowed), which the `Surface matrix` workflow uploads as CI artifacts. Every result whose placement is not local and which is not emulated becomes an entry:

- `passed` only when the result and the report's access check (`access.result`) both passed, otherwise `failed`;
- `checked_on` is the UTC date of the report's `finished_at`;
- an entry of the same key is replaced, and reports apply in the order given.

Local and emulated results are skipped, and so are results that did not run (`not_run`: a surface whose engine is not available and which the check did not require) and results without a key: such a surface has no engine version to record. The command prints one line with the counts, writes `verification.json` sorted by key, and leaves `matrix.json` alone: the next `pnpm support:update` turns the entries into rows and gaps.

The owner's checklists are entered by hand from the owner's report: one entry per key the owner checked, `desktop` for each OS where Desktop is checked, `tui` for the interactive Claude CLI on macOS and Windows. Then `pnpm support:update` regenerates the matrix.

## Observer isolation (F.10)

```sh
pnpm support:isolation codex [--cli <codex>] [--support <directory>] [--hook <aang-hook>]
pnpm support:isolation import <matrix.json>... [--support <directory>]
```

`isolation codex` runs the automatic admission of ADR-0007 from `@aang/observer` (F.6) on the installed Codex CLI, `codex` from `PATH` by default: the observer profile against the local Responses stub in a temporary `CODEX_HOME`, without authorization and without the user's Codex home. It writes the result into the `observer` column of the row `(codex, codex_exec, <this OS>, local, <CLI version>)`: the observer runs `codex exec`, so the column belongs to that surface.

- `admission` is `passed` when the admission passes and `failed` when the admission disables the backend for isolation: tools in the request, a tool call that is not rejected, a turn that does not complete, a control hook that runs with hooks disabled, a rollout or SQLite rows after `--ephemeral`. A failed admission is written and the command exits with 1.
- Any other admission failure (the CLI is missing or reports no version, a launch failure or timeout, output that is missing or invalid) is no verdict: nothing is written and the command exits with 1.
- `cross_session_inbound` stays `not_run` for Codex, which has no inbox for other sessions; `builtins` stays empty.
- A new row is a row without recordings, as `update` would generate it. `check` and `update` keep the column from the previous matrix.

CI installs `@openai/codex@$CODEX_VERSION` (`.github/workflows/ci.yml`) on all three runners and sets `AANG_ISOLATION_CODEX=codex`, which turns on the contract test in `tools/support/test/isolation.test.ts`. The test runs `isolation codex` into a temporary directory and requires `support/matrix.json` to hold the same `observer` column for the runner's OS and CLI version, so a profile change that breaks isolation, or a Codex version whose result is not recorded, fails CI. When the job fails, it runs `isolation codex` into a temporary directory of the runner and uploads that matrix as the `support-isolation-<os>` artifact.

`isolation import` copies the `observer` column of every row of the given matrices whose admission or cross-session check has run into `support/matrix.json`. A new Codex version is recorded by changing `CODEX_VERSION`, running `isolation codex` locally, and importing the `support-isolation-<os>` matrices of the other runners from the failed CI job.

Claude rows keep `not_run` in the `observer` column: the local Claude check, the admission on the authorized CLI with a peer session for `crossSessionInbound` (ADR-0010), is not part of the tool.

## Tests

`tools/support/test/run.test.ts` records sessions from the spike samples with the real recorder: `spike-runtime.ts` plays the testkit sample scenarios, fires hooks built from the spike hook samples, writes and removes a session registry entry from the spike sample, moves and deletes the transcript, writes a JSONL file under `tool-results`, pauses so that the recorder captures the transcript in parts, and sends the spike OTLP requests. The reconnect recording puts its `daemon-restart` checkpoint on the first part of the transcript, and its snapshot must equal the snapshot of the same recording replayed without the restart. The tests place copies under several OS directories and run the CLI. The OTel decisions of the spike samples belong to no recorded rollout and stay `unknown`, so the recording made from them breaks the run and checks the unparsed record invariant, together with transcript lines rewritten into a listed, an unlisted and an invalid record. `test/portable/` holds three such recordings made on macOS with their snapshots, so every CI runner checks that a recording of another OS replays to the same snapshot; OTLP steps replay on every runner with the reference sessions of `fixtures/sessions`.

`tools/support/test/isolation.test.ts` runs `isolation codex` with the fake `codex` of `@aang/testkit` in place of the CLI: a passed admission, a hook that runs with hooks disabled, and checks without a verdict; it imports matrices written for other OSes, and with `AANG_ISOLATION_CODEX` set it runs the contract test on the installed CLI.

`tools/support/test/verification.test.ts` runs the CLI on a matrix and `verification.json` without recordings: owner checklists of exact keys remove the Desktop and TUI gaps, Claude CLI on Linux needs no TUI checklist, `placement import` writes passed and failed entries from surface check reports, skips local, emulated, not run and keyless results and replaces an entry of the same key, and an invalid verification file or report is refused. The rules that need recordings (the status that follows from the gaps, a non-local row with a passed, a failed or no placement check, E2E columns taken from the local row, `verified_on`) are in the matrix tests of `run.test.ts`.
