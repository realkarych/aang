# Scenarios from samples (T.5)

Player manifests (`PlayerManifest`, T.2) for the spike samples from `docs/research/samples` that do not need hooks and files to be merged. Transcripts and rollouts are taken from the samples by relative path, without copies. Coordinated scenarios with hooks and files are the R.4 recordings.

```ts
import { createPlayer, loadManifest, sampleScenarioManifest } from '@aang/testkit'

const player = createPlayer(await loadManifest(sampleScenarioManifest('claude-fork')), { roots, timeScale: 0 })
await player.play({ until: 'fork' })
```

| Scenario | What it replays | Labels |
| --- | --- | --- |
| `claude-subagent` | the first run of session `86f93ed5`: the main transcript (34 lines), the meta and transcript of subagent `aad616394e806288d` | `subagent`, `subagent-result` |
| `claude-fork` | run, resume and continue of the main transcript (52 lines), then fork `cdfb3544` (49 lines) | `subagent`, `subagent-result`, `resume`, `continue`, `fork` |
| `claude-compaction` | the whole main transcript (97 lines): the same three runs, a manual compaction and the turn after it | `subagent`, `subagent-result`, `resume`, `continue`, `compaction`, `compact-boundary`, `post-compaction` |
| `codex-resume-compaction` | rollout `01a0f752`: `codex exec`, then `exec resume` with automatic compaction (41 lines) | `resume`, `compaction` |
| `codex-otel` | 24 OTLP log requests: 15 `codex.tool_decision` and 9 other events that the receiver discards | each decision has the case name from the sample |

A label sits on the first step of a phase, so `play({ until })` stops before it.

## How step times were obtained

- **Claude.** Line write times come from `claude-code-transcripts/write-timeline-watch.jsonl`, the run offsets from `run_start` in `sessions-registry-lifecycle-observed.jsonl`. Lines of one file seen in the same millisecond are written as one step. On equal times, the file with the earlier write mark goes first: the subagent finishes before the result appears in the parent. The subagent meta is written whole at the moment the file appears.
- **Codex.** The samples have no rollout write log, so a step's time is the record's `timestamp` mark; records with the same mark are written as one step. The file name is built from the `session_meta` time in UTC.
- **OTel.** One record per request, order and time by `observedTimeUnixNano`. The resource is the `/v1/logs` attributes of the service from `codex-otel/resource-attributes.by-service.json` in the order of the envelope `logs.envelope.tool_decision.approved-user.app-server.json`, the scope from the same envelope. The service of the other events is determined by `originator`.

The first step's time is 0. Full intervals are kept: minutes pass between spike runs, so tests set `timeScale`.

Times inside records are spike times. The observer's work queue is limited to 24 hours by fact time (ADR-0007), so the observer receives such records only as a summary. Tests that need the observer's response to the facts themselves play the sample with `recordTime: 'playback'`: every quoted ISO timestamp in lines, JSON files and hook payloads, including in JSON text inside a string value (with escaped quotes at any nesting depth), is shifted by one amount in whole seconds, so that the earliest timestamp of the sources falls on the last second before the player is created, and the intervals between records are kept. The earliest timestamp and the day around the timestamps are determined only by timestamps outside JSON text in lines: a date in tool output is shifted, but the start of playback does not depend on it. Numeric timestamps in JSON values — seconds, milliseconds, microseconds and nanoseconds of the epoch, as a number or a string of digits at any nesting depth, including in formatted JSON text with escaped newlines around the value, for example `started_at_ms` in a Codex rollout and `observedTimeUnixNano` in OTLP — are shifted by the same amount if they fall within the day around the sources' ISO timestamps; other numbers, for example durations, counters and a limit reset several days out, do not change. If the shift would make a shifted numeric timestamp coincide with a number left in place, all timestamps are shifted by one second less until no coincidences remain: this way the reverse shift of a snapshot in `tools/support` unambiguously restores the record time. OTLP requests are shifted the same way as lines and hook payloads. Fractions of a second in timestamps stay as in the record, so the source length does not change: the player shifts the source as a whole and cuts it at the same lines and bytes as without the shift — a `bytes` step may split a timestamp or a UTF-8 character, but in the file they add up whole. `recordTime: { startsAt }` shifts records the same way, but the earliest timestamp falls on the last second before the given moment in epoch milliseconds: this way a test plays part of a session, for example, a day earlier. By default (`recordTime: 'original'`) files and requests match the sources byte for byte.

## What is not included

- Registry snapshots `sessions/*.json`: the samples have only the status change log without the full file contents.
- Hook events: the hook and transcript samples were taken in different sessions.

The sessions' working directories are `/tmp/aang-spike/cc-transcripts/run` and `/tmp/aang-spike/codex-cli/run1`. Tests include them in scope via `watch.all`.

Conformance of the manifests to the samples is checked by `packages/testkit/test/sample-scenarios.test.ts` (each step's time, files at labels, OTLP bodies) and `packages/engine/test/sample-scenarios.test.ts` (a pass through the real collector, adapters and `engine`).
