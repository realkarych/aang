# A.5: the OTel path with a token on real Codex

Verified 2026-10-02: `codex-cli 0.160.0`, macOS arm64 (Darwin 27.0.0), Node 26.10.0. The collector is from commit `a5484d804f06d269b885285c79f0163e055d54cc`.

**A.5 acceptance is met.** Real `codex exec` sent OTLP/HTTP JSON directly to the `@catacomb/collector` receiver at the path `/otel/<token>/v1/logs`. Through the public `collector.start()`, one `codex.tool_decision` record with `source: Config` and `decision: approved` was received. There are no gaps. No real model was called: the Responses API was replaced with a local stub.

Basis: [plan, A.5](../plan/mvp.md), [ADR-0004: Codex OpenTelemetry](../adr/0004-event-collection.md#codex-opentelemetry-opt-in), [ADR-0012](../adr/0012-testing.md). This checks the question left open after the [spike](integrations.md): whether the token is preserved in the exporter path. Product code and architectural decisions do not change.

## Scenario

1. Create a temporary directory outside the repository with a separate `CODEX_HOME`, working directory and spool. Copy only `~/.codex/auth.json`, without a symlink; profile permissions — `0700`, auth copy — `0600`.
2. Start the real collector via `createCollector()`, open `listenOtel({ port: 0, token })` on `127.0.0.1`. The token is 32 random bytes in hex. The file source roots are empty, so received records can only arrive via OTel.
3. Start a local `/v1/responses` stub. The first SSE response contains a code mode call `functions.exec`, which runs `tools.exec_command({cmd:"printf catacomb-a5-otel-token",login:false})`. The second request must contain the tool result with this marker; the second response finishes the turn with the text `A5_OK`.
4. Run the installed `codex exec --json` with `--ephemeral`, `--ignore-user-config`, `--ignore-rules`, `--skip-git-repo-check`, `-s read-only` and `approval_policy="never"`. The `a5_stub` provider points only to loopback, `requires_openai_auth=false`. The model string `gpt-6-astra` is passed to the stub, which returns predefined responses.
5. Pass the OTel settings via `-c`, wait for the CLI to exit and for the collector record. Match `conversation.id` against `thread.started.thread_id`, check the event name, `source`, `decision`, the tool and a non-empty `call_id`.
6. Resend the received envelope as a plain HTTP request with an altered token: expect 404 and no additional record. This is a separate negative check of the receiver; no new Codex process is started.
7. Close the servers and the collector, delete the temporary directory together with the auth copy. Compare the SHA-256 of the user's `auth.json`, `config.toml`, `hooks.json` before and after; keep only the comparison result in the report.

Key overrides:

```text
-c otel.environment="catacomb-a5-token-live"
-c otel.log_user_prompt=false
-c otel.exporter.otlp-http.endpoint="http://127.0.0.1:<port>/otel/<token>/v1/logs"
-c otel.exporter.otlp-http.protocol="json"
-c otel.trace_exporter="none"
-c otel.metrics_exporter="none"
```

The child CLI environment is set explicitly: `PATH`, the original `HOME`, `TMPDIR`, a temporary `CODEX_HOME`, `OTEL_BLRP_SCHEDULE_DELAY=100`. Its stdin is closed right after launch. The endpoint and JSON protocol settings are described in the [official OpenAI reference](https://learn.chatgpt.com/docs/config-file/config-reference); this experiment confirms that the full path is preserved.

## Observations

Successful run: `2026-10-02T18:57:17.758Z` — `2026-10-02T18:57:19.861Z` (2.103 s). This is the time of the whole process, not the OTel delivery latency.

| Check | Result |
| --- | --- |
| CLI exit | 0; the `printf` command exited with 0; final text `A5_OK`; `turn.completed` is present |
| Responses API | Two local POSTs; the second contains the result of the first tool call |
| Exporter path | All three OTLP POSTs arrived at `/otel/<token>/v1/logs` without a changed prefix or a repeated `/v1/logs` |
| HTTP | `Content-Type: application/json`, all three responses — 200 |
| Collector batches | One record `channel: otel`, `runtime: codex`; zero gaps |
| Event | `codex.tool_decision`, `source: Config`, `decision: approved`, `tool_name: exec_command` |
| Correlation | `conversation.id` matched `thread.started.thread_id`; the nested command's `call_id` — `exec-aa9dd2cc-147a-4ebe-be20-790ad69998d9` |
| Exporter resource | `service.name: codex_exec`, `service.version: 0.160.0` |
| Wrong token | 404; the record count stayed at one |
| Isolation | The auth copy did not change; the user's auth/config/hooks did not change; the temporary directory was deleted |

Method, path, Content-Type and status are captured passively via Node `diagnostics_channel` (`http.server.request.start`) on the real receiver's port. There is no proxy and no substitution of catacomb modules. The record content is taken from the collector batch; the experiment calls `ack()` after receiving it.

The CLI also requested the local `/v1/models?client_version=0.160.0` twice and sent one POST to the local `/v1/analytics/codex/turn-costs`, despite `analytics.enabled=false`. The stub responds with `{"models":[]}` and `{}` respectively. The bodies of these service requests are not saved. The usage counters in stdout are synthetic, set by the stub, and do not reflect model consumption.

In the received event, `timeUnixNano` equals the string `"0"`; the receive time `observed_at` is saved separately. No latency measurement was made from this timestamp. The `call_id` belongs to the nested `exec_command`, not to the outer code mode call with id `catacomb_a5_exec`.

While preparing the scenario, one run was stopped by a timeout before any model requests: stdin had remained open. Subsequent runs revealed the service calls `/models` and `/analytics/codex/turn-costs`, which the initial stub treated as unexpected. After closing stdin and handling these two routes, the scenario completed with all checks passing. In all runs the provider was local; Claude CLI was not launched.

## Artifacts and reproduction

- [run.mjs](samples/codex-otel-token/run.mjs) — a self-contained local scenario with `assert` checks, the real CLI and the real collector.
- [result.json](samples/codex-otel-token/result.json) — the result of the successful run: command, versions, HTTP observations, CLI stdout, selected fields of the received OTLP envelope and the isolation check.

The remaining resource fields and event attributes, including user and host identifiers, are excluded from the saved envelope. The token, ports and temporary paths are replaced with markers. Auth files, authorization headers and provider request bodies are not copied into the repository. This is abbreviated evidence of the experiment, not a full R.4 reference package.

To reproduce from the repository root on macOS with Node 26 and Codex installed:

```sh
pnpm install --frozen-lockfile
pnpm build
node docs/research/samples/codex-otel-token/run.mjs > /tmp/catacomb-a5-result.json
```

The absolute path to the Codex binary can be passed as the scenario's first argument. A readable `~/.codex/auth.json` is required; it is copied into a new temporary profile and is not used to authorize the local provider. The scenario is not part of automated CI and does not launch Claude CLI or subagents.

## Checks and limits of the conclusion

Locally, `pnpm build`, `pnpm typecheck`, `pnpm lint` (including the comment check), `pnpm test` passed: 70 files and 1275 tests succeeded, 2 files and 24 tests skipped as expected. `pnpm e2e` exited with 0; there are no E2E tests in the current tree yet, the command uses `--pass-with-no-tests`. `node --check` verified the scenario's syntax; its run exited with 0 and verified A.5 acceptance.

The first full test run was mistakenly started before the build finished: 25 tests in `packages/catacomb/test/{access,commands,lifecycle}.test.ts` failed due to the missing `dist/main.js` and related timeouts. After the build finished, a full rerun was green; no product code changes were needed.

The conclusion is limited to the OTel path of `codex exec` version 0.160.0 on macOS arm64 with `source: Config`. It does not confirm an interactive human decision (`source: User`), TUI/managed daemon, Desktop, SDK, Linux or Windows, and does not extend the support matrix. Checks of the other surfaces and OSes remain in their own plan items. No new architectural decision was needed for A.5.
