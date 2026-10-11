# Freshness measurement: claude-workload-low-parallel

- Workload profile fixed at 2026-10-08T18:10:22.380Z; the measurement started at 2026-10-08T18:29:28.770Z and lasted 3782.2 s.
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
| claude | 2.1.293 | claude-opus-5-5 | low | 30.0 s | 34.9 s | no | 90% | 67 of 67 | 0 | 0 | 11 | 11 | — | 2% (1) |

## Control events

| Recording | Event | Method | Outcome | Latency, s | Full, s | Follow-ups, s | Version | Author |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude/2.1.292/claude_cli/macos/workload-ledger | plan-written | predicate | met | 36.1 | — | 0.0 | 5 | observer |
| claude/2.1.292/claude_cli/macos/workload-ledger | plan-ready | annotator | met | 29.6 | — | 0.0 | 5 | observer |
| claude/2.1.292/claude_cli/macos/workload-ledger | parse-tested | predicate | met | 34.9 | — | 0.0 | 10 | observer |
| claude/2.1.292/claude_cli/macos/workload-ledger | parse-done | predicate | met | 27.6 | — | 0.0 | 10 | observer |
| claude/2.1.292/claude_cli/macos/workload-ledger | balances-tested | predicate | met | 32.1 | — | 0.0 | 12 | observer |
| claude/2.1.292/claude_cli/macos/workload-ledger | balances-done | predicate | met | 25.8 | — | 0.0 | 12 | observer |
| claude/2.1.292/claude_cli/macos/workload-ledger | rounding-answered | annotator | met | 11.7 | — | 0.0 | 22 | observer |
| claude/2.1.292/claude_cli/macos/workload-ledger | conversion-tested | predicate | met before the event, annotation invalid | — | — | — | 24 | — |
| claude/2.1.292/claude_cli/macos/workload-ledger | conversion-done | predicate | met before the event, annotation invalid | — | — | — | 25 | — |
| claude/2.1.292/claude_cli/macos/workload-ledger | review-reported | annotator | met | 12.3 | — | 0.0 | 46 | observer |
| claude/2.1.292/claude_cli/macos/workload-ledger | review-fixed | annotator | met | 10.5 | — | 0.0 | 61 | observer |
| claude/2.1.292/claude_cli/macos/workload-ledger | cli-tested | predicate | met | 14.7 | — | 0.0 | 77 | observer |
| claude/2.1.292/claude_cli/macos/workload-ledger | cli-done | predicate | met | 14.0 | — | 0.0 | 78 | observer |
| claude/2.1.292/claude_cli/macos/workload-ledger | export-tested | predicate | met before the event, annotation invalid | — | — | — | 94 | — |
| claude/2.1.292/claude_cli/macos/workload-ledger | export-done | predicate | met before the event, annotation invalid | — | — | — | 98 | — |
| claude/2.1.292/claude_cli/macos/workload-ledger | cents-done | predicate | met | 17.7 | — | 0.0 | 122 | observer |
| claude/2.1.292/claude_cli/macos/workload-ledger | parallel-reported | annotator | description does not match the recording, annotation invalid | — | — | — | — | — |
| claude/2.1.292/claude_cli/macos/workload-ledger | parallel-done | annotator | met | 2.9 | — | 0.0 | 146 | observer |
| claude/2.1.292/claude_cli/macos/workload-ledger | committed | annotator | met | 22.4 | — | 0.0 | 165 | observer |
| claude/2.1.292/claude_cli/macos/workload-ledger | commit-done | annotator | met | 18.8 | — | 0.0 | 165 | observer |
| claude/2.1.292/claude_cli/macos/workload-ledger | final-tested | annotator | description does not match the recording, annotation invalid | — | — | — | — | — |
| claude/2.1.292/claude_cli/macos/workload-ledger | final-done | annotator | met | 13.3 | — | 0.0 | 174 | observer |
| claude/2.1.292/claude_cli/macos/workload-logstats | triage-tested | predicate | met | 9.7 | — | 0.0 | 3 | observer |
| claude/2.1.292/claude_cli/macos/workload-logstats | triage-done | predicate | met | 6.1 | — | 0.0 | 3 | observer |
| claude/2.1.292/claude_cli/macos/workload-logstats | plan-written | predicate | met | 22.7 | — | 17.9 | 6 | observer |
| claude/2.1.292/claude_cli/macos/workload-logstats | plan-ready | annotator | met | 16.4 | — | 0.0 | 7 | observer |
| claude/2.1.292/claude_cli/macos/workload-logstats | aggregate-tested | predicate | met | 20.1 | — | 0.0 | 14 | observer |
| claude/2.1.292/claude_cli/macos/workload-logstats | aggregate-done | predicate | met | 11.8 | — | 0.0 | 14 | observer |
| claude/2.1.292/claude_cli/macos/workload-logstats | big-log | annotator | met | 16.8 | — | 0.0 | 22 | observer |
| claude/2.1.292/claude_cli/macos/workload-logstats | generator-done | predicate | met | 4.8 | — | 0.0 | 22 | observer |
| claude/2.1.292/claude_cli/macos/workload-logstats | cli-tested | predicate | met | 28.5 | — | 0.0 | 32 | observer |
| claude/2.1.292/claude_cli/macos/workload-logstats | cli-done | predicate | met | 21.3 | — | 0.0 | 32 | observer |
| claude/2.1.292/claude_cli/macos/workload-logstats | format-answered | annotator | met | 11.4 | — | 0.0 | 43 | observer |
| claude/2.1.292/claude_cli/macos/workload-logstats | report-tested | predicate | met | 18.1 | — | 0.0 | 47 | observer |
| claude/2.1.292/claude_cli/macos/workload-logstats | report-done | predicate | met | 7.3 | — | 0.0 | 47 | observer |
| claude/2.1.292/claude_cli/macos/workload-logstats | review-reported | annotator | met | 6.0 | — | 0.0 | 84 | observer |
| claude/2.1.292/claude_cli/macos/workload-logstats | review-fixed | annotator | description does not match the recording, annotation invalid | — | — | — | — | — |
| claude/2.1.292/claude_cli/macos/workload-logstats | streaming-tested | predicate | met | 34.8 | — | 0.0 | 124 | observer |
| claude/2.1.292/claude_cli/macos/workload-logstats | streaming-done | predicate | met | 17.1 | — | 0.0 | 124 | observer |
| claude/2.1.292/claude_cli/macos/workload-logstats | docs-reported | annotator | met | 4.2 | — | 0.0 | 145 | observer |
| claude/2.1.292/claude_cli/macos/workload-logstats | docs-done | annotator | description does not match the recording, annotation invalid | — | — | — | — | — |
| claude/2.1.292/claude_cli/macos/workload-logstats | committed | annotator | met | 9.4 | — | 0.0 | 166 | observer |
| claude/2.1.292/claude_cli/macos/workload-logstats | commit-done | annotator | met | 4.2 | — | 0.0 | 166 | observer |
| claude/2.1.292/claude_cli/macos/workload-logstats | final-tested | annotator | description does not match the recording, annotation invalid | — | — | — | — | — |
| claude/2.1.292/claude_cli/macos/workload-logstats | final-done | annotator | met | 17.2 | — | 0.0 | 171 | observer |
| claude/2.1.292/claude_cli/macos/workload-kvstore | plan-written | predicate | met | 33.4 | — | 0.0 | 5 | observer |
| claude/2.1.292/claude_cli/macos/workload-kvstore | plan-ready | annotator | met | 26.8 | — | 0.0 | 5 | observer |
| claude/2.1.292/claude_cli/macos/workload-kvstore | log-tested | predicate | met | 13.7 | — | 0.0 | 9 | observer |
| claude/2.1.292/claude_cli/macos/workload-kvstore | log-done | predicate | met | 7.8 | — | 0.0 | 9 | observer |
| claude/2.1.292/claude_cli/macos/workload-kvstore | crash-tested | predicate | met before the event, annotation invalid | — | — | — | 11 | — |
| claude/2.1.292/claude_cli/macos/workload-kvstore | crash-done | predicate | met | 11.4 | — | 0.0 | 13 | observer |
| claude/2.1.292/claude_cli/macos/workload-kvstore | durability-answered | annotator | met | 12.4 | — | 0.0 | 22 | observer |
| claude/2.1.292/claude_cli/macos/workload-kvstore | compaction-tested | predicate | met | 13.0 | — | 0.0 | 26 | observer |
| claude/2.1.292/claude_cli/macos/workload-kvstore | compaction-done | predicate | met | 6.3 | — | 0.0 | 26 | observer |
| claude/2.1.292/claude_cli/macos/workload-kvstore | batch-tested | predicate | met | 13.4 | — | 0.0 | 31 | observer |
| claude/2.1.292/claude_cli/macos/workload-kvstore | batch-done | predicate | met | 7.9 | — | 0.0 | 31 | observer |
| claude/2.1.292/claude_cli/macos/workload-kvstore | review-reported | annotator | met | 11.5 | — | 0.0 | 57 | observer |
| claude/2.1.292/claude_cli/macos/workload-kvstore | review-fixed | annotator | met | 26.3 | — | 0.0 | 83 | observer |
| claude/2.1.292/claude_cli/macos/workload-kvstore | cli-tested | predicate | met | 13.1 | — | 0.0 | 94 | observer |
| claude/2.1.292/claude_cli/macos/workload-kvstore | cli-done | predicate | met | 0.5 | — | 0.0 | 94 | observer |
| claude/2.1.292/claude_cli/macos/workload-kvstore | ttl-planned | predicate | met before the event, annotation invalid | — | — | — | 101 | — |
| claude/2.1.292/claude_cli/macos/workload-kvstore | ttl-done | predicate | met before the event, annotation invalid | — | — | — | 117 | — |
| claude/2.1.292/claude_cli/macos/workload-kvstore | parallel-reported | annotator | description does not match the recording, annotation invalid | — | — | — | — | — |
| claude/2.1.292/claude_cli/macos/workload-kvstore | parallel-done | annotator | met before the event, annotation invalid | — | — | — | — | — |
| claude/2.1.292/claude_cli/macos/workload-kvstore | committed | annotator | met | 12.7 | — | 0.0 | 217 | observer |
| claude/2.1.292/claude_cli/macos/workload-kvstore | commit-done | annotator | met | 6.8 | — | 0.0 | 217 | observer |
| claude/2.1.292/claude_cli/macos/workload-kvstore | final-tested | annotator | description does not match the recording, annotation invalid | — | — | — | — | — |
| claude/2.1.292/claude_cli/macos/workload-kvstore | final-done | annotator | met | 11.9 | — | 0.0 | 229 | observer |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | explore-done | annotator | met | 12.7 | — | 0.0 | 4 | observer |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | plan-written | predicate | met | 57.6 | — | 0.0 | 8 | observer |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | plan-ready | annotator | met | 52.1 | — | 0.0 | 9 | observer |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | extract-tested | predicate | met | 17.3 | — | 0.0 | 14 | observer |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | extract-done | predicate | met | 5.6 | — | 0.0 | 14 | observer |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | check-tested | predicate | met before the event, annotation invalid | — | — | — | 27 | — |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | check-done | predicate | met | 10.1 | — | 0.0 | 32 | observer |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | slugs-answered | annotator | description does not match the recording, annotation invalid | — | — | — | — | — |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | report-tested | predicate | met before the event, annotation invalid | — | — | — | 47 | — |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | report-done | predicate | met before the event, annotation invalid | — | — | — | 52 | — |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | review-reported | annotator | met | 10.2 | — | 0.0 | 91 | observer |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | review-fixed | annotator | met | 9.3 | — | 0.0 | 106 | observer |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | fix-tested | predicate | met | 23.6 | — | 0.0 | 147 | observer |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | fix-done | predicate | met | 5.7 | — | 0.0 | 147 | observer |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | json-done | predicate | met | 14.8 | — | 0.0 | 173 | observer |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | docs-reported | annotator | description does not match the recording, annotation invalid | — | — | — | — | — |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | docs-done | annotator | description does not match the recording, annotation invalid | — | — | — | — | — |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | committed | annotator | met | 20.4 | — | 0.0 | 231 | observer |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | commit-done | annotator | met | 16.6 | — | 0.0 | 231 | observer |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | final-tested | annotator | description does not match the recording, annotation invalid | — | — | — | — | — |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | final-done | annotator | met | 7.6 | — | 0.0 | 240 | observer |

## Observer

| Backend | Calls | Accepted | Rejected | Failed | With follow-up |
| --- | --- | --- | --- | --- | --- |
| claude | 369 | 358 | 11 | 0 | 4 |

| Backend | State | Time, s | Share |
| --- | --- | --- | --- |
| claude | ok | 11800.6 | 100% |

## Spending

Call spending comes from CLI data in the daemon call journal. A run hour is the sum of the durations of the played runs of the backend; an active hour is the time when at least one of its runs was in progress. Money is shown only for Claude, at list prices; under a subscription it is not a charge.

| Backend | Runs | Run hours | Active hours |
| --- | --- | --- | --- |
| claude | 4 | 1.77 | 1.02 |

| Backend | Journal | Calls | Uncached input | Cache read | Cache write | Output | Reasoning | Total tokens | Cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude | observer | 369 | 752 | 3,530,729 | 4,426,079 | 247,552 | 7,111 | 8,205,112 | $41.53 |
| claude | chat | 12 | 24 | 63,173 | 291,441 | 13,239 | 647 | 367,877 | $2.64 |
| claude | probes and auth status | 0 | 0 | 0 | 0 | 0 | 0 | 0 | — |

| Backend | Journal | Calls per run hour | Tokens per run hour | Cost per run hour | Calls per active hour | Tokens per active hour | Cost per active hour |
| --- | --- | --- | --- | --- | --- | --- | --- |
| claude | observer | 208.8 | 4,642,259 | $23.50 | 362.8 | 8,067,023 | $40.83 |
| claude | chat | 6.8 | 208,136 | $1.49 | 11.8 | 361,686 | $2.60 |

| Backend | Questions | Answers | Failed | Not asked | Insufficient data | Answer p50, s | Answer p95, s | Tokens per answer | Cost per answer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude | 12 | 12 | 0 | 0 | 0 | 12.6 | 19.4 | 30,656 | $0.22 |

Per the daemon spending accounting (U.1), active hours: 2; these are calendar hours with solver activity.
