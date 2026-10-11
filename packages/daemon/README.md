# Daemon

## Run change stream

`GET /api/stream?run=<id>` serves the run's change feed (M.6, `feed`) as SSE per ADR-0011. Access is the same as for the rest of the API: a bearer token or a cookie.

- The client takes a snapshot and subscribes with `Last-Event-ID` equal to the snapshot's `change_seq`. The stream first serves events after that position, then new changes as they are committed. Without `Last-Event-ID` the stream starts at the current position.
- Every store transaction in the daemon wakes the stream after commit. Subscribers receive changes on the next turn of the event loop, not by polling.
- `facts` and `model` events carry `id` — the last `change_seq` within the event. After the events the stream serves a `run` delta with `id` equal to the feed position. It is state, not an event: it arrives on every connection and on every change of the summary, the view or the bindings. `Last-Event-ID` after it points to the position up to which the feed has already been delivered.
- Reconnecting with the last received `id` continues the feed from that point: data events are neither lost nor repeated.
- A position ahead of the feed (for example, the database was replaced while a tab remembers the old position) yields `reset` with reason `stale_position` and no `id`, after which the stream closes. The stream also closes with `reset` if the run disappears during the subscription. The client rereads the snapshot and subscribes again.
- A position before the last `reparse` that changed data yields `reset` with reason `reparsed`: the feed does not transmit facts and objects it removed. Open streams receive it right after the `reparse` commit, new connections with an old position — on opening, including after a daemon restart.
- Rejections before the stream starts are JSON API errors: an invalid `run` — 400, an invalid `Last-Event-ID` — 400, an unknown run — 404.
- A slow client does not accumulate a queue in memory: while the socket is not free, the stream does not write, and once it is freed, it sends the rest of the feed from the last delivered position.
- A daemon shutdown ends open streams gracefully before the server closes.

The `chat` event carries a run chat message (`ChatDelta`) on a question and on its answer or error; `id` is the `change_seq` of the message's last change, so a connection with an earlier position receives the message in its latest state. `attention` events carry views and dismissals of attention items (see "Writes: viewing, view rules, bindings"). The `reset` event with reason `pruned` will appear together with its source, `prune`.

## Status stream

`GET /api/stream` without `run` serves `status` events with a `StatusResponse` body (ADR-0011). Access and rejections are the same as for the run stream.

- The first event arrives on connection, subsequent ones on a change of the `observer` section of the status: backend states, CLI versions or admission. An event with an unchanged `observer` section is not repeated. The other status sections in the event are as of the moment it is sent, and their changes do not produce events yet.
- The event `id` is `database.change_seq` from its status. `Last-Event-ID` in this stream is checked for format and affects nothing else: the state arrives in full on every connection.
- A slow client does not accumulate a queue: while the socket is busy, the stream does not write, and once it is freed, it sends the current state if the `observer` section has changed.
- A daemon shutdown ends these streams too.

## Retained artifact versions

An artifact version that has become a basis (a stage output or input, a dependency version) is retained when the daemon calls `engine.retainBases`: after every accepted observer response — for its run, and once at startup — for all runs. So a file that did not exist at the time of the response is retained after a restart if it has appeared by then.

`GET /api/artifact-versions/:id` serves an artifact version and its content (G.4, ADR-0006): retained content — from a blob saved from an action payload or by reading the file, or from a commit read through git read-only; UTF-8 text comes as `utf8`, everything else as `base64`. A version without content comes with a reason: known only by reference (`reference_only`), retained only as a hash (`hash_only`), the blob is lost (`blob_missing`), or the file in the commit cannot be read (`commit_missing`). An unknown id — 404, a malformed id — 400.

## Writes: viewing, view rules, bindings

The G.8 write routes (ADR-0008, ADR-0011) accept JSON with the same access as reads, respond with contract DTOs and commit the change in one transaction. Every commit wakes the run stream, so the interface learns about a write through SSE the same way as about new runtime events, including from another tab.

- `POST /api/runs/:run/viewed` with `{version, change_seq}` sets the viewed mark (`MarkViewedResponse`). The client takes the pair from the displayed snapshot together with the applied events: `version` is the run model version at position `change_seq`. A pair that does not describe a single state, and a position ahead of the feed — 400, the previous mark stays. There is one mark per run; new events do not move it. The stream serves it in the `run` delta. The diff since the mark is `GET /api/runs/:run/changes?version=&seq=` (G.4).
- `POST /api/runs/:run/attention/:item/viewed` and `…/dismiss` with `{}` mark an item as viewed or dismiss it (`AttentionViewResponse`). A viewed item sinks in the attention zone; a dismissed one leaves `view.zone` and stays in `attention.items` with an entry in `attention.views` — that is its history. The first time of each action is kept; a repeat changes nothing. The model, the journal and the item itself do not change: the stream serves an `attention` event with the view entry and a `run` delta with the new zone and counters; there are no `model` events. An item of another run — 404.
- `POST /api/runs/:run/view-rules` with a `ViewRuleSpec` creates a view rule with source `ui` and applies it immediately (`CreateViewRuleResponse`: the rule and the affected elements). An invalid selector or parameters — 400 with an explanation: unknown stage, empty name, role, type or group title, schema mismatch. `DELETE /api/runs/:run/view-rules/:id` revokes the rule (`RevokeViewRuleResponse`); a repeat returns the already revoked rule. A rule of another run — 404. Rules change only the presentation: the stream serves a `run` delta with the new `view.rules` and `view.placements`, and the rule also applies to elements that appear after it.
- `POST /api/bindings` with a `CreateBindingRequest` (`attach`, `detach`, `fork_parent`) and `DELETE /api/bindings/:id` create and revoke an explicit binding (`BindingResponse`). The binding goes through the intake queue, is journaled in both runs and moves the session (ADR-0006). An unknown session, run or binding — 404, a fork parent for a run that is not a fork — 400, during a daemon shutdown — 503. A repeated revoke returns the already revoked binding.

Moving a session updates both runs through the stream. The source run receives a `model` event with the `session_membership` removed: the client removes the objects, gaps and plan facts of that session. The target run receives a `model` event with the binding and membership, followed by a `facts` event with the session's objects, its plan facts and gaps: the move assigns them new positions after the membership, so they arrive on connection from any position, including from the event of the move itself. A snapshot plus the feed after it yields the next snapshot for both runs.

The write body is JSON up to 64 KiB; invalid JSON, extra fields or a different body shape — 400. A request without a token — 401.

## Reparse

`POST /api/admin/reparse` with an empty JSON object and the `aang reparse` command reparse the stored raw records with the current adapters (E.9, ADR-0005). Parsing runs in the same queue as intake and is applied in one transaction.

- The response is `ReparseResponse`: the number of parsed records, and of added, id-preserving and vanished facts. `aang reparse` prints these numbers.
- A repeated call is idempotent: records with facts of the current normalizer version are not parsed, and records without facts are parsed again without changes. The feed position does not move, and streams are not reset.
- A request without a token — 401, with a body other than an empty object — 400. During a daemon shutdown — 503; the shutdown waits for a reparse already in progress.

## OTel address for Codex

`POST /api/admin/otel-config` serves the OTel receiver address with the current intake token (ADR-0004): `http://127.0.0.1:<port>/otel/<token>/v1/logs`. The port is the actual port of the running receiver.

- `{ "rotate": false }` only reads the address. The intake token is stored in `settings` and survives a restart; `aang token rotate` does not change it (ADR-0003).
- `{ "rotate": true }` saves a new token and switches the receiver immediately: the previous address answers 404, the new one accepts records.
- The body is a JSON object with the `rotate` flag; otherwise 400.

`aang otel-config [--rotate]` prints, from the response, an `[otel]` section for Codex's `config.toml`. aang does not change the user's config.

## Observer

The daemon assembles the observer from the `observer` package (G.6, ADR-0007).

- **Backend.** At startup the `claude` and `codex` backends are created. The CLI path is set by `cli.claude` and `cli.codex`; without them the CLI is looked up in the `PATH` of the environment the daemon was started with. Model, effort and timeout are `observer.models`, `observer.effort` and `observer.timeoutMs`. Claude's default effort is `low`; for Codex it is not set, and the CLI default applies; `null` keeps the CLI default (ADR-0007, decisions 14 and 15). The CLI environment is cleaned by `observer` (ADR-0007, ADR-0013). On Windows the launcher is `aang-hook.exe`, which `aang install` puts into `AANG_HOME/bin`; without it the backend is disabled (`launcher_unavailable`).
- **Admission.** The daemon admits both backends on a synthetic input (F.6) and only then starts the scheduler: this way the scheduler continues from the saved recovery state (F.9) rather than having it reset by admission. While admission is running, facts accumulate in `pending`. The admission result is `AANG_HOME/support/<runtime>-observer.json`.
  - Built-in Claude plugins, for example `cc-plugin-agents-md` and `cc-plugin-plugin-authoring` in 2.1.286, are admitted if they give the model no tools, no MCP servers and no hooks. Their list is recorded in the version's admission result (ADR-0007, decision 9; `packages/observer/README.md`). The support matrix (R.5a, F.10) is not needed for this.
  - There are no Claude versions with a local contract run yet (F.10), so an admitted Claude works with the warning «изоляция от сообщений других сессий на этой версии не проверена» ("isolation from other sessions' messages is not verified on this version") (owner decision 5).
- **New CLI version.** Every 10 seconds the daemon asks every disabled backend for its CLI version (`cliVersion()`, `--version` only) and admits it if it differs from the version on which the last admission ran. This way the daemon admits a new version after `version_not_admitted` of a working call, after an isolation violation and after a failed admission, as well as a CLI that was absent at startup. If the backend still has calls of the old version running (`admission_busy`) or its process has not stopped (`process_stuck`), admission is retried on the next check. On the same version the daemon does not retry admission.
- **Isolation violation.** The backend stays in `disabled: isolation` on the same CLI version and with the same profile even after a daemon restart: the mark is stored in the admission status file, and admission at startup refuses without probes (`packages/observer/README.md`). It is resumed by a new CLI version or by a manual admission `aang doctor --admit` (G.12). A failed admission for another reason on the same version is not retried by the daemon either. It can be retried only by a manual admission.
- **Scheduler.** It receives `observer.backend`, `observer.crossVendor`, `observer.budgetTokensPerHour`, the input limit `observer.inputLimitTokens` and the Claude configuration directory (`runtimes.claude.configDir`, `CLAUDE_CONFIG_DIR` or `~/.claude`), where it looks for skills and subagent definitions for the run context (F.7a). A run goes to the backend of the vendor of its root session unless `observer.backend` overrides it. Facts of sessions of another vendor are not sent to the observer without `observer.crossVendor`: they get `not_interpreted`, and a `cross_vendor_excluded` gap opens on the run. After every accepted batch and after every binding that may move a session's facts into another run's queue, intake wakes the scheduler; other calls are scheduled by its timers.
- **State in the API.** `/api/status` shows in `observer.backends`, for each backend:
  - the state: `ok`, `lagging`, `backoff`, `unavailable` with a reason and the time of the next attempt, or `disabled` with a reason. This is the same state the scheduler uses to decide on calls; before the scheduler starts — the state of the backend itself;
  - the CLI path from the config (`null` — the CLI is looked up in `PATH`), model and effort;
  - the CLI version and the last admission: `admitted`, `pending` or `failed` with a reason. `cross_session_inbound_verified: false` on an admitted backend is the warning «изоляция от сообщений других сессий на этой версии не проверена». While the CLI version is unknown (the CLI was not found or admission has not yet received the `--version` answer), admission is `null`.

  The run summary (`observer` in `RunSummary` and in the `run` delta) carries the observer state of that run and `isolation_unverified` if the run's backend was admitted with the warning. A change of the observer state wakes both kinds of streams: the run stream serves a `run` delta if the summary changed, the status stream a `status` event if the `observer` section changed.
- **Shutdown.** Intake stops first, then the observer: a running admission and calls are cancelled, and their batches return to `pending` without spending an attempt. An observer error, for example an unreadable saved recovery state, stops the daemon with an error, as does an intake error.

The tests (`test/observer.test.ts`, `test/observer-status.test.ts`) start the daemon with fake `claude` and `codex` from `testkit`, whose paths are written into the config. On Windows only `codex` can be launched from a single path — in the npm package layout (`codex.cmd` and `node_modules/@openai/codex/bin/codex.js`) that `observer` finds; the fake `claude` there needs `node` with a script, so the Claude backend tests run on macOS and Linux. The fake `claude` reports in `init` the same built-in plugins as Claude 2.1.286. The test binds a Codex session to a Claude run through `engine` while the daemon is stopped: the bindings API will appear in G.8.

## Mutating requests from the browser

A request with an unsafe method (`POST`, `PUT`, `PATCH`, `DELETE`) authorized by a cookie is accepted by the daemon only from the daemon's own page and only with JSON (ADR-0003, decision 1). The check sits in the router before route selection, so new write routes do not need their own check.

- `Origin` must be exactly `http://127.0.0.1:P` or `http://localhost:P`, where P is the daemon port; without `Origin`, `Sec-Fetch-Site: same-origin` and `Host` `127.0.0.1:P` or `localhost:P` are required. Otherwise — 403 `forbidden`, including for `Origin: null` and a malformed `Origin`.
- `Content-Type` is `application/json`, including for a `DELETE` without a body. Otherwise — 415 `unsupported_media_type`.
- Requests with a bearer token (CLI) and reads are not checked.
- To use the UI from another machine, an SSH tunnel forwards the same port: `ssh -L P:127.0.0.1:P`. A page opened at another address or port reads data, but its mutating requests get 403.

## Chat

`POST /api/runs/:run/chat` with `{ question, stage }` asks a question (K.1, ADR-0008). The response is a message in the `pending` state with the map version on which the input was assembled; the answer or error arrives as a `chat` event of the run stream. `GET /api/runs/:run/chat` serves the run's chat history.

- The call goes through the same observer (`createChat` from `observer`) in a separate scheduler slot. A question asked during admission at startup waits for the scheduler to start.
- An unknown run — 404; an invalid body, an empty question, a stage outside the run, or a question that does not fit the input limit `observer.inputLimitTokens` — 400; without a token — 401; during a daemon shutdown — 503.
- Chat call usage is written to the U.1 chat journal (#108) once it appears in the store; until then the daemon does not pass `journal`.
- A view rule from a chat answer (K.2) is checked and applied by the daemon together with the answer, with source `chat`: the `chat` event carries the message with `view_rule` — the rule id, and the `run` delta carries the rule in `view.rules` with the affected elements and `view.placements`. If the rule fails the check (unknown stage, empty selector text or group name), the answer is saved without the rule, and `view_rule_error` explains the reason. A chat rule is revoked by the same `DELETE /api/runs/:run/view-rules/:id` as an interface rule; the message keeps its id.

The tests (`test/chat.test.ts`) ask questions over HTTP to a daemon with a fake `codex` and read the answers from the run stream and the history: an answer with reference and insufficient-data marks; a view rule from an answer after a `needs` follow-up request — application, affected elements in the stream and the snapshot, revocation; rejection of a rule with an unknown stage, with an explanation.

## Usage report

`GET /api/admin/usage` and the `aang usage` command show the three usage ledgers per run and period (U.1, ADR-0009): solver, observer and chat. How the report is computed is described in `engine` ("Observer and chat usage").

- Query parameters: `run` — the run id, `from` and `to` — the period bounds in epoch nanoseconds; `from` is included in the period, `to` is not. `aang usage [--run <id>] [--from <date>] [--to <date>]` accepts dates in the `Date.parse` format.
- The response is `UsageReport`: the ledgers of each run, the observer and chat ledgers over all runs of the report, probes, ledger totals, active hours and usage per active hour.
- An unknown run — 404 with the text `no run <id>`; an invalid `run`, date, or `from` not earlier than `to` — 400; a request without a token — 401.
- `aang usage` prints the ledger totals, usage per active hour, calls with latencies and observer lag, then each run: duration and active hours, solver usage by stage and the unattributed remainder, the session's "Claude Code reports" total with a mark of whether it is final and whether it includes usage inherited by a fork, the Codex "thread total" without usage records (it is not part of the solver ledger, and a fork does not have it), and the observer and chat ledgers. In a period report a note reminds that these cumulative totals cover the whole session or thread, not only the period. Money is shown only from runtime data, with the note "money is at list prices; with a subscription it is not a charge".

## Connection state

`GET /api/status` shows how completely aang sees the runtimes (G.7, ADR-0004, ADR-0010).

- **`runtimes[].hooks` — a static check of the installation.**
  - Claude: `claude plugin list --json`. The `aang@aang` plugin is absent — `not_installed`, it is disabled — `disabled`, enabled — `active`.
  - Codex: its own `codex app-server` (`codexHooksState` from `@aang/hook`); the process exits right after the `hooks/list` answer. Only an entry of the current installation with the command `<AANG_HOME>/bin/aang-hook codex user <spool>` counts as an aang entry. None — `not_installed`, at least one untrusted — `untrusted`, all trusted but one disabled — `disabled`, trusted and enabled — `active`. Stale entries of previous installations and of another `AANG_HOME` do not change the state.
  - The check failed (CLI not found, timeout, malformed answer, on Windows no `aang-hook.exe` launcher in `AANG_HOME/bin`) — `unknown`.
  - The CLIs are taken from `cli.claude` and `cli.codex` of the config, without them — `claude` and `codex` from `PATH`. Both are resolved the same way as for the observer (`resolveCli` from `@aang/observer`): on Windows — a real `.exe` or `node` with the Codex npm package script.
  - **Process tree** (ADR-0013). `claude plugin list` goes through the same launch operation as the observer (`createProcessRunner` from `@aang/observer`): a new process group leader on macOS and Linux, the `aang-hook launch` launcher with a Job Object on Windows. After the root exits, a timeout or a cancellation, the whole tree is terminated, and the result is returned only after a confirmed stop. If the stop is not confirmed within 10 s, the Claude probe yields `unknown`, and its subsequent launches are rejected (`process_stuck`) until a late confirmation or a daemon restart. The Codex app-server on macOS and Linux is started as a group leader; after the answer or an error the group gets SIGKILL, and `codexHooksState` waits until the group is empty. On Windows the app-server goes through the same launcher in `stream` mode, and `codexHooksState` waits for its status file (`@aang/hook`, section "Windows"). Confirmation is awaited for no more than 10 s after the stop command; without it the Codex probe yields `unknown`, and its subsequent launches do not start the CLI until a late confirmation or, if the launcher exited without a status, until a daemon restart.
  - **Budget.** Each probe is limited to 10 s, the tree stop to another 10 s. On daemon shutdown running probes are cancelled, and the shutdown does not wait for them.
- **When the check runs.** Per ADR-0004 — only on an event:
  - at daemon startup;
  - on a change of `settings.json` and `plugins/installed_plugins.json` in the Claude root, `hooks.json` and `config.toml` in the Codex root. The daemon compares `stat` of these files once a second; the CLI is not launched for this;
  - on `POST /api/admin/hooks-check` with an empty JSON object. It is called by `aang status`. The response is a `StatusResponse` after a new check.

  `GET /api/status` serves the last saved state and does not launch the CLI: the UI polls the status, and the app-server on every launch contacts OpenAI services and writes to `CODEX_HOME` (D.6). Checks of one runtime run one at a time. A request during a check waits for the next one, which starts after it, so `hooks-check` answers within at most two checks with tree stop — 40 s. Until the first result the state is `unknown`.
- **`runtimes[].hooks_inactive_sessions`** — the E.3 dynamics: sessions in «только файлы» ("files only") mode. These are sessions whose lines are in the files but that have no hook events, and sessions whose turn is visible in the files but that have had no hook events for that turn for longer than `freshness.hooksInactiveAfterMs` (ADR-0004, decision 12). `double_registration_sessions` — sessions with events from two registrations.
- **`versions`** — the versions encountered. The matrix key is made up of the runtime, the surface and the session's engine version, the daemon OS and the placement. The status is taken from `support/matrix.json`; a key outside the matrix is `unverified`. Sessions without a version are not listed.
  - The Claude surface comes with the `SessionStart` hook. For a session without hook events ("files only" mode) the engine version is known from the transcript, but the surface is not: such a version is shown with `surface: null` and is always `unverified`, because it matches no matrix row.
  - The placement is set by `placement` in the config: `local`, `docker`, `vm` or `desktop_ssh`. A VM and Desktop's SSH mode cannot be distinguished from a local launch from the inside, so the owner specifies them. Without `placement` — `docker` if `/.dockerenv` exists (this is determined by `aang`), otherwise `local`. Each placement has its own matrix rows: a verified local row does not carry over to a VM.
  - The matrix path is passed by `aang`. The daemon reads it at startup; without the file, or with a file that fails the schema, the daemon does not start.
- **`not_observable`** — a permanent notice: aang does not observe Claude Cowork and cloud modes (ADR-0004, decision 10).
- **`spool`** — the number and size of files, the lease term, the stop marker and the threshold (G.1).

`aang status` with a running daemon calls `POST /api/admin/hooks-check` and prints the hooks state by runtime, the number of sessions with inactive hooks and with double registration, the versions with their status, and the "not observable" notice. On Windows, under the Codex hooks state there is an explanation (ADR-0013, decision 7): without entries — that Codex sessions are visible only from files, with entries — that each event costs 0.25–0.4 s. If the daemon is not running, the command shows only the state of the `AANG_HOME` files.

- `hooks-check` waits up to 60 s, with a margin over the daemon's 40 s budget.
- If the check failed (timeout, error, a daemon without this endpoint), the command writes the reason to stderr, takes the saved state from `GET /api/status` and marks it with the line `hooks: not checked now, the last stored state follows`.
- If the saved state cannot be obtained either (the process from `daemon.json` is alive but the daemon does not respond), the command writes the reason and exits with code 1.
