# Live measurement of observer freshness and economics (Q.2, Q.3)

Status: report on plan items Q.2 and Q.3 (`docs/plan/mvp.md`). This is not an ADR; decisions are made by the owner. The owner resolved the questions of section 2 on 2026-10-08: all recommendations accepted (ADR-0007, decisions 14–16; plan, decisions 18–22), implementation — PR #172. The re-measurement after them and new questions are in section 9.

Dates: recordings and measurements — 2026-10-07, annotation and report — 2026-10-08, re-measurement — 2026-10-08. Branch — `feat/q2q3-live` (PR #163), re-measurement — `feat/q2-remeasure`. The measured builds are described in sections 8 and 9.1.

## 0. Scope, versions, method

Owner decision of 2026-10-07: live measurements are moderate.

- A fixed load profile, on the order of a couple of hours of active work per runtime: Claude with a Claude observer and Codex with a Codex observer.
- Subscription limit exhaustion and degradation on failure are checked only on a fake CLI.
- Live sessions run in a temporary test project, user configs are not changed, no more than one live solver runs at a time, everything is anonymized.

**Versions and environment:**

- macOS 27.0.1 (Darwin 27.0.0), Apple M4 Pro, 12 cores, arm64; Node 26.10.0. The machine is not dedicated: other development sessions were running in parallel.
- Claude Code from the native installer, subscription. Solver — 2.1.292 (the `mdlinks` recording — 2.1.293), observer — the pinned binary 2.1.293. Solver and observer model — `claude-opus-5-5`.
- `codex-cli 0.160.0` from Homebrew, sign-in via ChatGPT. Solver and observer model — `gpt-6.1-sol`. Observer effort — the CLI default, which for this model is `low`.

**Load.** Four tasks of 12 turns each in a single solver session (`docs/research/samples/q2-live/tasks.mjs`):

| Task | What the solver does |
| --- | --- |
| `ledger` | an accounting library and CLI per SPEC.md: plan, CSV parsing, balances, a question to the user about the rounding method, conversion, review by a subagent, CLI, context compaction, export, a requirements change (integer cents), two subagents in parallel, README and commit, final check |
| `logstats` | log analysis: fixing failing tests, plan, aggregates with percentiles, a large-log generator and a benchmark, CLI, a question about the report format, HTML report, review, compaction, streaming reading, documentation by two subagents, commit |
| `kvstore` | a key-value store with a journal: plan, journal and recovery, a torn line, a question about `fsync`, compaction with a snapshot, batches, review, CLI, context compaction, a requirements change (TTL), a benchmark and randomized tests by two subagents, commit |
| `mdlinks` | Markdown link checking: analysis of existing documents, plan, link extraction, checking files and anchors, a question about anchor case, report, review, compaction, `--fix`, a requirements change (JSON), documentation by two subagents, commit |

Each session was recorded by the `tools/record` recorder from the `claude-workload.mjs` or `codex-workload.mjs` module:

- **Claude** — `claude -p` in stream-json mode through the recorder host; each turn is a separate launch with `--resume` of the same session.
  - The host approves commands outside the allowlist after 2.5 s and answers `AskUserQuestion` with the first option after 15 s.
  - The owner's settings, hooks, plugins and MCP are not loaded (`--setting-sources project,local`, `--strict-mcp-config`); the solver's network access (WebFetch, WebSearch) is denied.
- **Codex** — `codex exec` in the standard `CODEX_HOME` with `--ignore-user-config`, without the owner's hooks and plugins, in the `workspace-write` sandbox; each turn is `codex exec resume` of the same thread.
  - `codex exec` cannot ask the user, so the answer to the turn's question is given in the turn's text.
  - Compaction is triggered by a low `model_auto_compact_token_limit` threshold on one turn.
- Between turns there are pauses of 20–60 s, like a reading user.

The recordings were anonymized by the recorder and checked by its verifier. The verifier rejected the Codex `mdlinks` recording ("JSON with duplicate keys, which can hide private data"), so the Codex measurement has three recordings. The recordings are not part of the repository (about 40 MB); they are identified by SHA-256 digests in the fixed profiles (section 8).

**Load profiles** were fixed before the measurements (`tools/freshness fix`), measurement window — 120 s, time scale — 1. Each recording has three chat questions at 30, 60 and 95 % of its duration:

1. "What is the run doing now and what remains to be done per the plan?"
2. "Which tests failed during the run and how did it end?"
3. "Is my intervention needed now? If so, where."

| Measurement | Observer | Recordings and start | Concurrency |
| --- | --- | --- | --- |
| `claude` | default effort | lane 1: `ledger` (0 s), `kvstore` (1408 s); lane 2: `logstats` (300 s), `mdlinks` (1618 s) | up to two runs at once |
| `claude-low` | effort `low` | `logstats` (0 s), `mdlinks` (1318 s) | no concurrency |
| `codex` | default effort (`low`) | lane 1: `ledger` (0 s), `kvstore` (1531 s); lane 2: `logstats` (300 s) | up to two runs at once |

The `claude-low` measurement was added after the main one to compare effort on the same `logstats` and `mdlinks` recordings.

**Checkpoint events.** The recorder places a checkpoint event on each significant step of a turn:

- writing PLAN.md;
- the last test run;
- answering a question;
- subagent completion;
- commit;
- end of turn.

Predicates were added to the manifests before the profile was fixed (`markup.mjs`):

- after writing PLAN.md — the map has stages for all main sections of the plan;
- after a stage's test run — the stage is done or its criterion is confirmed;
- after the end of a turn — the turn's stage is done;
- after a requirements change — a stage for the new requirement has appeared.

The remaining events are assessed by the annotator against the expectation description (section 4.1).

**Notation:** **Obs** — observed in the measurement; **Est** — estimate from the measurement and the ADR-0007 rules.

## 1. Summary

| Measurement | Assessed | Met | Violations | Annotation defects: before event / not per recording | Profile p95 | Met: p50 / p95 / max | Within target | p95 without plan expectations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `claude`, target 30 s | 65 | 60 | 5 | 13 / 11 | 730.5 s | 23.3 / 51.0 / 96.1 s | 66 % | 57.4 s (57 events) |
| `claude-low`, target 30 s | 34 | 32 | 2 | 3 / 7 | beyond the window | 12.1 / 29.7 / 32.8 s | 91 % | 22.8 s (30 events) |
| `codex`, target 40 s | 48 | 42 | 6 | 6 / 4 | beyond the window | 19.2 / 26.4 / 31.5 s | 88 % | 26.4 s (42 events) |

Obs. The profile p95 is computed per ADR-0007: an unmet expectation counts as beyond the window. "Beyond the window" means that violations exceed 5 % of assessed events. "Without plan expectations" is the same computation without the `plan-written` and `plan-ready` events (section 4.5); it is an explanation for the conclusions, not a replacement of the criterion.

**Conclusions:**

1. **No backend met the target, and all violations are about reflecting the plan, not about latency.** There are 5 such violations for Claude, 2 for `claude-low` and 6 for Codex. Two kinds of misses (section 4.5):
   - stages from PLAN.md do not appear on the map as planned: for Claude in 2 of 4 recordings, for Codex in 3 of 3, 9–17 minutes late;
   - the brief after the planning turn does not name the run goal: for Claude in 3 of 4 recordings, for `claude-low` in 2 of 2, for Codex in 3 of 3.
2. **Codex fits within 40 s with margin.** All 42 met expectations arrived within 31.5 s, p95 — 26.4 s (Obs). The target of about 40 s from ADR-0007 decision 11 is confirmed in terms of latency.
3. **Claude with default effort does not fit within 30 s.** p95 of met expectations is 51 s, without plan expectations 57 s (Obs). The tail has two causes (section 4.6):
   - the observer call: p50 13.2 s, p95 24.8 s;
   - the fact queue during activity bursts: up to 176 facts with a limit of 30 facts per call.
4. **Effort `low` on the Claude observer is twice as fast on the same recordings:**
   - p95 29.7 s versus 92.3 s on the 30 events met in both measurements; faster in 27 of 30 (Obs);
   - call: p50 8.0 s, p95 15.2 s;
   - cost per run 6 % lower;
   - more rejected responses: 5 of 175 versus 3 of 316, of which 4 are an inaccurate card quote;
   - caveat: the `low` measurement ran without concurrent load (section 4.3).
5. **There were no `needs` follow-up requests in batch calls at all:** share 0 % in all measurements. The full latency from the event's own time for Codex matches the semantic latency within 50 ms. For Claude, checkpoint events sit on hook deliveries without their own event time, so there is no full latency (section 4.7).
6. **Cost (section 6).**
   - Claude observer (Obs):
     - per run hour — 4.5 M tokens and $26 per CLI data;
     - per active hour with two concurrent runs — 7.8 M tokens and $46;
     - 59 % of tokens are cache writes of context that the next call does not read.
   - Codex observer (Obs): 1.4 M tokens per run hour and 2.0 M per active hour; 81 % is uncached input.
   - Chat (Obs): 0.25–0.36 M tokens per active hour.
   - One-time cost — Claude admission per CLI version (Obs): 2 calls, about 20k tokens, $0.02.
7. **Collection does not stop on limit exhaustion and network failures.** The observer state is visible immediately, after a limit reset there is one probe, and a long lag switches to catch-up mode (section 5, Obs, fake CLI).
8. **The annotation did not anticipate some sessions.** The descriptions of 11 Claude events and 4 Codex events contradict what the session did. Another 13 and 6 expectations were met before their event. All of them are excluded from the statistics; their list with grounds is in section 4.8.

## 2. Questions for the owner

Owner decision of 2026-10-08: recommendations 1a, 2, 3a, 4a and 4b, 5 and 6 accepted. The questions are kept below in the form in which the owner considered them; results after the decisions are in section 9.

1. **Target and effort of the Claude observer** (ADR-0007 decisions 3, 11 and 12). Options:
   - a) effort `low` by default (`observer.effort.claude: "low"`) and a 30 s target;
   - b) the CLI default effort and a target of about 60 s.

   Recommendation — a):
   - on the same recordings, p95 of met expectations is 29.7 s, without plan expectations 22.8 s;
   - cost per run is 6 % lower;
   - with default effort p95 is 51–57 s.

   Before finally pinning it, `low` should be repeated with two concurrent runs: that is about an hour of subscription.
2. **Codex target.** Confirm about 40 s (decision 11): p95 26.4 s, all met expectations within 40 s. I do not recommend narrowing to 30 s based on a single measurement on three recordings: the maximum is 31.5 s. Keep the Codex effort at the CLI default (`low`).
3. **Default token budget** (decision 13). Options:
   - a) keep `budgetTokensPerHour: null`;
   - b) set a safeguard of about 12 M tokens per hour per daemon.

   Recommendation — a):
   - the budget counts all tokens of observer calls and probes over a sliding hour, for all backends together;
   - the Claude measurement peak is 7.9 M tokens per hour on two concurrent runs. Any budget below that breaks freshness: batches go once per 60 s, the state becomes `lagging`;
   - from above, cost is already bounded by two simultaneous observer calls per daemon. That is about 14 M tokens per hour for Claude at default effort (Est: 2 × 3600 s / 13 s × 25k tokens);
   - what should be reduced is the cost of a call, not the frequency. Question 5 is about money: it does not change the number of tokens the budget counts.
4. **Reflecting the plan** (violations of section 4.5).
   - a) Observer prompt: an explicit plan (PLAN.md, a task list) is immediately laid out into planned stages. This is a separate PR in `observer`, followed by a re-measurement. I recommend it: without it the map does not show the plan for 9–17 minutes, and that is one of its main functions.
   - b) Remove the requirement "the brief names the run goal" from future annotation. The goal is already in the model by a rule: `run.goal` from the first message, ADR-0006. The brief of both observers describes the current state. I recommend b) if the UI shows `run.goal` next to the brief; otherwise, extend the prompt.
5. **Claude observer cache** (Est, section 6).
   - Each call reads from the cache only the unchanging part, exactly 9,029 tokens.
   - The rest of the input (p50 13.8k tokens) it writes to a cache that the next call does not read.
   - I propose to separately investigate a call that does not write the changing part to the cache.
     - The number of tokens will not decrease: with the same input this part moves from cache writes to uncached input, and catacomb's cost accounting and budget count all kinds of input together.
     - The hypothesis is a lower call cost: cache writes are billed higher than regular input. It needs to be measured with the same input using the cost from the CLI, separately cross-checking the total number of tokens. The amount cannot be estimated in advance without our own price table (ADR-0009).
6. **Load recordings** (about 40 MB, 7 recordings): keep them outside the repository with the owner (as now) or add them in a separate code-free PR, like the reference sessions (ADR-0010). I recommend outside the repository: the report identifies them by digests.

## 3. Defects found by the measurement

The live measurement ran into four defects without fixing which Q.2 and Q.3 could not be measured. All are fixed.

1. **Claude observer admission did not pass on the real CLI** — PR #158, merged 2026-10-08 together with the new wording of ADR-0007.
   - Claude Code 2.1.289–2.1.293 on macOS runs a command hook in its own process group: the admission control hook has `pid` 94382, `ppid` 94369 (`claude` itself), `pgid` 94382.
   - The process group check (ADR-0007 decision 10) saw this `node` outside the call's group, and admission did not pass: backend — `disabled: isolation` with the reason "CLI descendant left its process group: node".
   - The fix repeats the exception for the Codex control hook from #136: a group whose leader wrote its `pid` into the marker is not considered a violation.
2. **Claude observer responses were rejected by the schema** — PR #162, merged 2026-10-08.
   - In the `stage.depends` operation, the `via` field is an artifact version id or `null`. Claude 2.1.293 wrote a path there (`SPEC.md`, `PLAN.md`), and the daemon rejected the whole response.
   - In the first 10 minutes of the first measurement attempt, 9 of 10 responses were rejected, all because of this field. That attempt was stopped.
   - The prompt now explains `via`, and the schema rejection reason names the field and reaches `previous_attempt`.
   - In the measurements of this report there are no `via` rejections. There were rejections nonetheless, for other reasons:
     - `claude` — 3 of 316: a fact outside the batch twice, a plan criterion without a plan fact once;
     - `claude-low` — 5 of 175: the card does not match the quote four times, a fact outside the batch once;
     - `codex` — 1 of 213: a card.
3. **The chat journal was empty** (this PR). The daemon created the chat without a journal, so chat calls did not get into `observer_calls`, and the "chat" journal in `catacomb usage` and on the cost panel was always empty. Now every CLI call of a question, including the follow-up request, is written to the journal.
4. **The recorder did not record long sessions** (this PR).
   - Every 25 ms the scan reread all source files in full, and in an hour-long session the scan queue grew without bound.
   - Now the scan skips unchanged files, reads the tail of a growing JSONL and is not queued behind a running scan.
   - A file changed without growing or replaced is read in full. The scan at a command boundary still verifies the whole captured prefix.

Minor:

- `/api/runs/:run/observer-calls` returns `error: null`, `cli_version: null` and `model: null` for every call, although the error class is stored. The tool takes the error class from the store after the daemon stops.
- A call cancelled on stop is recorded as `failed` without a class and message.

Operational: Claude Code updated itself from 2.1.292 to 2.1.293 between recordings — it was updated by other owner sessions. So that the observer version would not change in the middle of a measurement, the profiles pin the path to the 2.1.293 binary.

## 4. Freshness (Q.2)

### 4.1. Assessment method

- **A predicate** is checked by the tool: the first model version after the event in which the predicate holds. A predicate that already held before the event is an annotation defect; the event is not included in the statistics.
- **A description** is assessed by the annotator against the full map state.
  - Candidates are all versions of the run within the 120 s window after the event. `state.mjs` prints the full map state before the event and the changes of each candidate, and with `--at`, the full state of the chosen candidate.
  - The verdict is the first candidate in which every part of the description holds, including the part before the colon: meaning, not wording.
  - If the description already held before the event, the verdict is "met before the event".
  - If the description contradicts what the session did, the verdict is "does not match the recording". This is decided from the recording itself, identically for all measurements of that recording.
  - Both such cases are annotation defects; they are not included in p95, just like a predicate met before the event.
- **Grounds.** Each verdict has grounds: the version, the entities and their states, why the previous candidate does not fit. The verdicts are in `results/<measurement>/verdicts.json`, the applied annotation in `annotations.json`.
- **Heuristics.** Earlier verdicts based on matching stage titles were discarded. The annotation was done by four separate Claude Opus sessions under a common procedure (the rules are this section), each on its own recordings. Then the report author reconciled reading discrepancies into a single rule, rechecked the longest met expectations and cross-checked all "does not match the recording" cases against the recording transcripts. After the PR review, all `review-fixed` expectations of the seven recordings were also cross-checked against the solver's final messages; one missed case was found, `logstats:review-fixed` (section 4.8). An example of a discrepancy with the heuristic is `ledger:rounding-answered`:
  - the heuristic chose v21 after 0.9 s, where the observer had only created an "ask the user" stage and the question was still open;
  - the full description ("answer Half-up, question resolved, conversion continues with this choice") held in v24 after 21.7 s.
- **Ambiguous descriptions and the adopted reading:**
  - "running" in an expectation about current work is also satisfied by an already completed step: the map is ahead, not behind;
  - "every stage of the plan" — the stages of PLAN.md;
  - work split into two stages (review and fixes) is assessed on both;
  - "the confirmed findings are fixed" — all review findings that the solver acknowledged as defects are fixed:
    - an acknowledged finding left unfixed makes the description not match the recording (Claude `logstats`: byte total overflow);
    - findings that the solver considered non-defects and deferred to the user's decision are not part of the description (Claude `ledger`: 10 of 14 fixed, the other four are behavior that SPEC.md does not define).

### 4.2. Claude, default effort

Obs: 89 checkpoint events, 47 of them with a predicate.

- Event outcomes:
  - met — 60;
  - after the window — 2;
  - not met — 3;
  - met before the event — 13;
  - does not match the recording — 11.
- Latency of met expectations:
  - p50 — 23.3 s, p90 — 41.2 s, p95 — 51.0 s, max — 96.1 s;
  - within 30 s — 66 % of assessed events.
- Per recording, without plan expectations:
  - `ledger` — p95 57.4 s;
  - `logstats` — 39.0 s;
  - `kvstore` — 32.6 s;
  - `mdlinks` — 96.1 s.
- Longest:
  - `mdlinks:committed` — 96.1 s and `mdlinks:commit-done` — 92.3 s. The observer was still processing earlier facts at that time: in v224, 66 s after the commit, the commit stage is still waiting;
  - `ledger:review-fixed` — 57.4 s;
  - `mdlinks:plan-written` — 51.0 s.
- Observer calls: 316, 313 accepted. Call: p50 13.2 s, p95 24.8 s, max 34.8 s. Facts per call: p50 11, max 30. Observer state — `ok` 100 % of the time.

### 4.3. Claude, effort `low`

Obs: 44 checkpoint events.

- Event outcomes:
  - met — 32;
  - not met — 2, both `plan-ready`;
  - met before the event — 3;
  - does not match the recording — 7.
- Latency of met expectations:
  - p50 — 12.1 s, p95 — 29.7 s, max — 32.8 s;
  - within 30 s — 91 % of assessed events;
  - without plan expectations — 100 %.
- Calls: 175, 170 accepted. Call: p50 8.0 s, p95 15.2 s, max 21.4 s.
- Comparison with `claude` on the same two recordings (`compare.mjs`, 30 events met in both measurements):

| | Default effort | `low` |
| --- | --- | --- |
| Latency p50 / p95 / max | 22.0 / 92.3 / 96.1 s | 12.1 / 29.7 / 32.8 s |
| Events faster | — | 27 of 30 |
| Calls of the `logstats` and `mdlinks` runs | 145, p50 14.1 s, p95 26.9 s | 175, p50 8.0 s, p95 15.2 s |
| Tokens per call, p50 | 23.9k | 21.0k |
| Cost of the two runs per CLI data | $21.85 | $20.56 |
| Rejected responses | 3 of 316 in the whole measurement | 5 of 175 |

Caveat: in the `claude` measurement these recordings ran concurrently with `ledger` and `kvstore`, in `claude-low` one at a time.

- There are no more than two simultaneous calls per daemon, so two runs do not wait for each other, but the load on the CLI and the machine is higher.
- The event outcomes by annotation in the two measurements match, except for one expectation met before the event.
- By these data, response quality with `low` is not worse. Cards with an inaccurate quote are rejected by the daemon and retried.

### 4.4. Codex

Obs: 58 checkpoint events.

- Event outcomes:
  - met — 42;
  - after the window — 3;
  - not met — 3;
  - met before the event — 6;
  - does not match the recording — 4.
- Latency of met expectations:
  - p50 — 19.2 s, p90 — 24.8 s, p95 — 26.4 s, max — 31.5 s;
  - all met expectations within 40 s;
  - without plan expectations — 100 % within the target.
- Per recording, without plan expectations:
  - `ledger` — p95 31.5 s;
  - `logstats` — 28.1 s;
  - `kvstore` — 26.4 s.
- Calls: 213, 212 accepted. Call: p50 11.8 s, p95 19.4 s, max 40.7 s. Facts per call: p50 7. State — `ok` 100 % of the time.

This is consistent with F.3: there p95 was about 33 s under continuous activity.

### 4.5. Violations: reflecting the plan

All violations of all three measurements are two expectations of the planning turn.

| Recording | `plan-written`: all PLAN.md sections as stages | `plan-ready`: the brief names the goal |
| --- | --- | --- |
| Claude `ledger` | 534.8 s, after the window | 29.8 s |
| Claude `logstats` | 42.6 s (`low`: 32.8 s) | not met (`low`: not met) |
| Claude `kvstore` | 730.5 s, after the window | not met |
| Claude `mdlinks` | 51.0 s (`low`: 29.2 s) | not met (`low`: not met) |
| Codex `ledger` | 646.3 s, after the window | not met |
| Codex `logstats` | 1024.4 s, after the window | not met |
| Codex `kvstore` | 817.2 s, after the window | not met |

- **`plan-written`.** The observer often does not lay out the plan into stages. 120 s after PLAN.md is written, the Codex `ledger` map contains three stages: "Read SPEC.md", "Write and summarize PLAN.md", "Implement and test CSV parsing". The Claude `ledger` map at the same moment looks the same. Stages for the other sections appear one by one as the solver reaches them.
  - In recordings where the user asks for one stage per turn, this means 9–17 minutes without the planned part of the map.
  - Claude laid out the plan right away in `logstats` and `mdlinks`, so the behavior is unstable.
  - Codex never laid out the plan.
- **`plan-ready`.** After the planning turn the brief retells what was done (PLAN.md, stages, broken links found) and does not name the run goal. For Codex in `kvstore` the brief is empty for the whole turn. The run goal exists separately in the model: `run.goal` from the user's first message, by a rule. Therefore this is a miss against the description, but not necessarily against the product (question 4).

### 4.6. Where the latency comes from

Est. An expectation is met when the observer call that included the event's facts arrives. The latency consists of:

- up to 5 s of waiting for a batch (`delayMs`);
- the time of an ongoing call of the same run: no more often than once per 10 s, `intervalMs`;
- the time of the call itself: p95 for Claude default — 24.8 s, for `low` — 15.2 s, for Codex — 19.4 s.

If facts arrive faster than one call processes them (up to 30 facts), the queue grows. Obs, time with a queue of more than 30 facts:

| Run | Default effort | `low` | Codex |
| --- | --- | --- | --- |
| Claude `mdlinks` | 512 s (peak 176 facts) | 177 s (peak 150) | — |
| Claude `logstats` | 351 s | 154 s | — |
| Claude `ledger` | 341 s | — | — |
| Claude `kvstore` | 93 s | — | — |
| Codex `ledger`, `logstats`, `kvstore` | — | — | 82, 84 and 115 s |

The tail for Claude default is exactly such queues after bursts: subagents, series of edits and test runs. The faster call with `low` processes them faster.

### 4.7. Full latency and follow-up requests

- **Codex.** Events sit on rollout lines with their own time. During playback a fact is available to the collector after p50 16 ms, max 50 ms after the event time (Obs). Therefore the full latency matches the semantic latency: p95 of met expectations — 26.4 s.
- **Claude.** Events sit on hook deliveries (PostToolUse, Stop), which have no event time of their own, so the full latency is not computed (shown as "—" in the report). A hook fires at the moment of the action, and during playback delivery is instantaneous: between the recording step and the collector's observation, from −2 to 0 ms (Obs). The full latency for Claude equals the semantic latency up to the delay of the hook itself in a live session.
- **Follow-up requests.** The observer never requested `needs` in a batch call: the share of follow-up time is 0 % in all measurements. The Codex chat requested additional data four times: 13 calls for 9 questions (section 6).

### 4.8. Annotation defects

**Met before the event:**

- **Claude predicates, 13:**
  - `ledger`: `conversion-tested`, `conversion-done`, `export-tested`, `export-done`, `cents-done`;
  - `logstats`: `report-tested`;
  - `kvstore`: `crash-tested`, `compaction-tested`, `ttl-planned`, `ttl-done`;
  - `mdlinks`: `check-tested`, `fix-tested`, `json-done`;
- **`claude-low`, 3:** `logstats:streaming-done`, `mdlinks:check-tested`, `mdlinks:fix-tested`;
- **Codex, 6:**
  - predicates: `ledger`: `export-tested`, `export-done`, `cents-planned`; `logstats:report-tested`; `kvstore:crash-tested`;
  - description: `kvstore:parallel-done`.

The typical cause: the observer marks a stage as done based on an earlier successful test run, while the event sits on the last test run of the turn.

**Does not match the recording** — the description was written before the recording and assumed a turn that did not happen in the session. In all these cases the map shows what actually happened.

| Event | What was in the recording |
| --- | --- |
| Claude `ledger:parallel-reported` | the subagents were launched in the background, the event sits on the launch; they finished after 69 and 92 s |
| Claude `kvstore:parallel-reported` | the event sits on the completion of the first subagent; the second returned its result after 115 s |
| Claude `mdlinks:docs-reported` (both measurements) | Claude Code 2.1.293 launched the subagents asynchronously, the event sits on the launch; the README subagent did not deliver a result |
| Claude `mdlinks:slugs-answered` (both measurements) | the solver put the "Case-insensitive" option first, the host chose it, while the description expected case-sensitive |
| Claude `mdlinks:docs-done` (both measurements) | README.md was not written |
| Claude `logstats:review-fixed` (both measurements) | the solver acknowledged the confirmed review finding about byte total overflow and left it: "Not fixed: Byte total overflow"; the map shows the exception |
| Claude `logstats:docs-done` (both measurements) | the PLAN.md documentation stage is not finished: no `bin` in package.json, the solver: "Stage 6 stays pending" |
| Claude `final-tested`: `ledger`, `kvstore`, `logstats` (both measurements), `mdlinks` (both measurements) | the solver itself reports unfinished PLAN.md stages; in `mdlinks` the final tests fail: 64 of 72 |
| Codex `commit-done`: `ledger`, `logstats`, `kvstore` | in the `workspace-write` sandbox `.git` is read-only, no commit was created |
| Codex `kvstore:final-tested` | final check: some of the PLAN.md crash tests were not written |

Sensitivity (Obs):

- if these events are counted as not met, the profile p95 of all measurements stays beyond the window;
- if they are assessed without the unachievable part, the latencies fit the same distributions. For example, `mdlinks:slugs-answered` with the actual answer was met after 15.8 s, in `claude-low` after 16.7 s.

For future measurements:

- place the subagent event on their completion, not on the PostToolUse of the Agent call;
- for Codex, make `.git` writable;
- word final expectations and fix expectations without assuming the solver's success.

## 5. Limit exhaustion and degradation (fake CLI)

The owner's limits were not spent: failures were reproduced with the fake `claude` from `@catacomb/testkit` (`fake-observer.mjs`).

- Profile: the `ledger` and `logstats` recordings with a 60 s start offset, time scale 0.25 (four times faster than the recording), window 120 s, the same chat questions.
- The fake observer answers instantly with the `map` script and names stages its own way. Therefore the annotation predicates do not hold on it, and the latencies of these runs are not representative.
- What is examined are observer states, the fact queue, map versions and calls (Obs, `degradation.mjs`, results — `results/degradation-limit.json` and `results/degradation-failures.json`).

| Scenario | Failure | State and duration | Queue peak, facts | Map versions during the failure | Recovery |
| --- | --- | --- | --- | --- | --- |
| subscription limit | after 12 calls — a "limit" response with a reset time 4 minutes after it is set | `unavailable:limit` 145 s in both runs, 32 % of the measurement time | 442 and 532 | rules — 2, observer — 0 | at the reset moment one probe on a synthetic input, then regular batches; the first run's queue dropped to 30 facts in 241 s, the second's did not drop by the end of the measurement |
| network failures | after 12 calls — five consecutive responses with a network error | `backoff` 312 and 313 s: pauses of 10, 20, 40, 80 and 160 s, 68 % of the time | 749 and 913 | rules — 12 and 4, observer — 1 each (a successful response between failures) | facts older than 5 minutes went into the compressed summary of catch-up mode (`lagging: backlog` for half a second), the queue is empty immediately |

- **Collection does not stop.** Facts accumulate in the run's queue, rules keep changing the map (explicit requests, execution state), the observer makes no calls. The `unavailable: limit` and `backoff` states are visible in the UI from the first refusal.
- **Limit.** The daemon does not spend batch attempts and does not retry calls until the reset time reported by the CLI.
  - After the reset — one probe (`probe` in the journal) and a return to work.
  - During the 145 s of refusal the lag did not reach the catch-up mode threshold (5 minutes), so the queue was processed by regular batches: no more than 30 facts per call and no more often than once per 10 s.
  - In the four-times accelerated profile facts arrived faster, and the second run did not catch up with the queue by the end of the measurement. In real time the fact stream is four times sparser.
- **Network failures** fit the ADR-0007 rules: the pause doubles starting from 10 s. A lag of more than 5 minutes enables catch-up mode: early facts go to the observer as a summary, and the map is marked as recovered with reduced detail.
- **The chat** kept answering during the observer failure: with the fake CLI, chat answers do not depend on the failure scenario. A real subscription limit would reject the chat too — this cannot be checked with the fake CLI.
- **Freshness during a failure.** Violations are inevitable: an expectation is not met while the observer is unavailable. The RFC §8 target applies to operation without an LLM failure; during a failure the UI shows the age of the semantic model.

## 6. Economics (Q.3)

Obs. Call cost — per CLI data in the daemon's call journal.

- **Run hour** — the sum of the durations of the played runs.
- **Active hour** — the time when at least one run of the backend was in progress.
- **Money** — only for Claude, at the price list reported by the CLI. On a subscription this is not a charge but a measure of the share of the limit.

**Recurring costs:**

| Measurement | Runs | Run hours | Active hours | Observer per run hour | Observer per active hour | Chat per active hour |
| --- | --- | --- | --- | --- | --- | --- |
| `claude` | 4 | 1.77 | 1.02 | 179 calls, 4.50 M tokens, $26.28 | 311 calls, 7.82 M, $45.67 | 11.8 calls, 0.36 M, $2.70 |
| `claude-low` | 2 | 0.78 | 0.78 | 226 calls, 5.04 M, $26.52 | same | 7.7 calls, 0.28 M, $1.72 |
| `codex` | 3 | 1.36 | 0.95 | 157 calls, 1.42 M | 225 calls, 2.04 M | 13.7 calls, 0.25 M |

- **Peak sliding hour.**
  - Claude — 7.88 M tokens, 312 calls, $46.11, on two concurrent runs.
  - `claude-low` — 3.91 M for the whole measurement (48 minutes).
  - Codex — 1.93 M over 57 minutes.
- **Per run** (recording of 20–38 minutes).
  - Claude observer: 1.75–2.37 M tokens, $10.39–13.35.
  - With `low` on the same recordings 4–8 % cheaper, 6 % overall. There are more calls per hour, though: a shorter call means more frequent batches.
- **Chat.**
  - Claude: 12 questions, 11 answers, one CLI call exceeded the 90 s timeout. Answer: p50 21.2 s, p95 36.0 s, 33k tokens and $0.25 per answer.
  - `claude-low`: 6 of 6, p50 11.9 s, p95 14.6 s.
  - Codex: 9 of 9, p50 11.4 s, p95 21.6 s, 26k tokens per answer. 4 answers are "not enough data", 3 of them to the question about failing tests. The chat requested additional data 4 times: 13 calls for 9 questions.

**Token structure:**

| Observer | Uncached input | Cache read | Cache write | Output |
| --- | --- | --- | --- | --- |
| Claude, default effort | 0 % | 36 % | 59 % | 5 % |
| Claude, `low` | 0 % | 40 % | 57 % | 3 % |
| Codex | 81 % | 16 % | 0 % | 4 % |

- For Claude each call reads exactly 9,029 tokens from the cache — the unchanging part of the input.
- The rest of the input (p50 13.8k, p95 28.7k tokens) is written to the cache and is not read by the next call: the next call's input is already a different map and batch (question 5).

**Observer versus solver, per run:**

- **Claude.**
  - Observer — 1.75–2.37 M tokens, solver — 3.27–5.05 M (39–55 %).
  - But 92–94 % of the solver's tokens are cache reads.
  - The observer's cache writes are 1.05–1.37 M per run, the solver's 0.19–0.25 M: 5–6 times more.
  - Output is comparable: 89–102k for the observer, 72–106k for the solver.
- **Codex.**
  - Observer — 0.52–0.74 M, solver — 1.68–2.84 M (26–31 %).
  - The observer's uncached input is 0.43–0.58 M, the solver's 0.15–0.21 M: 2.7–3.1 times more.
- The transcripts do not report the solver's money, so the comparison is only by token kinds.

**One-time costs:**

- **Claude admission** for each new CLI version (`admission-cost.mjs`, Obs): 2 calls of 3.5–3.7 s, 20,150 tokens, $0.019. Claude Code is released almost daily, i.e. about $0.02 per day.
- **Codex admission** was not measured separately: the same two calls, the cost does not get into the call journal.
- **The probe after a limit reset** — one short call (section 5).
- **Writing the unchanging part of the input into the one-hour cache** — about 9k tokens once per idle hour.
- Recurring costs are two orders of magnitude larger than one-time costs.

**Hour per U.1.** The daemon's cost accounting (U.1) counts as active the calendar hours with solver activity; there are 2 of them here for each measurement. Therefore its "per active hour" is half the measured value: for example, for the Claude observer $23.23 versus $45.67. This is a consequence of the definition, not an accounting error.

## 7. How to reproduce

Build — `pnpm build`.

**Load recordings.** Live solvers, one at a time. Claude — the owner's standard `~/.claude` without their settings, Codex — the standard `CODEX_HOME` without hooks and plugins:

```sh
F=fixtures/workloads
for task in ledger logstats kvstore mdlinks; do
  CATACOMB_Q2_TASK=$task CATACOMB_Q2_FIXTURES=$F node tools/record/dist/main.js record $PWD/docs/research/samples/q2-live/claude-workload.mjs
done
for task in ledger logstats kvstore mdlinks; do
  CATACOMB_Q2_TASK=$task CATACOMB_Q2_FIXTURES=$F node tools/record/dist/main.js record $PWD/docs/research/samples/q2-live/codex-workload.mjs
done
node docs/research/samples/q2-live/markup.mjs $F
```

**Profiles, measurements and annotation.** The observer is the pinned binary. Recordings are looked up by version directories, so the mixed 2.1.292 and 2.1.293 are found automatically. These commands produce the fixed profiles of this report byte for byte (before anonymizing the CLI path):

```sh
D=docs/research/samples/q2-live
CLAUDE="$HOME/.local/share/claude/versions/2.1.293"
CODEX=/opt/homebrew/Caskroom/codex/0.160.0/bin/codex
node $D/profile.mjs --runtime claude --fixtures $F --surface claude_cli --cli "$CLAUDE" --out claude.json
node $D/profile.mjs --runtime claude --fixtures $F --surface claude_cli --cli "$CLAUDE" --effort low --name claude-workload-low --lanes logstats,mdlinks --out claude-low.json
node $D/profile.mjs --runtime codex --fixtures $F --surface codex_exec --cli "$CODEX" --lanes 'ledger,kvstore;logstats' --out codex.json
for m in claude claude-low codex; do
  node tools/freshness/dist/main.js fix $m.json measure-$m --fixtures $F
  node tools/freshness/dist/main.js run measure-$m --fixtures $F
done
node $D/annotate.mjs measure-claude
node $D/state.mjs measure-claude workload-ledger:rounding-answered --at 5
node $D/annotate.mjs measure-claude --verdicts verdicts.json
node tools/freshness/dist/main.js report measure-claude
```

**How the annotation works:**

- `annotate.mjs` without `--verdicts` prints events and candidates;
- `state.mjs` prints the full map state; it needs the measurement's store;
- `annotate.mjs --verdicts` applies the verdicts: every event must have a verdict with grounds in `reason`;
- `candidate` is the candidate index or `null`; the `held_before` and `mismatch` flags mark annotation defects.

**Recomputation from saved data**, without a live run:

```sh
for m in claude claude-low codex; do
  node $D/annotate.mjs $D/results/$m --verdicts $D/results/$m/verdicts.json
  node tools/freshness/dist/main.js report $D/results/$m
done
node $D/compare.mjs $D/results/claude $D/results/claude-low
node $D/analyze.mjs $D/results/claude
```

**Other:**

- One-time cost of Claude admission — `node $D/admission-cost.mjs --cli "$CLAUDE"`.
- Degradation on the fake CLI:
  1. `node $D/fake-observer.mjs limit <dir> --before 12 --limit-seconds 240` or `node $D/fake-observer.mjs failures <dir> --before 12 --failures 5` prints the path of the fake `claude` for `observer.claude.cli`;
  2. profile — the `ledger` (0 s) and `logstats` (60 s) recordings, `time_scale` 0.25, questions at 30, 60 and 95 % of the accelerated duration;
  3. then `node $D/degradation.mjs <measurement dir>`.

## 8. Evidence and the measured build

**Measurement build.** The daemon and the measurement tools were built from revision `e8ffee13` of the local branch `tmp/q2-measure`. Its tree is reproducible from published commits: `51471d4e` of this branch, with `b1f702a8` (PR #158, `refs/pull/158/head`) and `0706f513` (PR #162, `refs/pull/162/head`) applied on top. `git diff 51471d4e e8ffee13` equals the sum of these two diffs: 10 files, +86 −26.

- Build — `pnpm build`, after applying #162 — `tsc -b tsconfig.build.json`.
- The recordings were made by this branch's recorder at `733801e5`; the recorder fix `0af42d5a` was made after the recordings.
- The annotation and report tool is from this branch (the `mismatched` status and the annotation-defect verdicts were added after the measurement and do not affect the measurements themselves).

**Recordings.** The measurement load, identified by the digests of the recording directories from the fixed profiles:

| Recording | Duration, min | Checkpoint events | SHA-256 (prefix) |
| --- | --- | --- | --- |
| `claude/2.1.292/claude_cli/macos/workload-ledger` | 22.0 | 22 | `2e9942ca88697de2` |
| `claude/2.1.292/claude_cli/macos/workload-logstats` | 20.5 | 23 | `b90f7426d609de67` |
| `claude/2.1.292/claude_cli/macos/workload-kvstore` | 37.6 | 23 | `948eeb06e9b486bf` |
| `claude/2.1.293/claude_cli/macos/workload-mdlinks` | 26.1 | 21 | `232b6fec0906edcc` |
| `codex/0.160.0/codex_exec/macos/workload-ledger` | 24.0 | 19 | `b72859f45620ef03` |
| `codex/0.160.0/codex_exec/macos/workload-logstats` | 26.2 | 19 | `c4eabfc29cdd31b4` |
| `codex/0.160.0/codex_exec/macos/workload-kvstore` | 31.2 | 20 | `571a97975277dfb0` |

**Results** — in `docs/research/samples/q2-live/results/<measurement>/`:

| File | Contents |
| --- | --- |
| `profile.json` | the profile fixed before the measurement: fixing time and full recording digests |
| `measurement.json` | events with annotation predicates, calls with cost, observer states, chat questions, U.1 accounting |
| `annotations.json` | candidates with the changes of each version and the applied verdicts |
| `verdicts.json` | the annotator's verdicts with grounds |
| `report.json`, `report.md` | the tool report, recomputed by the command from section 7 |

**Anonymization.** The repository is public, therefore:

- in the observer CLI path in `profile.json` the home directory is replaced with `/Users/USER`, and `profile_digest` in `measurement.json` is recomputed for the anonymized profile (for `codex` the path is not personal, the digest was not changed);
- the root of the Claude Code temporary directory in one solver command is replaced with `<other-tmp-1>`;
- names, addresses, hosts and tokens do not occur in the files (checked by search);
- the daemon stores (`catacomb.db`, 20–50 MB per measurement) are not part of the repository.

## 9. Re-measurement after the owner's decisions

Date — 2026-10-08. The recommendations of section 2 were accepted by the owner (ADR-0007, decisions 14–16; plan, decisions 18–22) and implemented in PR #172. Compared with the measurements of sections 1–6, four things changed:

- the default effort of the Claude observer is `low`;
- the observer prompt immediately lays out an explicit plan (PLAN.md, a task list) into planned stages, and writes a criterion from the plan file without a plan fact into the stage's expected result;
- the run goal `run.goal` is the human's first prompt; it is set by a rule and gets into the observer input;
- `plan-ready` in the annotation no longer requires the brief to name the goal.

### 9.1. Method

- **Build.** Local branch `tmp/q2dec-measure` at `010944b5`: tree `3d112544` from PR #172 and the same `b1f702a8` (#158) and `0706f513` (#162) as in section 8. `git diff 3d112544 010944b5` — 10 files, +86 −26, as there.
  - The short `codex-plan` check ran on an earlier build: `532212a0` from #172 with the same two commits, without the plan criteria fix.
  - After `3d112544`, `cb37e1cf` and `5786954d` were added to #172. The first changes only the fact referenced by the run goal: the earliest prompt with the same text. The goal text in the observer input does not change because of it. The second edits only the ADR. Therefore the observer input in these runs is the same for the measured build and for #172.
- **Observer** — the same pinned `claude` 2.1.293 and `codex-cli 0.160.0`.
- **Recordings** — the same seven. `markup.mjs` now carries the current descriptions from `tasks.mjs` into the manifests. For these recordings only the `plan-ready` description changes, so the digests are different (section 9.7).
- **Measurements:**

| Measurement | Observer | Recordings and start | Concurrency |
| --- | --- | --- | --- |
| `claude-low-parallel` | effort `low` | as `claude`: lane 1 — `ledger` (0 s), `kvstore` (1408 s); lane 2 — `logstats` (300 s), `mdlinks` (1618 s) | up to two runs at once |
| `codex-plan` | CLI default (`low`) | `ledger`, `logstats`, `kvstore`, each up to the end of the planning turn; one lane, pauses of 30 s, no chat | no |
| `codex-plan-2` | same | same | no |

- The `claude-low-parallel` profile matches the `claude` profile of section 0 in everything except effort and name: the same runs, starts and chat questions.
- **Short Codex check.** `plan-only.mjs` copies the recordings and truncates each after the `plan-ready` event: 73–112 s of playback per recording. The full Codex measurement was not repeated: its target is confirmed (decision 15), and the prompt change concerns the plan.
- **Annotation** — per the rules of section 4.1. The `claude-low-parallel` events without a predicate were annotated by four separate Claude Opus sessions, one per recording; the report author reconciled the verdicts and rechecked the disputed ones.
  - "Does not match the recording" verdicts are decided from the recording itself. All 11 were carried over from the `claude` measurement, each checked against the map of this measurement.
  - `plan-ready` was read the same way by all: the planning turn is over when the planning stage is done, the plan stages are in place as planned and no stage is `running`.
  - `logstats:docs-reported` was chosen at v145 (+4.2 s): the summary of the stage with two agents already reports the result of both subagents there. An explicit "Both subagents finished" appears in v149 (+19.1 s).
  - The remaining places where a description allowed two readings were resolved the same way as in section 4.1.

### 9.2. Summary

| Measurement | Assessed | Met | Violations | Annotation defects: before event / not per recording | Profile p95 | Met: p50 / p95 / max | Within 30 s | p95 without plan expectations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `claude`, section 1 | 65 | 60 | 5 | 13 / 11 | 730.5 s | 23.3 / 51.0 / 96.1 s | 66 % | 57.4 s (57 events) |
| `claude-low`, section 1 | 34 | 32 | 2 | 3 / 7 | beyond the window | 12.1 / 29.7 / 32.8 s | 91 % | 22.8 s (30 events) |
| `claude-low-parallel` | 67 | 67 | 0 | 11 / 11 | 34.9 s | 13.3 / 34.9 / 57.6 s | 90 % | 32.1 s (59 events) |

Obs.

- **No violations.** All expectations were met within the window, including all four `plan-written` and `plan-ready`. Profile p95 — 34.9 s: the 30 s target is missed by 4.9 s. Within 30 s — 60 of 67 events.
- **Per recording, without plan expectations:** `ledger` — p95 34.9 s, `logstats` — 34.8 s, `kvstore` — 26.3 s, `mdlinks` — 23.6 s.
- **Longest:**
  - `mdlinks:plan-written` — 57.6 s and `mdlinks:plan-ready` — 52.1 s. The response with seven plan stages (+17.3…42.6 s) was rejected: its `actions.assign` referenced an id outside the batch in its evidence. The retry was accepted at +57.6 s;
  - `ledger:plan-written` — 36.1 s;
  - `ledger:parse-tested` — 34.9 s;
  - `logstats:streaming-tested` — 34.8 s;
  - `kvstore:plan-written` — 33.4 s.
- **Calls:** 369, 358 accepted. Call: p50 8.0 s, p95 15.7 s, max 27.9 s. Facts per call: p50 9, max 30. Observer state — `ok` 100 % of the time.
- **11 responses rejected (3.0 %), one with two reasons:** the card does not match the quote or goes beyond the message — 8, evidence outside the batch — 3, schema — 1. In `claude` it was 3 of 316, in `claude-low` 5 of 175.
- **`needs` follow-up requests:** 4 calls, one met event; the share of follow-up time — 1.6 %.

**Comparison on the same events** (`compare.mjs`, met in both measurements):

| | `claude` → `claude-low-parallel` | `claude-low` → `claude-low-parallel` |
| --- | --- | --- |
| Events | 57 | 30 (`logstats`, `mdlinks`) |
| p50 / p95 / max | 23.6 / 57.4 / 96.1 → 12.4 / 34.8 / 57.6 s | 12.6 / 29.7 / 32.8 → 11.4 / 34.8 / 57.6 s |
| Faster in the new measurement | 49 of 57 | 16 of 30 |

**Queue** — the time when the run's queue holds more than 30 facts (`queue.mjs`, Obs):

| Run | `claude` | `claude-low` | `claude-low-parallel` |
| --- | --- | --- | --- |
| `ledger` | 341 s | — | 166 s (peak 78) |
| `logstats` | 351 s | 154 s | 134 s (peak 97) |
| `kvstore` | 93 s | — | 47 s (peak 44) |
| `mdlinks` | 512 s (peak 176) | 177 s (peak 150) | 254 s (peak 151) |

**Conclusions:**

- With effort `low` and two concurrent runs the call is no slower than without concurrency: p50 8.0 s, p95 15.7 s.
- The queue after bursts is half as long as with the CLI default, and p95 of met expectations is 34.9 s versus 51.0 s.
- The tail above 30 s comes from plan expectations (a large response with the stages of the whole plan) and a retry after a rejected response. Without plan expectations p95 is 32.1 s.
- On two runs one at a time (`claude-low`) it was 29.7 s. The difference is the concurrent load and longer responses when laying out the plan; this measurement does not allow separating them.

### 9.3. Reflecting the plan

| Recording | `plan-written`, Claude: section 4.5 → `claude-low-parallel` | `plan-ready`, Claude | `plan-written`, Codex: section 4.5 → `codex-plan` → `codex-plan-2` | `plan-ready`, Codex |
| --- | --- | --- | --- | --- |
| `ledger` | 534.8 s, after the window → 36.1 s | 29.6 s | 646.3 s, after the window → not met → 44.0 s | not met → not met → 36.7 s |
| `logstats` | 42.6 s → 22.7 s | 16.4 s | 1024.4 s, after the window → not met → not met | not met |
| `kvstore` | 730.5 s, after the window → 33.4 s | 26.8 s | 817.2 s, after the window → not met → not met | not met |
| `mdlinks` | 51.0 s → 57.6 s | 52.1 s | — | — |

The `plan-ready` description has changed, so it is not compared with section 4.5.

**Claude** lays out the plan in all four recordings, including those where stages previously appeared one by one over 9–12 minutes.

- In `ledger` and `kvstore`, where there is no task list, the plan stages reference the PLAN.md write and the turn's final message (1.8–1.9k characters). Per the turn's assignment this message briefly sets out the plan, so the plan is visible even when the file itself is truncated (below).
- In `logstats` and `mdlinks` there is also a task list: it arrives as a separate plan fact.

**Codex**, after the prompt change, tries to lay out the plan but runs into three things.

1. **Rejected response (`codex-plan`).**
   - In `ledger` the observer requested the raw PLAN.md record and created a stage for each plan step.
   - It recorded the steps' acceptance criteria with the `plan` source, although there is no plan fact in the batch. The daemon rejected the whole response: "plan criterion requires a plan fact", five operations.
   - The retry requested the record again and returned an empty response. The prompt explained this rule for a stage's `origin` but not for a criterion — the same class of error as `via` in #162.
   - Fixed in #172 (`3d112544`). In `codex-plan-2` there are no rejections, the `ledger` plan is reflected in 44.0 s: six `planned` stages. In section 4.5 this took 646 s.
2. **A long plan is not visible in full.** Each line of the observer input is truncated to 4000 characters: this is the limit both for the batch (`textLength` of the observer scheduler) and for `needs` materials (`defaultMaterialLimits` in `engine`). All PLAN.md files are longer (`plan-sizes.mjs`, UTF-16 characters):

| Recording | Claude | Codex |
| --- | --- | --- |
| `ledger` | 6224 | 4768 |
| `logstats` | 4749 | 4836 |
| `kvstore` | 9411 | 8018 |
| `mdlinks` | 4283 | — |

   - In `logstats` and `kvstore` the Codex observer requested the source via `needs`, got the same truncated text and created no stages: "the plan itself is not available in this batch".
   - The turn's final message in `ledger` lists all six stages, and the plan is reflected. In `logstats` it only says "six numbered stages", in `kvstore` it names four topics for six stages. The observer does not build stages from such a statement.
3. **The Codex task list is not a plan fact.**
   - Codex 0.160.0 in code mode calls `update_plan` inside an `exec` cell: `text(await tools.update_plan({plan: [...]}))`.
   - The adapter parses the cell as a `code_cell` action: there is not a single `plan_update` fact in these recordings.
   - In `logstats` the short task list sits in the same cell as the `apply_patch` for PLAN.md, after 4836 characters of the plan, and is truncated too.

Claude has three rejections due to evidence outside the batch (two in `claude`): twice in `actions.assign` and once in `stage.update`. They are not related to laying out the plan, but one of them hit the response with the `mdlinks` plan stages and caused its tail.

### 9.4. Cost (Q.3)

Obs, per CLI data, as in section 6.

| | `claude` | `claude-low-parallel` |
| --- | --- | --- |
| Run hours / active hours | 1.77 / 1.02 | 1.77 / 1.02 |
| Observer per run hour | 179 calls, 4.50 M tokens, $26.28 | 209 calls, 4.64 M, $23.50 |
| Observer per active hour | 311 calls, 7.82 M, $45.67 | 363 calls, 8.07 M, $40.83 |
| Peak sliding hour | 7.88 M, $46.11 | 8.13 M, $41.24 |
| Tokens per call, p50 | 23.9k | 20.5k |
| Structure: uncached input / cache read / cache write / output | 0 / 36 / 59 / 5 % | 0 / 43 / 54 / 3 % |
| Chat per active hour | 11.8 calls, 0.36 M, $2.70 | 11.8 calls, 0.36 M, $2.60 |
| Chat: answers, p50 / p95, per answer | 11 of 12, 21.2 / 36.0 s, 33k, $0.25 | 12 of 12, 12.6 / 19.4 s, 30.7k, $0.22 |

- With `low` a call is cheaper, but there are 17 % more calls: a shorter call means more frequent batches. Tokens per active hour are 3 % higher, money 11 % lower.
- The peak sliding hour is 8.13 M tokens, at the level of section 6. The conclusion of question 3 of section 2 does not change: any budget below the peak breaks freshness.

### 9.5. Questions for the owner

1. **Claude target** (decision 14). Effort `low` is confirmed: with two concurrent runs there are no violations, p95 is 34.9 s versus 51.0 s and five violations with the CLI default. The 30 s target is not met by this measurement:
   - profile p95 — 34.9 s, 90 % of expectations within 30 s;
   - without plan expectations — 32.1 s;
   - on two runs one at a time (`claude-low`) it was 29.7 s.

   Options:
   - a) keep 30 s and consider the 5 s gap acceptable for a profile with two runs;
   - b) record a target of about 35 s for Claude runs, like about 40 s for Codex;
   - c) keep 30 s as the goal and return to it with separate work on the tail.

   I recommend b). Effort is already at the lowest, and the call did not slow down under concurrent load. The tail comes from the queue after bursts and large responses laying out the whole plan, and effort does not reduce those.
2. **A long plan in the observer input** (new, section 9.3). Currently both the batch and the `needs` materials cut a line to 4000 characters, so the observer does not see a PLAN.md longer than that in full even on request.
   - a) Give follow-up materials a larger line limit (for example, 16k characters) within the overall input budget of 24k tokens. The batch stays at 4000 characters, and a follow-up request costs a separate call anyway.
   - b) Change nothing and rely on the task list and the turn's final message.

   I recommend a): it is the direct `needs` path to the source that ADR-0007 describes, and it does not grow regular batches. This is a change to the observer input (F.7b, F.7c), a separate PR after the decision.
3. **The Codex plan from `update_plan`** (new). In code mode Codex 0.160.0's `update_plan` call is visible only in the code text of an `exec` cell (a `custom_tool_call` record); there is no separate plan record in the rollout. The adapter does not extract a plan fact (ADR-0006: the Codex plan sources are defined by the "plan" reference session).
   - a) Recognize the `tools.update_plan(...)` call in the cell code as a plan fact. This is parsing code, not data: fragile and dependent on how the model writes the cell.
   - b) Do not parse code and consider the Codex plan visible through the plan file and the turn's final message.

   I recommend b) together with question 2 a): then the full PLAN.md is available to the observer via `needs`. The "plan" reference session for code mode should be re-recorded once a separate plan record appears in the rollout.

### 9.6. How to reproduce

Build — as in section 9.1. Recordings — a copy of the section 7 recordings with the new annotation:

```sh
F=fixtures/workloads
D=docs/research/samples/q2-live
CLAUDE="$HOME/.local/share/claude/versions/2.1.293"
CODEX=/opt/homebrew/Caskroom/codex/0.160.0/bin/codex
node $D/markup.mjs $F
node $D/plan-only.mjs $F plan-only codex
node $D/profile.mjs --runtime claude --fixtures $F --surface claude_cli --cli "$CLAUDE" --effort low --name claude-workload-low-parallel --out claude-low-parallel.json
node $D/profile.mjs --runtime codex --fixtures plan-only --surface codex_exec --cli "$CODEX" --name codex-plan --lanes 'ledger,logstats,kvstore' --gap-ms 30000 --no-chat --out codex-plan.json
node tools/freshness/dist/main.js fix claude-low-parallel.json measure-claude-low-parallel --fixtures $F
node tools/freshness/dist/main.js run measure-claude-low-parallel --fixtures $F
node tools/freshness/dist/main.js fix codex-plan.json measure-codex-plan --fixtures plan-only
node tools/freshness/dist/main.js run measure-codex-plan --fixtures plan-only
```

Recomputation from saved data:

```sh
for m in claude-low-parallel codex-plan codex-plan-2; do
  node $D/annotate.mjs $D/results/$m --verdicts $D/results/$m/verdicts.json
  node tools/freshness/dist/main.js report $D/results/$m
done
node $D/compare.mjs $D/results/claude $D/results/claude-low-parallel
node $D/compare.mjs $D/results/claude-low $D/results/claude-low-parallel
node $D/analyze.mjs $D/results/claude-low-parallel
node $D/queue.mjs $D/results/claude-low-parallel
node $D/plan-sizes.mjs $F
```

### 9.7. Evidence

**Recordings** with the new annotation, digests from the fixed profiles:

| Recording | SHA-256 (prefix) |
| --- | --- |
| `claude/2.1.292/claude_cli/macos/workload-ledger` | `65d73c029d05cdea` |
| `claude/2.1.292/claude_cli/macos/workload-logstats` | `9a1eaa88072c98b4` |
| `claude/2.1.292/claude_cli/macos/workload-kvstore` | `1de4c69aad404ba5` |
| `claude/2.1.293/claude_cli/macos/workload-mdlinks` | `4c3bcdaad76bb5a2` |
| `codex/0.160.0/codex_exec/macos/workload-ledger`, up to `plan-ready` | `fdb14c0fc705bda4` |
| `codex/0.160.0/codex_exec/macos/workload-logstats`, up to `plan-ready` | `7f3064b7fa10e72f` |
| `codex/0.160.0/codex_exec/macos/workload-kvstore`, up to `plan-ready` | `9cbc16586a6a7ef7` |

**Results** — in `docs/research/samples/q2-live/results/claude-low-parallel/`, `codex-plan/` and `codex-plan-2/`, with the same files as in section 8. The anonymization is the same: the Claude CLI path — `/Users/USER`, `profile_digest` recomputed, the root of the Claude Code temporary directory in solver commands — `<other-tmp-1>`. The daemon stores and the load recordings are not part of the repository.
