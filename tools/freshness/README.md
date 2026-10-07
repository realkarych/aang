# Freshness measurement (Q.2)

`tools/freshness` measures how fast the semantic map catches up with the run, as ADR-0007 («Бюджет свежести») and RFC §8 define it. It replays reference recordings (ADR-0010) into a real daemon with a real or a fake observer CLI, times every control event of their manifests until the expected map change, and writes a report.

Build with `pnpm build`. A measurement is three steps in one directory:

```sh
node tools/freshness/dist/main.js fix <profile.json> <directory> [--fixtures <directory>]
node tools/freshness/dist/main.js run <directory> [--fixtures <directory>] [--daemon <aang main.js>] [--hook <aang-hook>]
node tools/freshness/dist/main.js report <directory>
```

`--fixtures` defaults to `fixtures/sessions`, `--daemon` to `packages/aang/dist/main.js`, `--hook` to the built `aang-hook`.

## Load profile

The load profile is fixed before the measurement. `fix` validates it, loads every recording and writes `<directory>/profile.json` with the profile, the time of fixation and a SHA-256 digest of each recording directory. A fixed profile is never overwritten. `run` refuses to start when a recording, its markup included, no longer matches its digest, and `report` refuses a measurement made with another `profile.json`.

```json
{
  "format": "aang-freshness-profile/1",
  "name": "claude-parallel",
  "time_scale": 1,
  "window_ms": 120000,
  "observer": {
    "claude": { "cli": null, "model": null, "effort": null, "target_p95_ms": 30000 },
    "codex": { "cli": null, "model": null, "effort": null, "target_p95_ms": 40000 }
  },
  "runs": [
    { "recording": "claude/2.1.289/claude_cli/macos/tools", "start_ms": 0, "chat": [{ "after_ms": 4000, "question": "What is the run doing now?" }] },
    { "recording": "codex/0.160.0/codex_exec/macos/subagents", "start_ms": 5000 }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `time_scale` | Player time scale: 1 replays the recorded intervals, 2 replays them twice as slow; default 1 |
| `window_ms` | Measurement window: an expectation not met within it after its event is a violation |
| `observer.<runtime>` | Observer of the runs of that runtime: absolute CLI path (`null` finds it on `PATH`), model and effort (`null` keeps the daemon defaults) and the p95 target. Every runtime of the recordings needs an entry; a runtime without one has no observer in the measurement |
| `runs` | Recordings under `--fixtures`, each played once, starting `start_ms` after the measurement starts. Overlapping runs are the parallel load |
| `runs[].chat` | Chat questions of the run: each is asked `after_ms` after the recording starts, in the run of the recording; default none |

A recording without control events only adds load. A profile without any control event, a recording played twice and a control event on a step other than `hook`, `append` or `write` are refused.

## Markup of control events

Each control event of a manifest has an `expected_map_change` with a `description`. An optional `predicate` over the model makes the event measurable without an annotator; the other events are judged by the annotator.

A predicate holds when the model has an entity that matches every given field. Text fields are regular expressions (`u` flag), lists allow any of their values, and `"evidence": "event"` requires the entity to cite a fact made from the control event's own records.

| Predicate | Fields |
| --- | --- |
| `{ "stage": … }` | `title`, `lifecycle` (`active`, `replaced`, `merged`, `split`), `execution` (execution states), `output` (path, URL or commit of an output artifact), `evidence` |
| `{ "criterion": … }` | `text`, `status`, `evidence` |
| `{ "attention": … }` | `kind`, `author`, `resolution`, `text`, `evidence` |
| `{ "card": … }` | `text`, `evidence` |
| `{ "link": … }` | `kind`, `evidence` |
| `{ "brief": "<pattern>" }` | The run brief |
| `{ "all": [ … ] }`, `{ "any": [ … ] }` | Every or any nested predicate |

## Run

`run` lays out a runtime home inside the directory (`home`, with the Claude `projects`, `sessions` and `teams` and the Codex `sessions` and `archived_sessions` a used runtime has) and an aang home (`aang`), and starts the daemon with `AANG_HOME`, `CLAUDE_CONFIG_DIR` and `CODEX_HOME` there. `HOME` is inherited, so a real observer CLI runs with the owner's login; the daemon never watches the owner's runtime homes. The daemon config watches every session, uses the observer settings of the profile and otherwise keeps the defaults.

The tool waits until the observer of every runtime of the profile is admitted, then starts each recording at its offset with the current time (`recordTime` of the player), and keeps sampling the observer state of every run. After the last control event plus `window_ms` it reads the observer calls, stops the daemon and evaluates the store. When a recording fails to play, the other recordings stop at once; the daemon is shut down on every path, so it cancels the observer calls and ends their processes, and is killed only when it does not shut down.

- the records of a control event are the raw records its own step delivered. A hook step that is the n-th delivery of its payload with its registration in the recording matches the n-th hook record of that payload and registration; a write step matches the n-th file record of its content at its path in the same way; an append step matches the lines that start within the bytes it appended. A repeated delivery is never taken for an earlier one: a write the collector deduplicates has no record of its own. The earliest `observed_at` of the records starts the measurement, their earliest `source_ts` placed on the playback timeline (the recording's own clock from its `recorded_at`, replayed from the moment the recording starts at the profile time scale) is the time of the event itself, and their facts and runs are the event's facts and runs. An event whose records carry no fact of any run is `unmatched`;
- for a predicate, the model of each run of the event is replayed version by version from the journal. If the predicate already holds in the last version before the event, the markup is defective (`held_before`) and the event is left out of the statistics. Otherwise the first version created after the event in which it holds sets the latency; none means the expectation is missed;
- for a description, the candidates are the versions of the event's runs created within the window, with a one-line summary of each change.

A chat question is asked in the run that contains a session of the recording (the session id of its transcript or rollout); the tool looks for that run for up to two minutes, otherwise the question is `not_asked`. After the window it waits up to five minutes for the answers, then reads the usage report of the daemon (`/api/admin/usage`) and stops it. From the call journal of the store it takes the chat calls of every run and the probes and `auth status` checks of the backends; the usage of the observer calls comes with the calls.

`run` writes `measurement.json`, `annotations.json` and the report.

## Annotation and report

`annotations.json` lists the events without a predicate with their candidates. The annotator sets each `verdict`: `{ "met": true, "run": …, "version": … }` for the first candidate in which the description holds, `{ "met": false }` when none does; `null` leaves the event unassessed. `report` recomputes `report.json` and `report.md` and can be run after every change of the verdicts.

Per backend, the report gives:

- statuses: met, late (met after the window), missed, unmatched, held before the event, unassessed; late, missed and unmatched are violations;
- p95 by nearest rank over the assessed events, with missed and unmatched events beyond the window, and whether it meets the target; the share of assessed events within the target;
- p95 of the full latency from the event's own time, for events whose records have one;
- the share of `needs` time: the follow-up time of the observer call whose transaction produced each reached version, summed over the reached events, divided by their summed latency. A version the rules make in the same transaction as the observer's answer counts as the call's, its author stays `rule`;
- observer calls by outcome and the time share of each observer state (`ok`, `lagging`, `backoff`, `unavailable:<reason>`, `disabled`), which shows exhausted limits and degradation;
- spending (Q.3): the run hours (the sum of the played runs of the backend) and the active hours (the time at least one of its runs was playing); the calls, tokens by kind and cost of the observer, the chat and the probes; their rates per run hour and per active hour; the chat answers, their p50/p95 time and the tokens and cost per answer. The active hours of the usage report of the daemon (U.1, calendar hours with solver activity) are given next to them.
