# E2E (T.4)

E2E tests run in Playwright on top of the built daemon (`packages/aang/dist/main.js`), the player and fake CLIs (ADR-0012). A build is required before running: `pnpm build`, then `pnpm e2e`.

```ts
import { endpoints } from '@aang/contract'
import { sampleScenarioManifest } from '@aang/testkit'
import { expect, getWithoutKeepAlive, test } from './fixtures.js'

test.use({ config: { watch: { all: true } } })

test('a run from a sample is visible in the API', async ({ player, page }) => {
  await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
  await expect
    .poll(async () => {
      const response = await getWithoutKeepAlive(page.request, '/api/runs')
      return endpoints.runs.response.parse(await response.json()).runs.length
    })
    .toBe(1)
})
```

## Fixtures `e2e/fixtures.ts`

All fixtures are per test: each test has its own temporary HOME and its own daemon.

| Fixture | What it provides |
| --- | --- |
| `profile` | a temporary HOME from `testkit` (`createProfile`): `.claude`, `.codex`, `.aang`, the profile's config and environment |
| `fakeClaude`, `fakeCodex` | fake CLIs from `testkit` installed into the profile; the scenario is set by options or `setScenario`, inputs via `calls()` |
| `daemon` | a daemon started from the built `aang` in the profile; after the test it is stopped via the shutdown API and must exit with code 0 |
| `baseURL` | the daemon's address: relative paths of the built-in `page`, `context` and `request` go to it |
| `context`, `page` | a signed-in user: a one-time link from a real `aang open` is opened via `context.request`, the cookie is in the browser context |
| `request` | the built-in anonymous `APIRequestContext`, for 401 checks |
| `aang(...args)` | a command of the built `aang` in the profile's environment; returns stdout |
| `signInLink()` | a new unused one-time link from `aang open` |
| `player(manifest, { timeScale, recordTime, otlp })` | the `testkit` player with the profile's roots and a real `aang-hook` that writes to the profile's spool; `manifest` is a path or a loaded manifest; `recordTime: 'playback'` shifts the recording's times to the moment of playback, `{ startsAt }` to a given moment |
| `otelEndpoint()` | the address of the running daemon's OTel receiver with its intake token, for the player's `otlp` |
| `hook.claude(sample, fields)`, `hook.codex(sample, fields)` | a call to the real `aang-hook` with the payload of a sample from `docs/research/samples/claude-code-hooks` or `codex-cli/hooks` (the `stdin` field), whose fields are replaced with `fields` |

The sample sessions and their files in the profile are in `e2e/samples.ts` (`hookFields` gives `session_id`, `cwd` and `transcript_path` for the hook events of these sessions), shared screen locators are in `e2e/screens.ts`. Reference R.4 recordings are chosen by `e2e/recordings.ts`: the recording of the runner's OS, and if there is none, macOS; `through` (up to and including the label), `after` (after the label) and `startingAt` (from the label) cut a recording at the label of a control event, `tornAt(manifest, label, head, bytes)` moves the first `bytes` bytes of the append labeled `label` into the step labeled `head` before it, so that playing up to `label` breaks a file line in the middle, `filesOnly` keeps only the session files in it, without hook events and OTLP, `threadsOf` lists Codex threads in the order of their rollouts.

| Option (`test.use`) | Default | Meaning |
| --- | --- | --- |
| `config` | `{}` | daemon config on top of the `testkit` test values (ports 0) |
| `claudeScenario`, `codexScenario` | `{}` | scenarios of the fake CLIs |
| `signedIn` | `true` | `false` leaves `context` and `page` anonymous |

- Tests send requests through `APIRequestContext` (`page.request`, `context.request`, the anonymous `request`) with the `getWithoutKeepAlive(request, url, options)` function from `fixtures.ts`, and the sign-in of the `context` fixture goes through it as well. It sends a GET with `Connection: close`: each request has its own connection, and the daemon closes it after the response. Playwright keeps idle `APIRequestContext` connections in a pool with no expiry and ignores the daemon's hint `Keep-Alive: timeout=5`, while the daemon, like any Node `http.Server`, closes an idle connection after 6 s (`keepAliveTimeout` 5 s plus a 1 s margin). A request sent into such a connection around that moment is not read by the daemon and is reset, and the test fails with `read ECONNRESET`; if the daemon's event loop is busy ingesting records at that time, the window is wider. A single direct call puts a connection into the context's pool, and the next request may take it, so ESLint forbids calling `get`, `post` and other request methods directly on `request` in `e2e`.
- Daemon restart: `daemon.stop()` gracefully or `daemon.kill()`, which is SIGKILL (`TerminateProcess` on Windows); in that case the fixture does not stop it after the test. A new daemon is started by `profile.startDaemon({ entry: aangEntry })` after `profile.configure` with the same config and the `api.port` of the previous daemon: the open page reconnects to the same address. The test stops the restarted daemon itself.
- A failure in the middle of intake does not depend on the daemon's speed. The daemon picks up a spool file within milliseconds of it being written, and appended lines immediately via watch, and on Windows it manages to ingest everything written before `daemon.kill()`. So E2E 6 plays the recording up to the control label, appends the beginning of the next line without a newline (`tornAt`), waits via `/api/raw/:seq` until the daemon has ingested all complete lines and hook events, and only then kills the daemon. The collector does not accept a torn line, so there is always unaccepted data at the moment of the failure. The rest of the recording and new hook events arrive while the daemon is down. A spool file is deleted after the commit, so an ingested event may still be in the spool at the moment of the failure; after the restart it must not produce a duplicate.
- `recordTime: 'playback'` shifts the times in session files by a whole number of seconds: the first timestamp of the recording falls into the last second before the player was created. Hook events get the real time of intake. If the runner's hook processes are slower than in the reference (this happens on Windows), a file line written in the reference a second after a hook event can get an earlier time than it. That is how E2E 8 lost the link between an approval request and a call: the command output in the rollout ended up earlier than the request from the hook, the call was considered completed before the request, and the decision from OTel was attached to nothing. When a check requires the files of the second part of a recording to come after the hook events of the first, the second part is played by a separate player `startingAt(manifest, label)` with `recordTime: { startsAt: Date.now() + 1000 }`: its first timestamp falls into the nearest second after the current moment.
- Scanning of runtime roots is sped up: `collector.rootsScanIntervalMs` is 250 ms unless the test sets its own. There are no roots in a fresh profile yet, and the daemon notices a root that appears via a watch on the nearest existing parent (ADR-0004, decision 15). Watch is only a signal, and the faster scan keeps a missed notification from delaying a test by a minute.
- The admission call of the fake Claude lasts 1 s (`admissionMs`) unless the scenario sets its own, including after `setScenario`. While the call is running, its registry entry `~/.claude/sessions/<pid>.json` exists, and the admission check notices it by polling in the daemon's event loop. By default in `testkit` the call lasts 100 ms; under the load of the browser and record intake the daemon's loop is sometimes busy longer, the check does not see the entry, and admission is rejected as an isolation violation. So tests with a working observer (`map.test.ts`) wait in `beforeEach` for the outcome of Claude's admission in `/api/status` and require `admitted`: admission completes before recordings are played and the page is opened, not at the same time.
- The observer works in E2E by default: the fake CLIs pass admission, and 5 s after the oldest unprocessed fact of a run (ADR-0007) the observer calls the CLI. A scenario without `replies` answers with an error, and the rejected call goes into the observer log. So E2E 11 (`usage.test.ts`), which reconciles the observer and chat logs with the calls recorded in the database, runs with the LLM unavailable (`loggedIn: false` in both scenarios): Claude's admission is rejected, and for Claude runs the observer does not call the CLI, however long the test runs before the daemon is stopped.
- Map tests (`map.test.ts`) compare card coordinates only after `aria-busy="false"` on the map canvas (H.5, "Readiness"). Each `boundingBox` is a separate protocol call, and if the view changed between two calls, the coordinates belong to different map states. That is how card order checks failed while the map was fitted with React Flow's `fitView`: it deferred fitting until the nodes were measured, and nodes of the new layout stood under the previous view for tens of milliseconds.
- The fake CLI path (`fakeClaude.path`, `fakeCodex.path`) is written into `cli.claude` and `cli.codex` of the config on all OSes, and the daemon launches it like a real CLI. On macOS and Linux it is an executable script. On Windows the fake `claude` is `claude.exe` (the `testkit` exe shim runs `node` with the fake CLI script), and the fake `codex` is an npm package layout (`codex.cmd` and `node_modules/@openai/codex/bin/codex.js`), which the observer launches as `node` with the package script (ADR-0013).
- The `aang-hook` launcher is in `AANG_HOME/bin`, as after `aang install`: on Windows the observer launches CLIs through it (`aang-hook launch`, Job Object, ADR-0013).
- The OTel receiver token will be exposed externally by `otel-config` (G.12). Until then `otelEndpoint()` reads the token from the daemon's storage settings (read-only), and the port from `/api/status`.
- E2E tests with the observer (`inspector.test.ts`) set the fake `claude` scenario via `fakeClaude.setScenario` and therefore run only on macOS and Linux. The spike samples are dated 2026-10-01, and the observer queue keeps facts for 24 hours by their time (F.9), so such tests play the sample via `freshManifest` from `e2e/fresh.ts`: a copy of the sources in whose JSONL lines the `timestamp` values are shifted so that the last one falls on the current moment, while the intervals are preserved.
- The per-surface variants of E2E 1 (`surfaces.test.ts`, H.12) play the reference R.4 recording of the `subagents` scenario in full, with hook events and OTLP: Claude Code CLI, Claude Agent SDK, Claude Desktop, `codex exec`, Codex SDK and Codex Desktop. The run page is open before playback starts: the recording plays up to the first control event, then to the end, and the map grows without a reload. Each delegated agent gets its own nested stage; the evidence linking a stage's actions leads to the raw hook record from the spool and to a line of the agent's own transcript or rollout. Both fake CLIs answer with `live-map.live`: the Claude run is interpreted by the fake `claude`, the Codex run by the fake `codex`, and the test waits for this backend's admission. The adapter identifies the Codex Desktop surface only by `originator`, so the session is labeled «предположительно» ("presumably"). Codex TUI has no `subagents` recording in R.4, so there is no variant for it.
- The variants of E2E 4 (`since-last-view-variants.test.ts`, H.12) play the `tools` recording (Claude) or the `tools` and `question` recordings (Codex) up to the first tool call after the mark, mark the run as viewed and play the rest of the recording: Claude Code CLI, Claude Agent SDK, Claude Desktop, `codex exec`, Codex SDK and Codex Desktop. Desktop variants are skipped on Windows (ADR-0013, decision 3).
- The variant table for both scenarios is `e2e/variants.ts`: runtime, surface, engine version, recording scenarios, OS, whose recordings are the reference for the variant (`recordedOn`), and the OSes where the variant is skipped, with the reason (`skippedOn`). Tests build their variants from it and skip a variant on the runner's OS according to `skippedOn`, and `variantRecording` from `e2e/recordings.ts` takes the runner OS's recording if it is in `recordedOn`, otherwise the recording of the first OS in the list, macOS. Desktop recordings exist only for macOS: E2E 1 Desktop on Linux and Windows plays the macOS recording, E2E 4 Desktop on Windows is skipped. The Claude CLI 2.1.289 recordings for Linux and Windows were made in the `Scenarios` workflow, whose environment with `CLAUDE_AGENT_SDK_VERSION` got into the engine and the hooks, and the adapter attributes their sessions to Claude Agent SDK. So for the Claude Code CLI variant only the macOS recording is the reference, and on Linux and Windows the variant is skipped until these recordings are re-recorded (R.4).
- `support-matrix.test.ts` reconciles the variant table with `support/matrix.json` without a browser or a daemon. Every recording in `recordedOn` exists. A local row of the runner's OS where `during_work` (E2E 1) or `after_iteration` (E2E 4) equals `passed` has a variant of its surface and engine version that runs on this OS and plays its recording. And conversely: every such variant is marked `passed` in its row. A new variant or a reference recording for a new OS requires a mark in the matrix, and a mark without a variant breaks the test. The Docker, VM and Desktop SSH-mode rows take these columns from the local row of their OS on `pnpm support:update` (`tools/support/README.md`).
- E2E 3 (`inspector.test.ts`) runs on a temporary git repository in the `realpath(tmpdir())` directory: the watch root with a contract is set in `config` before the daemon starts. The input edit between check snapshots is made after the raw record of the `snapshot` channel for the start of the check has appeared in `GET /api/raw/:seq`.

## CI

The `CI` workflow (`.github/workflows/ci.yml`) calls `.github/workflows/check.yml` separately for Ubuntu, macOS and Windows, and a failure on one OS does not stop the others. Within a call, the jobs of one OS:

| Job | What it does |
| --- | --- |
| `build` | `pnpm build` and the `build-<OS>` artifact: the `dist` directories of packages and tools, `tsconfig.tsbuildinfo` of the `web` package and the Go binaries from `bin` |
| `typecheck, lint` | `pnpm typecheck` and `pnpm lint` on top of the build |
| `vitest i/n` | a part of `pnpm test --shard=i/n` with `codex` and `AANG_ISOLATION_CODEX` installed |
| `e2e i/n` | a part of `pnpm e2e --shard=i/n` |
| `package` | `pnpm test:package` on top of the build |
| `docker` | `pnpm test:docker`, on Ubuntu only |
| `coverage` | the combined coverage report of the OS from all Vitest and Playwright parts (section "Coverage") |

The number of Vitest and Playwright parts for each OS is set by `ci.yml`. Vitest splits files by path hash, Playwright by the number of tests in files, so the parts come out unequal. On Windows, Vitest files run one at a time (`vitest.config.ts`), and there are more parts there.

The build is done by one job per OS, the others unpack its archive over the checkout (`tar -xm`, files get the unpacking time), and `tsc -b` in `typecheck, lint` considers the build projects up to date and checks only the test projects. The Playwright browser is cached by OS and the hash of `pnpm-lock.yaml`, the pnpm store via `actions/setup-node`.

macOS and Windows jobs run on push to `master` and on PRs not in draft status. Draft PRs are checked only on Ubuntu, and moving a PR from draft to ready for review (`ready_for_review`) triggers a full run on all three OSes. A new push to the same branch cancels an unfinished run.

## Coverage

`pnpm coverage` combines V8 coverage into a single `c8` report:

1. `coverage:test`: Vitest under `c8`, raw data in `coverage/tmp`;
2. `coverage:e2e`: Playwright under `c8 --clean=false`. Daemons and `aang open` inherit `NODE_V8_COVERAGE` through the profile's environment and write coverage on graceful shutdown. The `page` fixture takes Chromium JS coverage and writes it for the `web` build into the same directory; `c8` maps it to sources via source maps;
3. `coverage:report`: the combined report and `aang-hook` coverage.

After the wrapped command exits, `c8` merges the whole `coverage/tmp` directory, even with `--reporter=none`. So CI collects the same raw data without intermediate `c8` merges: each Vitest and Playwright part runs with `NODE_V8_COVERAGE=coverage/tmp`. The raw files of one part are large, and at the end of the part they are merged by `tools/coverage`: it keeps the scripts and source maps that match `include` and `exclude` from `.c8rc.json`, merges them with the same `mergeProcessCovs` from `@bcoe/v8-coverage` that `c8` uses with `mergeAsync`, and writes one V8 file of the same format. Vitest parts put `aang-hook` coverage from `coverage/hook` next to it. The `coverage` job collects the files of all parts of its OS into `coverage/tmp`, merges the `aang-hook` coverage directories with `go tool covdata merge` and runs `coverage:report`. Paths in the data are absolute, and the workspace directory is the same for all jobs of one OS, so the report finds the sources and source maps of the unpacked build. When an E2E part fails, `test-results/` with Playwright traces is uploaded.

A raw file is written by every Node process with `NODE_V8_COVERAGE`: Vitest workers, daemons, CLIs, the fake `claude` and `codex`. The file contains all scripts of the process: Node internal modules, `node_modules` and a copy of the source map of every loaded `dist` module, and less than a tenth of it falls under `include`. So `mergeAsync` is enabled in `.c8rc.json`: `c8 report` reads files one at a time, discards scripts outside `include` and `exclude` and merges the rest into the summary, and the report's memory does not grow with the number of processes. Without it `c8` keeps all parsed files in the heap at once, more than their size on disk, and as the test suite grew the report hit the 6 GB limit: on Linux within one to two minutes, on macOS after 6–13 minutes, because the runner has 7 GB of memory and garbage collection goes into swap. The heap limit of `coverage:report` stays at 6 GB: the report needs a few hundred megabytes, and a larger limit on macOS runs into physical memory. Pairwise merging of V8 ranges splits some branches differently than merging all files at once and depends on file order: branch percentages shift by tenths, while lines, statements and functions are the same. Merging per part also changes the order, with the same branch shift. There are no coverage thresholds in CI.
