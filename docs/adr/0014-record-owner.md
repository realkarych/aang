# ADR-0014: Owner of a collected record

Status: accepted by the owner 2026-10-02.

## Context

E.1 intake must keep unknown and unparsed session records in scope (ADR-0005), determine scope by the first `cwd` of the root session, and exclude the observer (ADR-0004). The facts from `parse` are not enough: for `unknown` and `invalid` there are none, even though the record may name the session. The adapter knows the runtime formats; `engine` must not parse them on its own.

Basis: [PR #25](https://github.com/realkarych/aang/pull/25), the preliminary contract for E.1, and comment 3 of its cross-review. The owner explicitly approved ADR-0014 in the PR #25 fix session of 2026-10-02. This ADR extends the adapter interface from ADR-0011.

## Decision

Add to `Adapter` a mandatory pure method `owner(record: CollectedRecord): RecordOwner | null`. It determines the owner independently of the result of `parse`, performs no I/O and makes no scope decision.

| `RecordOwner` field | Meaning |
| --- | --- |
| `session: SessionKey` | The root session the record belongs to |
| `thread: 'root' \| 'agent'` | A record of the root's thread or of an agent's thread, including a service thread |
| `cwd: string \| null` | A non-empty directory named by this record; this is not a ready scope decision |
| `start: boolean` | The record explicitly opens the root session; if `cwd` is given, it is the session's initial directory |
| `observer: boolean` | The record or the spool header has a recognized observer marker |

`null` means the adapter could not establish the record's owner. Errors in auxiliary fields do not destroy a known identity. `cwd`, the start flag and the observer flag are extracted independently: unrecognized evidence yields `null` or `false`, and valid neighboring fields are kept. `observer: false` means there is no recognized marker in this record, not proof that the session does not belong to the observer. `start: true` is allowed with `cwd: null`.

### Sources of evidence

- Hooks of both runtimes: the session from `session_id`, the agent thread from `agent_id`, the directory from `cwd`. `SessionStart` with `source` `startup`, `clear` or `fork` opens a root session; `resume` and `compact` continue the previous one. An agent record does not open a root session. Spool markers: `CLAUDE_CODE_ENTRYPOINT=aang-observer` and `CODEX_INTERNAL_ORIGINATOR_OVERRIDE=aang_observer`.
- Claude transcript lines: `sessionId`, `agentId`, `cwd`, the marker `entrypoint: aang-observer`. A line does not itself declare the start of a session: when the file is read from the beginning, `engine` determines the root's first line with a directory by position.
- Claude files: the owner of an agent meta file, a workflow snapshot and a workflow log line is determined by path; the owner of a team config by `leadSessionId`. A deleted team config without a payload yields no owner.
- Codex rollout: the root session and the thread are determined by the stream key. The root thread's `session_meta` opens the session; `session_meta` and `turn_context` may name the directory. Markers in `session_meta`: `thread_source: aang-observer` or `originator: aang_observer`. An error in one field does not erase a valid directory or another marker.

### Responsibility boundary

`engine` gets the adapters through the registry, decides scope and stores it next to the cursor per ADR-0004 and ADR-0011. It distinguishes the root's initial directory from the hook's current directory and the agent's directory, accounts for the shared git directory of a worktree, and discards observer sessions. Ownership does not depend on the presence of facts: unknown and unparsed records of a known in-scope session are stored raw per ADR-0005. This PR does not implement the E.1 intake transaction.

## Alternative

An owner field in every variant of `ParseResult` would tie identity extraction to fact parsing and would require changing every return point of `parse`. A separate method keeps the existing parsing protocol; the cost of this decision is an extra payload parse at intake.

## Verification

Integration tests call the public APIs of the real adapters on runtime samples. They check the owner, root and agent, session start, directory, self-exclusion, and combinations of valid and invalid fields. The intake transaction and the scope decision are checked by the first consumers in E.1.
