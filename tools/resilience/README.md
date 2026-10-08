# Live resilience scenarios (Q.4)

`tools/resilience` drives the installed `claude` and `codex` CLIs against the built aang daemon and disrupts them the way real use does: the daemon is killed or stopped mid-session, sources are deleted, moved, archived and forked, hooks fail or lose their trust, hooks and files disagree. Each scenario checks what the daemon API then shows against ADR-0004, ADR-0005 and ADR-0006 and writes a report. The research report is `docs/research/q4-live-resilience.md`.

```sh
pnpm build
node tools/resilience/dist/main.js --list
node tools/resilience/dist/main.js --out resilience-report
node tools/resilience/dist/main.js --out resilience-report --only sources --only hooks/codex-hooks-trust
```

| Option | Meaning |
| --- | --- |
| `--out` | report directory: `report.json` and `summary.md` (default `resilience-report`) |
| `--only` | an area (`restart`, `sources`, `hooks`, `divergence`, `lineage`) or `area/name`; repeatable |
| `--claude`, `--codex` | CLI executables; default: found as `tools/record` finds them (`PATH`, the native Claude install, the Codex executable of the npm package on Windows) |
| `--aang` | entry of the built aang package (default `packages/aang/dist/main.js`) |
| `--keep` | keep the temporary profile of each scenario and print its path |
| `--list` | print the scenario names |

## Isolation

- Every scenario runs in its own temporary profile from `@aang/testkit`: `HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `AANG_HOME` are temporary, with a project directory whose name has a space and Cyrillic letters. The owner's `~/.claude`, `~/.codex`, settings, plugins, MCP servers and logins are neither read nor changed, and nothing is copied out of them.
- The model is the scripted stub of `tools/record`: an Anthropic Messages endpoint for Claude (`ANTHROPIC_BASE_URL` with a stub key) and a Responses endpoint for Codex (a provider without authorization in the temporary `config.toml`). No real model is called and nothing is spent.
- Hooks are installed by the product command `aang install` into the temporary profile. Codex hooks are trusted by writing `hooks.state` with the hashes `hooks/list` reports, as `/hooks` would; the owner's trust is never touched.
- The daemon gets gate executables as `cli.claude` and `cli.codex`: they pass `plugin` (Claude), `app-server` (Codex) and `--version` to the real CLI and refuse everything else. The hook state checks therefore use the real CLIs, while the observer and chat cannot start a model session.
- Scenarios run one after another, so at most one solver CLI runs at a time.
- A step that must happen while a tool runs uses a gate: the stub asks the CLI to run `node gate.mjs <name>`, which waits until the scenario opens it.

## Report

Each scenario records its steps with times, its checks (expected and observed) and observations. A check that fails because of a documented finding carries `known` with the finding id from `src/findings.ts`; such a scenario is `known`, not `failed`, and does not fail the run. The process exits with 1 only for unexpected failures.

The report replaces the temporary and home directories with `<tmp>` and `~`, also inside the Claude project directory names that encode them, and is not written if it still names a user path.

A daemon exit or a cleanup step of a scenario that does not finish within 60 s fails that scenario. The tool then kills the daemons and CLIs the scenario started, their descendants and the processes whose command line names the profile, and the report lists them. Every cleanup step runs even when an earlier one fails, the scenario reports all their errors, and the cleanup ends with the same kill of whatever still runs, so no process of a scenario outlives it.

The `Resilience` workflow runs all scenarios on Linux, macOS and Windows with the CLI versions pinned in it and uploads the report. On Windows Claude runs its Bash tool in Git Bash and Codex its commands in PowerShell; the gate command works in both.
