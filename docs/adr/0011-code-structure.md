# ADR-0011: Code structure, API and packaging

Status: accepted by the owner 2026-10-01; the `catacomb` composition root and the adapter interface addition (ADR-0014) accepted 2026-10-02; the path in `streamKey` approved by the owner 2026-10-07.

## Context

ADR-0001 set TypeScript on Node 26, a pnpm monorepo, SQLite, SSE and React. AGENTS.md requires logically cohesive reviewable PRs and PR stacks for large tasks. So modules with narrow boundaries and a shared contract are needed, so that stacks across different modules can proceed concurrently. RFC §4 includes local mode and one's own VM/Docker.

## Decision

### Packages `packages/*`

| Package | Responsibility | Depends on |
| --- | --- | --- |
| `contract` | types and `zod` schemas: raw records, spool format, fact kinds, observation objects, model entities, observer operations, observer and chat input and output with JSON Schema generation, API DTOs, SSE events, config, support matrix format; adapter and collector interfaces | — |
| `store` | `node:sqlite`: migrations, repositories for all layers, transactions, journal, `change_seq` | `contract` |
| `collector` | spool, tailing JSONL files, snapshots of whole JSON files (meta, teams, workflows, registry), OTel receiver; receives cursors at start, emits batches | `contract` |
| `adapter-claude` | Claude: stream key and line deduplication key, raw records → facts; pure functions without I/O | `contract` |
| `adapter-codex` | the same for Codex | `contract` |
| `engine` | batch intake in a transaction; scope; observation objects; run linking; daemon rules; usage accounting; validation and application of model changes; read queries (snapshot, inspector, diff); view projection, view rules, attention order; `reparse` and projection rebuild | `contract`, `store` |
| `observer` | CLI launch, isolation profiles, self-checks, batch assembly, scheduler, observer and chat calls, system prompts | `contract`, `store`, `engine` |
| `hook` | `catacomb-hook` (Go, ADR-0013), Claude plugin templates and Codex `hooks.json`; installation, removal and checking of installation and trust state (TypeScript) | `contract` |
| `daemon` | module composition, config, lifecycle, HTTP API and SSE, authorization (ADR-0003), serving `web` static files | all except `catacomb`, `cli`, `web`, `testkit` |
| `cli` | `catacomb` commands; calls the daemon API, performs installation via `hook`; starts the daemon via the entry point that `catacomb` passes to it | `contract`, `hook` |
| `web` | React, Vite, React Flow, ELK | `contract` |
| `testkit` | reference session player, fake `claude` and `codex` CLIs, observer response scenarios, temporary HOME, daemon launch for tests | `contract` |
| `catacomb` | entry point of the public `catacomb` package and the command's composition root: passes `cli` the daemon launch from `daemon` and the `web` static directory | `cli`, `daemon`, `web` |

### Interfaces between packages

- **Adapter** (in `contract`):
  - `streamKey(path, first lines of the file)` — the stream for the cursor and for relocation search. The path is needed for files whose lines do not name the stream; for a hook record outside a file the path is `null`;
  - `rawKey(record, stream)` — deduplication key (ADR-0004);
  - `parse(record, stream)` — facts with `entity_key`, `speaker`, `urgent`;
  - `owner(record)` — the root session and independent evidence about the stream, directory, session start and observer, including for unknown and unparsed records ([ADR-0014](0014-record-owner.md)).

  `engine` receives adapters through a registry and does not depend on specific runtimes.
- **Collector:** `start(cursors) → stream of batches {records, cursor updates}` and `ack(batch)` after commit. Spool file deletion is performed in `ack`.
- Pairwise links between records (for example, `PermissionRequest` ↔ `PreToolUse`) and the scope decision are built by `engine`, not by the adapter. The scope decision is stored per stream next to the cursor.
- `web` talks to the daemon only through the API.
- Dependency direction and the comment ban (AGENTS.md) are checked in CI. `engine` tests are allowed to import adapters (ADR-0012), product code is not.

### Daemon process

A single Node process. It runs the intake loop, the observer scheduler and the HTTP server. Observer and chat calls are child processes. A lock file in `CATACOMB_HOME` (from `store`) prevents starting a second daemon.

The `catacomb` command and the daemon process execute the same entry point — the `catacomb` package:

- `cli` and `daemon` do not depend on each other. `catacomb` passes `cli` a function that runs the daemon in the current process and the command with which this same entry point is started in daemon mode;
- `catacomb start --foreground` runs the daemon in the CLI process;
- `catacomb start` spawns the same entry point as a detached process in daemon mode and waits for it to become ready;
- `catacomb` tells the daemon the `web` static directory; it does not import `web` code.

`cli` and `daemon` share files in `CATACOMB_HOME`: the spool with a lease and a stop marker, the daemon state file, the UI token and one-time codes. Their layout and the state file schema are defined in `contract`.

### API

HTTP JSON and SSE with the `/api` prefix. Access is by bearer token or cookie (ADR-0003). `web` static files are served by the daemon from the same origin.

| Method | Purpose |
| --- | --- |
| `GET /api/status` | sources, support modes, hooks, observer, versions and their status, spool, the "Not observable" notice |
| `GET /api/runs` | runs: state, attention, freshness |
| `GET /api/runs/:run` | snapshot: model of the current version, objects, attention, applied view rules, view mark, freshness, the snapshot's `change_seq` |
| `GET /api/runs/:run/stages/:stage` | inspector: summary, inputs and outputs, time, usage, grounds, history |
| `GET /api/runs/:run/changes?version=<version>&seq=<change_seq>` | diff since the view mark: by the model journal and by observation objects (ADR-0008) |
| `GET /api/runs/:run/observer-calls` | observer calls: accepted and rejected operations, latencies |
| `GET /api/facts/:id`, `GET /api/raw/:seq` | source events |
| `POST /api/runs/:run/viewed` | view mark on a version |
| `POST /api/runs/:run/attention/:item/viewed`, `POST /api/runs/:run/attention/:item/dismiss` | marking and dismissing an attention item |
| `GET /api/artifact-versions/:id` | a saved artifact version or an unavailability note |
| `GET`, `POST /api/runs/:run/chat` | chat history; a question, the answer arrives via SSE |
| `POST`, `DELETE /api/runs/:run/view-rules[/:id]` | view rules |
| `POST`, `DELETE /api/bindings[/:id]` | explicit session bindings |
| `/api/admin/*` | `watch`, `unwatch`, `prune`, `reparse`, `usage`, `doctor` for the CLI |
| `GET /api/stream?run=<id>` | SSE |
| `GET /auth/<one-time code>` | sets the cookie (ADR-0003) |
| `POST /otel/<intake token>/v1/logs` | OTel intake on a separate loopback listener (ADR-0004) |

**SSE:**

- events are deltas `run`, `facts`, `model`, `attention`, `chat`, `status`;
- the event `id` is `change_seq`;
- the client takes a snapshot, then subscribes with `Last-Event-ID` equal to the snapshot's `change_seq`;
- if the position is stale, the server sends `reset`, and the client re-reads the snapshot.

### CLI

- Lifecycle: `catacomb start [--foreground] [--bind <address>]`, `stop`, `status`, `open` (one-time link, ADR-0003), `token rotate`.
- Connection: `install [--claude] [--codex]`, `uninstall`, `otel-config [--rotate]`, `doctor`.
- Scope: `watch <dir> [--lookback <period>] | --all`, `unwatch`.
- Runs: `bind` (explicit bindings), `usage`, `prune`, `reparse`.

The config is `~/.catacomb/config.json`, schema in `contract`. It contains:

- runtime roots (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`), watched roots and `lookback`;
- backend, models, effort, cross-vendor transfer and observer budget;
- CLI paths;
- listen address;
- validation contracts per watched root.

### Packaging

- **npm.** One public package `catacomb` with the commands `catacomb` and `catacomb-hook`.
  - Internal packages are bundled by `esbuild` into `dist/` from the entry point of the `catacomb` package.
  - Per-platform `catacomb-hook` binaries (macOS, Linux, Windows; amd64 and arm64) ship as optional packages `catacomb-hook-<os>-<arch>` (ADR-0013).
  - `engines.node` — `>=26`.
- **Docker.** An `catacomb` image on `node:26-slim` with the catacomb package. It is the base layer for the solver image: in a derived image the user installs `claude` and/or `codex` and authorizes them inside the container. The catacomb daemon and the solver run in the same container. UI access is via an SSH tunnel or an explicit bind with a token (ADR-0003).
  - The spike did not check the OAuth path via the CLI on Linux, and this is a verification item (plan, Q).
  - A sidecar with shared volumes is not supported in the MVP: it has no authorized CLI for the observer, and a liveness check by pid from the registry is wrong across pid namespaces.
- **Background mode.** `catacomb start` spawns a detached process with a pid file. `catacomb stop` stops the daemon with an authorized `POST /api/admin/shutdown` on all OSes (ADR-0013). There are no launchd, systemd or Windows service units in the MVP.

## Consequences

- Aspects are developed concurrently against the shared contract: adapters, collection, engine, observer, API and UI.
- A change to `contract` affects all aspects, so its PRs are reviewed first and in small portions.
- One public package simplifies installation; internal packages are not versioned separately.

## Owner decisions

Accepted by the owner 2026-10-01:

1. One public npm package with a bundle; hook handler binaries as optional per-platform packages.
2. The MVP Docker topology is catacomb in the solver container; sidecar after the MVP.
3. No autostart via launchd, systemd or Windows services in the MVP.

Accepted by the owner 2026-10-02:

4. The composition root of the `catacomb` command is the `catacomb` package: it imports `cli` and `daemon`, and `cli` receives the daemon launch by injection and does not depend on `daemon`.

Approved by the owner 2026-10-07:

5. `streamKey` receives the file path together with the first lines. Basis: [PR #151](https://github.com/realkarych/catacomb/pull/151), a cross-review remark about the Claude workflow journal. The lines of the journal `<session>/subagents/workflows/<launch>/journal.jsonl` name neither the session nor the launch, and the first line `{"type":"launched"}` is the same for all launches. So from the lines alone `engine` could not name the stream, held the file and from the 16th line discarded it with the gap `unknown_stream_layout`.
   - The Claude adapter builds the journal key from the path: `[session, 'workflow', launch, 'journal']`. The key does not change when the project directory is relocated, so relocation search finds the journal at its new location.
   - The owner of a journal line is already determined from the path (ADR-0014), so the path as an input of the adapter's pure function adds no I/O and does not move format parsing into `engine`.
   - Rejected: `engine` builds the stream key — then it knows the file layout of a specific runtime; the journal is not ingested — the source from ADR-0004 is lost, and a workflow with several agents still yields `unknown_stream_layout`.
