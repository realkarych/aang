# Freshness measurement: claude-workload-low

- Workload profile fixed at 2026-10-07T20:31:55.081Z; the measurement started at 2026-10-07T20:32:07.931Z and lasted 3001.5 s.
- Measurement window 120.0 s, recording time scale 1.
- Daemon 0.0.0.

## Recordings

| Recording | Runtime | Start, s |
| --- | --- | --- |
| claude/2.1.292/claude_cli/macos/workload-logstats | claude | 0.0 |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | claude | 1318.2 |

## Backend summary

A violation is an expectation not met within the measurement window. p95 is computed over assessed events, with missed events counted as beyond the window. Events met before the event or not matching the recording are annotation defects and are excluded from p95. Full latency runs from the time of the event itself; the number in parentheses is the count of events with a known time. Follow-up share is the share of `needs` time in the latency of met events; the number in parentheses is the count of events with a follow-up.

| Backend | CLI | Model | Effort | Target p95 | p95 | Target met | Within target | Met | Violations | Unassessed | Met before the event | Does not match the recording | Full latency p95 | Follow-up share |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude | 2.1.293 | claude-opus-5-5 | low | 30.0 s | beyond the window (violation) | no | 91% | 32 of 34 | 2 | 0 | 3 | 7 | — | 0% (0) |

## Control events

| Recording | Event | Method | Outcome | Latency, s | Full, s | Follow-ups, s | Version | Author |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude/2.1.292/claude_cli/macos/workload-logstats | triage-tested | predicate | met | 9.1 | — | 0.0 | 3 | observer |
| claude/2.1.292/claude_cli/macos/workload-logstats | triage-done | predicate | met | 5.5 | — | 0.0 | 3 | observer |
| claude/2.1.292/claude_cli/macos/workload-logstats | plan-written | predicate | met | 32.8 | — | 0.0 | 7 | observer |
| claude/2.1.292/claude_cli/macos/workload-logstats | plan-ready | annotator | missed, violation | — | — | — | — | — |
| claude/2.1.292/claude_cli/macos/workload-logstats | aggregate-tested | predicate | met | 22.2 | — | 0.0 | 16 | observer |
| claude/2.1.292/claude_cli/macos/workload-logstats | aggregate-done | predicate | met | 13.9 | — | 0.0 | 16 | observer |
| claude/2.1.292/claude_cli/macos/workload-logstats | big-log | annotator | met | 16.9 | — | 0.0 | 24 | observer |
| claude/2.1.292/claude_cli/macos/workload-logstats | generator-done | predicate | met | 13.2 | — | 0.0 | 25 | observer |
| claude/2.1.292/claude_cli/macos/workload-logstats | cli-tested | predicate | met | 13.7 | — | 0.0 | 34 | observer |
| claude/2.1.292/claude_cli/macos/workload-logstats | cli-done | predicate | met | 6.4 | — | 0.0 | 34 | observer |
| claude/2.1.292/claude_cli/macos/workload-logstats | format-answered | annotator | met | 11.0 | — | 0.0 | 44 | observer |
| claude/2.1.292/claude_cli/macos/workload-logstats | report-tested | predicate | met | 13.8 | — | 0.0 | 49 | observer |
| claude/2.1.292/claude_cli/macos/workload-logstats | report-done | predicate | met | 3.0 | — | 0.0 | 49 | observer |
| claude/2.1.292/claude_cli/macos/workload-logstats | review-reported | annotator | met | 19.7 | — | 0.0 | 83 | observer |
| claude/2.1.292/claude_cli/macos/workload-logstats | review-fixed | annotator | description does not match the recording, annotation invalid | — | — | — | — | — |
| claude/2.1.292/claude_cli/macos/workload-logstats | streaming-tested | predicate | met | 12.6 | — | 0.0 | 118 | observer |
| claude/2.1.292/claude_cli/macos/workload-logstats | streaming-done | predicate | met before the event, annotation invalid | — | — | — | 118 | — |
| claude/2.1.292/claude_cli/macos/workload-logstats | docs-reported | annotator | met | 14.4 | — | 0.0 | 143 | observer |
| claude/2.1.292/claude_cli/macos/workload-logstats | docs-done | annotator | description does not match the recording, annotation invalid | — | — | — | — | — |
| claude/2.1.292/claude_cli/macos/workload-logstats | committed | annotator | met | 10.2 | — | 0.0 | 161 | observer |
| claude/2.1.292/claude_cli/macos/workload-logstats | commit-done | annotator | met | 5.0 | — | 0.0 | 161 | observer |
| claude/2.1.292/claude_cli/macos/workload-logstats | final-tested | annotator | description does not match the recording, annotation invalid | — | — | — | — | — |
| claude/2.1.292/claude_cli/macos/workload-logstats | final-done | annotator | met | 11.5 | — | 0.0 | 166 | observer |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | explore-done | annotator | met | 19.7 | — | 0.0 | 5 | observer |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | plan-written | predicate | met | 29.2 | — | 0.0 | 8 | observer |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | plan-ready | annotator | missed, violation | — | — | — | — | — |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | extract-tested | predicate | met | 21.7 | — | 0.0 | 14 | observer |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | extract-done | predicate | met | 10.0 | — | 0.0 | 14 | observer |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | check-tested | predicate | met before the event, annotation invalid | — | — | — | 28 | — |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | check-done | predicate | met | 6.2 | — | 0.0 | 33 | observer |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | slugs-answered | annotator | description does not match the recording, annotation invalid | — | — | — | — | — |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | report-tested | predicate | met | 7.9 | — | 0.0 | 52 | observer |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | report-done | predicate | met | 9.3 | — | 0.0 | 54 | observer |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | review-reported | annotator | met | 9.0 | — | 0.0 | 92 | observer |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | review-fixed | annotator | met | 12.1 | — | 0.0 | 107 | observer |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | fix-tested | predicate | met before the event, annotation invalid | — | — | — | 140 | — |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | fix-done | predicate | met | 5.5 | — | 0.0 | 149 | observer |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | json-done | predicate | met | 8.7 | — | 0.0 | 175 | observer |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | docs-reported | annotator | description does not match the recording, annotation invalid | — | — | — | — | — |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | docs-done | annotator | description does not match the recording, annotation invalid | — | — | — | — | — |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | committed | annotator | met | 22.8 | — | 0.0 | 235 | observer |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | commit-done | annotator | met | 19.1 | — | 0.0 | 235 | observer |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | final-tested | annotator | description does not match the recording, annotation invalid | — | — | — | — | — |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | final-done | annotator | met | 29.7 | — | 0.0 | 243 | observer |

## Observer

| Backend | Calls | Accepted | Rejected | Failed | With follow-up |
| --- | --- | --- | --- | --- | --- |
| claude | 175 | 170 | 5 | 0 | 0 |

| Backend | State | Time, s | Share |
| --- | --- | --- | --- |
| claude | ok | 4683.8 | 100% |

## Spending

Call spending comes from CLI data in the daemon call journal. A run hour is the sum of the durations of the played runs of the backend; an active hour is the time when at least one of its runs was in progress. Money is shown only for Claude, at list prices; under a subscription it is not a charge.

| Backend | Runs | Run hours | Active hours |
| --- | --- | --- | --- |
| claude | 2 | 0.78 | 0.78 |

| Backend | Journal | Calls | Uncached input | Cache read | Cache write | Output | Reasoning | Total tokens | Cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude | observer | 175 | 350 | 1,580,075 | 2,207,838 | 117,551 | 2,965 | 3,905,814 | $20.56 |
| claude | chat | 6 | 16 | 63,337 | 146,264 | 6,738 | 207 | 216,355 | $1.33 |
| claude | probes and auth status | 0 | 0 | 0 | 0 | 0 | 0 | 0 | — |

| Backend | Journal | Calls per run hour | Tokens per run hour | Cost per run hour | Calls per active hour | Tokens per active hour | Cost per active hour |
| --- | --- | --- | --- | --- | --- | --- | --- |
| claude | observer | 225.7 | 5,037,380 | $26.52 | 225.7 | 5,037,380 | $26.52 |
| claude | chat | 7.7 | 279,036 | $1.72 | 7.7 | 279,036 | $1.72 |

| Backend | Questions | Answers | Failed | Not asked | Insufficient data | Answer p50, s | Answer p95, s | Tokens per answer | Cost per answer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude | 6 | 6 | 0 | 0 | 0 | 11.9 | 14.6 | 36,059 | $0.22 |

Per the daemon spending accounting (U.1), active hours: 2; these are calendar hours with solver activity.
