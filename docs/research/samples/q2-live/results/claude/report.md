# Freshness measurement: claude-workload

- Workload profile fixed at 2026-10-07T19:24:28.585Z; the measurement started at 2026-10-07T19:24:41.525Z and lasted 3782.2 s.
- Measurement window 120.0 s, recording time scale 1.
- Daemon 0.0.0.

## Recordings

| Recording | Runtime | Start, s |
| --- | --- | --- |
| claude/2.1.292/claude_cli/macos/workload-ledger | claude | 0.0 |
| claude/2.1.292/claude_cli/macos/workload-logstats | claude | 300.0 |
| claude/2.1.292/claude_cli/macos/workload-kvstore | claude | 1407.9 |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | claude | 1618.2 |

## Backend summary

A violation is an expectation not met within the measurement window. p95 is computed over assessed events, with missed events counted as beyond the window. Events met before the event or not matching the recording are annotation defects and are excluded from p95. Full latency runs from the time of the event itself; the number in parentheses is the count of events with a known time. Follow-up share is the share of `needs` time in the latency of met events; the number in parentheses is the count of events with a follow-up.

| Backend | CLI | Model | Effort | Target p95 | p95 | Target met | Within target | Met | Violations | Unassessed | Met before the event | Does not match the recording | Full latency p95 | Follow-up share |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude | 2.1.293 | claude-opus-5-5 | CLI default | 30.0 s | 730.5 s | no | 66% | 60 of 65 | 5 | 0 | 13 | 11 | — | 0% (0) |

## Control events

| Recording | Event | Method | Outcome | Latency, s | Full, s | Follow-ups, s | Version | Author |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude/2.1.292/claude_cli/macos/workload-ledger | plan-written | predicate | after the window, violation | 534.8 | — | 0.0 | 60 | observer |
| claude/2.1.292/claude_cli/macos/workload-ledger | plan-ready | annotator | met | 29.8 | — | 0.0 | 5 | observer |
| claude/2.1.292/claude_cli/macos/workload-ledger | parse-tested | predicate | met | 39.5 | — | 0.0 | 11 | observer |
| claude/2.1.292/claude_cli/macos/workload-ledger | parse-done | predicate | met | 32.2 | — | 0.0 | 11 | observer |
| claude/2.1.292/claude_cli/macos/workload-ledger | balances-tested | predicate | met | 26.9 | — | 0.0 | 14 | observer |
| claude/2.1.292/claude_cli/macos/workload-ledger | balances-done | predicate | met | 20.6 | — | 0.0 | 14 | observer |
| claude/2.1.292/claude_cli/macos/workload-ledger | rounding-answered | annotator | met | 21.7 | — | 0.0 | 24 | observer |
| claude/2.1.292/claude_cli/macos/workload-ledger | conversion-tested | predicate | met before the event, annotation invalid | — | — | — | 24 | — |
| claude/2.1.292/claude_cli/macos/workload-ledger | conversion-done | predicate | met before the event, annotation invalid | — | — | — | 25 | — |
| claude/2.1.292/claude_cli/macos/workload-ledger | review-reported | annotator | met | 19.0 | — | 0.0 | 46 | observer |
| claude/2.1.292/claude_cli/macos/workload-ledger | review-fixed | annotator | met | 57.4 | — | 0.0 | 58 | observer |
| claude/2.1.292/claude_cli/macos/workload-ledger | cli-tested | predicate | met | 23.6 | — | 0.0 | 72 | observer |
| claude/2.1.292/claude_cli/macos/workload-ledger | cli-done | predicate | met | 41.2 | — | 0.0 | 73 | observer |
| claude/2.1.292/claude_cli/macos/workload-ledger | export-tested | predicate | met before the event, annotation invalid | — | — | — | 89 | — |
| claude/2.1.292/claude_cli/macos/workload-ledger | export-done | predicate | met before the event, annotation invalid | — | — | — | 92 | — |
| claude/2.1.292/claude_cli/macos/workload-ledger | cents-done | predicate | met before the event, annotation invalid | — | — | — | 113 | — |
| claude/2.1.292/claude_cli/macos/workload-ledger | parallel-reported | annotator | description does not match the recording, annotation invalid | — | — | — | — | — |
| claude/2.1.292/claude_cli/macos/workload-ledger | parallel-done | annotator | met | 43.2 | — | 0.0 | 137 | observer |
| claude/2.1.292/claude_cli/macos/workload-ledger | committed | annotator | met | 29.1 | — | 0.0 | 153 | observer |
| claude/2.1.292/claude_cli/macos/workload-ledger | commit-done | annotator | met | 25.5 | — | 0.0 | 153 | observer |
| claude/2.1.292/claude_cli/macos/workload-ledger | final-tested | annotator | description does not match the recording, annotation invalid | — | — | — | — | — |
| claude/2.1.292/claude_cli/macos/workload-ledger | final-done | annotator | met | 18.7 | — | 0.0 | 162 | observer |
| claude/2.1.292/claude_cli/macos/workload-logstats | triage-tested | predicate | met | 13.8 | — | 0.0 | 3 | observer |
| claude/2.1.292/claude_cli/macos/workload-logstats | triage-done | predicate | met | 10.2 | — | 0.0 | 3 | observer |
| claude/2.1.292/claude_cli/macos/workload-logstats | plan-written | predicate | met | 42.6 | — | 0.0 | 6 | observer |
| claude/2.1.292/claude_cli/macos/workload-logstats | plan-ready | annotator | missed, violation | — | — | — | — | — |
| claude/2.1.292/claude_cli/macos/workload-logstats | aggregate-tested | predicate | met | 18.0 | — | 0.0 | 10 | observer |
| claude/2.1.292/claude_cli/macos/workload-logstats | aggregate-done | predicate | met | 27.8 | — | 0.0 | 11 | observer |
| claude/2.1.292/claude_cli/macos/workload-logstats | big-log | annotator | met | 14.5 | — | 0.0 | 17 | observer |
| claude/2.1.292/claude_cli/macos/workload-logstats | generator-done | predicate | met | 21.0 | — | 0.0 | 19 | observer |
| claude/2.1.292/claude_cli/macos/workload-logstats | cli-tested | predicate | met | 39.0 | — | 0.0 | 28 | observer |
| claude/2.1.292/claude_cli/macos/workload-logstats | cli-done | predicate | met | 31.7 | — | 0.0 | 28 | observer |
| claude/2.1.292/claude_cli/macos/workload-logstats | format-answered | annotator | met | 11.4 | — | 0.0 | 37 | observer |
| claude/2.1.292/claude_cli/macos/workload-logstats | report-tested | predicate | met before the event, annotation invalid | — | — | — | 40 | — |
| claude/2.1.292/claude_cli/macos/workload-logstats | report-done | predicate | met | 34.4 | — | 0.0 | 44 | observer |
| claude/2.1.292/claude_cli/macos/workload-logstats | review-reported | annotator | met | 14.1 | — | 0.0 | 75 | observer |
| claude/2.1.292/claude_cli/macos/workload-logstats | review-fixed | annotator | description does not match the recording, annotation invalid | — | — | — | — | — |
| claude/2.1.292/claude_cli/macos/workload-logstats | streaming-tested | predicate | met | 19.0 | — | 0.0 | 107 | observer |
| claude/2.1.292/claude_cli/macos/workload-logstats | streaming-done | predicate | met | 18.1 | — | 0.0 | 108 | observer |
| claude/2.1.292/claude_cli/macos/workload-logstats | docs-reported | annotator | met | 23.3 | — | 0.0 | 134 | observer |
| claude/2.1.292/claude_cli/macos/workload-logstats | docs-done | annotator | description does not match the recording, annotation invalid | — | — | — | — | — |
| claude/2.1.292/claude_cli/macos/workload-logstats | committed | annotator | met | 22.0 | — | 0.0 | 149 | observer |
| claude/2.1.292/claude_cli/macos/workload-logstats | commit-done | annotator | met | 16.9 | — | 0.0 | 149 | observer |
| claude/2.1.292/claude_cli/macos/workload-logstats | final-tested | annotator | description does not match the recording, annotation invalid | — | — | — | — | — |
| claude/2.1.292/claude_cli/macos/workload-logstats | final-done | annotator | met | 16.9 | — | 0.0 | 154 | observer |
| claude/2.1.292/claude_cli/macos/workload-kvstore | plan-written | predicate | after the window, violation | 730.5 | — | 0.0 | 80 | observer |
| claude/2.1.292/claude_cli/macos/workload-kvstore | plan-ready | annotator | missed, violation | — | — | — | — | — |
| claude/2.1.292/claude_cli/macos/workload-kvstore | log-tested | predicate | met | 16.8 | — | 0.0 | 9 | observer |
| claude/2.1.292/claude_cli/macos/workload-kvstore | log-done | predicate | met | 32.6 | — | 0.0 | 10 | observer |
| claude/2.1.292/claude_cli/macos/workload-kvstore | crash-tested | predicate | met before the event, annotation invalid | — | — | — | 11 | — |
| claude/2.1.292/claude_cli/macos/workload-kvstore | crash-done | predicate | met | 23.1 | — | 0.0 | 13 | observer |
| claude/2.1.292/claude_cli/macos/workload-kvstore | durability-answered | annotator | met | 11.3 | — | 0.0 | 21 | observer |
| claude/2.1.292/claude_cli/macos/workload-kvstore | compaction-tested | predicate | met before the event, annotation invalid | — | — | — | 22 | — |
| claude/2.1.292/claude_cli/macos/workload-kvstore | compaction-done | predicate | met | 22.9 | — | 0.0 | 25 | observer |
| claude/2.1.292/claude_cli/macos/workload-kvstore | batch-tested | predicate | met | 19.7 | — | 0.0 | 29 | observer |
| claude/2.1.292/claude_cli/macos/workload-kvstore | batch-done | predicate | met | 27.7 | — | 0.0 | 30 | observer |
| claude/2.1.292/claude_cli/macos/workload-kvstore | review-reported | annotator | met | 13.6 | — | 0.0 | 53 | observer |
| claude/2.1.292/claude_cli/macos/workload-kvstore | review-fixed | annotator | met | 30.7 | — | 0.0 | 78 | observer |
| claude/2.1.292/claude_cli/macos/workload-kvstore | cli-tested | predicate | met | 24.2 | — | 0.0 | 90 | observer |
| claude/2.1.292/claude_cli/macos/workload-kvstore | cli-done | predicate | met | 29.4 | — | 0.0 | 91 | observer |
| claude/2.1.292/claude_cli/macos/workload-kvstore | ttl-planned | predicate | met before the event, annotation invalid | — | — | — | 97 | — |
| claude/2.1.292/claude_cli/macos/workload-kvstore | ttl-done | predicate | met before the event, annotation invalid | — | — | — | 112 | — |
| claude/2.1.292/claude_cli/macos/workload-kvstore | parallel-reported | annotator | description does not match the recording, annotation invalid | — | — | — | — | — |
| claude/2.1.292/claude_cli/macos/workload-kvstore | parallel-done | annotator | met | 5.5 | — | 0.0 | 196 | observer |
| claude/2.1.292/claude_cli/macos/workload-kvstore | committed | annotator | met | 30.8 | — | 0.0 | 206 | observer |
| claude/2.1.292/claude_cli/macos/workload-kvstore | commit-done | annotator | met | 24.9 | — | 0.0 | 206 | observer |
| claude/2.1.292/claude_cli/macos/workload-kvstore | final-tested | annotator | description does not match the recording, annotation invalid | — | — | — | — | — |
| claude/2.1.292/claude_cli/macos/workload-kvstore | final-done | annotator | met | 18.0 | — | 0.0 | 217 | observer |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | explore-done | annotator | met | 31.8 | — | 0.0 | 4 | observer |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | plan-written | predicate | met | 51.0 | — | 0.0 | 8 | observer |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | plan-ready | annotator | missed, violation | — | — | — | — | — |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | extract-tested | predicate | met | 28.4 | — | 0.0 | 14 | observer |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | extract-done | predicate | met | 16.7 | — | 0.0 | 14 | observer |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | check-tested | predicate | met before the event, annotation invalid | — | — | — | 24 | — |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | check-done | predicate | met | 22.6 | — | 0.0 | 29 | observer |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | slugs-answered | annotator | description does not match the recording, annotation invalid | — | — | — | — | — |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | report-tested | predicate | met | 29.2 | — | 0.0 | 46 | observer |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | report-done | predicate | met | 19.8 | — | 0.0 | 46 | observer |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | review-reported | annotator | met | 16.7 | — | 0.0 | 85 | observer |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | review-fixed | annotator | met | 27.3 | — | 0.0 | 99 | observer |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | fix-tested | predicate | met before the event, annotation invalid | — | — | — | 132 | — |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | fix-done | predicate | met | 12.6 | — | 0.0 | 139 | observer |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | json-done | predicate | met before the event, annotation invalid | — | — | — | 162 | — |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | docs-reported | annotator | description does not match the recording, annotation invalid | — | — | — | — | — |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | docs-done | annotator | description does not match the recording, annotation invalid | — | — | — | — | — |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | committed | annotator | met | 96.1 | — | 0.0 | 226 | observer |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | commit-done | annotator | met | 92.3 | — | 0.0 | 226 | observer |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | final-tested | annotator | description does not match the recording, annotation invalid | — | — | — | — | — |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | final-done | annotator | met | 38.2 | — | 0.0 | 228 | observer |

## Observer

| Backend | Calls | Accepted | Rejected | Failed | With follow-up |
| --- | --- | --- | --- | --- | --- |
| claude | 316 | 313 | 3 | 0 | 0 |

| Backend | State | Time, s | Share |
| --- | --- | --- | --- |
| claude | ok | 11801.0 | 100% |

## Spending

Call spending comes from CLI data in the daemon call journal. A run hour is the sum of the durations of the played runs of the backend; an active hour is the time when at least one of its runs was in progress. Money is shown only for Claude, at list prices; under a subscription it is not a charge.

| Backend | Runs | Run hours | Active hours |
| --- | --- | --- | --- |
| claude | 4 | 1.77 | 1.02 |

| Backend | Journal | Calls | Uncached input | Cache read | Cache write | Output | Reasoning | Total tokens | Cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude | observer | 316 | 632 | 2,853,164 | 4,709,051 | 386,049 | 66,211 | 7,948,896 | $46.46 |
| claude | chat | 12 | 22 | 57,430 | 282,880 | 22,298 | 3,409 | 362,630 | $2.75 |
| claude | probes and auth status | 0 | 0 | 0 | 0 | 0 | 0 | 0 | — |

| Backend | Journal | Calls per run hour | Tokens per run hour | Cost per run hour | Calls per active hour | Tokens per active hour | Cost per active hour |
| --- | --- | --- | --- | --- | --- | --- | --- |
| claude | observer | 178.8 | 4,497,272 | $26.28 | 310.7 | 7,815,078 | $45.67 |
| claude | chat | 6.8 | 205,166 | $1.56 | 11.8 | 356,525 | $2.70 |

| Backend | Questions | Answers | Failed | Not asked | Insufficient data | Answer p50, s | Answer p95, s | Tokens per answer | Cost per answer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude | 12 | 11 | 1 | 0 | 0 | 21.2 | 36.0 | 32,966 | $0.25 |

Per the daemon spending accounting (U.1), active hours: 2; these are calendar hours with solver activity.
