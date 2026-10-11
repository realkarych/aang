# Installing hooks

`installCodexHooks` takes `aangHome`, `hookBinarySource`, `codexHome` and `codex: { command, args? }`. The CLI command and the profile are set explicitly. `args` makes it possible to run the CLI script through Node without a shell. `timeoutMs` bounds a single app-server query; the default is 10 seconds.

The installation holds a lock on `hooks.json` for the duration of two `hooks/list` queries and the file write. Each query starts a separate stdio process with `CODEX_HOME` and the working directory both set to `codexHome`: `initialize` → `initialized` notification → `hooks/list`. After the response or an error the process exits. There are no thread operations and no responses to server requests.

Foreign entries are matched by their positional `key`. A change in their `trustStatus`, a disappearing entry or an error in the final query cancels the installation. The rollback restores the original bytes and permissions of `hooks.json`, preserves a symlink, or deletes the file if the installation created it. If another program has managed to change the file in the meantime, its edit is kept: the `hooks_file_changed` error points to a backup copy for restoring after review. The rollback covers the registration; the binary copied into `AANG_HOME/bin` stays. The installer does not write `config.toml` or `hooks.state`.

`codexHooksState({ aangHome, codexHome, codex, timeoutMs?, signal? })` is a static check for the CLI and the daemon. `signal` cancels the check: the app-server is stopped and the function fails with `codex_app_server`. The result or error is returned after the app-server process group has become empty (ADR-0013). Confirmation is awaited for no longer than 10 s after the stop command: a response, an error, a timeout, a cancellation or a process exit. Without confirmation the check fails with `codex_app_server`, and subsequent queries of the same `codexHome` in this process do not start an app-server until the stop is confirmed. An entry counts as belonging to the current installation only if it has the command that `installCodexHooks` writes for this `aangHome`: `<AANG_HOME>/bin/aang-hook codex user <spool>` with the same quoting (`codexHookCommand`; on Windows, the PowerShell form, see the [Windows](#windows) section). The function returns these entries (`hooks`), the other aang entries (`stale`), runtime warnings and `status`:

| Value | State |
| --- | --- |
| `not_installed` | There are no entries of the current installation |
| `untrusted` | At least one entry of the current installation does not have `trustStatus: trusted` |
| `inactive` | All entries of the current installation are trusted, but at least one is disabled |
| `active` | All entries of the current installation are trusted and enabled |

`stale` are `aang hook` or `aang-hook` entries with a different command: previous installations, a different `AANG_HOME`, manual edits. They do not affect `status`, so trusted entries of a previous installation do not produce a false `active` (D.6, section 2). The installation neutralizes them in place, as before.

A launch failure, a timeout, a malformed response or hook loading errors lead to a `HookInstallError` with the reason `codex_app_server`; they are not replaced by a "not installed" state. `active` describes the configuration. Whether events actually arrive from a particular session is checked by the dynamic diagnostics from ADR-0004.

## Windows

- **Entry command.** Codex executes the hook command through PowerShell, so on Windows `codexHookCommand` produces `& '<AANG_HOME>\bin\aang-hook.exe' 'codex' 'user' '<AANG_HOME>\spool'`: the `&` call operator, paths in single quotes, a single quote is doubled. Neutralized entries get the command `exit 0`, because `true` is not a command in PowerShell. aang entries in both forms are recognized on any OS.
- **app-server via the launcher.** On Windows the app-server is started through the `aang-hook launch` launcher in `stream` mode (ADR-0013, technical decision 4, accepted by the owner on 2026-10-07). The launcher keeps all CLI processes in a Job Object and passes its stdin to the CLI as it arrives. When stdin is closed, it terminates the job and writes a status file.
  - The launcher's regular mode closes the CLI's input after the first n bytes, and the Codex app-server exits on closed input without answering `hooks/list`.
  - The result or error is returned after the status file, that is, after confirmation that the job has become empty. A launcher that failed to start the CLI writes the step and the error into the status, and they end up in the `codex_app_server` message.
  - A hung launcher does not hold up the call: 10 s after the stop command without a status file the query fails with an error, and a late status file lifts the ban on subsequent queries. A launcher that exited without a status file produces an error immediately, and the ban holds until the process restarts.
- **Which binary is the launcher.** For `codexHooksState`, the copy of the binary in `<AANG_HOME>\bin`; for `installCodexHooks`, `hookBinarySource`. Without a launcher the check fails with `codex_app_server`, and the CLI is not started.
- **Codex command.** A command without a path is looked up in `PATH` as `codex.com` or `codex.exe`: this is how Node would find it without a shell. The launcher does not run the npm shim `codex.cmd`, so an npm installation needs the path to the real `codex.exe`, or `node` with the package script in `args`.
- **What gets installed when.** The default installation on Windows is chosen by `cli`: `aang install` without flags installs only the Claude plugin, Codex hooks only with `--codex` (ADR-0013, decision 7). The functions of this package work on Windows the same way as on macOS and Linux.

Side effects of the app-server in the standard `~/.codex` were checked by D.6 (`docs/research/d6-app-server-live.md`). On startup the process itself contacts OpenAI services on behalf of the user and writes logs and caches to `CODEX_HOME`. Therefore, per ADR-0004, these functions are called only on an event: install and uninstall, `status`, `doctor`, daemon start, a change to `hooks.json` or `config.toml`. There is no periodic polling.

`aang install` for Codex (G.12) calls `installCodexHooks` and `codexHooksState` for the profile from the aang config, `CODEX_HOME` or the standard `~/.codex`. The ADR-0004 conditions after D.6 are met: each app-server process exits right after the `hooks/list` response, and the installation itself is the event that triggers the check. One installation starts three short processes: two trust queries around the `hooks.json` write and the final state check. `aang uninstall` does not start an app-server.

Integration tests use temporary profiles and a fake app-server and run on three OSes, on Windows through the launcher. The command string is verified by running it through the Codex shell: `sh` on macOS and Linux, `pwsh -NoProfile -Command` on Windows. Tests of file permissions and symlinks run only on macOS and Linux. Installation and the check with the real `codex` from CI are verified by the daemon contract test (`AANG_ISOLATION_CODEX`).
