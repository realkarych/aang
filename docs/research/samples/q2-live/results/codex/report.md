# Freshness measurement: codex-workload

- Workload profile fixed at 2026-10-07T20:51:05.952Z; the measurement started at 2026-10-07T20:51:11.791Z and lasted 3524.4 s.
- Measurement window 120.0 s, recording time scale 1.
- Daemon 0.0.0.

## Recordings

| Recording | Runtime | Start, s |
| --- | --- | --- |
| codex/0.160.0/codex_exec/macos/workload-ledger | codex | 0.0 |
| codex/0.160.0/codex_exec/macos/workload-logstats | codex | 300.0 |
| codex/0.160.0/codex_exec/macos/workload-kvstore | codex | 1531.5 |

## Backend summary

A violation is an expectation not met within the measurement window. p95 is computed over assessed events, with missed events counted as beyond the window. Events met before the event or not matching the recording are annotation defects and are excluded from p95. Full latency runs from the time of the event itself; the number in parentheses is the count of events with a known time. Follow-up share is the share of `needs` time in the latency of met events; the number in parentheses is the count of events with a follow-up.

| Backend | CLI | Model | Effort | Target p95 | p95 | Target met | Within target | Met | Violations | Unassessed | Met before the event | Does not match the recording | Full latency p95 | Follow-up share |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| codex | 0.160.0 | gpt-6.1-sol | CLI default | 40.0 s | beyond the window (violation) | no | 88% | 42 of 48 | 6 | 0 | 6 | 4 | 646.3 s (45) | 0% (0) |

## Control events

| Recording | Event | Method | Outcome | Latency, s | Full, s | Follow-ups, s | Version | Author |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| codex/0.160.0/codex_exec/macos/workload-ledger | plan-written | predicate | after the window, violation | 646.3 | 646.3 | 0.0 | 27 | observer |
| codex/0.160.0/codex_exec/macos/workload-ledger | plan-ready | annotator | missed, violation | — | — | — | — | — |
| codex/0.160.0/codex_exec/macos/workload-ledger | parse-tested | predicate | met | 26.0 | 26.0 | 0.0 | 8 | observer |
| codex/0.160.0/codex_exec/macos/workload-ledger | parse-done | predicate | met | 20.8 | 20.8 | 0.0 | 8 | observer |
| codex/0.160.0/codex_exec/macos/workload-ledger | balances-tested | predicate | met | 20.8 | 20.8 | 0.0 | 12 | observer |
| codex/0.160.0/codex_exec/macos/workload-ledger | balances-done | predicate | met | 18.0 | 18.0 | 0.0 | 12 | observer |
| codex/0.160.0/codex_exec/macos/workload-ledger | conversion-tested | predicate | met | 23.6 | 23.7 | 0.0 | 16 | observer |
| codex/0.160.0/codex_exec/macos/workload-ledger | conversion-done | predicate | met | 19.4 | 19.4 | 0.0 | 16 | observer |
| codex/0.160.0/codex_exec/macos/workload-ledger | review-fixed | annotator | met | 15.1 | 15.1 | 0.0 | 25 | observer |
| codex/0.160.0/codex_exec/macos/workload-ledger | cli-tested | predicate | met | 19.2 | 19.3 | 0.0 | 29 | observer |
| codex/0.160.0/codex_exec/macos/workload-ledger | cli-done | predicate | met | 15.9 | 15.9 | 0.0 | 29 | observer |
| codex/0.160.0/codex_exec/macos/workload-ledger | export-tested | predicate | met before the event, annotation invalid | — | — | — | 35 | — |
| codex/0.160.0/codex_exec/macos/workload-ledger | export-done | predicate | met before the event, annotation invalid | — | — | — | 36 | — |
| codex/0.160.0/codex_exec/macos/workload-ledger | cents-planned | predicate | met before the event, annotation invalid | — | — | — | 41 | — |
| codex/0.160.0/codex_exec/macos/workload-ledger | cents-done | predicate | met | 20.6 | 20.6 | 0.0 | 44 | observer |
| codex/0.160.0/codex_exec/macos/workload-ledger | parallel-done | annotator | met | 31.5 | 31.5 | 0.0 | 52 | observer |
| codex/0.160.0/codex_exec/macos/workload-ledger | commit-done | annotator | description does not match the recording, annotation invalid | — | — | — | — | — |
| codex/0.160.0/codex_exec/macos/workload-ledger | final-tested | annotator | met | 22.6 | 22.6 | 0.0 | 59 | observer |
| codex/0.160.0/codex_exec/macos/workload-ledger | final-done | annotator | met | 12.7 | 12.7 | 0.0 | 60 | observer |
| codex/0.160.0/codex_exec/macos/workload-logstats | triage-tested | predicate | met | 18.9 | 18.9 | 0.0 | 4 | observer |
| codex/0.160.0/codex_exec/macos/workload-logstats | triage-done | predicate | met | 23.4 | 23.4 | 0.0 | 5 | observer |
| codex/0.160.0/codex_exec/macos/workload-logstats | plan-written | predicate | after the window, violation | 1024.4 | 1024.4 | 0.0 | 43 | observer |
| codex/0.160.0/codex_exec/macos/workload-logstats | plan-ready | annotator | missed, violation | — | — | — | — | — |
| codex/0.160.0/codex_exec/macos/workload-logstats | aggregate-tested | predicate | met | 24.8 | 24.8 | 0.0 | 12 | observer |
| codex/0.160.0/codex_exec/macos/workload-logstats | aggregate-done | predicate | met | 8.8 | 8.8 | 0.0 | 12 | observer |
| codex/0.160.0/codex_exec/macos/workload-logstats | big-log | annotator | met | 21.6 | 21.7 | 0.0 | 16 | observer |
| codex/0.160.0/codex_exec/macos/workload-logstats | generator-done | predicate | met | 14.5 | 14.5 | 0.0 | 16 | observer |
| codex/0.160.0/codex_exec/macos/workload-logstats | cli-tested | predicate | met | 8.7 | 8.7 | 0.0 | 20 | observer |
| codex/0.160.0/codex_exec/macos/workload-logstats | cli-done | predicate | met | 5.1 | 5.1 | 0.0 | 20 | observer |
| codex/0.160.0/codex_exec/macos/workload-logstats | report-tested | predicate | met before the event, annotation invalid | — | — | — | 24 | — |
| codex/0.160.0/codex_exec/macos/workload-logstats | report-done | predicate | met | 7.9 | 7.9 | 0.0 | 25 | observer |
| codex/0.160.0/codex_exec/macos/workload-logstats | review-fixed | annotator | met | 13.4 | 13.4 | 0.0 | 40 | observer |
| codex/0.160.0/codex_exec/macos/workload-logstats | streaming-tested | predicate | met | 28.1 | 28.1 | 0.0 | 49 | observer |
| codex/0.160.0/codex_exec/macos/workload-logstats | streaming-done | predicate | met | 21.5 | 21.5 | 0.0 | 49 | observer |
| codex/0.160.0/codex_exec/macos/workload-logstats | docs-done | annotator | met | 9.6 | 9.6 | 0.0 | 65 | observer |
| codex/0.160.0/codex_exec/macos/workload-logstats | commit-done | annotator | description does not match the recording, annotation invalid | — | — | — | — | — |
| codex/0.160.0/codex_exec/macos/workload-logstats | final-tested | annotator | met | 23.9 | 23.9 | 0.0 | 72 | observer |
| codex/0.160.0/codex_exec/macos/workload-logstats | final-done | annotator | met | 14.3 | 14.4 | 0.0 | 74 | observer |
| codex/0.160.0/codex_exec/macos/workload-kvstore | plan-written | predicate | after the window, violation | 817.2 | 817.3 | 0.0 | 33 | observer |
| codex/0.160.0/codex_exec/macos/workload-kvstore | plan-ready | annotator | missed, violation | — | — | — | — | — |
| codex/0.160.0/codex_exec/macos/workload-kvstore | log-tested | predicate | met | 22.0 | 22.0 | 0.0 | 9 | observer |
| codex/0.160.0/codex_exec/macos/workload-kvstore | log-done | predicate | met | 16.5 | 16.5 | 0.0 | 9 | observer |
| codex/0.160.0/codex_exec/macos/workload-kvstore | crash-tested | predicate | met before the event, annotation invalid | — | — | — | 11 | — |
| codex/0.160.0/codex_exec/macos/workload-kvstore | crash-done | predicate | met | 18.8 | 18.9 | 0.0 | 13 | observer |
| codex/0.160.0/codex_exec/macos/workload-kvstore | compaction-tested | predicate | met | 0.7 | 0.7 | 0.0 | 17 | observer |
| codex/0.160.0/codex_exec/macos/workload-kvstore | compaction-done | predicate | met | 11.4 | 11.4 | 0.0 | 18 | observer |
| codex/0.160.0/codex_exec/macos/workload-kvstore | batch-tested | predicate | met | 24.0 | 24.0 | 0.0 | 23 | observer |
| codex/0.160.0/codex_exec/macos/workload-kvstore | batch-done | predicate | met | 19.4 | 19.4 | 0.0 | 23 | observer |
| codex/0.160.0/codex_exec/macos/workload-kvstore | review-reported | annotator | met | 26.4 | 26.4 | 0.0 | 30 | observer |
| codex/0.160.0/codex_exec/macos/workload-kvstore | review-fixed | annotator | met | 16.6 | 16.6 | 0.0 | 31 | observer |
| codex/0.160.0/codex_exec/macos/workload-kvstore | cli-tested | predicate | met | 20.5 | 20.5 | 0.0 | 34 | observer |
| codex/0.160.0/codex_exec/macos/workload-kvstore | cli-done | predicate | met | 17.9 | 17.9 | 0.0 | 34 | observer |
| codex/0.160.0/codex_exec/macos/workload-kvstore | ttl-done | predicate | met | 22.0 | 22.0 | 0.0 | 43 | observer |
| codex/0.160.0/codex_exec/macos/workload-kvstore | parallel-reported | annotator | met | 24.7 | 24.7 | 0.0 | 51 | observer |
| codex/0.160.0/codex_exec/macos/workload-kvstore | parallel-done | annotator | met before the event, annotation invalid | — | — | — | — | — |
| codex/0.160.0/codex_exec/macos/workload-kvstore | commit-done | annotator | description does not match the recording, annotation invalid | — | — | — | — | — |
| codex/0.160.0/codex_exec/macos/workload-kvstore | final-tested | annotator | description does not match the recording, annotation invalid | — | — | — | — | — |
| codex/0.160.0/codex_exec/macos/workload-kvstore | final-done | annotator | met | 12.6 | 12.6 | 0.0 | 89 | observer |

## Observer

| Backend | Calls | Accepted | Rejected | Failed | With follow-up |
| --- | --- | --- | --- | --- | --- |
| codex | 213 | 212 | 1 | 0 | 0 |

| Backend | State | Time, s | Share |
| --- | --- | --- | --- |
| codex | ok | 8739.3 | 100% |

## Spending

Call spending comes from CLI data in the daemon call journal. A run hour is the sum of the durations of the played runs of the backend; an active hour is the time when at least one of its runs was in progress. Money is shown only for Claude, at list prices; under a subscription it is not a charge.

| Backend | Runs | Run hours | Active hours |
| --- | --- | --- | --- |
| codex | 3 | 1.36 | 0.95 |

| Backend | Journal | Calls | Uncached input | Cache read | Cache write | Output | Reasoning | Total tokens | Cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| codex | observer | 213 | 1,553,161 | 299,904 | 0 | 73,463 | 273 | 1,926,528 | — |
| codex | chat | 13 | 234,428 | 0 | 0 | 2,971 | 102 | 237,399 | — |
| codex | probes and auth status | 0 | 0 | 0 | 0 | 0 | 0 | 0 | — |

| Backend | Journal | Calls per run hour | Tokens per run hour | Cost per run hour | Calls per active hour | Tokens per active hour | Cost per active hour |
| --- | --- | --- | --- | --- | --- | --- | --- |
| codex | observer | 157.0 | 1,419,738 | — | 225.3 | 2,037,328 | — |
| codex | chat | 9.6 | 174,949 | — | 13.7 | 251,052 | — |

| Backend | Questions | Answers | Failed | Not asked | Insufficient data | Answer p50, s | Answer p95, s | Tokens per answer | Cost per answer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| codex | 9 | 9 | 0 | 0 | 4 | 11.4 | 21.6 | 26,378 | — |

Per the daemon spending accounting (U.1), active hours: 2; these are calendar hours with solver activity.
