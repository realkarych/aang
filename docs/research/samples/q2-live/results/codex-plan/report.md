# Freshness measurement: codex-plan

- Workload profile fixed at 2026-10-08T18:10:22.006Z; the measurement started at 2026-10-08T18:10:26.912Z and lasted 472.3 s.
- Measurement window 120.0 s, recording time scale 1.
- Daemon 0.0.0.

## Recordings

| Recording | Runtime | Start, s |
| --- | --- | --- |
| codex/0.160.0/codex_exec/macos/workload-ledger | codex | 0.0 |
| codex/0.160.0/codex_exec/macos/workload-logstats | codex | 102.9 |
| codex/0.160.0/codex_exec/macos/workload-kvstore | codex | 240.2 |

## Backend summary

A violation is an expectation not met within the measurement window. p95 is computed over assessed events, with missed events counted as beyond the window. Events met before the event or not matching the recording are annotation defects and are excluded from p95. Full latency runs from the time of the event itself; the number in parentheses is the count of events with a known time. Follow-up share is the share of `needs` time in the latency of met events; the number in parentheses is the count of events with a follow-up.

| Backend | CLI | Model | Effort | Target p95 | p95 | Target met | Within target | Met | Violations | Unassessed | Met before the event | Does not match the recording | Full latency p95 | Follow-up share |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| codex | 0.160.0 | gpt-6.1-sol | CLI default | 40.0 s | beyond the window (violation) | no | 0% | 0 of 6 | 6 | 0 | 2 | 0 | — | — (0) |

## Control events

| Recording | Event | Method | Outcome | Latency, s | Full, s | Follow-ups, s | Version | Author |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| codex/0.160.0/codex_exec/macos/workload-ledger | plan-written | predicate | missed, violation | — | — | — | — | — |
| codex/0.160.0/codex_exec/macos/workload-ledger | plan-ready | annotator | missed, violation | — | — | — | — | — |
| codex/0.160.0/codex_exec/macos/workload-logstats | triage-tested | predicate | met before the event, annotation invalid | — | — | — | 4 | — |
| codex/0.160.0/codex_exec/macos/workload-logstats | triage-done | predicate | met before the event, annotation invalid | — | — | — | 4 | — |
| codex/0.160.0/codex_exec/macos/workload-logstats | plan-written | predicate | missed, violation | — | — | — | — | — |
| codex/0.160.0/codex_exec/macos/workload-logstats | plan-ready | annotator | missed, violation | — | — | — | — | — |
| codex/0.160.0/codex_exec/macos/workload-kvstore | plan-written | predicate | missed, violation | — | — | — | — | — |
| codex/0.160.0/codex_exec/macos/workload-kvstore | plan-ready | annotator | missed, violation | — | — | — | — | — |

## Observer

| Backend | Calls | Accepted | Rejected | Failed | With follow-up |
| --- | --- | --- | --- | --- | --- |
| codex | 17 | 16 | 1 | 0 | 4 |

| Backend | State | Time, s | Share |
| --- | --- | --- | --- |
| codex | ok | 1070.9 | 100% |

## Spending

Call spending comes from CLI data in the daemon call journal. A run hour is the sum of the durations of the played runs of the backend; an active hour is the time when at least one of its runs was in progress. Money is shown only for Claude, at list prices; under a subscription it is not a charge.

| Backend | Runs | Run hours | Active hours |
| --- | --- | --- | --- |
| codex | 3 | 0.08 | 0.08 |

| Backend | Journal | Calls | Uncached input | Cache read | Cache write | Output | Reasoning | Total tokens | Cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| codex | observer | 17 | 139,896 | 5,120 | 0 | 6,385 | 204 | 151,401 | — |
| codex | chat | 0 | 0 | 0 | 0 | 0 | 0 | 0 | — |
| codex | probes and auth status | 0 | 0 | 0 | 0 | 0 | 0 | 0 | — |

| Backend | Journal | Calls per run hour | Tokens per run hour | Cost per run hour | Calls per active hour | Tokens per active hour | Cost per active hour |
| --- | --- | --- | --- | --- | --- | --- | --- |
| codex | observer | 209.5 | 1,865,399 | — | 209.5 | 1,865,399 | — |
| codex | chat | 0.0 | 0 | — | 0.0 | 0 | — |

| Backend | Questions | Answers | Failed | Not asked | Insufficient data | Answer p50, s | Answer p95, s | Tokens per answer | Cost per answer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| codex | 0 | 0 | 0 | 0 | 0 | — | — | — | — |

Per the daemon spending accounting (U.1), active hours: 1; these are calendar hours with solver activity.
