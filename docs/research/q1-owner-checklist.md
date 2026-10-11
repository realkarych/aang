# Q.1 owner checklist: macOS, Desktop SSH mode and OAuth on Linux

Status: instructions for plan item Q.1 (`docs/plan/mvp.md`). Performed by the owner. This is not a report: the result goes to `docs/research/q1-owner-checklist-results.md` (section 7).
Date: 2026-10-07. Instructions for Windows — `docs/research/q1-owner-checklist-windows.md`. The automated part of Q.1 and its results — `docs/research/q1-surface-matrix.md`.

## 0. What is checked and why

Per ADR-0010, a support matrix row gets `full` or `limited` only after the owner's manual checklist: for Desktop — section 11 of the spike on each OS where Desktop is checked; for the interactive Claude TUI — items (a)–(h) of section 6. Recordings of Desktop engines under emulation do not replace the manual check. Q.1 repeats D.7 on the released versions and adds what cannot be checked automatically:

| Part | What | Matrix rows |
| --- | --- | --- |
| 1 | D.7 on current versions: Claude TUI (a)–(h), Claude Desktop steps 1–6, Codex in ChatGPT Desktop steps 7–10 | `claude_cli`, `claude_desktop`, `codex_desktop` on macOS, `local` |
| 2 | End-to-end check with aang itself: Desktop and TUI are visible in the UI in both user scenarios | same |
| 3 | SSH mode of both Desktops: aang on a remote Linux host | `claude_desktop`, `codex_desktop` on Linux, `desktop_ssh` |
| 4 | OAuth path on Linux: CLI login in a container and the aang observer with this authorization | observer on Linux (`docker`, `vm`) |

Desktop on Windows is not checked in the MVP (ADR-0013, decision 3). Desktop limitations found here are brought to the owner (RFC §4); those known so far are collected in `docs/research/q1-surface-matrix.md`, section 5.

The automated part of Q.1 passed on CI without the owner (native Linux, macOS and Windows, Docker, VM, emulation of the SSH mode; `docs/research/q1-surface-matrix.md`, sections 2, 3 and 8). Here is only what requires a GUI, an interactive terminal, an account or the owner's remote machine.

## 1. Preparation

Record the versions before the start and after the end (Desktop updates its engines itself):

- `claude --version` and `codex --version`;
- "About" of Claude Desktop and ChatGPT;
- the version of the built-in Claude Desktop engine — the «Версии» ("Versions") field of the transcript table of the D.7 summary, or `version` of the lines of a Desktop session transcript;
- `cli_version` from `session_meta` of a Codex Desktop session rollout.

These are the released versions: matrix rows are created exactly for them. If a version differs from the one recorded in `support/matrix.json` (Claude 2.1.289, Desktop engine 2.1.286, Codex 0.160.0, Codex Desktop engine 0.159.2), note this in the report: a new version needs reference recordings (ADR-0010, decision 1).

Build from the repository:

```sh
cd ~/src/aang
git switch master && git pull
pnpm install --frozen-lockfile
pnpm build
alias aang="node $HOME/src/aang/packages/aang/dist/main.js"
```

Until the end of the check, do not rebuild or switch branches: the D.7 probes and aang hooks refer to build files.

## 2. Part 1 — D.7 on the released versions

Run `docs/research/d7-owner-checklist.md` in full: preparation (section 2), sections A, B and C, collection (section 6) and rollback (section 8). The working directory is `/tmp/aang-q1-d7`, so as not to mix the results with D.7:

```sh
node tools/owner-checklist/dist/main.js prepare --dir /tmp/aang-q1-d7 --codex-hooks
```

Differences from D.7:

- results are moved to `docs/research/samples/owner-checklist/q1-macos/`;
- in the Q.1 report (section 7), for each item add a comparison with the D.7 expectation and with the previous D.7 run, if there was one;
- roll back part 1 before starting part 2: the D.7 plugin and the aang plugin in the user scope would give a double registration.

## 3. Part 2 — end-to-end check with aang on macOS

Here aang is installed the product way into the user profile: this is what a user will do.

### 3.1. What changes

| What | How it is rolled back |
| --- | --- |
| The `aang` marketplace and the `aang@aang` plugin in the Claude user scope | `aang uninstall` |
| aang entries at the end of the `~/.codex/hooks.json` arrays, a backup next to it | `aang uninstall` neutralizes the entries in place (`true`); the owner deletes the `hooks.json.aang-backup-*` backup |
| Trust in the aang entries in `~/.codex/config.toml` | manually, as in D.7 |
| The `AANG_HOME` directory — `/tmp/aang-q1/aang`, not `~/.aang` | delete the directory |
| Sessions in `~/.claude/projects`, Desktop metafiles, rollouts in `~/.codex/sessions` | the owner deletes them |

While the plugin and hooks are installed, aang receives events from all Claude and Codex sessions, but only the probe repository (`aang watch`) is in scope. Do not work in other projects until the rollback.

If your own aang is already installed on the Mac: `aang install` in part 2 will redirect the `aang@aang` plugin and the Codex hook entries to `/tmp/aang-q1/aang`, and until the rollback your daemon receives no hooks; ports 4280 and 4281 are taken by its daemon. Before the start, record `aang status` of your installation, stop its daemon (`aang stop` without `AANG_HOME`), and after the rollback repeat `aang install` and `aang start` with your installation without `AANG_HOME` (section 3.4).

### 3.2. Installation and start

In a separate terminal:

```sh
export AANG_HOME=/tmp/aang-q1/aang
mkdir -p /tmp/aang-q1/probe-repo && git -C /tmp/aang-q1/probe-repo init -q
git -C /tmp/aang-q1/probe-repo commit -q --allow-empty -m init
aang install
aang start
aang watch /tmp/aang-q1/probe-repo
aang open
```

- Open the `aang open` link in a browser.
- Trust the aang entries in Codex: `/hooks` in the terminal `codex` or in ChatGPT. `aang status` must show Claude and Codex hooks as active.
- Restart Claude Desktop and ChatGPT (Cmd+Q and open again): running applications do not re-read the set of plugins and hooks.
- The aang observer calls your authorized CLI (ADR-0007): building the map spends subscription tokens. The UI status bar shows the observer CLI version and the outcome of its admission; record them.

### 3.3. Scenarios

For each surface: Claude Desktop Code in Local and worktree modes, Codex in ChatGPT in Local and Worktree modes, the interactive Claude TUI (`claude` in Terminal.app). All sessions are in `/tmp/aang-q1/probe-repo`, with the default permission mode (Ask, on-request).

1. **During work (E2E 1).** Prompt: "Create notes.txt containing one line about this repository, then use a subagent to list the files, then ask me one question with your question tool and wait for the answer". For Codex: "… then spawn a subagent that runs `ls` and ask me one question". When the permission request to create the file appears, wait 10 s and look at the UI:
   - the run of this session appeared by itself, without a page reload, labeled with the surface and version;
   - the open permission request is visible in the attention zone and closes after the answer;
   - the action and the subagent are visible on the map or in the action list; the subagent has its own place on the map (if the observer is working);
   - the model's question is visible in the attention zone until you answer.
2. **Reconnection.** While the model is waiting for the answer to the question, run `aang stop`, then `aang start`. Answer the question. There are no duplicate actions or questions in the UI, the question is closed.
3. **After an iteration (E2E 4).** Press «Отметить просмотренным» ("Mark as viewed") in the UI. Continue the session: for Claude Desktop and Codex, close and reopen the application and continue the same chat (resume); for the TUI, `claude --resume`. Prompt: "Append a second line to notes.txt". Then in the «С последнего просмотра» ("Since last view") tab:
   - the new version of `notes.txt` and the new action are among the changes;
   - the cards lead to the source record (transcript or rollout).
4. **Compaction.** `/compact` in Claude Desktop and the TUI. In the UI the session continues without a gap; record what is visible about the compaction.

Record for each surface: whether each item passed, the surface label in the UI (for example, Codex Desktop is labeled «предположительно» ("presumably") — the adapter distinguishes it only by `originator`), the session support mode (hooks and files), the version status in the status bar, screenshots.

### 3.4. Rolling back part 2

```sh
aang uninstall
aang stop
rm -rf /tmp/aang-q1
```

Then manually: aang trust in `~/.codex/config.toml`, the `hooks.json.aang-backup-*` backup, the sessions of the probe repository and its worktree. If your own aang was installed before part 2, in a new terminal without `AANG_HOME` run `aang install` and `aang start` with your installation: `aang status` must match what was recorded before the start.

## 4. Part 3 — Desktop SSH mode

You need your own Linux host accessible by SSH key from this Mac: your own VM or a machine on the network. aang runs on the same host as the Desktop engine (ADR-0004), the UI is opened via an SSH tunnel (ADR-0003).

The automated part of Q.1 checked this without Desktop: on a VM under QEMU, engines launched via SSH with Desktop's flags and environment are visible to the daemon on the VM, and the UI works through a tunnel with the same port (`docs/research/q1-surface-matrix.md`, section 3). What Desktop itself does is not checked: which engine and which version it installs on the host, with which flags, environment and settings sources it launches it, whether the user's aang plugin is loaded.

### 4.1. Remote host

On the host: Node.js 26, git, pnpm, Go (to build `aang-hook`) and, if Desktop requires it, `codex`.

The check does not touch the aang working profile on the host, if there is one: everything it creates lives in `~/aang-q1-ssh` — the build, a separate `AANG_HOME` (`~/aang-q1-ssh/home`), the probe repository and the saved Codex settings; the daemon listens on ports 4290 (API) and 4291 (OTLP), not 4280 and 4281. Only the registrations in the runtime profiles remain shared: `aang install` will redirect the `aang@aang` plugin in the Claude user scope and the Codex hook entries to the check's `AANG_HOME`, so an already installed aang receives no hooks until the rollback. If there is one, record `aang status` of your installation (without `AANG_HOME`) before the start.

All `aang` commands on the host below and in sections 4.2–4.4 are run in one terminal:

```sh
git clone https://github.com/realkarych/aang.git ~/aang-q1-ssh/aang && cd ~/aang-q1-ssh/aang
pnpm install --frozen-lockfile && pnpm build
alias aang="node $HOME/aang-q1-ssh/aang/packages/aang/dist/main.js"
export AANG_HOME="$HOME/aang-q1-ssh/home"
mkdir -p "$AANG_HOME" ~/aang-q1-ssh/saved
printf '{"placement":"desktop_ssh","api":{"port":4290},"otel":{"port":4291}}\n' > "$AANG_HOME/config.json"
for file in hooks.json config.toml; do [ -f ~/.codex/$file ] && cp -p ~/.codex/$file ~/aang-q1-ssh/saved/; done
mkdir -p ~/aang-q1-ssh/probe-repo && git -C ~/aang-q1-ssh/probe-repo init -q && git -C ~/aang-q1-ssh/probe-repo commit -q --allow-empty -m init
```

`placement` is set in the config: from the inside the SSH mode cannot be distinguished from a local launch (`packages/daemon/README.md`). Without it, sessions will land in the `local` row.

If Claude Code has not yet been run on the host, `aang install` will not find `claude`: in that case first connect the host in Claude Desktop (section 4.2, step 1) and only then install aang.

```sh
aang install
aang start
aang watch ~/aang-q1-ssh/probe-repo
```

On the Mac: `ssh -N -L 4290:127.0.0.1:4290 <user>@<host>`, on the host `aang open`, open the link on the Mac. The tunnel port must match the daemon port: with a different local port the UI reads, but marks, view rules and chat respond 403 (ADR-0003, decision 1; section 4 of the Q.1 report).

### 4.2. Claude Desktop

1. Code → SSH environment → your host → folder `~/aang-q1-ssh/probe-repo`. Record what Desktop installed on the host: `ls -la ~/.claude` and the directories that appeared in the home directory, the path and version of the running engine (`ps -eo pid,args | grep -i claude` on the host during the session) and its environment (`tr '\0' '\n' < /proc/<pid>/environ | grep -E 'CLAUDE|ANTHROPIC|PATH'`; do not copy token values into the report).
2. Scenarios 1–4 from section 3.3. In the aang UI on the host the session must appear labeled Claude Desktop with the version row `desktop_ssh`. If the label is different (for example, CLI or SDK) or hooks do not arrive (the «только файлы» ("files only") mode), record this: it determines whether the SSH mode is supported by the same adapter (`docs/research/integrations.md`, "Recommended collection approach for aang").
3. If the aang plugin does not load, check the engine's settings sources in its command line (`--setting-sources`) and record them.

### 4.3. Codex Desktop

1. In ChatGPT add a remote connection to the host and open `~/aang-q1-ssh/probe-repo`. Record which `codex app-server` is running on the host (path, version, `CODEX_INTERNAL_ORIGINATOR_OVERRIDE` in the process environment) and which `CODEX_HOME` it uses.
2. Trust the aang entries in Codex on the host (`/hooks` in the terminal `codex` on the host). `aang status` on the host — Codex hooks are active.
3. Scenarios 1–3 from section 3.3. Expected: the Codex Desktop label and the `desktop_ssh` row.

### 4.4. Rollback

On the host, in the terminal with `AANG_HOME="$HOME/aang-q1-ssh/home"`:

```sh
aang uninstall
aang stop
for file in hooks.json config.toml; do [ -f ~/aang-q1-ssh/saved/$file ] && cp -p ~/aang-q1-ssh/saved/$file ~/.codex/; done
```

The copies return Codex's `hooks.json` and `config.toml` to their state before the check, together with trust. Delete a file that did not exist before the check yourself: `aang uninstall` leaves neutralized entries (`true`) in `hooks.json`, and trust in `config.toml`. The `hooks.json.aang-backup-*` backups created by the check are also deleted by the owner.

If your own aang was installed on the host before the check, in a new terminal without `AANG_HOME` run `aang install` and `aang start` with your installation: this returns the plugin and the Codex hook entries to its `AANG_HOME`; `aang status` must match what was recorded before the start. Then `rm -rf ~/aang-q1-ssh`: the check did not touch the `~/.aang` directory or other host data. On the Mac, remove the connections in Desktop if they are not needed.

## 5. Part 4 — OAuth path on Linux

The automated part established (`docs/research/q1-surface-matrix.md`, section 4):

- `claude auth login` in a container without a browser prints a link with `redirect_uri=https://platform.claude.com/oauth/code/callback` and waits for a code: "Paste code here if prompted". No port needs to be published;
- `codex login` by default starts a login server on `localhost:1455` inside the container, and the host browser will not reach it: Codex itself suggests `codex login --device-auth`. On a VM without a container, the tunnel `ssh -L 1455:127.0.0.1:1455` also works;
- before login `claude auth status` is `loggedIn: false`, `codex login status` is `Not logged in`; the aang observer in such a container does not pass admission, and the daemon works without a map.

The rest requires your account. Use the solver image from the README (section "Docker") with the real CLIs:

```sh
docker build --tag aang .
docker build --tag aang-solver - <<'EOF'
FROM aang
USER root
RUN npm install --global --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code @openai/codex
USER node
EOF
docker run --detach --name aang-q1-oauth --publish 127.0.0.1:4280:4280 aang-solver sleep infinity
docker exec --interactive --tty aang-q1-oauth claude auth login
docker exec --interactive --tty aang-q1-oauth codex login --device-auth
```

1. Open the links on the Mac, log in, paste the Claude code into the terminal. Record how many steps it took and whether there were errors.
2. Where the authorization lives and with which permissions: `docker exec aang-q1-oauth sh -c 'ls -la ~/.claude ~/.codex'`. Expected: `~/.claude/.credentials.json` and `~/.codex/auth.json` with permissions 0600; do not copy the content or put it into the report.
3. `docker exec aang-q1-oauth sh -c 'claude auth status --text; codex login status'`.
4. `docker exec aang-q1-oauth aang start --bind 0.0.0.0`, then `docker exec aang-q1-oauth aang status`: the Claude and Codex observer admission must pass (`admitted`). Admission makes one synthetic call per CLI.
5. If admission passed, the solver session in the container is visible in the UI with a map: `docker exec aang-q1-oauth git -C /home/node init -q work`, `docker exec aang-q1-oauth aang watch /home/node/work`, `docker exec --workdir /home/node/work aang-q1-oauth claude -p "Create a.txt with hi"`, the `docker exec aang-q1-oauth aang open` link in a browser.
6. Rollback: `docker exec aang-q1-oauth sh -c 'claude auth logout; codex logout'`, then `docker rm --force aang-q1-oauth`.

## 6. What not to do

- Do not copy authorization files from the container, from the host or from `~/.claude` into the repository or into other profiles.
- Do not put into the report prompts with personal data, tokens, email addresses, account and organization identifiers. The `tools/owner-checklist` summaries are already anonymized; review UI screenshots before adding them.

## 7. Report

`docs/research/q1-owner-checklist-results.md`, following the example of `docs/research/windows-runtimes.md`:

- versions from section 1 before and after;
- part 1 — by items (a)–(h), 1–6 and 7–10: expectation, observation, difference from D.7;
- parts 2 and 3 — a "surface × item" table with outcome and notes; for the SSH mode — what Desktop installs and launches on the host;
- part 4 — login steps, authorization location, outcome of the observer admission;
- Desktop limitations for the owner's decision (RFC §4).

Then the implementer adds entries to `support/verification.json`, the `owner_checklists` array (`tools/support/README.md`): `checklist: "desktop"` for the `claude_desktop` and `codex_desktop` rows macOS `local` and Linux `desktop_ssh` with the engine versions from the report, `checklist: "tui"` for `claude_cli` macOS `local`; `result` is `passed` or `failed`, `report` is the report path. After that `pnpm support:update` recomputes the matrix. Declaring `full` or `limited` based on the results is the owner's decision (plan, "Stage outcome").
