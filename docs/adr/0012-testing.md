# ADR-0012: Testing strategy

Status: accepted by the owner 2026-10-01.

## Context

AGENTS.md sets the testing rules: unit tests only by exception, 100% of business logic and scenarios through E2E, functional and integration tests, mocks only at external boundaries. ADR-0001 chose Playwright and Vitest with real SQLite and real processes. The external boundaries of aang are the Claude Code and Codex runtimes (their files, hooks, OTel) and the CLIs through which the observer and the chat work.

## Decision

### External boundaries and their replacements

- **Runtimes.** Instead of live CLIs, tests use the `testkit/player` player. It replays reference sessions (ADR-0010) and the `docs/research/samples` samples in a temporary HOME the way the runtime does:
  - appends transcript and rollout lines with the original (scalable) intervals;
  - writes and updates JSON files (meta, registry, teams);
  - calls the real `aang-hook` with the event payload in stdin;
  - sends recorded OTLP logs to the receiver;
  - deletes, moves and archives files.
- **LLM.** Fake `claude` and `codex` executables (`testkit/fake-cli`) are substituted via the CLI paths in the daemon config. They:
  - check for the presence of isolation flags and fail if a flag is missing;
  - emit `init`, the result and `--json` events in the format of the real CLI; the fake `codex` sends a real Responses API request to the self-check stub;
  - respond according to a scenario: the response is built from the input and references fact ids and the `model_version` from it;
  - can inject failures: an authorization error, a limit, a timeout, invalid JSON, the `unsupported` string;
  - record inputs for assertions.
- **Third-party processes during installation** (`claude plugin …`, `codex app-server` for `hooks/list`) are replaced with fake executables.
- **Own modules are not mocked.** A module is tested through its public API with a real `store` on a temporary SQLite file. Functional `engine` tests feed raw records from samples and reference sessions through the real adapters: tests are allowed to import adapter packages, `engine` product code is not. Observer responses in these tests are external-boundary (LLM) data, so they are set by fixtures.
- **Failures are simulated externally.** A process is terminated with SIGKILL and restarted, files are corrupted and deleted. There are no test failure points in the product code.

### Levels

| Level | Tool | What it covers |
| --- | --- | --- |
| E2E | Playwright on top of the built daemon, the player and the fake CLI | user scenarios of RFC §2, §5, §8 through the UI and API |
| Integration | Vitest | `aang-hook` (the real binary on each OS, spool lease); the collector on real files (appending, incomplete lines, inode change, move, archive, loss); double hook registration and repeated identical requests; `prune` followed by a file move and a restart; adapters on samples; API and SSE over real HTTP; installation into a temporary HOME; observer launch and version admission with the fake CLI |
| Functional | Vitest | `engine` through the public API: run linking, rules, three axes, validation of observer operations, view rules, the "since last view" diff, usage accounting |
| Contract | Vitest | strict mode of the observer and chat schemas; reference sessions by version — in CI; observer isolation: Codex on the stub — in CI, Claude — locally (ADR-0010) |

### Mandatory E2E scenarios

| # | Scenario | Runtime | Requirement source |
| --- | --- | --- | --- |
| 1 | Live observation with a subagent and parallel agents: map, inspector, evidence down to the source event | both; CLI, Desktop, SDK variants | RFC §2, §5, §9 |
| 2 | An approval request appears in the attention zone within ≤ 1 s while the LLM is unavailable | both | RFC §8 |
| 3 | "All done" with a failed check: a conflict on the stage, the attention item remains. A successful contract rerun where the check reports the verified commit gives `confirmed`; a subsequent edit under the mask gives `stale`. A contract rerun without a reported commit gives `passed_unversioned`, including with a clean tree before and after the check and when the input changes and is reverted between snapshots | Claude | RFC §2, §6 |
| 4 | Marking as viewed, the run continues, the «С последнего просмотра» ("Since last view") mode with a replaced stage, a new result and a question; final text cards lead to the original | both; CLI, Desktop, SDK variants | RFC §2, §5 |
| 5 | Chat: an answer with references and the map version; «сверни ревьюеров» ("collapse the reviewers"); undoing the rule; questions are visible | both | RFC §5 |
| 6 | SIGKILL of the daemon in the middle of playback and a restart: no duplicates, cursors, the mark and the rules are restored, hook events from the spool are not lost | Claude | RFC §8 |
| 7 | LLM failure: facts keep flowing, the model age grows, the state is visible; recovery and catch-up mode | Codex | RFC §8 |
| 8 | Hooks with `PermissionRequest`, a decision via OTel (`source: User`), a subagent, a fork as a new run with a link | Codex | RFC §4, §6 |
| 9 | A session without hook events: «hooks не активны» ("hooks inactive"), «только файлы» ("files only") mode | both | ADR-0004 |
| 10 | Distinguishing «ждёт человека» ("waiting for a human"), «нет новых событий» ("no new events"), «источник потерян» ("source lost") | Claude | RFC §6, §8 |
| 11 | Claude fork: shared origin, no double usage; a usage panel with three journals | Claude | RFC §8 |
| 12 | Claude compaction: a false `SubagentStop` does not turn into an agent | Claude | ADR-0006 |
| 13 | Access without a token is rejected; a one-time link works | — | ADR-0003 |
| 14 | A new model version does not reset the selected stage; when a stage is replaced, the selection moves to its successor | Claude | RFC §5 |
| 15 | A session ended with an unanswered question and a review request: on return both are in the attention zone, the stage is not in `waiting`; a new off-topic prompt does not close them; an answer to an asynchronous Codex question gives the «вероятно отвечен» ("probably answered") mark, while the item stays open; dismissal by the user removes the item with a history entry | both | RFC §2, §5 |
| 16 | Marking as viewed → LLM failure → a new artifact version and a question by a rule → return: both are visible in the changes mode; after a restart and observer recovery they are not announced again | Claude | RFC §5, §8 |
| 17 | A report created via Bash becomes evidence; the source file is changed and deleted, the daemon is restarted; the inspector opens the saved version | Claude | RFC §6, §7 |
| 18 | A chat question about an old piece of evidence that is not in the first input: an answer via `needs` with a reference to that evidence and the same map version | both | RFC §5 |

### Unit tests

A unit test is allowed only for fragments that cannot be adequately checked at a higher level. Every unit test is justified in the PR description: what exactly the integration or functional scenario does not cover. There are no pre-approved unit tests. A split multibyte character is checked by the collector's integration test on a real file, and id stability after `reparse` by a functional `engine` test.

### Coverage and CI

- **Coverage.**
  - V8 coverage of the daemon and the CLI is collected during integration and E2E runs and merged via `c8`.
  - `web` coverage — via Chromium JS coverage in Playwright.
  - The goal is 100% of lines of all TS packages except `testkit`; exclusions are listed explicitly in the coverage config.
  - `aang-hook` coverage is collected during integration tests via `go build -cover`.
- **Scenario matrix.** The "RFC scenario → E2E test" mapping is maintained in `docs/plan/mvp.md`.
- **CI on every PR** — GitHub Actions on a macOS, Linux and Windows matrix (ADR-0013):
  - a ban on comments in all repository languages (TS, Go, SQL, YAML, CSS); exceptions are the shebang and syntactically significant directives;
  - linter and type checking;
  - integration, functional and contract tests on fixtures;
  - E2E in Chromium.
- Claude isolation tests on the real CLI run locally before declaring support for a version.

## Consequences

- Tests check behavior on the same data that the real runtimes write.
- Reference sessions, the player and the fake CLI are shared infrastructure. It must be built before mass E2E (plan, stage 1).
- An error in the semantic interpretation by a real LLM is not caught by tests; it is a matter of product validation (RFC §9).

## Owner decisions

Accepted by the owner 2026-10-01:

1. The goal is 100% of lines of all TS packages, including `web`, and of the `aang-hook` handler through E2E, integration and functional tests; exclusions are listed explicitly in the coverage config and justified in the PR.
