# Contract run and support matrix (R.5a, R.5b)

`tools/support` replays the reference sessions of `fixtures/sessions` through the real collector, adapters and `engine`, compares the result with stored snapshots, checks the invariants of ADR-0010 and generates `support/matrix.json`.

```sh
pnpm build
pnpm support:check
pnpm support:update
```

Both commands accept `--fixtures <directory>` (default `fixtures/sessions`), `--support <directory>` (default `support`) and `--hook <aang-hook>` (default the built binary). `check` exits with 1 and lists the problems; `update` writes the snapshots and the matrix, and refuses to write anything when an invariant is violated.

CI runs the same check as contract tests: `tools/support/test/contract.test.ts` has one test per recording and fails when a snapshot differs, a snapshot is missing or stale, an invariant is violated (an unparsed record among them), or `support/matrix.json` is not the matrix of the run. A pull request that adds or re-records reference sessions (R.4) or changes the normalized output runs `pnpm support:update` and commits the regenerated files.

## Which recordings run

Every recording under `fixtures/sessions/<runtime>/<engine-version>/<surface>/<os>/<scenario>/` is verified with the recorder's `verifyRecording` and replayed on every OS, whatever OS recorded it. Every scenario of ADR-0010 is in the run and mandatory (R.5b): the R.5a subset left out `plan` and `question` (plans and answers to questions), C.6 added them for Codex and B.7 for Claude, so `pendingScenarios` in `src/run.ts` is empty. Teammates, workflows and MCP elicitation have no recorded scenarios yet: R.2b adds the scenarios, R.4b records them, and B.8 adds them to the run as mandatory.

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
- Every raw record is parsed (R.5b, ADR-0010: no `unknown` among the covered types). An `invalid` record always breaks the run. An `unknown` record breaks it unless its runtime, channel and record type are listed in `uncoveredTypes` (`src/record-types.ts`) with the plan item that parses them: today only the Claude transcript record `system:stop_hook_summary`, which F.7d parses. The record type is the one of the snapshot's record counts: the hook event name or the record `type`, followed by its `subtype` or `payload.type`. The covered types are therefore all types of the reference sessions except the listed ones, and a new type in a new recording breaks the run until the adapter parses it or the type is listed with the item that will.

## Matrix

`support/matrix.json` follows `SupportMatrix` from `@aang/contract`. Rows come from the recordings (local placement), from the previous matrix, and, for every Desktop engine version, an explicit Windows row. For each row:

- `resume`, `compaction`, `child_sessions` (`subagents`, `fork`) and `reconnect` are `passed`, `failed` or `not_run` from the recordings of the row's own OS; recordings of another OS never count;
- `during_work`, `after_iteration` (E2E 1 and 4), `observer`, `verified_on` and a claimed `full` or `limited` status are kept from the previous matrix;
- the row is `unverified`, with the reasons as gaps, when Desktop runs on Windows (ADR-0013, decision 3), the placement is not local (until Q.1), the OS has no recordings, a recording fails, a scenario that the recorder's catalog has for the surface and OS and that the run includes is not recorded, or E2E 1 or 4 has failed or not run: a claimed status needs both to have passed.

A key outside the matrix reads as `unverified` through `supportStatusOf` from `@aang/contract`.

## Tests

`tools/support/test/run.test.ts` records sessions from the spike samples with the real recorder: `spike-runtime.ts` plays the testkit sample scenarios, fires hooks built from the spike hook samples, writes and removes a session registry entry from the spike sample, moves and deletes the transcript, writes a JSONL file under `tool-results`, pauses so that the recorder captures the transcript in parts, and sends the spike OTLP requests. The reconnect recording puts its `daemon-restart` checkpoint on the first part of the transcript, and its snapshot must equal the snapshot of the same recording replayed without the restart. The tests place copies under several OS directories and run the CLI. The OTel decisions of the spike samples belong to no recorded rollout and stay `unknown`, so the recording made from them breaks the run and checks the unparsed record invariant, together with transcript lines rewritten into a listed, an unlisted and an invalid record. `test/portable/` holds three such recordings made on macOS with their snapshots, so every CI runner checks that a recording of another OS replays to the same snapshot; OTLP steps replay on every runner with the reference sessions of `fixtures/sessions`.
