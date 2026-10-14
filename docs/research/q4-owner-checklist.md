# Owner resilience checklist (Q.4)

Status: checklist for plan item Q.4 (`docs/plan/mvp.md`). The automated part is done by `tools/resilience`, the report is [`q4-live-resilience.md`](q4-live-resilience.md). This collects what the tool cannot check: Desktop, interactive TUIs on macOS and Windows, `/hooks` in the real interface, and the real model. Automated scenarios on native Windows run in CI.

## General conditions

The checklist does not change the owner's regular profiles — `~/.claude`, `~/.codex`, `~/.catacomb` and the Desktop login. Working Claude and Codex sessions run on the machine in parallel. catacomb hooks in the regular profile would write the full payloads of all those sessions to the spool, and an entry before catacomb in `~/.codex/hooks.json` would shift the positional trust keys of the entries after it.

**TUI and CLI (sections B and C) — in a separate profile.** All `catacomb`, `claude` and `codex` commands from these sections run in a single terminal in which the profile has been redirected.

macOS and Linux:

```sh
export CATACOMB_Q4="$(mktemp -d)/Όνομα Επώνυμο"
mkdir -p "$CATACOMB_Q4/έργο q4"
export HOME="$CATACOMB_Q4" CLAUDE_CONFIG_DIR="$CATACOMB_Q4/.claude" CODEX_HOME="$CATACOMB_Q4/.codex" CATACOMB_HOME="$CATACOMB_Q4/.catacomb"
```

Windows, PowerShell:

```powershell
$env:CATACOMB_Q4 = Join-Path ([IO.Path]::GetTempPath()) "catacomb-q4-$(Get-Random)\Όνομα Επώνυμο"
New-Item -ItemType Directory -Force (Join-Path $env:CATACOMB_Q4 'έργο q4') | Out-Null
$env:HOME = $env:CATACOMB_Q4; $env:USERPROFILE = $env:CATACOMB_Q4
$env:CLAUDE_CONFIG_DIR = "$env:CATACOMB_Q4\.claude"; $env:CODEX_HOME = "$env:CATACOMB_Q4\.codex"; $env:CATACOMB_HOME = "$env:CATACOMB_Q4\.catacomb"
```

Then in the same terminal:

1. Log in within the test profile: `claude`, then `/login`; `codex login`. The regular logins are not copied into this profile.
2. If catacomb is already running in the regular profile, the test daemon needs other ports: `{"api":{"port":4290},"otel":{"port":4291}}` in `config.json` of the test `CATACOMB_HOME` — `$CATACOMB_HOME/config.json`, in PowerShell `$env:CATACOMB_HOME\config.json`.
3. catacomb from this branch or release: `catacomb install`, `catacomb start`, `catacomb watch` for the `έργο q4` directory. Sessions B and C are started from this directory.
4. After the section: `catacomb stop`, close the sessions and delete the temporary profile directory together with the test logins.

Step 3 on macOS and Linux:

```sh
catacomb install && catacomb start
catacomb watch "$CATACOMB_Q4/έργο q4"
cd "$CATACOMB_Q4/έργο q4"
```

Step 3 in PowerShell:

```powershell
catacomb install; catacomb start
catacomb watch (Join-Path $env:CATACOMB_Q4 'έργο q4')
Set-Location (Join-Path $env:CATACOMB_Q4 'έργο q4')
```

Step 4 on macOS and Linux:

```sh
catacomb stop
rm -rf "$(dirname "${CATACOMB_Q4:?}")"
```

Step 4 in PowerShell:

```powershell
catacomb stop
Set-Location ([IO.Path]::GetTempPath())
Remove-Item -Recurse -Force (Split-Path $env:CATACOMB_Q4)
```

**Desktop (section A) — in a separate macOS user account.** Claude Desktop and ChatGPT read only the user's regular profile; it cannot be redirected. So section A is done in a test macOS account: catacomb is installed there (`catacomb install`, `catacomb start`), you log in to Claude Desktop and ChatGPT, and a test project is created for `catacomb watch`. catacomb is not installed in the main account for section A.

For all sections:

- Sessions are short: one or two commands like `echo`, usage — a few thousand tokens.
- The owner decides runtime permission prompts personally. The tool and the agents do not approve them.
- After each item: `catacomb status` (spool, lease, hooks state, gaps) and the run page in the UI.
- The result is recorded in the table at the end: "as expected", or an observation with a screenshot.

## A. Desktop on macOS (Claude Desktop and Codex Desktop)

| # | Steps | Expected |
| --- | --- | --- |
| A1 | Ask the session to run `sleep 20 && echo done`. While the command runs, find the daemon pid in `catacomb status` and run `kill -9 <pid>`. Wait for the end of the turn, then `catacomb start`. | The turn's actions are visible once each, the turn and the session are up to date, `catacomb status` shows an empty spool. Events that arrived while the daemon was down are not lost. |
| A2 | Run `catacomb stop` between two turns, make a turn, then `catacomb start`. | The turn made while catacomb was stopped is visible from files. The waits of this turn are not visible: this is a known limitation, hooks do not write while stopped. The next turn is again visible with hooks. |
| A3 | Codex Desktop: archive a thread in the interface, then unarchive it and continue. | The thread is not marked "source lost", actions are not duplicated (cf. `sources/codex-archive-unarchive-delete`). |
| A4 | Codex Desktop: delete a thread in the interface. | The session stays visible marked "source lost". |
| A5 | Claude Desktop, worktree mode: start a session in a worktree of a tracked repository. | The session comes into scope via the shared git directory and forms its own run. A directory match with another session does not link it to anything. |
| A6 | Claude Desktop: if the version has conversation branching, branch the conversation. | A new run with an "Common origin" link, no parent assigned (cf. `lineage/claude-forks`). |
| A7 | Close Desktop in the middle of a command and do not reopen it. | The session moves to "no new events" (`quiet`) after 5 minutes. The action remains running: this is finding Q4-5 of the report. |

## B. Interactive TUIs: macOS and Windows

| # | Steps | Expected |
| --- | --- | --- |
| B1 | Codex TUI after `catacomb install --codex`: open `/hooks`. | catacomb's entries are listed as untrusted. `catacomb status` shows Codex hooks `untrusted`. Until trusted, the session runs in "files only" mode. |
| B2 | Confirm trust for catacomb's entries in `/hooks`. | Without restarting the daemon, `catacomb status` shows `active`, a new session gets full mode. The tool checks this with a `hooks.state` record; here the real dialog is checked. |
| B3 | Repeat `catacomb install --codex`. Then insert into `hooks.json` of the test profile (`$CODEX_HOME/hooks.json`, in PowerShell `$env:CODEX_HOME\hooks.json`) your own `PreToolUse` entry before the catacomb entry. | After the repeated install, trust is preserved. After the insertion, `/hooks` shows the catacomb entry as untrusted, `catacomb status` — `untrusted`. |
| B4 | Claude TUI: `/clear` in the middle of a session, then `/resume` of the previous session. | After `/clear` — a new run with no link. After `/resume` the previous run gets a `resume` launch. |
| B5 | Claude TUI and Codex TUI: close the terminal window during a command. | As in A7. |
| B6 | Windows only, PowerShell: A1 and A2 for Claude CLI and Codex CLI, in a profile with a space and Greek letters in the path. The daemon in A1 is killed with `Stop-Process -Id <pid> -Force` instead of `kill -9 <pid>`. | As in A1 and A2. Spool and lease work through `catacomb stop` and `catacomb start`. Codex hooks on Windows are connected per the owner decisions of 2026-10-06 (PR #150). |

## C. Real model (optional)

| # | Steps | Expected |
| --- | --- | --- |
| C1 | One Claude CLI turn with the real model in the test profile (login via this profile's `/login`): command `sleep 15`, during it `kill -9` of the daemon, then `catacomb start`. | The same as `restart/claude-sigkill-mid-turn` on the stub. Usage — one short turn. |

## Results

| # | macOS | Windows | Notes |
| --- | --- | --- | --- |
| A1–A7 | | — | |
| B1–B5 | | | |
| B6 | — | | |
| C1 | | — | |
