# ADR-0005: Storage and journal

Status: accepted by the owner 2026-10-01; retraction of observation objects (decision 3) accepted by the owner 2026-10-03.

## Context

RFC §7–8 require:

- restoring cursors, stages and view state after a restart;
- not creating duplicates on redelivery;
- not filling unrecoverable gaps with guesses;
- on recovery, replaying the saved model changes, not the LLM requests.

ADR-0001 chose SQLite via `node:sqlite`. ADR-0002 requires storing data locally and indefinitely until manual deletion. Claude transcripts are deleted after 30 days (spike, section 7), so to return to old runs aang needs its own copy of the raw records.

## Decision

### Placement

- A single file `~/.aang/aang.db` (the directory is overridden by `AANG_HOME`), WAL mode. The directory has permissions 0700 on macOS and Linux; on Windows the user profile ACL applies (ADR-0013).
- The only writer is the daemon process. The CLI works through the daemon API.
- SQL does not leave the `store` package; the other modules work with typed repositories. This keeps replacing SQLite reversible (ADR-0001).

### Data layers

Each layer is derived only from the previous one and its own inputs.

| Layer | What it stores | How it is derived |
| --- | --- | --- |
| Raw records | `seq` — the global intake order; a unique `dedupe_key` (ADR-0004); channel (`hook`, `transcript`, `rollout`, `otel`, `registry`, `snapshot`, `context`); runtime; stream; position; `observed_at` (the moment it became available to the collector); `source_ts`; the payload unchanged; `parse_state`: `parsed`, `unknown` or `invalid` | intake from the source; unknown and unparsed records are stored too. The `snapshot` (git snapshots, ADR-0006) and `context` (observer context snapshots, ADR-0007) channels are written by the daemon itself |
| Facts | immutable normalized observations: `kind`, `entity_key`, `speaker`, `urgent`, runtime identifiers, time, payload, `normalizer_version`, `seq` of the source record | an adapter from one raw record. The id is deterministic: a hash of `dedupe_key`, `kind`, `entity_key` and the index among facts of the same kind and key in the record |
| Observation objects | sessions, agents, actions, questions, usage records, artifact versions, gaps (ADR-0006); object retractions: kind, id, key, run, replacement `replaced_by`, `change_seq` | a deterministic projection of facts by `entity_key`; the id is a hash of the key; rebuildable. When an identity is refined, the previous object is removed from the objects and gets a retraction naming the replacement (ADR-0006) |
| Blob | the content of base versions (ADR-0006), addressed by hash, with references to versions and a source mark: action payload or file read | the daemon, when it retains a version; deleted together with the last reference |
| Semantic model | the current state of stages, links, criteria, cards and the attention zone per run | a projection of the change journal |
| Change journal | `model_changes`: version, operation, entity, `before`/`after`, author (`rule`, `observer`, `user`), grounds, fact references, observer call id; `model_versions`: run, version number, base version, time | daemon rules, verified observer changes, user actions |
| Interpretation | `fact_interpretation`: run, fact, status (`pending`, `in_call`, `interpreted`, `deferred`, `not_interpreted`), attempt count, call id | the observer queue (ADR-0007) |
| Interface state | `view_marks` (run, model version, `change_seq`, time); `attention_views` (attention item, time); `view_rules`; `chat_messages` (question, answer, citations, model version) | only explicit user actions and chat answers |
| Service | `cursors`; `observer_calls` (input, base version, output, verification result with reasons, usage, latency); `bindings` (explicit bindings); `pruned_streams` (per-stream deletion boundary); `settings`; `gaps` | the daemon |

- The global counter `change_seq` numbers the visible changes of all layers, including retractions of observation objects. It serves as the `id` of SSE events and as the position in "changes since" queries.
- A view mark stores the pair "model version and `change_seq`", taken atomically. The difference "since the last view" is built from the model journal starting at the version, and from the changes and retractions of observation objects and attention changes starting at `change_seq` (ADR-0008). Therefore changes that appeared without the observer (a new artifact version, a question by rule) do get into the difference.
- `gaps` records known gaps: a lost source, unrecognized records, inactive hooks, discarded stale spool files, facts the observer could not make sense of. Gaps are not filled with guesses.

### Transactions and recovery

- Intake of a batch is one transaction: raw records, facts, objects and their retractions, `pending` interpretation statuses, changes from deterministic rules (including retargeting links to the replacement of a retracted object) and the file cursor.
  - The spool file is deleted after the commit.
  - A failure before the commit: reading is repeated from the old cursor.
  - A failure after the commit but before deletion: the repeated intake is cut off by `dedupe_key`.
- Applying an observer result is also one transaction: verification, changes, the new version, interpretation statuses and the `observer_calls` record.
- Nothing that cannot be restored is kept only in memory. After a restart, facts with status `in_call` return to `pending`.
- Damaged model projections are rebuilt by replaying the journal, without the LLM.
- `aang reparse` reruns the adapters over the raw records after `normalizer_version` changes (ADR-0010).
  - Facts with the same keys keep their ids, so model references stay correct.
  - New facts get the `pending` status.
  - A reference to a vanished fact is shown as "Ground unavailable".

### Migrations and deletion

- Migrations are numbered SQL files in `store`, forward only. The number is stored in `PRAGMA user_version`; a copy of the DB file is made before a migration.
- Retention is indefinite (ADR-0002). `aang prune --run <id>` and `aang prune --before <date>` delete all layers of a run, then `VACUUM` runs.
  - For each stream of the run, `pruned_streams` stores the deletion boundary and the deletion time. The table does not depend on the deleted data.
    - Codex: the last accepted `ordinal` — it is present in every line and does not depend on the position in the file.
    - Claude: the offset and the hash of the file prefix up to that offset.
  - Any re-read — backfill, `rescan`, recovery after a move, archive or inode change — skips the stream records up to the boundary.
    - For Claude, the boundary applies only if the prefix hash matched, that is, it is the same sequence of records.
    - If a file with the same `sessionId` shrank or was replaced and the prefix does not match, the boundary is not applied blindly. Intake of the stream stops, a gap "stream changed after pruning" is written, and `aang status` offers the user to re-accept the whole stream or leave it stopped.
  - Spool files of deleted sessions with an intake time earlier than the deletion are discarded.
  - Cursors are kept.
  - Records past the boundary form the run anew with the mark "start pruned".

## Consequences

- Returning to a run does not depend on `cleanupPeriodDays`, `codex archive` or transcript deletion.
- The DB size is comparable to the size of the source files of the tracked projects. Payload compression is deferred until measurements.
- A single writer simplifies deduplication and transactions. A lock file forbids running two daemons on one `AANG_HOME`.

## Owner decisions

Accepted by the owner 2026-10-01:

1. The payload is stored whole, without a limit; compression comes after size measurements.
2. One last-view mark per run.

Accepted by the owner 2026-10-03:

3. An observation object can be retracted with a replacement named (`replaced_by`). A retraction is a visible change with its own `change_seq`: it is written in the intake transaction together with the replacement, and the change feed delivers it to consumers. The rule for retraction and link retargeting is ADR-0006, decision 7.
