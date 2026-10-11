# Own `app-server` in the regular `~/.codex` (D.6)

Status: report on plan item D.6 (`docs/plan/mvp.md`). This is not an ADR: the clarification has been made in ADR-0004, questions to the owner are collected in section 2.
Date: 2026-10-03, rerun — 2026-10-04. Branch: `feat/d6-app-server-live`.

## 0. Scope, versions, method

We check the side effects of our own stdio process `codex app-server`, which `@aang/hook` (D.4) launches for `initialize` and `hooks/list`: sqlite, logs, caches, network, MCP launch, threads, configs and trust. By the owner's decision (2026-10-03) the experiment runs directly in the regular `~/.codex` without a copy of the profile. The working directory is a separate test project in a temporary directory. User configs were intentionally not changed; the state before and after is recorded (section 3).

**Versions and environment:**

- macOS 27.0.1 (Darwin 27.0.0), Apple M4 Pro, arm64; Node 26.10.0;
- `codex-cli 0.160.0` from Homebrew (`/opt/homebrew/bin/codex`) — the same CLI that the owner runs in the TUI;
- a profile with ChatGPT authorization; in `config.toml` — MCP `node_repl` (enabled) and `computer-use` (disabled), 11 enabled plugins, 4 trusted `hooks.json` entries;
- during the runs, Codex Desktop was running with its own `codex-cli 0.159.2` (app-server, exec-server, code-mode host); at times — unrelated `codex` processes; in the last two runs — an app-server daemon of someone else's temporary profile (`<other-tmp-N>` in the samples).

**Method.** Script [`samples/codex-app-server-live/run.mjs`](samples/codex-app-server-live/run.mjs). The result of the run on the regular profile is [`result.json`](samples/codex-app-server-live/result.json), on a disposable profile without authorization — [`result-disposable.json`](samples/codex-app-server-live/result-disposable.json). The repository is public, so the samples are anonymized. Paths are replaced with `<codex>`, `<work>`, `<tmp>` and `~`, the roots of other temporary directories (`/tmp/…`, `/private/tmp/…`, `/var/folders/…`) with `<other-tmp-N>`, the host name with `<host>`, plugin names in `plugins/cache` with `<plugin N>`, and the `[projects]` keys are reduced to a count and a hash. The installation identifier and values derived from installation, account and host data are replaced with placeholders: `INSTALLATION_ID_N`, hashes of profile files and `[projects]` — `DIGEST_N`, `trusted_hash` — `TRUSTED_HASH_N`, plugin catalog cache keys — `CATALOG_KEY_N`. Equal values get the same placeholder, so the "before/after" comparison is preserved.

Run phases:

1. Snapshot S0, a 30 s control window without launches, snapshot S1.
2. Instrumented session:
   - `codex app-server` over stdio with `CODEX_HOME=~/.codex`; the working directory is the test project `<work>/project`;
   - 5 s without requests, then `initialize` with the same `clientInfo` as D.4, and `initialized`;
   - another 5 s, then `hooks/list {}` and `hooks/list {cwds: [~/.codex]}`;
   - 20 s, stdin closed; snapshot S2.
3. Three product calls `codexHooksState({ codexHome: ~/.codex, codex: { command } })` from the built `@aang/hook`: the process working directory is `codexHome`, `initialize` → `hooks/list`, SIGKILL of the process group right after the reply. Snapshot S3.
4. A 30 s control window, snapshot S4.
5. Trust reconciliation: a short `initialize` + `hooks/list` session, stdin closed. Snapshot S5.

What a snapshot includes:

- a walk of `~/.codex` by `lstat` before and after reading the databases: about 12.6 thousand entries with size, `mtime`, `ctime` and inode;
- sha256 of `config.toml`, `hooks.json`, `installation_id`, `version.json`, `models_cache.json`, `.codex-global-state.json`, `history.jsonl`, `session_index.jsonl`, `AGENTS.md`. The contents of `auth.json` were not read — only `stat`;
- the `[hooks.state]` and `[projects]` tables from `config.toml`;
- the row count in every table of every database (`*.sqlite`, `sqlite/*.db`) and the threads from `state_5.threads`. The script does not open the profile databases: it makes an APFS clone of the main file and `-wal` into a temporary directory and reads the clone. A read-only connection creates `-wal` and `-shm` for a WAL database if they are missing and modifies `-shm` (reproducible on Node 26.10), so direct reading distorts the measurement. The clone is taken only if the main file did not change during copying;
- Codex processes, `/tmp/codex-daemon-<uid>` and `<codex>/app-server-control`.

An interval between snapshots compares the state after the previous snapshot read the databases with the state before the next one reads them. Changes during reading are recorded in each snapshot (`changedWhileReading`): in all snapshots of both runs they are empty, that is, the collector does not change the profile. Separately verified on a disposable profile with WAL databases and a fake app-server that writes nothing: the previous version of the script created `-wal`/`-shm` and changed `-shm` in every interval, the current one changes nothing.

During the sessions the script polled the process tree (`ps` every 100 ms, every 20 ms for product calls), open files and sockets (`lsof`), and recorded the server's notifications.

**Attribution.** Rows of `logs_2.sqlite` are attributed by `process_uuid = pid:<pid>:…`. Files and connections — by `lsof` of our processes and by matching modification times with our log rows; the control windows show the background. Log row bodies were read only for our processes. Logs of other processes were not read.

**The model was not called.** The script does not send `thread/*`, `turn/*` or any methods other than `initialize`, `initialized` and `hooks/list`, and does not answer server requests (there were none).

There were four runs on the regular profile: 22:37, 22:48 and 22:52 MSK on October 3 and 00:11 MSK on October 4. The first three ran early versions of the script that opened the profile databases in place. Their data on sqlite service files (`-wal`, `-shm`) are distorted by the collector itself and are not used. The other observations of all four runs matched. The numbers in the report are from the fourth run (`result.json`) and the rerun on the disposable profile (`result-disposable.json`). Both samples are output of the current script version without post-processing.

**Notation:** **Obs** — observed in a run; **Inf** — a high-probability inference without direct proof.

**Limitations:**

- macOS only. On Windows `codexHooksState` is closed until the launcher (ADR-0013); Linux was not checked;
- the content of network requests is visible only through our process's logs, connections through `lsof`. Packets were not intercepted;
- the product process lives 35–53 ms and `lsof` does not catch it in time: network connections of the product path were not observed directly.

## 1. Key findings

1. **No threads, sessions or model calls** (Obs). The thread count in `state_5.threads` is 419 before and after, there are no new rollouts, `remote_control_enrollments` is empty before and after.
2. **Configs and trust do not change** (Obs):
   - `config.toml`, `hooks.json`, `auth.json`, `installation_id`, `version.json`, `history.jsonl`, `session_index.jsonl` and `.codex-global-state.json` did not change;
   - `[hooks.state]` (4 entries) and `[projects]` (6 entries) are the same;
   - `hooks/list` returns 4 `trusted` entries before and after. For the working directory in the temporary project and for `~/.codex` the lists match; no new project trust entries appeared.
3. **MCPs are not launched, the user's daemon is not affected** (Obs). During the 30 s session the app-server has not a single child process, even though MCP `node_repl` and plugins with MCP are enabled in the profile. No control socket is created, `/tmp/codex-daemon-<uid>` does not change.
4. **At startup, even before `initialize`, the process itself contacts OpenAI services on behalf of the user and writes to `CODEX_HOME`** (Obs, section 4):
   - it starts a remote control loop to `https://chatgpt.com/backend-api/`;
   - it refreshes the model list (`GET /backend-api/codex/models` with ChatGPT authorization);
   - it requests the remote plugin catalog and synchronizes installed remote plugins.

   Over a 30-second session this is 42 rows (about 12 KB) in `logs_2.sqlite`, rewritten plugin catalog caches and markers of 10 remote plugins, and probably `models_cache.json`.
5. **The D.4 product path leaves almost no traces** (Obs). A call lasts 35–53 ms; the process is killed before the background tasks write anything: no log rows and no cache writes. After SIGKILL there remain the directory `tmp/arg0/codex-arg0*` (removed by the next launch of any `codex`) and the sqlite service files `-wal`/`-shm` of the `goals_1` and `memories_1` databases. The product process probably starts a network connection (Inf): in the short reconciliation session a TCP connection to `chatgpt.com` is already open 47 ms after start, right after the reply to `hooks/list`.
6. **In a profile without remote plugins (without ChatGPT authorization) every short launch leaves an empty directory `.tmp/git-XXXXXX`** (Obs, disposable profile, section 8). Instead of remote plugins, a git synchronization of `github.com/openai/plugins` runs there. The directory remains both on SIGKILL and on a normal stdin close; a long session removes it.
7. **On the owner's profile `codexHooksState` returns `active` even though there is no current aang installation** (Obs). `~/.codex/hooks.json` has three stale `~/src/aang/bin/aang hook` entries from a previous installation: the binary is gone, the entries are trusted and enabled. `isAangCommand` attributes them to aang. Before G.7 the state must be determined by the current entry (section 2, item 2).

## 2. Escalated to the owner

1. **Condition for using the trust check — an ADR-0004 amendment in this PR.** `hooks/list` itself is safe, but every app-server launch starts background network tasks on behalf of the user. If such a process is not killed immediately, it writes logs and caches to `CODEX_HOME`. The proposal has been added to ADR-0004 (section "Channels"):
   - the process exits immediately after the `hooks/list` reply — D.4 already does this;
   - the check runs only on an event: install and uninstall, `aang status`, `doctor`, daemon start, a change to `hooks.json` or `config.toml`. The daemon keeps the last state and does not launch app-server on every `/api/status` request or on a timer.

   Owner approval is required: the G.7 implementation depends on it.
2. **False `active` from stale entries (D.4, before G.7).** `codexHooksState` attributes any `aang hook` or `aang-hook` entry to aang and derives the state from them. On the owner's profile these are three trusted entries of a previous installation, so the result is `active`, although there is no current entry and no binary either. The D.4 installer neutralizes such entries, as ADR-0004 requires, so there will be no error after installation. Before installation, G.7 and `doctor` would show "active" instead of "not installed".

   Proposal: determine the state by the entry with the expected command — the absolute path `<AANG_HOME>/bin/aang-hook` and arguments `codex user <spool>`. Stale entries should be shown as a separate flag. This is a change to the D.4 code and possibly to the state values in the API, so it is not part of this PR. A decision is needed on which PR does it: a separate one before G.7 or as part of G.7.
3. **`.tmp/git-XXXXXX` litter in profiles without remote plugins.** Every short app-server launch leaves an empty directory (HEAD, objects, refs) in Codex's internal directory. aang does not write to it and does not clean it. With event-only checks (item 1) the growth is bounded by the number of checks. This is a known limitation, not a reason to change the check method; for information.
4. **Requests to OpenAI go out with the aang user agent.** In the instrumented session, model and plugin requests came from a process with `clientInfo.name = "aang"`; its `userAgent` is `aang/0.160.0 (…) (aang; 0.0.0)`. This concerns only our own process: unlike the shared daemon (spike, section 10), the `originator` of other threads does not change. For information.

## 3. State before and after

S0 (before the first launch) and S5 (after the trust reconciliation) of the fourth run are compared.

| What | Before | After |
| --- | --- | --- |
| `hooks/list` | — (app-server was not called before the first launch) | 4 `user` entries, all `trusted` and `enabled`; identical with the working directory in the project and in `~/.codex` |
| `[hooks.state]` in `config.toml` | 4 entries with `trusted_hash` | the same 4 entries |
| `hooks.json` | `SessionStart` 1+1, `UserPromptSubmit` 1, `Stop` 1 | unchanged (same sha256) |
| `config.toml` | sha256 `DIGEST_1` | the same |
| `[projects]` | 6 entries | the same 6 (same hash) |
| `auth.json` | — | `stat` unchanged (contents not read) |
| Threads `state_5.threads` | 419 | 419, no new ones |
| `remote_control_enrollments` | 0 | 0 |
| sqlite migrations | `state_5` 58, `thread_history_1` 7, `logs_2`, `goals_1`, `memories_1`, `queue_1` 2 each, `sqlite/codex-dev.db` 31 | unchanged |
| Daemon sockets `/tmp/codex-daemon-<uid>` | 2 files | 2 files |
| `<codex>/app-server-control` | none | none |

The `[hooks.state]` entries belong to `herdr-agent-state.sh` and to the stale `aang hook` entries (item 7 of section 1). The `trusted_hash` values in `result.json` are replaced with placeholders `TRUSTED_HASH_1`–`TRUSTED_HASH_4`, identical before and after.

## 4. Instrumented session

Timeline of the fourth run, time from process start (Obs):

| Time | Event |
| --- | --- |
| +46 ms | `lsof`: `tmp/arg0/codex-arg0*/.lock` opened |
| +107 ms | log: remote control loop started (`remote_control_url=https://chatgpt.com/backend-api/`, state `Unknown`) |
| +156 ms | log: remote plugin catalog request (`ps/plugins/list`, `GLOBAL`) |
| +453 ms | `lsof`: `state_5`, `logs_2`, `goals_1`, `memories_1`, `queue_1` opened (with `-wal` and `-shm`); TCP `104.18.32.47:443` — the address `chatgpt.com` resolves to |
| +653 ms | log: `GET https://chatgpt.com/backend-api/codex/models?client_version=0.160.0` → 200, ChatGPT authorization header |
| +1.02 s | log: synchronization of installed remote plugins finished, no changes; skills cache cleared. Files: markers `plugins/cache/{openai-curated-remote,created-by-me-remote}/*/.codex-remote-plugin-install.json` rewritten (10 files) |
| +5.03 s | `initialize` → reply in 12 ms; notifications `remoteControl/status/changed` and `account/updated`. Log: remote control connection loop, status `Disabled`, `environment_id=None` |
| +10.07 s | `hooks/list {}` → reply in 46 ms; `hooks/list {cwds: [~/.codex]}` → in 2 ms. Log: plugin loading, 2 warnings about plugin icon paths |
| +12.9 s | log: repeated catalog request (`WORKSPACE`); `cache/remote_plugin_catalog/*.json` rewritten (`mtime` +12.9 and +13.0 s) |
| +30.15 s | stdin closed → exit with code 0 in 11 ms |

- **Processes.** No child processes, nothing left after exit.
- **Logs.** 42 rows and 11.8 KB in `logs_2.sqlite`, all without `thread_id`. Half were written before `initialize`. By source: config loading (24 `DEBUG` rows), protocol, remote control, plugins and HTTP (`INFO` and `TRACE`), 2 `WARN` about plugins.
- **Model cache.** `models_cache.json` changed in content during the session window (Inf: our process requested the model list). The same file is regularly rewritten by other Codex processes: in this run it also changed in the control window after the product calls, without our processes.
- **sqlite.** Before the session, `goals_1` and `memories_1` had no `-wal` and `-shm`. 0.45 s after start our process holds them open; after a normal exit they are gone again: when the last connection closes, sqlite moves the WAL into the main file and deletes the service files. This is normal sqlite behavior; the row count in the databases does not change.
- **Remote control.** The loop starts at launch and moves to connecting after `initialize`. On the owner's profile remote control is in state `Disabled`; no enrollment is created. It cannot be disabled with a flag: `remote_control` is marked `removed` in 0.160.0.

## 5. D.4 product path

| Call | Duration | Result | Leftovers |
| --- | --- | --- | --- |
| 1 | 35 ms | `active`, 3 "aang entries" (stale, section 2, item 2) | no processes |
| 2 | 50 ms | the same | no processes |
| 3 | 53 ms | the same | no processes |

Changes over the window of the three calls (Obs):

- no rows in `logs_2.sqlite` from the product processes; caches and plugin markers were not rewritten;
- after the last call the directory `tmp/arg0/codex-arg0*` remained with `.lock` and links `apply_patch`, `applypatch`, `codex-execve-wrapper`. The next `codex` launch, here the reconciliation session, removed it;
- `goals_1` and `memories_1` got `-wal` and `-shm`: the killed process did not close its connections. The collector is not involved (section 0); these files did not change in the control windows. The short reconciliation session removed only `goals_1.sqlite-shm`; an empty `goals_1.sqlite-wal` and the `memories_1` pair remained after the run;
- the main file `logs_2.sqlite` changed without new rows in all four runs. Probably (Inf) this is a WAL checkpoint on opening the database. In the control window before the calls the main file did not change; after the calls it changed, but Desktop wrote 12 rows there.

The reconciliation session (launch, `initialize`, `hooks/list`, stdin close) lasted 55 ms: `initialize` replied in 21 ms, `hooks/list` in 9 ms. When `lsof` caught the process 47 ms after start, before stdin was closed, a TCP connection to `chatgpt.com` was already open. This session left no log rows.

## 6. Background and attribution

In the control windows only `logs_2.sqlite` (main file, `-wal`, `-shm`) and `models_cache.json` (the window after the product calls) changed. Log rows in them were written only by the Desktop app-server: 5 and 12 rows. The service files of `goals_1`, `memories_1` and `state_5` did not change in the control windows. In the third run the control windows showed changes to their `-shm` — that was the collector itself reading the databases. Everything that changed in the windows of our launches and was attributed to us is confirmed by our process's rows, `lsof` and modification times. The only exception is `models_cache.json` (section 4).

## 7. Network

| Request | When | What is known |
| --- | --- | --- |
| remote control (`https://chatgpt.com/backend-api/`) | loop — at startup, connection — after `initialize` | the log has `installation_id` and the host name; status `Disabled`, no enrollment. What exactly is sent is not visible |
| `GET /backend-api/codex/models` | +0.5–0.65 s | reply 200, the user's ChatGPT authorization header |
| remote plugin catalog (`ps/plugins/list`) | `GLOBAL` — at startup, `WORKSPACE` — after 13–25 s | in all four runs; the reply is written to `cache/remote_plugin_catalog/` |
| synchronization of installed remote plugins | +0.75–1.0 s | no changes, markers rewritten |

All connections were observed as a single TCP connection on `:443` to the `chatgpt.com` address. app-server analytics are disabled by default (`codex app-server --help`), and the profile has no `[analytics]` section.

## 8. Profile without ChatGPT authorization

A disposable `CODEX_HOME` with a single line `[features] hooks = true`, without `auth.json`. The same script, 10 s control windows (`result-disposable.json`, Obs):

- **The first launch** creates the databases and applies migrations (`state_5` 58), `installation_id`, `skills/.system` (71 entries).
- **Plugin catalog synchronization via git:** `git ls-remote`, `git fetch --depth 1` and `git reset --hard` from `https://github.com/openai/plugins.git` into `.tmp/plugins` — 7790 entries, a connection to `github.com:443`.
- **Without authorization — still network traffic to OpenAI.** The remote control loop waits for authorization and after `initialize` re-reads it once a second (16 rows each of `Reloading auth`/`Reloaded auth` from +5 to +20 s after start). The recommended plugins request to `chatgpt.com` without authorization gets 401; a connection to the `chatgpt.com` address is open just as on the regular profile.
- **Short launches.** Each of the three product calls (63–77 ms) and the reconciliation session left an empty directory `.tmp/git-XXXXXX` (HEAD, objects, refs). The `tmp/arg0` directory after SIGKILL was removed by the next launch, but nobody removed `.tmp/git-*`. After the product calls all five databases got `-wal` and `-shm`; the reconciliation session did not remove them.

The owner's regular profile has no git synchronization: `.tmp/plugins` has not been updated since 2026-08-08; the account works through remote plugins (`.tmp/app-server-remote-plugin-sync-v1`). There are no `.tmp/git-*` directories there after all the runs.

## 9. Summary of side effects

| Effect | Instrumented session (30 s) | Product call (35–53 ms) | Remains |
| --- | --- | --- | --- |
| threads, rollout, model call | none | none | — |
| `config.toml`, `hooks.json`, `auth.json`, trust | unchanged | unchanged | — |
| MCP and other child processes | none | none | — |
| user daemon | not affected | not affected | — |
| `logs_2.sqlite` rows | 42, about 12 KB | 0 | until Codex log rotation |
| network to OpenAI with user authorization | remote control, models, plugins | a connection probably starts | — |
| caches: plugin catalog, remote plugin markers, `models_cache.json` (Inf) | rewritten | none | ordinary Codex caches |
| `tmp/arg0/codex-arg0*` | created and removed | remains after SIGKILL | until the next `codex` launch |
| `-wal`/`-shm` of databases `goals_1`, `memories_1` (without remote plugins — all five) | created and removed on close | remain after SIGKILL | until the last connection to the database closes (Inf); the short reconciliation session did not remove them |
| `.tmp/git-XXXXXX` (only without remote plugins) | none | one per call | forever |

## 10. Created sessions (for deletion)

No threads or sessions were created: `state_5.threads` is 419 before and after, there are no threads with `originator: aang` or with a working directory in the temporary project, and no new files in `sessions/`. There is nothing to delete.

Traces left in `~/.codex`:

- 42 rows each in `logs_2.sqlite` from four instrumented sessions, 168 in total. Their `process_uuid` start with `pid:29178:`, `pid:80420:`, `pid:17509:` and `pid:84721:`. The rows will go away with Codex log rotation. If they must be deleted earlier, this is done with Codex, Desktop and the TUI closed: `DELETE FROM logs WHERE process_uuid LIKE 'pid:29178:%' OR process_uuid LIKE 'pid:80420:%' OR process_uuid LIKE 'pid:17509:%' OR process_uuid LIKE 'pid:84721:%'`. I did not delete them, so as not to write to Codex's internal database;
- rewritten plugin catalog caches, remote plugin markers and probably `models_cache.json`. These are ordinary caches; there is no need to delete them;
- an empty `goals_1.sqlite-wal` and a `-wal`/`-shm` pair for `memories_1` after the product calls. These are sqlite service files that Codex handles normally. There is no need to delete them manually, and it must not be done while Codex is running.

No `tmp/arg0` and `.tmp/git-*` directories from our launches remained in `~/.codex`. The disposable profiles and the test project lived in temporary directories and have been deleted.

## 11. How to reproduce

```sh
pnpm build
node docs/research/samples/codex-app-server-live/run.mjs --codex /opt/homebrew/bin/codex > result.json
mkdir -p /tmp/aang-d6-home && printf '[features]\nhooks = true\n' > /tmp/aang-d6-home/config.toml
node docs/research/samples/codex-app-server-live/run.mjs --codex /opt/homebrew/bin/codex --codex-home /tmp/aang-d6-home --control 10 > result-disposable.json
```

Without `--codex-home` the script works with the regular `~/.codex`. The parameters `--control`, `--before-initialize`, `--after-initialize` and `--after-list` set pauses in seconds, `--runs` — the number of product calls.
