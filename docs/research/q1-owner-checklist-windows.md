# Owner checklist Q.1: Windows

Status: instructions for plan item Q.1 (`docs/plan/mvp.md`) for native Windows. Performed by the owner. The outcome goes into the combined report `docs/research/q1-owner-checklist-results.md` as a separate section.
Date: 2026-10-07. The instructions for macOS, the Desktop SSH mode and OAuth on Linux are in `docs/research/q1-owner-checklist.md`.

## 0. What is verified

- The interactive Claude TUI: items (a)–(h) of section 6 of the spike on the release version. This is D.7 again: the `claude_cli` Windows `local` row requires this checklist (ADR-0010).
- An end-to-end check with aang itself: Claude TUI sessions are visible in the UI in both user scenarios.
- Claude Desktop and Codex Desktop on Windows are not verified in the MVP (ADR-0013, decision 3). The interactive Codex TUI on Windows is not included either: there are no reference Codex TUI recordings for Windows (plan, R.3), and the `codex_tui` Windows row stays without recordings.

The CLIs and SDKs of both runtimes on Windows were verified without the owner on the `windows-latest` runner (`docs/research/q1-surface-matrix.md`, section 2). This covers only the interactive terminal and your account.

All commands are PowerShell in a native console (Windows Terminal or a PowerShell window). A run in WSL is a Linux environment (ADR-0013) and does not close this item.

## 1. Preparation

You need Node 26, pnpm, Go, Git for Windows and Claude Code. Write down `claude --version` and the installation method (native installer or npm). If the version differs from 2.1.289 in `support/matrix.json`, note it: a new version needs reference recordings.

```powershell
Set-Location $HOME\src\aang
git switch master; git pull
pnpm install --frozen-lockfile
pnpm build
function aang { node "$HOME\src\aang\packages\aang\dist\main.js" @args }
```

Declare the `aang` function in every window where you need it.

## 2. Part 1: D.7 on the release version

Perform `docs/research/d7-owner-checklist-windows.md` in full (sections 2–5) with the working directory `$env:TEMP\aang-q1-d7`:

```powershell
node tools\owner-checklist\dist\main.js prepare --dir "$env:TEMP\aang-q1-d7"
```

The results are moved to `docs\research\samples\owner-checklist\q1-windows\`. Perform the rollback of part 1 before starting part 2.

## 3. Part 2: end-to-end check with aang

### 3.1. What changes

| What | How it is rolled back |
| --- | --- |
| The `aang` marketplace and the `aang@aang` plugin in Claude's user scope | `aang uninstall` |
| The `AANG_HOME` directory: `$env:TEMP\aang-q1\aang` | delete the directory |
| Sessions in `%USERPROFILE%\.claude\projects` | deleted by the owner |

`aang install` without flags on Windows installs only the Claude plugin; Codex hooks are installed separately with `--codex` (README, section "Windows"), and they are not needed here. While the plugin is installed, aang receives events from all Claude sessions, but only the probe repository is in scope.

### 3.2. Installation and startup

```powershell
$env:AANG_HOME = "$env:TEMP\aang-q1\aang"
$repo = "$env:TEMP\aang-q1\probe-repo"
New-Item -ItemType Directory -Force -Path $repo | Out-Null
git -C $repo init -q
git -C $repo commit -q --allow-empty -m init
aang install
aang start
aang watch $repo
aang open
```

Open the link in a browser. `aang status` should show Claude hooks as active. The aang observer calls your authorized `claude` and spends subscription tokens; the UI status bar shows the outcome of its admission. Write it down: storage of OAuth authorization on Windows is verified here for the first time (ADR-0013, decision 4).

### 3.3. Scenarios

In a separate window:

```powershell
Set-Location "$env:TEMP\aang-q1\probe-repo"
claude
```

1. **During work (E2E 1).** Prompt: "Create notes.txt containing one line about this repository with your shell tool, then use a subagent to list the files, then ask me one question with AskUserQuestion". When a permission request appears, wait 10 s and look at the UI: the run appeared on its own, the permission request is open in the attention zone and closes after you answer, the subagent and actions are visible, the question is visible until answered.
2. **Reconnection.** While Claude is waiting for an answer to the question, run `aang stop` in the preparation window, then `aang start`. Answer. There are no duplicate actions or questions, the question is closed.
3. **After the iteration (E2E 4).** «Отметить просмотренным» ("Mark as viewed") in the UI. Exit the session (`/exit`) and continue it: `claude --resume`, the same session, prompt "Append a second line to notes.txt". The «С последнего просмотра» ("Since last view") tab has a new version of `notes.txt` and a new action, and the cards lead to the transcript.
4. **Compaction.** `/compact`. The session continues in the UI without a gap.

For each item, write down the outcome, the surface label (`Claude Code CLI`), the session support mode, the version status in the status bar, and screenshots.

### 3.4. Rollback

```powershell
aang uninstall
aang stop
Remove-Item -Recurse -Force "$env:TEMP\aang-q1"
```

The probe repository's sessions in `%USERPROFILE%\.claude\projects` and the project entry in `%USERPROFILE%\.claude.json` are deleted by the owner.

## 4. Report

The Windows section in `docs/research/q1-owner-checklist-results.md`:

- Windows version, terminal, `claude` version and installation method, Claude's shell tool (`Bash` or `PowerShell`);
- part 1: items (a)–(h): expectation, observation, difference from D.7;
- part 2: items 1–4 with the outcome and notes, the outcome of the observer's admission.

The executor adds a `checklist: "tui"` entry for the `claude_cli` Windows `local` row in `support/verification.json` and recomputes the matrix (`docs/research/q1-owner-checklist.md`, section 7).
