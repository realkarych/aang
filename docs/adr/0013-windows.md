# ADR-0013: Windows support

Status: requirement accepted by the owner on 2026-10-01: the MVP supports macOS, Linux and native Windows without WSL. The Go hook handler was accepted by the owner on 2026-10-01. The remaining technical decisions were accepted by the owner on 2026-10-01. By the owner's decision of 2026-10-02, Claude Desktop and Codex Desktop on Windows are not verified in the MVP (decision 3). The hook budget on Windows and the installation of Codex hooks on Windows were approved by the owner on 2026-10-06 (decisions 6 and 7). The launcher's `stream` mode for `codex app-server` was accepted by the owner on 2026-10-07 (technical decision 4). The `not_installed` state without launching app-server when there are no aang entries (section "Codex on Windows") was approved by the owner on 2026-10-08.

## Context

ADR-0004 proposed limiting the MVP to macOS and Linux. The owner decided otherwise: native Windows is part of the MVP.

The spike was conducted only on macOS, so everything related to Windows is unverified:

- the layout of `~/.claude` and `~/.codex`;
- the way Claude Code and Codex run hook commands;
- the behavior of fs watch and file locks;
- launching the CLI by the observer and storing authorization;
- the data of both Desktops.

The hook handler from ADR-0004 is written in POSIX sh, which does not exist on Windows. A Node handler takes tens of milliseconds to start and does not fit the 10 ms per-event budget.

## Decision

### Hook handler

- `aang-hook` is a single native Go executable for all platforms: macOS, Linux, Windows, amd64 and arm64 architectures. It replaces the sh script (accepted by the owner on 2026-10-01).
- The ADR-0004 contract does not change:
  - a synchronous call with `timeout: 2` s in the hooks config;
  - always `exit 0`, empty stdout and stderr;
  - no network;
  - the spool format with a header and NUL separators;
  - the lease, the stop marker and the observer markers;
  - reading stdin to the end.
- The handler compares the lease expiry with the system time inside the process. The file is created in the spool's temporary directory and renamed into `spool/new`.
- **`exit 0` in Go** is ensured by the binary itself:
  - expected errors are handled without output;
  - arguments are parsed without a terminating parser: `flag` with `ExitOnError` terminates the process with code 2. Invalid or missing arguments mean exiting without writing;
  - a panic is caught at the top level (`recover`) and ends with `exit 0` without output: an unhandled Go panic gives code 2;
  - stdin is streamed into the file without accumulating in memory; the handler runs in a single goroutine.
- **Limits of the guarantee.** The binary cannot survive a fatal Go runtime error (for example, out of memory) or external termination, whether by a runtime timeout, the OS or the user. `timeout: 2` bounds the solver's wait but does not ensure a successful exit, and reading stdin works only while the process is alive.
  - According to Claude's documentation, cancellation by timeout and a code other than 2 with empty stdout do not block the action. The exception is `PreModelSwitch`: a hook cancelled by timeout blocks the model switch, so aang does not register it (ADR-0004).
  - Codex's behavior on timeout and a non-zero code was verified by D.5 (macOS, Linux) and D.8 (Windows): a timeout terminates the hook process and does not block the action, `exit 1` does not block, `exit 2` in `PreToolUse` blocks the call on macOS and Linux.
- **Why Go:**
  - a static binary without a runtime;
  - startup in milliseconds on all OSes;
  - cross-compilation without a C toolchain (`CGO_ENABLED=0`).

  Rust is comparable in speed, but its toolchain is heavier. Compiled Node, Deno and Bun take tens of milliseconds to start. PowerShell takes hundreds of milliseconds to start, and `cmd` does not read stdin without corruption.
- This is an exception to ADR-0001 limited to one component (accepted by the owner on 2026-10-01). The AGENTS.md rules, including the ban on comments, apply to Go as well.
- On Windows the same binary also works as the CLI process launcher, the `aang-hook launch` mode (section "Processes and communication between them"). The mode is selected by the first argument: `launch` is not a runtime, so a call from the hooks config never ends up in it. This was accepted by the owner on 2026-10-01 and extends the purpose of the exception, but not the number of Go components.
- **Budget**: p95 per event, measured from the runtime side: from launching the hook command to the process exit, including the launcher (shell or direct launch) and passing stdin of typical size, in the configuration that `aang install` sets up.
  - macOS and Linux: p95 ≤ 10 ms for both runtimes.
  - Windows, Claude in exec form: p95 ≤ 25 ms (approved by the owner on 2026-10-06, decision 6). Almost all of this time is Windows process creation; speeding up the binary itself will not reduce it (D.8).
  - Windows, Codex: no budget. Codex runs the hook command only through PowerShell, which costs 0.25–0.4 s per event. So Codex hooks on Windows are not installed by default (decision 7, section "Codex on Windows").
  - The benchmark of the binary itself (plan, D.1) is a necessary condition and a regression check in CI, but not the final value.
  - The final value comes from a benchmark with the same launcher as the runtime's and a live check: the increase in the time of a series of events in a real CLI with aang hooks relative to a series without them (plan, D.5 for macOS and Linux, D.8 for Windows).
  - The strict benchmark of the binary on Linux and Windows is performed by D.8 on GitHub Actions runners; on Windows the CI measurement serves as the reference (decision 5).
  - Process creation is more expensive on Windows. If the final latency on any OS exceeds the budget, the measured value is brought to the owner rather than silently accepted.
  - D.8 measurements on the CI runner (reference for Windows, decision 5; `docs/research/windows-runtimes.md`):
    - direct launch of `aang-hook.exe`, as in Claude's exec form: p95 18–24 ms, almost all of it process creation; the strict D.1 benchmark gives p95 40–100 ms;
    - Claude series increase: 23–29 ms per event;
    - Codex hook through PowerShell: 0.25–0.4 s per event;
    - on Linux the same measurements give p95 2.4–3.3 ms and 3–7 ms per event, within budget.

    The values for Windows are above the previous 10 ms budget and were brought to the owner. By the owner's decision of 2026-10-06, Claude's budget on Windows is p95 ≤ 25 ms, and Codex hooks on Windows are installed only explicitly (decisions 6 and 7).
  - D.5 measurements of the installed configuration on macOS and in a Linux container (`docs/research/d5-plugin-delivery-live.md`): direct launch of `aang-hook` in Claude's exec form gives p95 2.5–3.6 ms on macOS and 1.4 ms on Linux; the Codex command through the account's shell gives 5.2–6.2 ms and 1.7 ms; the series increase is 3.7–5.6 ms per event for Claude and 4–6.4 ms for Codex on macOS. All within budget.
- **Delivery:** the binaries ship in npm as optional per-platform packages (`aang-hook-<os>-<arch>`), like esbuild. `aang install` copies the right binary unchanged to `<AANG_HOME>/bin/aang-hook` (`aang-hook.exe` on Windows).
  - In-place update: the new file is written alongside and renamed over the old one.
  - On Windows a running `.exe` cannot be overwritten or deleted, but it can be renamed. So the old file is first moved aside, then the new one takes its place; old copies are deleted later, when not in use. A call in the window between the two renames will not start; this is a lost event, as with an unavailable spool, not a block.
- **Invocation from hook configs**: by absolute path with a registration tag and the absolute spool path.
  - Claude invokes `aang-hook` in exec form: `command` is the absolute path, the arguments are in `args`. Without `args`, Claude passes the command to a shell: `sh -c` on macOS and Linux, Git Bash or PowerShell on Windows, and launching a shell on Windows by itself exceeds the budget. How a version without exec form will behave is not guaranteed: it may drop `args`, pass `command` to a shell where an absolute path with spaces splits into words, or reject the config. So exec form is verified by an installation contract test on the matrix versions, and a version on which it fails is not considered supported (ADR-0010).
  - Claude on Windows in exec form launches `aang-hook.exe` directly (D.8). Without exec form it passes the command to Git Bash: two extra processes and another 35–60 ms per event.
  - Codex executes a hook command only through a shell: Codex hooks have no form with arguments (D.8). On Windows this is PowerShell, `pwsh.exe -NoProfile -Command "<command>"`, and Codex finds `pwsh` even outside PATH. The command string is built per OS:
    - on Windows, a call with the `&` operator with paths in single quotes: `& '<path>\aang-hook.exe' 'codex' 'user' '<spool>'`, a single quote inside a path is doubled. Inside single quotes PowerShell does not expand `$` and the backtick. Without `&`, PowerShell takes a quoted string for an expression and does not launch the binary;
    - on macOS and Linux, paths in POSIX single quotes. Codex runs the command through the account's shell from the user database, not `sh` and not `$SHELL`: `/bin/zsh -c` on macOS, `/bin/bash -c` on Linux (D.5). There is no `-l` flag, but zsh reads the user's `~/.zshenv` on every event, and its time is included in the hook latency.
  - Launching PowerShell on every event costs 0.25–0.4 s (D.8), 25–40 times above the macOS and Linux budget. The owner's decision is in section "Codex on Windows".
  - `pwsh -Command` turns a command exit code other than 0 and 1 into 1. So on Windows a hook's `exit 2` does not block a Codex action. A Codex hook timeout terminates the hook process together with its descendants and does not block the action (D.8).
  - Paths with spaces and non-ASCII characters (a profile like `C:\Users\Имя Фамилия`) were verified by D.8 for both runtimes: in Claude's exec form and in Codex's `&` form they arrive without corruption.

### Codex on Windows

Decision 7 was approved by the owner on 2026-10-06, option "b" of the D.8 report:

- `aang install` without flags on Windows installs only the Claude plugin. Codex hooks are not installed, and Codex sessions run in «только файлы» ("files only") mode (ADR-0004): content, links and usage are visible, approval waits are not. `aang install` prints this together with the cost of Codex hooks and the flag that enables them.
- The explicit flag `aang install --codex` installs Codex hooks on Windows with a command in PowerShell form (section "Hook handler") and warns about the slowdown: Codex launches PowerShell on every event, which is 0.25–0.4 s per event.
- `aang status` on Windows repeats the same: with `not_installed`, that Codex sessions are visible only through files; with entries installed (`untrusted`, `disabled`, `active`), the cost of each event.

How installation implements decision 7:

- The `--codex` flag selects the runtime on all OSes. On macOS and Linux `aang install` without flags still installs both runtimes.
- A neutralized aang entry on Windows gets the command `exit 0`: `true` is not a command in PowerShell. On macOS and Linux it is still `true`.
- The trust and state check is aang's own `codex app-server` (ADR-0004), on Windows through the launcher (section "Processes and communication between them", technical decision 2). The launcher is the copy of `aang-hook.exe` in `<AANG_HOME>\bin` (during installation, the binary from the package that the installation copies). Without aang entries in `hooks.json`, the daemon does not launch app-server and shows `not_installed` (an amendment to ADR-0004 after a Q.1 finding, approved by the owner on 2026-10-08); with entries but without an installed binary, `unknown`, as for Claude.
- The launcher passes app-server's input in `stream` mode. This is not part of decision 7: the mode is technical decision 4, accepted by the owner on 2026-10-07. Without it the trust check on Windows does not work, and therefore neither does `aang install --codex`.
- If OpenAI adds a shell-less launch form to Codex hooks, the decision is revisited (option "c" of the D.8 report).

### Paths and files

- Default roots:
  - `%USERPROFILE%\.claude` or `CLAUDE_CONFIG_DIR`;
  - `%USERPROFILE%\.codex` or `CODEX_HOME`;
  - `AANG_HOME`: `%USERPROFILE%\.aang`.

  Paths are built via `os.homedir()` and the `path` module, not by concatenating strings.
- Claude finds its root via `USERPROFILE`, and Codex via the OS account profile: it ignores the `HOME` and `USERPROFILE` variables (D.8). For a user both match `%USERPROFILE%`. Where the profile is substituted (tests, tools), `CODEX_HOME` is set explicitly.
- Claude's project directory name encodes `cwd` lossily: every character other than Latin letters and digits (including `:`, `\`, space and Cyrillic) is replaced with `-` (D.8). The adapter takes transcript paths from the hook payload (`transcript_path`) and from the root scan, and does not reconstruct the project directory name from `cwd`. Desktop data on Windows is not verified (decision 3).
- File identity is `fs.stat` with `bigint`: `dev` (volume serial number) and `ino` (NTFS file index).
- Reading a file held by another process: Node opens files with share access. If the writing process holds an exclusive lock, the read is retried after a pause; a prolonged failure becomes a gap.
- Both CLIs write JSONL with `\n` on Windows too (D.8); line parsing still accepts `\r\n`.
- Permissions: on macOS and Linux the `AANG_HOME` directory has mode 0700. On Windows aang does not change ACLs and relies on the default ACLs of the user profile (access for the user, SYSTEM and administrators).
- Paths in `-c` values for Codex (TOML) are written with forward slashes: in TOML basic strings a backslash is an escape.

### File watching

- Recursive `fs.watch` on Windows works via `ReadDirectoryChangesW`. On buffer overflow events are lost, and the directory has to be enumerated again.
- Per ADR-0004 and ADR-0006, fs watch is only a signal on all OSes. The guarantee is provided by periodic scans:
  - runtime roots: a `stat` scan every 60 s;
  - tail files modified in the last 10 minutes: a `stat` check every 1 s without enumerating directories (ADR-0004, decision 14). Windows guarantees the last write time of an open file only after the handle is closed, so the window is also extended by size growth noticed by the collector;
  - `spool/new`: directory enumeration every 5 s; a lost notification delays a `PermissionRequest` by no more than this interval;
  - a watcher event without a file name, an error or the watcher closing trigger an immediate scan and recreation of the watcher.
- `collector.fsWatch: false` disables watch and leaves only the scans, for file systems without reliable notifications (for example, network ones). The intervals are configurable.
- D.8 on real CLIs confirmed: recursive watch on the roots and on `spool\new` delivers events with file names. Neither Claude nor Codex holds an exclusive file lock while writing. The collector and adapters parsed Windows files without errors.

### Processes and communication between them

- Unix sockets are not used anywhere. The daemon API listens on loopback TCP by default, the explicit `--bind` from ADR-0003 is kept; the OTel receiver is loopback only. The CLI talks to the daemon over HTTP. The scheme is the same on all OSes.
- The daemon is started as a detached process (`detached`, `windowsHide`).
- Stopping is via an authorized `POST /api/admin/shutdown` on all OSes: Windows has no SIGTERM, and a single path is easier to test.
  - First of all, `aang stop` writes the intentional stop marker `spool/stopped`. The marker is stored on disk and is removed only by an explicit `aang start`.
  - The daemon finishes the current intake transaction, deletes the spool lease and exits. Files without `ack` remain in the spool.
  - If the API is unavailable (the daemon crashed or hung), `aang stop` deletes the lease itself and reports from the pid file whether the process is alive. If it is alive, `stop` says plainly that stopping the process is not confirmed.
  - The marker works on its own, independently of the lease and of what the daemon is doing:
    - a hook writes nothing while the marker exists, even with a valid lease (ADR-0004). It sees the marker and the lease in one enumeration of the spool directory, so latency does not grow. A renewal started by the daemon before the marker will not resume writing;
    - while the marker exists, the daemon neither creates nor renews a lease: neither by the hourly renewal nor after draining the queue at the volume threshold. Every lease creation is accompanied by a marker check; a lease created in a race with `stop` is deleted by the daemon itself;
    - a live daemon that discovers the marker (checked once a minute together with the spool volume) shuts down the same way as on shutdown.
  - `aang start` removes the marker only after acquiring the storage lock, then creates a lease. If the previous daemon is still alive, the lock is held: `start` is rejected, the marker stays.
  - In tests a crash is simulated via SIGKILL, on Windows this is `TerminateProcess`. Graceful stop is verified only by shutdown via the API.
- **The observer on Windows** is launched without a shell (ADR-0007).
  - CLIs installed via npm are `.cmd` shims, which Node does not launch without a shell. So the daemon finds the real executable (`claude.exe`, `codex.exe`) or runs `node` with the package script. If it cannot be found, the backend is disabled with a reason.
  - The package script may be a wrapper: the Codex npm script launches the real `codex.exe` as a child process. The root and the real CLI are then different processes.
  - Locations per D.8:
    - Codex from npm: the `codex.cmd` shim calls `node <package>\bin\codex.js`, which calls `codex.exe` from `@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin`. Without a shell `spawn('codex')` gives `ENOENT`, `spawn('codex.cmd')` gives `EINVAL`;
    - Claude from npm: the `claude.cmd` shim calls `<package>\bin\claude.exe`, a native binary that `postinstall` copies there. If `postinstall` did not run (for example, due to the npm script policy), a stub is in that place, so the found file is checked by running `--version`;
    - the native Claude installer puts `claude.exe` into `%USERPROFILE%\.local\bin` without a shim and does not add it to the current session's PATH.
  - The list of clean environment variables is defined per OS. On Windows these are `USERPROFILE`, `HOMEDRIVE`, `HOMEPATH`, `APPDATA`, `LOCALAPPDATA`, `SystemRoot`, `TEMP`, `TMP`, `USERNAME`, `PATHEXT`, the system `PATH` and markers. `PATHEXT` was added as a result of D.8: without it Codex does not run hook commands, and the positive admission branch (ADR-0007) fails. The other variables are enough for both CLIs in the observer profile.
  - Storage of real CLI OAuth authorization on Windows is unverified: D.8 runs in CI with a fake model endpoint (decision 4). Authorization on the user's machine is checked by version admission (ADR-0007).
  - The working directory is `os.tmpdir()/aang-observer/empty`. On Windows it lies inside the profile, so the ancestor check for `CLAUDE.md` and `AGENTS.md` is mandatory; if it fails, the backend is disabled with a reason.
- **Terminating the process tree.** All CLI launches by the daemon (observer, chat, admission, probes, `auth status`) go through one backend operation on all OSes. A call ends with the root's exit, a timeout or a cancellation. After that the backend terminates the whole tree of the call, even if the root exited on its own, and confirms that it has stopped.
  - **macOS and Linux.** The CLI is launched as the leader of a new process group (`detached`), and the tree is terminated by SIGKILL to the group.
    - Stopping is confirmed when `kill(-pgid, 0)` returns `ESRCH`. Success or `EPERM` mean there are still processes in the group: on macOS an unreaped zombie gives `EPERM`.
    - The unit of accounting is the group. A descendant that left it on its own (`setsid`, `setpgid`) is not visible to this check; this is the limit of the guarantee on macOS and Linux. F.3 verifies that the real CLIs in the observer profile do not do this. If they do, the approach is brought to the owner.
    - F.3 showed: Claude Code 2.1.289 does not leave the group, while Codex 0.160.0 leaves it in every call. The `shell_snapshot` feature launches the account's login shell via `setsid()`, and it ends up outside the group together with the processes of the startup files. With slow startup files such processes outlive the confirmed stop of the group. So the Codex observer profile disables the shell snapshot, and version admission checks that no descendant left the group during the call (technical decision 3; ADR-0007).
  - **Windows.** There are no process groups, `TerminateProcess` terminates only the root, and `taskkill /T` does not find descendants of a parent that has exited. So the CLI is launched through the launcher, the `aang-hook launch` mode of the Go binary (a Job Object is not available from Node without native code):
    - the launcher creates a Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` without the right to break away from the job (`BREAKAWAY_OK` and `SILENT_BREAKAWAY_OK` are not set). It launches the CLI suspended, assigns it to the job and resumes it. All descendants are in the job from the moment of creation and stay in it even if their parent exited, and they do not inherit the pipes;
    - the launcher passes the first n bytes of its stdin (n is an argument) to the CLI's input. Closing stdin after them is the stop command: the daemon closes it on timeout or cancellation, and when the daemon exits, the OS closes it. The launcher passes stdout and stderr to the CLI as is, and the daemon reads them directly;
    - the `stream` mode instead of n (technical decision 4, accepted by the owner on 2026-10-07) is for CLIs with a stdio dialogue, currently `codex app-server`. The launcher passes its stdin to the CLI's input as it arrives and does not close it, and closing the launcher's stdin is the same stop command. The mode is needed because `codex app-server` (0.160) exits on closed input without answering an already received `hooks/list`: the requests cannot be passed in one batch with the input then closed. Reading the launcher's stdin does not depend on whether the CLI reads its input, so the stop command always gets through;
    - on the root's exit or on the stop command, the launcher terminates the job (`TerminateJobObject`) and waits until no active processes remain in it. Only after that does it write a status file with the root's exit code and the stop confirmation and exit;
    - a launcher that exited without a status file (terminated externally, crashed) did not confirm the stop. Kill-on-close then terminates the job's processes by OS means, but there is nobody to confirm it;
    - if the job could not be created or assigned, the CLI is not launched, and the backend is disabled with a reason.
    - D.8 verified this scheme with a harness and both CLIs: in a session with hooks and in the observer profile.
      - All descendants stay in the job, and the CLIs work inside the job.
      - The stop is confirmed immediately after the job is terminated.
      - No processes that the CLIs would spawn through OS services were found.
      - Codex leaves live `git` processes after its exit; the job terminates them.
      - A repeated D.8 check revealed a `Win32_ProcessStartTrace` delay: the event of a short-lived `aang-hook.exe` was missing 1.569 s after the job was stopped and appeared in a later snapshot. The tree became 47/47, with 0 active processes already in the job. This is a defect in the timing of the trace capture; no CLI process leaving the job was found ([evidence and regression](../research/windows-runtimes.md#101-investigation-of-the-counter-mismatch-in-pr-26)).
      - The test bench keeps the original 1.5 s observation window, then waits for the tree to match `TotalProcesses` exactly, no longer than 10 s after the job is stopped. The final trace is re-checked after the harness exits; incompleteness, tree ambiguity, a tracing error or a non-zero number of active processes produce a check error.
  - **The slot** of the observer or chat is released only on a confirmed stop of the whole tree. The root's exit and the closing of its pipes do not count as confirmation: a descendant may not inherit the pipes or may close them.
  - **Stop not confirmed within 10 s**: the slot stays occupied, the backend gets `unavailable: process_stuck`, and its next call is not launched. The state with its reason is visible in `/api/status`, SSE and the UI.
    - A late confirmation releases the slot: the group became empty or the launcher wrote the status.
    - If there is nothing left to confirm with (the launcher disappeared without a status), the state is kept until the daemon restarts, and the UI suggests a restart.
  - **The `codex app-server` probe** (ADR-0004) conducts a stdio dialogue, so it is launched by the `hook` package rather than the observer backend, but under the same rules. The confirmation deadline is 10 s from the stop command: a response, an error, a timeout, a cancellation or the root's exit. It does not depend on whether the launcher has exited. Without confirmation the probe ends with an error, and the next probe of the same `CODEX_HOME` in this CLI process is not launched until the stop is confirmed. A launcher that exited without a status file gives an error immediately and the same ban until the process restarts. The daemon shows the state of Codex hooks as `unknown` for that time.
- Git on Windows is Git for Windows, which Claude Code itself also needs. The commands are the same, read-only, with `GIT_OPTIONAL_LOCKS=0`.

### Surfaces and environments

- The same adapters work on Windows: the CLIs of both runtimes, Agent SDK and Codex SDK.
- Claude Desktop (the Code tab) and Codex Desktop on Windows are not verified in the MVP: this narrows RFC §4 (decision 3).
  - The support matrix rows (ADR-0010) for Desktop on Windows are explicitly marked `unverified`.
  - The owner runs the manual Desktop checklist only on macOS; on Windows the checklist covers the interactive Claude TUI.
  - Desktop sessions on Windows, if their files end up in the runtime roots, are processed like any sessions of an `unverified` row (ADR-0010).
- WSL is a Linux environment. Sessions inside WSL are observed by aang installed in WSL. aang on Windows does not read WSL file systems, and vice versa. With mixed work, two daemons are run.
- Docker on Windows runs Linux containers; this is a Linux environment.
- In the support matrix (ADR-0010) the OS is a separate key dimension, and reference recordings are stored per OS. Support on macOS and Linux does not carry over to Windows without recordings and checks on Windows, and vice versa.

### Verification and CI

- Before support on Windows is declared, a check similar to the spike is performed (plan, D.8):
  - the form in which both CLIs execute hook commands, Claude's exec form, paths with spaces and non-ASCII characters;
  - the latency of the installed hook from the runtime side;
  - Codex's behavior on a hook timeout and a non-zero exit code;
  - paths and formats of transcripts and rollouts;
  - fs watch and file locks;
  - observer launch and admission; the CLI process tree in the launcher's job and its termination; processes that the CLI spawns outside its tree (through OS services).
- The check runs in GitHub Actions on `windows-latest` (decision 4). Real `claude` and `codex` are installed on the runner and pointed at local fake model endpoints: Claude via `ANTHROPIC_BASE_URL`, Codex via a Responses API stub, as in the spike. No secrets are needed in CI. Real OAuth authorization is not verified on the runner.

  Reference sessions are also recorded on Windows, separately from the recordings of other OSes (ADR-0010).
- CI on GitHub Actions runs on a matrix of macOS, Linux and Windows: linter, types, integration, functional, contract and E2E tests. The `aang-hook` binary is built and tested on each OS.

## Consequences

- The repository has two languages: TypeScript and Go (one small component). CI needs a Go toolchain.
- External termination of the handler and a fatal Go runtime error remain possible: the event is lost and marked as a gap, as with an unavailable spool.
- D.8 verified the CLIs of both runtimes on Windows (`docs/research/windows-runtimes.md`). Desktop (decision 3), OAuth authorization storage (decision 4) and the interactive TUI remain unverified. The Claude hook budget on Windows is 25 ms (decision 6). Codex hooks on Windows cost 0.25–0.4 s per event, so by default Codex sessions on Windows run in «только файлы» mode (decision 7).
- The daemon is stopped via the API on all OSes, without signals. An intentional stop is durable: the marker is removed only by `aang start`, and a live daemon that sees it shuts itself down.
- A CLI call whose tree stop cannot be confirmed occupies a slot until confirmation or a daemon restart. This is a deliberate choice of safety at the expense of observer availability.
- The Go binary has two modes: hook on all OSes and launcher on Windows.
- CI is more expensive: tests run on three OSes.

## Owner decisions

Accepted by the owner on 2026-10-01:

1. The MVP supports macOS, Linux and native Windows, including Claude Desktop and Codex Desktop, without WSL.
2. The hook handler is a native Go binary for all OSes; this is an exception to ADR-0001 limited to `aang-hook`.

Accepted by the owner on 2026-10-02:

3. Claude Desktop and Codex Desktop on Windows are not verified in the MVP. This narrows RFC §4 and decision 1: in the support matrix the Desktop rows on Windows are explicitly marked as "unverified" (`unverified`).
4. D.8 runs in GitHub Actions on `windows-latest`: real `claude` and `codex` on the runner, a fake model endpoint, a report in `docs/research/` based on the CI results. Storage of real OAuth authorization on Windows is marked as unverified.
5. The strict `aang-hook` benchmark on native Linux and Windows is part of D.8; on Windows the reference is taken from CI (decision on PR #11).

Accepted by the owner on 2026-10-06 based on the D.8 report ([`docs/research/windows-runtimes.md`](../research/windows-runtimes.md), section 2):

6. The budget of `aang-hook.exe` for Claude on Windows is p95 up to 25 ms per event from the runtime side. On macOS and Linux the budget is still 10 ms.
7. Codex hooks on Windows are not installed by default: Codex sessions run in «только файлы» mode (ADR-0004), approval waits are not visible. An explicit flag enables the hooks, and `aang install` and `aang status` warn about the slowdown of 0.25–0.4 s per event.

## Owner decisions on technical questions

Accepted by the owner on 2026-10-01:

1. Permissions on Windows rely on the user profile's ACLs without custom ACL configuration. Accepted for the MVP.
2. The launcher on Windows is the `aang-hook launch` mode of the same Go binary with a Job Object. The alternatives are worse: a native Node module is a second native component with a C/C++ toolchain and per-platform builds, and `taskkill /T` does not find descendants of a parent that has exited. The mode extends the purpose of the ADR-0001 exception, but not the number of Go components. Accepted.

Accepted by the owner on 2026-10-04 based on the F.3 report ([`docs/research/f3-observer-measurement.md`](../research/f3-observer-measurement.md), section 2, item 1; PR #96):

3. Codex leaving the process group is eliminated in the profile, rather than accepted as a limit of the guarantee or replaced by other process accounting (subreaper or cgroup on Linux).
   - `--disable shell_snapshot` was added to the Codex observer profile (ADR-0007, decision 10). The shell snapshot is needed only by shell tools, and those are disabled for the observer. With this flag F.3 found no processes outside the group and no `setsid`/`setpgid` calls on either OS; answers and latency are the same.
   - Version admission (ADR-0007) on macOS and Linux checks every CLI call: no descendant left the process group, otherwise admission fails. The check is needed so that a new CLI version with a different source of `setsid` does not go unnoticed. This is an admission safety net, not process accounting: it does not extend the tree stop guarantee.
   - The check works by snapshots of the process table. A process that left the group and disappeared, or lost its link to the root between snapshots (for example, after a double `fork` with the intermediate parent exiting), may go unnoticed. A snapshot error at any point of the call is an admission failure, even if the last snapshot succeeded.
   - On Windows the check is not needed: the launcher's job is created without the breakaway right, and all descendants stay in it.

Accepted by the owner on 2026-10-07 (owner's reply to the orchestrator):

4. The launcher's `stream` mode is for CLIs with a stdio dialogue, currently only `codex app-server` during the trust check on Windows.
   - Why. Codex 0.160.0 exits on closed input without answering an already received `hooks/list` ([`docs/research/windows-runtimes.md`](../research/windows-runtimes.md), section 14). The "first n bytes, then close the input" mode does not work for app-server, and without the trust check `aang install --codex` does not work (decision 7, ADR-0004).
   - What changes. Instead of the number n, the launcher gets `stream` and passes its stdin to the CLI's input as it arrives. Closing the launcher's stdin is the same stop command. Reading the launcher's stdin does not depend on whether the CLI reads its input, so the stop command always gets through.
   - What does not change: a Job Object with kill-on-close without the breakaway right, launching suspended, waiting for the job to empty, the status file, refusal without a job.
   - Hangs and loss of the launcher follow the rules of the `codex app-server` probe (section "Processes and communication between them"). A hung launcher: the probe ends with an error 10 s after the stop command, subsequent probes of the same `CODEX_HOME` are not launched by the CLI until a late status file. A launcher that exited without a status file: an error immediately and the same ban until the process restarts.
