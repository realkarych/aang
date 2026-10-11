# ADR-0007: LLM observer

Status: accepted by the owner 2026-10-01; admission of built-in Claude plugins (decision 9) accepted by the owner 2026-10-03; decisions on the F.3 report (decisions 10–13) accepted by the owner 2026-10-04; decisions on the Q.2 and Q.3 report (decisions 14–16) and on the Q.2 re-measurement (decisions 17 and 18) approved by the owner 2026-10-08.

## Context

RFC §4, §7 and §8 require:

- the observer's main path is an already authorized CLI;
- isolation from the solver's permissions;
- structured changes that the daemon verifies;
- event batches with a timer;
- a p95 freshness target of 30 s;
- explicit input requests without an LLM;
- continued operation when the LLM fails, and exclusion of its own sessions from observation.

ADR-0002: by default the observer uses the vendor of the observed solver, with an override in the config; the observer has no write tools. The spike (sections 3.4, 12, 5.4) provided isolation command lines and single measurements: Claude — 8.6–9.0 s, Codex without tools — 42 s.

## Decision

### Backend and launch

- Two backends:
  - `claude -p` with the isolation profile from the spike (section 12) plus `--settings '{"crossSessionInbound":"hold"}'`: while it runs, the observer is visible to other sessions as a peer and must not accept their messages;
  - `codex exec` with a profile without tools: a substituted model catalog and `tools.experimental_request_user_input` disabled. The shell snapshot is also disabled (`--disable shell_snapshot`, decision 10): otherwise Codex launches the account's login shell via `setsid()` outside the call's process group (ADR-0013).
- The observer and the chat are launched by the daemon, never by a hook. The chat uses the same launch, isolation and backend selection mechanism (ADR-0008).
- Launch via `spawn` without a shell; the absolute path to the CLI is resolved in advance. On Windows the daemon finds the real executable instead of the `.cmd` shim (ADR-0013).
- The environment is cleared. On macOS and Linux `HOME`, `USER`, `LOGNAME`, `PATH=/usr/bin:/bin`, `LANG` remain; the list for Windows is set by ADR-0013. Markers and the profile's isolating variables from the spike are added (section 12: `CLAUDE_CODE_DISABLE_CLAUDE_MDS`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY`, `ENABLE_CLAUDEAI_MCP_SERVERS=false`, `DISABLE_TELEMETRY` and others).
- The working directory is an empty `os.tmpdir()/aang-observer/empty`. At startup the daemon checks that the directory has no ancestors with `CLAUDE.md` or `AGENTS.md`.
- Hard timeout: Claude 90 s, Codex 150 s (configurable). On root exit, timeout or cancellation, the whole process tree of the call is terminated by one backend operation: a process group on macOS and Linux, a Job Object via the launcher on Windows (ADR-0013). The call slot is released only on a confirmed stop of the whole tree; closing the pipes does not count as confirmation. Without confirmation the backend gets `unavailable: process_stuck`.
- **Backend selection.** For a run — the vendor of its root session (ADR-0002); `observer.backend` in the config overrides it. There is no automatic switch to another vendor on failure.
  - A run may contain sessions of both vendors via explicit binding. Facts and records of sessions whose vendor differs from the vendor of the backend receiving the input are sent to the observer only with `observer.crossVendor: true` in the config. Otherwise they are not interpreted, and the gap is visible.
- **Authorization — a subscription through an already authorized CLI (OAuth), without `--bare` (approved by the owner).**
  - Before the first call and after authorization errors, `claude auth status` / `codex login status` is run.
  - If the subscription path breaks (for example, `--bare` becomes the default for `-p` and returns "Not logged in"), the backend goes to `unavailable: auth_path_broken`, and an alternative is brought to the owner for approval (approved by the owner).
- **The model** is pinned explicitly from the config (`--model`/`-m`). For Codex, `-m` must match the `slug` of the substituted catalog entry.
- **Effort** is set by the `observer.effort` config for each backend. By default Claude has `low` (decision 14); Codex has no effort set and the CLI default applies (decision 15). The `--effort`/`model_reasoning_effort` flag is passed only if effort is set; `null` in the config keeps the CLI default.
- **Undocumented levers are allowed with isolation contract tests on every supported version (approved by the owner, ADR-0010).** These are `CODEX_INTERNAL_ORIGINATOR_OVERRIDE`, `ENABLE_CLAUDEAI_MCP_SERVERS`, a custom value of `CLAUDE_CODE_ENTRYPOINT`, Codex feature flag names, model catalog fields, `tools.experimental_request_user_input` and `crossSessionInbound`.

### Runtime isolation check

- **Claude.** Every call runs in `stream-json` with `--include-hook-events`. The result is accepted only if:
  - `system/init` contains `tools == ["StructuredOutput"]`;
  - `init` has no MCP servers or skills other than the built-in ones from the support matrix;
  - `init` has no plugins other than built-in ones (`path: builtin`, source `<name>@builtin`) whose list was recorded at this version's admission (decision 9) or is given in the support matrix;
  - the stream has no hook events (`system/hook_*`).
- **Codex.**
  - The model catalog is regenerated from `codex debug models --bundled` when the CLI version changes.
  - A self-check against a local Responses API stub (temporary `CODEX_HOME`, about 80 ms) runs at daemon start and on version change. Conditions:
    - empty `body.tools`;
    - empty `input[additional_tools].tools`: for `gpt-6.1-sol` tools are passed exactly there;
    - probe calls `exec`, `spawn_agent` and `request_user_input*` from the stub get `unsupported`.

    If a condition is violated, the Codex backend is disabled with a visible reason.
  - The line `codex_core::tools::router: error=unsupported` in stderr means an attempt to call a tool. The result of such a call is rejected entirely and logged.
- **CLI version admission.** Before the first working call on a new CLI version or after a profile change, the daemon performs automatic admission on a synthetic input without user data. Until admission passes, the backend is disabled; the first working call does not count as admission.
  - Claude:
    - `init` — tools, MCP, plugins, skills;
    - a built-in plugin is admitted if in the observer profile it gives the model no tools, no MCP servers and no executable hooks (decision 9). A plugin with any tool, MCP server or hook means admission is refused. The list of admitted built-in plugins is recorded in the version admission result;
    - no transcript is written, the registry entry carries the marker;
    - a synthetic input instructing to call a tool does not lead to execution;
    - hooks are not executed — this is checked by an independent control hook, not by `aang-hook`, which disables itself by the marker.
      - Admission runs in a temporary directory with a project `.claude/settings.json` in which the control hook creates a marker file.
      - Both branches differ only by the switch: the positive one — with `--setting-sources project`, the marker must appear; the negative one — the observer profile with `--setting-sources ""`, no marker.
      - If the switch is removed from the negative branch, the marker appears and admission fails.
      - Claude admission costs 2–3 small model calls.
  - Codex:
    - the self-check against the stub (above);
    - after `--ephemeral` there is neither a rollout nor sqlite rows;
    - a control hook in a temporary isolated `CODEX_HOME`. Both branches run with the same test `--dangerously-bypass-hook-trust`, so that the lack of trust does not affect the result, and differ only by `--disable hooks`:
      - without `--disable hooks` the marker appears;
      - with it there is no marker;
      - if `--disable hooks` is removed from the negative branch, admission fails.

      The bypass is needed only by the test bench; the observer's working profile does not get it.
  - Both CLIs on macOS and Linux: no descendant of an admission call leaves the process group (ADR-0013; decision 10).
    - Every admission call is checked, including service commands. From launch until the confirmed stop of the group, and once more after it, the daemon takes the process table: `/proc` on Linux, `ps` on macOS.
    - A descendant is a process linked to the root by a `ppid` chain, or a process from the root's group; a noticed descendant is tracked even after its parent changes. A descendant with a different group is a violation: admission fails, the backend is `disabled: isolation` with the process names in the reason.
    - The exception is the group of the control hook of both CLIs. Both CLIs launch every command hook outside the call's group, so without the exception the positive branch never passes: Codex 0.160.0 — via `/bin/sh -lc` in a new session (`setsid`), Claude Code (checked on 2.1.289 and 2.1.292, macOS) — in its own process group. The hook process stays the leader of its group and writes its `pid` into the marker: in Codex the hook command starts with `exec`, in Claude the hook is defined without a shell (`command` and `args`), and the hook's Node process itself becomes the group leader. In both `claude -p` calls and both `codex exec` calls with the control hook, processes of the group with this `pid` are not considered a violation; any other process outside the call's group is a violation. In the negative branch the hook must not start, and its marker by itself rejects admission.
    - A snapshot error at any point of the call is also an admission failure, even if the last snapshot succeeded: absence of data does not count as absence of violations.
    - The check is an admission safety net, not process accounting (ADR-0013, decision 3 on technical questions). A process that left the group and exited or lost its link to the root between snapshots (for example, after a double `fork` with the intermediate parent exiting) may go unnoticed. So the check complements `--disable shell_snapshot` rather than replacing it.
    - On Windows the check is not needed: the launcher's job does not allow leaving it (ADR-0013).
  - The effect of `crossSessionInbound` is not checked automatically: that requires a peer session that sends messages. It is checked by the maintainer's local contract run (ADR-0010).
  - A version that passed automatic admission but has not yet passed the local contract run is enabled with the note "isolation from other sessions' messages is not verified on this version" (decision 7). The note is removed after the contract run.
  - The Codex profile and the spike measurements refer to 0.159.2. The currently installed 0.159.3 is used only after admission (ADR-0010).
  - The admission result is written to the local support status.
- **Success criterion.**
  - Claude: exit 0, `is_error == false` and a non-empty `structured_output`; `subtype: "success"` by itself does not count as success.
  - Codex: exit 0, `turn.completed` is present, `turn.failed` is absent, `last.json` passes the schema.

### Self-exclusion

- The observer writes no transcript and no rollout: `--no-session-persistence` for Claude, `--ephemeral` for Codex. For Claude, the registry entry `sessions/<pid>.json` and a UDS socket remain for the duration of the call. The registry entry is filtered out by `entrypoint`, incoming messages from other sessions by the `crossSessionInbound: "hold"` setting.
- Hooks are disabled in it: `--setting-sources ""` for Claude, `--disable hooks` for Codex.
- Markers: `CLAUDE_CODE_ENTRYPOINT=aang-observer`, `--thread-source aang-observer`, `CODEX_INTERNAL_ORIGINATOR_OVERRIDE=aang_observer`, `AANG_OBSERVER=1`.
- The hook handler and the adapters discard marked events and sessions (ADR-0004). Claude registry entries with `entrypoint: aang-observer` are ignored.

### Input

The input is a single JSON document. Event contents are passed as data; the system prompt forbids executing instructions from them.

- **Run context** — only from the list of allowed sources:
  - the task text (the first prompt);
  - project instruction files from `InstructionsLoaded` or `CLAUDE.md`/`AGENTS.md` along the `cwd` hierarchy, truncated;
  - definitions of the encountered subagents;
  - skills — only invoked ones (by the fact of a skill tool call), with a description; the presence of a skill in the catalog is not used;
  - names of MCP servers and hooks from the session's facts;
  - branch, commit and git snapshots (ADR-0006).

  The collected context is stored as a raw record of the `context` channel with a hash. It is written again only on change; it can be cited and reproduced.
- **Model snapshot** of version `model_version`: stages (`id`, title, state, summary, provenance), open questions, criteria.
- **Batch of new facts:** `id`, kind, `speaker`, time, agent, compressed payload, truncated outputs with their length. Model thinking is not passed (ADR-0006).
- **Materials requested in the previous reply** (`needs`).

The input size is limited by the config, by default about 24k tokens. Each line of the batch and the context is truncated to 4000 characters, a `needs` material line to 16 000 characters (decision 18).

### Structured change protocol

- Reply: `{base_version, ops[], needs[]}`.
- `ops` operations:
  - stages: `stage.create` (temporary id), `stage.update` (title, expected result, summary), `stage.state`, `stage.replace`, `stage.merge`, `stage.split`, `stage.nest`, `stage.depends`;
  - bindings: `actions.assign`, `agents.participate`, `artifact.link` (input or output);
  - criteria: `criterion.add`, `criterion.assess`;
  - results: `card.add`, `brief.update`;
  - attention:
    - `question.add` — an implicit question from text;
    - `attention.add` — `review_request` or `blocker`;
    - `attention.resolve` — only for items created by the observer, with evidence;
    - `attention.likely_resolved` — for rule items: a recommendation "likely answered" with evidence (`interpreted`). Does not close the item;
    - `attention.priority` — a recommendation.
- Every operation has evidence — fact ids — and a brief justification.
- `needs` requests raw records, actions with their input and output (including edit diffs from the payload), stored artifact versions (ADR-0006) and context records. A reply with a non-empty `needs` is not applied to the model: the call gets status `needs_requested`, the daemon resolves the request and immediately makes one follow-up request with the same batch, the same snapshot and the materials. The follow-up does not spend a batch attempt and does not wait for the interval between the run's calls, and `needs` in its reply is ignored. This way the observer gets access to sources without having tools.
- **Input scope.** The same filter applies to the whole input of the observer and the chat: the batch, the snapshot, the context and the replies to `needs`.
  - Only objects and records of this run get into the input.
  - Facts of sessions of a vendor other than the backend's get in only with `observer.crossVendor`.
  - Thinking blocks (`thinking`, `reasoning`) are cut from raw records.
  - A request for an object outside the scope is not fulfilled, and the reply states that the object is unavailable.
- The schema is generated from the `contract` package and is compatible with the strict subsets of both CLIs:
  - an object at the root;
  - every object has `additionalProperties: false`, all fields in `required`, `null` instead of optionality;
  - no free-form dictionaries, `oneOf`, `allOf`, `not`, `if`;
  - heterogeneous operations — `anyOf` of closed variants.

  Compatibility is checked by a contract test on both CLIs.

### Daemon verification

Verification runs in a single transaction:

1. **Schema.**
2. **Version.** `base_version` must match the version recorded in `observer_calls` when the call was sent; otherwise the reply is rejected. The reply is reconciled with the current state rather than requiring that the model has not changed. A conflict arises only if, after the base version:
   - the operation's target entity was replaced, merged, split or moved;
   - or the user changed the same field.

   Daemon rule changes in other fields are not considered a conflict.
3. **References and scope.**
   - Ids of stages, actions, artifact versions and attention items exist and belong to this run.
   - Evidence is only facts passed to the observer for this run.
   - Temporary ids are resolved within the reply, including references of new stages to each other.
   - Stage nesting and successor history stay acyclic: `stage.nest`, `stage.replace`, `stage.merge`, `stage.split` that create a cycle are rejected.
4. **The basis** is computed by the daemon (ADR-0006): LLM operations yield `interpreted` or `claimed`, never `observed`. `origin=plan` is accepted only with a plan fact in the evidence.
5. **Invariants.**
   - There is no deletion: replacement, merge and split preserve history.
   - The LLM does not close or hide attention items from daemon rules.
   - `criterion.assess` does not turn into a confirmation by contract.
   - An LLM claim does not replace the execution state observed by a rule (ADR-0006).
   - Limits on the number of operations and text length apply.
6. **Application.** The reply is applied entirely or rejected entirely.
   - Success: a new model version, log entries with `observer_call_id`, all facts of the batch become `interpreted` in the same transaction.
   - Any rejected operation (conflict, reference, invariant, limit) rejects the whole reply. All facts of the batch return to `pending`; the reasons are stored in `observer_calls` and visible in the inspector.
   - There is no partial acceptance: one fact may have several operations, and partial application would require rules for the remaining work and an idempotent retry. Conflicts are rare — only the observer changes the stage structure, one call per run at a time — so retrying the whole reply is cheaper.

### Batches and timer

- The run's queue is facts with status `pending` (ADR-0005). On sending they move to `in_call`.
- A call is started on any of the conditions:
  - 30 facts or the size limit have accumulated;
  - 5 s have passed since the oldest unprocessed fact;
  - a fact with `urgent` has arrived (ADR-0006).
- Concurrency:
  - one observer call runs per run at a time;
  - the overall observer concurrency is 2;
  - the chat has a separate slot; the chat does not wait for the observer.

  While a call is running, new facts accumulate into the next batch.
- Homogeneous low-value facts (series of reads and searches) are collapsed by rules into counters with id references before sending.
- **Catch-up mode** after idleness: batches go by time. If the lag exceeds a threshold, early facts are sent as a compressed summary (counters by agent and tool), and the model is marked as recovered with reduced detail.
- **Queue limit.** The run's active queue is limited: by default 2000 facts or 24 hours.
  - Facts over the limit, starting from the oldest, get status `deferred`. They are not lost, but reach the observer only as the compressed catch-up summary; the gap "meaning recovered from a summary" is visible in the UI.
  - The fact archive remains indefinite (ADR-0002); only the work queue is limited.
- **Spending.** At least 10 s pass between calls of one run. The observer's token budget per hour is set by the `budgetTokensPerHour` config, unlimited by default (`null`, decision 16). When the budget is exceeded, observation does not stop: the batch timer grows to 60 s, and the state becomes `lagging` with a reason.

### Freshness budget

- **Facts and observation objects** are visible immediately after the intake commit: SSE, milliseconds.
- **An explicit input request** (questions and approvals, ADR-0006) is created by daemon rules at intake, without the LLM.
- **Semantic changes:** the p95 target on the chosen load profile is about 35 s for Claude runs (decision 17) and about 40 s for Codex runs with a Codex observer (decisions 11 and 15). The RFC §8 candidate is 30 s; both targets are approved by the owner based on the Q.2 measurements.
  - A control event is annotated in the reference session manifest with the expected map change (ADR-0010). This is a predicate over the model, for example "there is a stage with output X", "criterion Y is `failed`", "an item of kind Z with evidence F is open". If a change cannot be expressed as a predicate, the annotator describes it in advance and then assesses the result.
  - The latency is from the control event's `observed_at` to the first model version in which the expectation is met. A reference to the fact in the evidence without the expected change does not count.
  - An expectation not met within the measurement window is a violation.
  - The time of `needs` follow-ups is included in the latency and shown separately.
  - The load profile is fixed before the acceptance measurement.
  - The full latency from `source_ts` is measured separately.
  - The daemon records the latency of each batch. The acceptance measurement with the real observer is performed by the local tool `tools/freshness`.
- The UI shows the model's age: the time of the oldest unprocessed fact, the time of the last successful call and the number of unprocessed facts.

### LLM failure

- Error classes:
  - authorization;
  - subscription limit;
  - timeout;
  - invalid output;
  - isolation violation;
  - missing CLI or unsupported version.
- Retries are limited by separate counters per error class. Backend errors do not spend the batch budget.

| Class | Action | Counter | Resumption |
| --- | --- | --- | --- |
| invalid output, reply verification failure, conflict | reply rejected entirely, batch facts → `pending` | batch attempts, at most 3; then `not_interpreted` | the next attempt — with a fresh snapshot and an error description |
| isolation violation (`init`, `unsupported`) | reply rejected, backend `disabled: isolation`, facts stay `pending` | — | only a new version admission: via `aang doctor --admit` or on a CLI version change |
| authorization | backend `unavailable: auth`, facts in the queue | batch budget not spent | `auth status` every 10 min without a model call |
| subscription limit | backend `unavailable: limit`, facts in the queue | batch budget not spent | after the reset time if the CLI reports it, otherwise after 30 min; one probe on a synthetic input, then the interval doubles up to 4 h |
| timeout, network | pause from 10 s to 5 min, at most 6 times in a row; then `unavailable: transient` | batch budget not spent | probes on a synthetic input, as for the limit |
| CLI missing, version not admitted | backend `disabled` | — | CLI version change and admission |

- Probes are visible in the UI and counted in the observer's spending. A successful `auth status` resumes only after an authorization error.
- The run's observer state is `ok`, `lagging`, `backoff`, `unavailable(reason)` or `disabled`; it is visible in the UI. Fact collection and display continue.

## Consequences

- The semantic model lags behind the facts by tens of seconds; urgent things reach the UI through rules.
- The observer spends the user's subscription limits; the spending is accounted separately (ADR-0009).
- The Codex observer is slower than Claude. Per the F.3 measurement on a small batch, a Codex call takes p50 about 15 s and p95 about 19 s, and under continuous activity the p95 of a semantic update is about 33 s, the worst case about 38 s. So the freshness target for Codex runs is softer: about 40 s instead of 30 s (decision 11).
- Codex in the observer profile does not launch the account's login shell with its startup files. A new CLI version whose descendant leaves the process group again will fail admission if the check notices that process.
- Every new CLI version requires a run of the isolation contract tests.
- The Claude observer with effort `low`, per the Q.2 measurement, replies twice as fast as with the CLI default, but makes more mistakes in the card citation. The daemon rejects such a reply entirely, and the batch is retried with the next attempt (decision 14).
- On two parallel Claude runs, the tail above 30 s comes from the queue after bursts and from large replies laying out the whole plan, and effort does not reduce them. So the target for Claude runs is about 35 s (decision 17).

## Owner decisions

Accepted by the owner 2026-10-01:

1. The backend for Codex runs is Codex (ADR-0002). Latency is measured in F.3; if p95 is not met, the owner decides whether to move Codex runs to the Claude observer. Following F.3, Codex remains the backend for Codex runs (decision 11).
2. Observer models are `claude-opus-5-5` and `gpt-6.1-sol` with the CLI default effort; revisited based on freshness and spending measurements. Following F.3, effort is not pinned until Q.2 (decision 12). Following Q.2, the Claude observer's default effort is `low` (decision 14), Codex's is the CLI default (decision 15).
3. The p95 ≤ 30 s target remains a candidate until measured on the load profile, then it is confirmed or revised. For Codex runs with a Codex observer — about 40 s (decision 11). Following Q.2, the Codex target is confirmed (decision 15), and for Claude runs it is about 35 s (decisions 14 and 17).
4. A minimum interval of 10 s per run; the token budget unlimited until measurements (plan, F.3). Following F.3 — unlimited until Q.3 (decision 13). Following Q.3, the budget is unlimited by default (decision 16).
5. `crossSessionInbound: "hold"` is enabled for the Claude observer and checked by an isolation contract test.
6. Cross-vendor fact transfer is forbidden by default and enabled by `observer.crossVendor`.
7. The observer on a Claude version after automatic admission is enabled with the note "isolation from other sessions' messages is not verified on this version" until the local contract run.
8. The observer's work queue is 2000 facts or 24 hours per run; beyond that — `deferred` with a compressed summary.

Accepted by the owner 2026-10-03:

9. A built-in Claude plugin (`cc-plugin-*` and similar) is admitted if, in the isolation check, it gives the model no tools, no MCP servers and no executable hooks. The list of such plugins is recorded in the version admission profile. A plugin with any tool, MCP server or hook means admission is refused.

Accepted by the owner 2026-10-04 based on the F.3 report ([`docs/research/f3-observer-measurement.md`](../research/f3-observer-measurement.md), section 2; PR #96):

10. Codex 0.160.0 leaves the process group on every call: the `shell_snapshot` feature is enabled by default and launches the account's login shell via `setsid()` (ADR-0013). `--disable shell_snapshot` is added to the Codex observer profile. Version admission on macOS and Linux checks that no descendant left the process group during the call; otherwise admission fails. This way a new CLI version with a different source of `setsid` will not go unnoticed.
11. Codex remains the backend for Codex runs (decision 1). For them the p95 freshness target is about 40 s; for Claude runs it remains 30 s (decision 3). Per F.3, under continuous activity Codex's p95 is about 33 s, the worst case about 38 s. The final check is Q.2 on the load profile.
12. The observer's effort is not pinned: until Q.2 the CLI default applies (decision 2). For `gpt-6.1-sol` the default is already the lowest level `low`; for Claude the default fits the 30 s target with a margin of about 10 s.
13. The observer's token budget stays unlimited until Q.3 (decision 4): there the spending is measured per active hour with working batches.

Approved by the owner 2026-10-08 based on the Q.2 and Q.3 report ([`docs/research/q2-q3-live-measurement.md`](../research/q2-q3-live-measurement.md), section 2; PR #163):

14. The Claude observer's default effort is `low` (`observer.effort.claude: "low"`), the p95 freshness target for Claude runs is 30 s (decisions 3 and 12). On two recordings, `logstats` and `mdlinks`, the p95 over 30 expectations met in both measurements is 29.7 s with `low` and 92.3 s with the CLI default; with the default these recordings ran in parallel with two others, with `low` one at a time. Over the whole Claude sample with the CLI default, the p95 of met expectations is 51 s, without plan expectations 57 s. A call with `low` is p50 8.0 s and p95 15.2 s; spending per run is 6 % lower. There are more rejected replies: 5 of 175 versus 3 of 316, mostly an inaccurate card citation. Effort `low` is checked by a re-measurement with two parallel runs; its result is in the same report. Following the re-measurement, effort `low` stays, and the target for Claude runs is about 35 s (decision 17).
15. The target of about 40 s for Codex runs with a Codex observer is confirmed (decision 11): the p95 of met expectations is 26.4 s, none exceeded 31.5 s. Narrowing the target to 30 s based on a measurement on three recordings was not done. The Codex observer's effort is not set; the CLI default applies; for `gpt-6.1-sol` it is `low`.
16. The observer's token budget is unlimited by default (`budgetTokensPerHour: null`, decision 13). The budget counts all tokens of calls and probes over a sliding hour across all backends together. The measurement peak is 7.9 million tokens per hour on two parallel Claude runs, and any budget below the peak breaks freshness: batches go once every 60 s, the state is `lagging`. From above, spending is already bounded by two concurrent observer calls per daemon.

Approved by the owner 2026-10-08 based on the Q.2 re-measurement ([`docs/research/q2-q3-live-measurement.md`](../research/q2-q3-live-measurement.md), section 9; PR #174):

17. The p95 freshness target for Claude runs is about 35 s instead of 30 s (decision 14); the Claude observer's effort stays `low`. On two parallel runs with `low`, all 67 assessed expectations were met, no violations, p95 is 34.9 s, without plan expectations 32.1 s. With the CLI default on the same profile, the p95 of met expectations was 51.0 s with five violations. A call under parallel load did not slow down: p50 8.0 s, p95 15.7 s.
18. A `needs` material line is truncated to 16 000 characters; batch and context lines are still truncated to 4000. All PLAN.md files of the measurement are longer than 4000 characters (4283–9411): the Codex observer in two recordings requested the plan record via `needs`, got the same truncated text and created no plan stages. A raw record with a plan is longer than the plan itself by the JSON escaping and the record envelope, and 16 000 characters leave more than 6500 characters for them beyond the longest plan of the measurement. The follow-up input limit is unchanged: material that does not fit, the daemon shortens as before, and batch lines in a follow-up are no longer than in the first call. Spending grows only for follow-ups, and in the measurement with two parallel Claude runs there were 4 of them per 369 calls. Each material grows by at most 12 000 characters — about 3000 tokens by the daemon's estimate; for Claude that is about $0.02 of cache write per material. With one such material per follow-up this is less than 12 thousand tokens and $0.1 per active hour, about 0.2 % of the observer's spending (8.07 million tokens, $40.83). The adapter does not parse a Codex plan from an `update_plan` call in the code of an `exec` cell: the observer gets the full PLAN.md via `needs`.
