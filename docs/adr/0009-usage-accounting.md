# ADR-0009: Usage accounting

Status: accepted by the owner 2026-10-01.

## Context

RFC §8 requires:

- accounting the usage of the solver, the observer and the chat separately;
- not counting the same action twice;
- distinguishing run duration from the summed time of parallel agents;
- when there is no exact attribution to a stage, showing session usage or a labeled estimate;
- allowing the monetary cost to be unknown under a subscription.

The spike (sections 3.3, 7–10) showed the sources of double counting:

- Claude: one message is written as N records, a fork copies the history and `cost-state`, SDK totals are cumulative;
- Codex: `turn.completed`, `thread_token_usage` and `token_count` are cumulative and inherited by a fork.

## Decision

### Three separate ledgers

Usage is kept in three ledgers: solver, observer, chat. The ledgers are not mixed.

### Solver: usage records

A usage record is an observation object with a unique key (ADR-0006). One record is counted once.

- **Claude**
  - The key is the global `message.id`.
  - Input and cache tokens are taken from any record of the group, output is the maximum.
  - If the group has no record with `stop_reason`, output is marked "lower bound". This is how the undercount for subagents in 2.1.286 shows up.
  - Records of the `<synthetic>` model are excluded.
  - Messages that a fork inherited (the ADR-0006 rule, independent of intake order) are not counted again.
  - The agent is determined by the file: main thread or subagent.
- **Claude `cost-state`** is a separate per-session figure, "total according to Claude Code": the last line, cumulative across resume.
  - For a fork it includes the inherited part, which is labeled.
  - It is the only source of compaction usage and of Claude's monetary estimate. It is not summed with usage records.
  - In `-p` the line is written at the end of every launch, and in interactive sessions only on exit. While an interactive session is running there is no money and no compaction usage, and the UI labels this.
- **The Desktop summary helper model** is visible only in the stream-json of the Desktop engine, which aang does not read. Its usage is marked as unavailable; whether it is included in `cost-state` the spike did not check.
- **Codex**
  - The key is `(thread_id, response_id)` of a `token_usage_record` record. `thread_id` is taken from the file's `session_meta.id`: the record's `session_id` field is the root id.
  - The records cover compaction calls (in the file of their own thread), subagents and guardian (in their own files).
  - `turn.completed`, `thread_token_usage` and `token_count` are not summed.
  - If a thread has no `token_usage_record` at all (old versions; the boundary between 0.144 and 0.153 was not established by the spike), the thread's last `total_token_usage` is taken, marked "thread total". For a fork this total probably includes the parent (not verified), so for forks such a total is not shown.

### Aggregation

- **Run** — the sum of the unique records of its sessions and agents, without inherited ones.
- **Session and agent** — the sum of their records.
- **Stage** — the exact sum of records all of whose response actions are attributed to that stage. The rest is shown as "not attributed to stages" next to the session usage. There is no proportional estimate in the MVP.
- **Time:**
  - run duration — from the first to the last activity, with visible pauses;
  - an agent's active time — the sum of the durations of its turns.

  The summed time of parallel agents is not presented as the run duration.

### Money

- Money is shown only where the runtime reports it: Claude's `cost-state` and `total_cost_usd` in the result of `claude -p` for the observer and the chat. Label: "at list price; under a subscription it is not a charge".
- For Codex only tokens are shown. There is no own price table.

### Observer and chat

- A call's usage is taken from the CLI result: `usage`, `modelUsage` and `total_cost_usd` for Claude; `turn.completed.usage` for Codex. The call is ephemeral and one-shot, so there is no cumulativeness.
- Call latency is stored in `observer_calls`.

### Report

`aang usage` and the usage panel show, per run and per period:

- the three ledgers;
- usage per active hour — an hour in which there was solver activity;
- observer lag and latencies.

## Consequences

- aang's numbers may not match `cost-state`; both are shown side by side.
- Stage usage will often be incomplete. An honest "not attributed" is preferred to a guess.

## Owner decisions

Accepted by the owner 2026-10-01:

1. There is no proportional estimate of stage usage in the MVP.
2. Money is shown only from runtime data, without an own price table.
