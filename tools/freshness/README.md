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
    { "recording": "claude/2.1.289/claude_cli/macos/tools", "start_ms": 0 },
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

The tool waits until the observer of every runtime of the profile is admitted, then starts each recording at its offset with the current time (`recordTime` of the player), and keeps sampling the observer state of every run. After the last control event plus `window_ms` it reads the observer calls, stops the daemon and evaluates the store:

- the records of a control event are the raw records whose content is what its step delivered: the hook payload, the appended lines of the file, the written file. Their earliest `observed_at` starts the measurement, their earliest `source_ts` is the time of the event itself, and their facts and runs are the event's facts and runs. An event whose records carry no fact of any run is `unmatched`;
- for a predicate, the model of each run of the event is replayed version by version from the journal. If the predicate already holds in the last version before the event, the markup is defective (`held_before`) and the event is left out of the statistics. Otherwise the first version created after the event in which it holds sets the latency; none means the expectation is missed;
- for a description, the candidates are the versions of the event's runs created within the window, with a one-line summary of each change.

`run` writes `measurement.json`, `annotations.json` and the report.

## Annotation and report

`annotations.json` lists the events without a predicate with their candidates. The annotator sets each `verdict`: `{ "met": true, "run": …, "version": … }` for the first candidate in which the description holds, `{ "met": false }` when none does; `null` leaves the event unassessed. `report` recomputes `report.json` and `report.md` and can be run after every change of the verdicts.

Per backend, the report gives:

- statuses: met, late (met after the window), missed, unmatched, held before the event, unassessed; late, missed and unmatched are violations;
- p95 by nearest rank over the assessed events, with missed and unmatched events beyond the window, and whether it meets the target; the share of assessed events within the target;
- p95 of the full latency from the event's own time, for events whose records have one;
- the share of `needs` time: the follow-up time of the observer call that produced each reached version, summed over the reached events, divided by their summed latency;
- observer calls by outcome and the time share of each observer state (`ok`, `lagging`, `backoff`, `unavailable:<reason>`, `disabled`), which shows exhausted limits and degradation.
