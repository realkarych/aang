# End-to-end surface matrix (Q.1)

Status: report on the automated part of item Q.1 of the plan (`docs/plan/mvp.md`). This is not an ADR: the questions for the owner to decide are collected in section 6; the owner checklists are `docs/research/q1-owner-checklist.md` (macOS, Desktop SSH mode, OAuth on Linux) and `docs/research/q1-owner-checklist-windows.md`.
Date: 2026-10-07. Branch: `feat/q1-surface-matrix`.

## 0. Scope, versions, method

Q.1 checks each surface through the whole product: a real CLI or SDK → the hooks installed by `aang install` → a running daemon → API and UI. The contract run (R.5a, R.5b) and E2E (H.12) check the same on playback of reference recordings; here it is the live path in every placement of the ADR-0010 matrix that can be brought up without the owner.

**Versions** are the same as in the R.4 reference recordings and in `support/matrix.json`: Claude Code 2.1.289, Claude Agent SDK 0.3.289 (engine 2.1.289), Codex CLI 0.160.0, Codex SDK 0.160.0; Node 26. The model is the `tools/record` stubs (Messages API and Responses API); no real model was called, and there is no authorization.

**Method.** The `tools/surface-check` tool (`tools/surface-check/README.md`), the `Surface matrix` workflow (`.github/workflows/surfaces.yml`).

- Each scenario of the `tools/record` catalog runs in its own temporary profile, as during recording: the same CLI and SDK hosts, the model stub, the scenario's own checks, its plugin and spool. On top of that, aang is connected via the product path and in README order: `aang install --claude` or `--codex` with the daemon stopped before the scenario's first command, `aang start`, `aang watch <project>`, Codex OTel export to the daemon's receiver. Before each scenario command, `aang status` drives the daemon's hook check to completion (section 6, item 6). In `reconnect`, the daemon is restarted at the `daemon-restart` checkpoint.
- After the scenario, when the spool is empty and the daemon's change sequence has not grown for 2 s, the tool reads `/api/status`, `/api/runs` and each run, and after the daemon stops, its store, and requires: the run exists; every session is labeled with the scenario's surface; `/api/status` lists the version `(runtime, surface, OS, placement, engine version)`; Claude hooks are active; `reconnect` restarted the daemon; runs, sessions (version, support mode, number of unrecognized records), agents, actions by tool and outcome, questions by kind, attention items by kind and author, and raw event records (hooks, rollout, transcript `user`, `assistant`, `attachment`, `system` lines) by type and parse state match the contract run snapshot of the reference recording of the same version, surface, OS and scenario (`support/contract`).
- Question decisions and attention item resolutions are compared, but a mismatch does not fail the check; it goes into notes: in the contract run they depend on the playback time (section 6, item 2). After the contract run is fixed, they are compared strictly.
- The scenario set (`core`): `tools`, `subagents`, `resume`, `compaction`, `reconnect`, `approval`, `question` — those of them that the surface has on this OS. These are the RFC §2 user scenarios as far as facts go (actions, child agents, waits and questions) and the matrix columns: resume, compaction, child sessions, reconnection.
- UI access: login via a new `aang open` link, the run list and marking as viewed (`POST /api/runs/:run/viewed`) with the `Origin` of the page the browser would have opened.

**Placements.**

| Placement | Where | UI access |
| --- | --- | --- |
| `local` | `ubuntu-latest`, `macos-latest`, `windows-latest` runners | loopback |
| `docker` | a container of the `aang` image (`Dockerfile`) with real CLIs and SDKs (`tools/surface-check/surface.Dockerfile`), Linux runner | published port 4280; another port 4380; container address |
| `vm` | Ubuntu 24.04 cloud image under QEMU/KVM on a Linux runner, aang deployed in the VM the same way as in the image | `ssh -L 4280:127.0.0.1:4280`; `ssh -L 4380:127.0.0.1:4280` |
| `desktop_ssh` (emulation) | the same VM, the check launched over SSH | `ssh -L 4280:127.0.0.1:4280` |

**Limitations:**

- the model is fake: event delivery, parsing and observation objects are checked, not the observer's map (the observer has no authorization; the daemon runs without a map);
- `desktop_ssh` is an emulation: the Claude Desktop and Codex Desktop engines are replaced with CLIs with the Desktop flags and environment from `tools/record`. What Desktop actually installs and runs on a remote host is checked only by the owner; the emulation does not create `desktop_ssh` matrix rows;
- the VM is a guest OS on a CI runner, not a user's machine; the "other machine" for the UI is the runner itself through an SSH tunnel.

## 1. Key findings

1. **All surfaces available without the owner pass the end-to-end check** natively on three OSes, in Docker and in a VM: Claude CLI, Claude Agent SDK, `codex exec`, Codex SDK and Codex TUI (except Windows). The objects and raw event records shown by the live daemon match the reference recordings of the same versions. Details are in sections 2, 3 and 8.
2. **`aang install` did not work in the Docker image** (`ENOENT`: the image did not put the binary where the installer looks for it). Fixed in `Dockerfile`; the Docker image smoke test checks installation.
3. **aang reads the R.4 Claude CLI recordings for Linux and Windows as Agent SDK sessions.** The `Scenarios` workflow set the SDK version via the `CLAUDE_AGENT_SDK_VERSION` variable; it got into the engine and hook environment, and the adapter uses it to detect the SDK. The recorder no longer inherits this variable, and the workflow does not set it; the recordings need to be re-recorded (section 6, item 1).
4. **The contract run evaluates Claude permission requests differently from the live daemon**: "answer unknown, the wait ended without an answer" instead of "approved" or "rejected" (section 6, item 2).
5. **The UI through a tunnel or a published port with a different number, and through an explicit `--bind`, works read-only**: changes get 403 under the ADR-0003 `Origin` rule. The README now says so; the question for the owner is section 6, item 3.
6. **On Windows, the daemon's `codex app-server` and the user's Codex interfere with each other when starting simultaneously**: installing Codex hooks while the daemon was running failed on a timeout, and the scenario's `app-server` failed with a state initialization error (section 6, item 6).
7. **OAuth path on Linux**: Claude logs in with a code from the host browser without publishing ports; Codex in a container logs in only via device code (section 4). Login with a real account is in the owner checklist.
8. **Matrix**: the Linux `docker` and `vm` rows received a placement check; the user scenario columns are filled from E2E 1 and 4 on reference recordings; for Desktop and Claude TUI the matrix requires the owner checklist (section 7).

## 2. Native OSes

Runs of this PR's `Surface matrix` workflow, the `native` job, `local` placement; `ubuntu-latest`, `macos-latest`, `windows-latest` runners. Reports are the `surface-check-Linux`, `surface-check-macOS`, `surface-check-Windows` artifacts (section 8).

| Surface | Scenarios | Linux | macOS | Windows |
| --- | --- | --- | --- | --- |
| Claude CLI (`-p`, stream-json) | `tools`, `subagents`, `resume`, `compaction`, `approval`, `question`, `reconnect` | ✔ | ✔ | ✔ |
| Claude Agent SDK 0.3.289 | the same | ✔ | ✔ | ✔ |
| `codex exec` | `tools`, `subagents`, `question`, `compaction`, `reconnect` | ✔ | ✔ | ✔ |
| Codex SDK 0.160.0 | `tools`, `subagents`, `question`, `resume` | ✔ | ✔ | ✔ |
| Codex TUI (`expect`) | `tools`, `approval` | ✔ | ✔ | — |

- **macOS.** The column is based on the final run from section 8, artifact `surface-check-macOS`: all scenarios of all five surfaces were reconciled with the macOS reference recordings, UI access — marking returns 200. In earlier runs this job was cancelled by a new commit before it got a runner.

- **Windows.** `aang install --claude` installs the plugin via a local marketplace, Claude hooks are active; `aang install --codex` writes PowerShell lines. Sessions of all four surfaces are visible to the daemon with hooks and files (`full` mode); objects and raw event records match the Windows reference recordings. Codex TUI does not run on Windows: it needs a ConPTY host (plan, R.3), and there are no recordings for Windows; in the report it is `not_run`, not passed.
- **Claude CLI on Linux and Windows** passes the check, even though aang reads the reference recordings of these OSes as Agent SDK (section 6, item 1): the check compares the live session's surface with the scenario, not with the snapshot. The live CLI session is labeled `claude_cli`.
- In all runs with Claude permissions and in Codex TUI `approval`, the live daemon's decision on the request is `approved` or `rejected`, the snapshot's is `unknown` (report notes; section 6, item 2).
- The number of Claude transcript service lines (`last-prompt`) varies from run to run; such lines are notes in the check, not errors (`tools/surface-check/README.md`).

## 3. Docker, VM and SSH mode

| Placement | Where | Surfaces | Scenarios | UI access |
| --- | --- | --- | --- | --- |
| `docker` | container on `ubuntu-latest`, `aang` image + CLI 2.1.289 and 0.160.0, SDK | Claude CLI, Claude Agent SDK, `codex exec`, Codex SDK, Codex TUI | as in section 2 | port 4280 → 4280: login, list, marking — 200; port 4380 → 4280: list present, marking — 403; container address `172.17.0.2:4280`: list present, marking — 403 |
| `vm` | Ubuntu 24.04.5 under QEMU/KVM on `ubuntu-latest`, 3 vCPU, 8 GB | the same | as in section 2 | `ssh -L 4280:127.0.0.1:4280`: 200; `ssh -L 4380:127.0.0.1:4280`: marking — 403 |
| `desktop_ssh` (emulation) | the same VM, the check launched over SSH | Claude Desktop (engine — Claude CLI 2.1.289), Codex Desktop (engine — `codex app-server` 0.160.0) | `tools`, `subagents`, `resume`, `compaction`, `approval`, `question`, `reconnect`; Codex — `tools`, `approval`, `subagents`, `question` | `ssh -L 4280:127.0.0.1:4280`: 200 |

- **Docker.** The daemon recognizes the container by itself: `/api/status` lists versions with the `docker` placement (`claude claude_cli linux docker 2.1.289`, etc.). `aang install` in the container works after the `Dockerfile` fix (section 1, item 2).
- **VM.** aang is deployed in the guest system the same way as in the image: `pnpm deploy` of the `aang` package, the support matrix, a link to `aang-hook`. The `vm` placement is set in the config (`placement`), and `/api/status` lists `claude claude_cli linux vm 2.1.289`. Node 26 in the Ubuntu cloud image needs `libatomic1`.
- **SSH mode, emulation.** Engines launched on the VM over SSH with the Desktop flags and environment produce sessions with the `claude_desktop` and `codex_desktop` surfaces and versions `… linux desktop_ssh …`; aang hooks from the user scope and `hooks.json` work in the SSH session environment without a shell profile. There is no comparison with snapshots: there are no Desktop engine recordings for Linux.
- The `docker` and `vm` rows received a placement check in `support/verification.json` from the reports of these jobs (`placement import`, section 7). The emulation does not create `desktop_ssh` rows.

## 4. OAuth path on Linux

Checked in a container of the `aang` image with Claude Code 2.1.289 and Codex 0.160.0 as the `node` user, without a browser:

- `claude auth login` prints "Opening browser to sign in…", then the link `https://claude.com/cai/oauth/authorize?…&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&…` and waits for "Paste code here if prompted". The callback goes to an Anthropic page that shows the code, so the container port does not need to be published: the link is opened in the host browser, and the code is pasted into `docker exec --interactive --tty`. The same path works on a VM via `ssh -t`.
- `codex login` brings up a login server on `localhost:1455` inside the container with `redirect_uri=http://127.0.0.1:1455/auth/callback` and itself suggests `codex login --device-auth` for a remote machine. The host browser will not reach this server even with a published port: the server listens on the container's loopback. On a VM, an `ssh -L 1455:127.0.0.1:1455` tunnel or device-code login works. There are also `--with-api-key` and `--with-access-token`.
- Before login, `claude auth status` gives `{"loggedIn": false, …, "configDirectory": "/home/node/.claude"}`, and `codex login status` gives `Not logged in`, both with exit code 1.
- The aang observer launches the CLI in a clean environment with the user's `HOME` (ADR-0007), so it takes the authorization from the default profile. A login with `CLAUDE_CONFIG_DIR` or `CODEX_HOME` other than the default will not be seen by the observer.

Login with a real account, the location and permissions of the authorization files, and observer admission with this authorization are in `docs/research/q1-owner-checklist.md`, section 5. The README ("Docker" section) describes this path instead of the "not verified" note.

## 5. Desktop limitations for the owner's decision

RFC §4 requires bringing Desktop limitations to the owner rather than silently excluding the surface. Known so far:

**Owner decision 2026-10-08:** limitations 1–6 are accepted as known MVP limitations. The README lists them in the "Desktop limitations" section.

1. **Desktop on Windows is not checked** in the MVP (ADR-0013, decision 3); the rows are `unverified` with a reason.
2. **The live GUI of both Desktops is not checked automatically.** Reference recordings and Desktop E2E run on the Desktop engines in emulation (R.2, R.3); ADR-0010 requires a manual checklist. The matrix now keeps the reason "no owner checklist" in the Desktop rows (section 7); the D.7 checklist has not yet been completed by the owner.
3. **SSH mode of both Desktops is checked only in emulation.** It is unknown which engine, of which version and with which settings sources Desktop launches on a remote host; this determines whether the aang user plugin loads and how sessions are labeled. There are no Desktop engine recordings for Linux, so the `desktop_ssh` rows will remain without contract columns even after the checklist, until such recordings appear (the plan, R.2, does not provide for them).
4. **The adapter distinguishes Codex Desktop only by `originator`**; the UI labels it "(assumed)" (H.12).
5. **Sessions spawned by Desktop** (spawn task, Dispatch, scheduled tasks) are linked to the parent only through Desktop metadata; the link format is checked by the D.7 checklist, step 3a.
6. **Desktop engine versions are updated by the application itself** and lag behind the CLI (currently 2.1.286 for Claude Desktop and 0.159.2 for Codex Desktop with CLI 2.1.289 and 0.160.0). Each new version requires reference recordings (ADR-0010, decision 1), otherwise the row is `unverified`.

## 6. Findings and questions for the owner

1. **Re-recording R.4 Claude CLI for Linux and Windows.** In the `fixtures/sessions/claude/2.1.289/claude_cli/{linux,windows}` recordings, every spool file contains `CLAUDE_AGENT_SDK_VERSION=0.3.289`, and the `support/contract` snapshots show their sessions as `claude_sdk`. The macOS recordings were made locally and are correct. Fixed in this PR: the recorder does not inherit `CLAUDE_AGENT_SDK_VERSION`, and the version variables of the `Scenarios` workflow got the `AANG_` prefix. The re-recording is a separate recordings PR (R.4); until then the Linux and Windows `claude_cli` rows get no user scenarios, and the Claude CLI E2E variants run only on macOS. A contract run invariant is also proposed: the surface of a recording's sessions equals the surface of its manifest; right now it would break CI on these two recordings.
2. **Time in the contract run.** `tools/support` replays recordings without `recordTime`: transcript and rollout lines keep the recording time, while hooks arrive with the playback time. A permission request (`PermissionRequest`, playback time) ends up later than the completion of its action in the transcript (recording time), and the engine does not link them: the snapshots show `permission unknown` and `ended_without_answer`. The live daemon and E2E (`recordTime: 'playback'`) see `approved` or `rejected` and `answered`, as in the scenario. This mismatch is present in all Claude scenarios with permissions and in Codex TUI `approval`. It is proposed to replay the contract run with the recording time shifted to playback (R.5, a separate PR with snapshot regeneration); until then `tools/surface-check` records such mismatches as notes. **Fixed after Q.1:** the contract run replays the recorded timeline on a single clock shifted to playback (`tools/support/README.md`, "Record time"); the snapshots were regenerated, and the question decisions and attention item resolutions match all 123 scenarios of the live daemon in the final run of section 8, and `tools/surface-check` compares them strictly.
3. **`Origin` and the remote UI.** Under decision 1 of ADR-0003, state-changing requests with a cookie are accepted only from `http://127.0.0.1:P` and `http://localhost:P`, where P is the daemon port. Checked in Docker and the VM: a tunnel or publication with the same port — reads and writes work; a different local port and the host address with `--bind` — reads work, marking as viewed returns 403. So the "explicit bind to an interface with a token" mode from the same ADR gives a read-only UI: marks, dismissing attention items, view rules and the chat are unavailable. A decision is needed: leave it as is (the README already says that the full UI needs a tunnel with the same port) or allow external origins set in the config.
4. **Fresh profile.** In a new container or VM, the runtime roots (`~/.claude/projects`, `~/.codex/sessions`) do not exist until the first session; the daemon notices them with a scan once every 60 s, and the files of the first session become visible with that delay (hooks arrive immediately). The check creates the roots in advance, as in a profile where the runtime has already been launched. The README ("Docker" section) describes this. No decision is needed if the first-session delay is acceptable.
5. **Claude TUI on Linux.** ADR-0010 requires checklist (a)–(h) for the interactive Claude TUI, while the plan (D.7, Q.1) assigns it to the owner only on macOS and Windows. The matrix requires the checklist for `claude_cli` rows on all OSes, so the Linux rows (`local`, `docker`, `vm`) keep this reason. A decision is needed: a checklist on Linux, or TUI recordings in `expect` (`teammates`, `input-dialogs`) are enough. **Owner decision 2026-10-08:** on Linux, TUI recordings in CI are enough, no manual checklist is needed (ADR-0010, decision 4); the matrix no longer requires the TUI checklist for the Linux `claude_cli` rows.
6. **Parallel `codex app-server` on Windows.** In the first run on `windows-latest`, the daemon was started before `aang install --codex`, as happens for a user who installs hooks while aang is running. `aang install --codex` failed three times out of five on the `codex app-server: timed out after 10000 ms` timeout, and the `codex app-server` of the Codex SDK `question` scenario exited with "failed to initialize sqlite state runtime under …\.codex". At that time the daemon itself launches `codex app-server` to check hooks (G.7): on every change of `hooks.json` and `config.toml`, on all OSes and even without aang hooks installed. After installation was done with the daemon stopped (README order), and every scenario command began to wait for the end of the daemon's check (`aang status`), there were no failures. This did not happen on Linux and macOS. The risk for a Windows user: Codex itself writes `config.toml` (project trust, `/hooks`), the daemon responds by launching `app-server`, and it may collide with the user's starting Codex. A separate check on Windows is needed (in the spirit of D.8) and a decision: leave it, check less often, or not launch `app-server` while Codex hooks on Windows are not installed (the owner decisions of 2026-10-06 make them optional).
7. **Gaps in the scenario catalog.** `codex_exec` on Linux and Windows has no `resume` (the live `resume-compaction` scenario is recorded only on macOS; ADR-0010 forbids copying authorization into a temporary profile); `codex_sdk` has no compaction and reconnection scenarios, and the `compaction` and `reconnect` columns of its rows are `not_run`, although this is not counted as a reason (the matrix requires only catalog scenarios).

## 7. Matrix update

`support/matrix.json` still has no declared `full` and `limited`: declaring support by version is the stage outcome and the owner's decision (plan, "Stage outcome"). Q.1 changes what the matrix knows and requires.

- **Evidence** — `support/verification.json` (`tools/support/README.md`): placement checks and owner checklists that the contract run does not compute. `placement import` recorded the placement checks from this PR's `docker` and `vm` reports: 10 Linux rows — Claude CLI, Claude Agent SDK, `codex exec`, Codex SDK and Codex TUI in `docker` and `vm`, all `passed`. Results for `local` and the `desktop_ssh` emulation are not recorded.
- **Rules.** A non-local placement row loses the reason "not verified before Q.1" only with a passed check of its key; the user scenarios of such a row are taken from the local row of the same OS and version. Desktop rows on macOS and Linux require the Desktop checklist, Claude CLI rows the TUI checklist (ADR-0010).
- **E2E 1 and 4.** Marked `passed` for local rows whose E2E variants run on recordings of their own OS: Claude CLI on macOS, Claude Agent SDK, `codex exec` and Codex SDK on three OSes, both Desktops on macOS. The correspondence is checked by `e2e/support-matrix.test.ts` on every runner.

Rows without reasons (ready for declaration by the owner): Claude Agent SDK 2.1.289 — Linux (`local`, `docker`, `vm`), macOS, Windows; Codex SDK 0.160.0 — the same; `codex exec` 0.160.0 — macOS.

What still holds rows back:

| Rows | Reason | What clears it |
| --- | --- | --- |
| Claude CLI 2.1.289, all OSes and placements | owner TUI checklist | checklist (macOS, Windows); for Linux — owner decision (section 6, item 5): no checklist needed |
| Claude CLI 2.1.289 Linux and Windows | E2E 1 and 4 do not run | R.4 re-recording (section 6, item 1) |
| Claude Desktop 2.1.286 and Codex Desktop 0.159.2, macOS | owner Desktop checklist; Claude Desktop has no `elicitation` recording (engine 2.1.288 or newer, B.8) | checklist `docs/research/q1-owner-checklist.md` |
| Desktop on Windows | not checked in the MVP | — |
| `codex exec` 0.160.0 Linux and Windows | no `resume-compaction` recording (live model) | a recording on these OSes (section 6, item 7) |
| Codex TUI 0.160.0 | E2E 1 and 4 do not run: no `subagents` recording | R.3 recordings |

**Owner decisions 2026-10-08.** Statuses are declared based on the results: a row without gaps is `full`, with gaps `limited` with a list, and rows that need an owner checklist remain `unverified` until the checklist; for Claude CLI on Linux the TUI checklist is not needed (section 6, item 5). `tools/support` derives the status from the gaps by itself (`tools/support/README.md`, "Matrix"), and rows without their own OS recordings, without a passed placement check, and Desktop on Windows also remain `unverified` (plan, R.5a). By the matrix on the same recordings:

- `full` — Claude Agent SDK 2.1.289 and Codex SDK 0.160.0 on three OSes and in `docker`/`vm`, `codex exec` 0.160.0 on macOS;
- `limited` — Claude CLI 2.1.289 on Linux (`local`, `docker`, `vm`): E2E 1 and 4 do not run; `codex exec` 0.160.0 on Linux and Windows: no `resume-compaction` recording; Codex TUI 0.160.0 on macOS and Linux: E2E 1 and 4 do not run;
- `unverified` — Claude CLI 2.1.289 on macOS and Windows (TUI checklist), both Desktops on macOS (Desktop checklist) and on Windows.

## 8. Runs

This PR's `Surface matrix` workflow: [first](https://github.com/realkarych/aang/actions/runs/37660627423) — Linux and Docker passed, the VM lacked `libatomic1`, item 6 of section 6 showed up on Windows; [second](https://github.com/realkarych/aang/actions/runs/37665180916) — after changing the installation order, Windows had no Codex failures, and reconciling raw records revealed the `last-prompt` service lines; [third](https://github.com/realkarych/aang/actions/runs/37667752046) — the basis for section 3 and the `verification.json` records; [final](https://github.com/realkarych/aang/actions/runs/37686903626) — after review fixes and merging with `master`, all five jobs passed; it is the basis for section 2 (artifacts `surface-check-Linux`, `surface-check-macOS`, `surface-check-Windows`), and Docker and the VM passed again with the same surfaces. In the first three, the `native (macos-latest)` job was cancelled by a new commit before getting a runner. Locally on macOS, the same tool was run in Docker Desktop containers (Linux arm64): all surfaces and the SSH mode emulation there are a Linux check, not native macOS.

Reports and the VM serial console log in the artifacts are anonymized: the working directory path, the home directory and the host name are replaced with placeholders, the VM SSH key has a synthetic comment, and before upload each job checks the report directory for the runner's user name, home directory and host name (`tools/surface-check/README.md`, "Report"). The artifacts of the runs above, made before this, still contain the GitHub runner account name and host name.
