# Stage operations

`applyObserverResponse` applies the `stage.*`, `actions.assign`,
`agents.participate` and `artifact.link` operations through the model journal.
Replaced, merged and split stages remain addressable, with successor ids in their
lifecycle and all earlier states in `store.model.entityChanges`. Replaying the
journal restores the same stage and relationship ids.

Assignments, participation, artifact links and dependencies are upserts by their
endpoints. Repeating a relationship keeps its id and updates its grounds. Artifact
input and output links are distinct; the same action, agent or version can belong
to several stages. Linking a version makes it a basis; see Artifact versions.

## Runtime execution

`refreshStageExecution(transaction, { run, at, observations })` reconciles active
stages with a complete current snapshot of the run's actions and agents.
It reads stage links and attention from the model, checks current object ownership,
and records changes as a rule version. An unchanged projection returns `null` and
does not advance the model version. Replaced stages retain their historical state.

Actions use their `input_fact` as execution evidence. Each agent is supplied as a
`StageAgentObservation`: an `Agent` plus required `execution_evidence` containing
only the facts that determine its current execution. The observation projection
replaces these grounds when execution changes; it must not append unrelated events
or the agent's full history. Reconciliation uses these supplied grounds without
reading the historical facts of the agent or session. Rule evidence is deduplicated
and sorted, so changing the order of the snapshot does not create a model version.

Pass the same snapshot as `observations` to `applyObserverResponse` to reconcile
new assignments and state claims before its transaction commits. The returned
version includes both the observer and any subsequent rule changes. A rejected
response applies neither its operations nor reconciliation. The parameter is
optional for callers which only apply semantic operations; such calls retain the
existing protection of rule execution against observer claims.

E.2 observation projections are not implemented on this branch. Their owner must
call reconciliation after projecting runtime changes, in the ingestion transaction,
and G.6 must supply the current snapshot when applying observer results. This
package does not persist a second copy of observations or write E-owned tables.
The functional tests ingest transcripts and hooks through real adapters and supply
typed observation fixtures at this component boundary.

Execution follows ADR-0006:

- A running assigned action or participating agent makes the stage `running`.
- Otherwise, an active rule request or a participant's explicit wait makes it
  `waiting`. Human waits take precedence over background, idle and unknown waits.
  An open request whose runtime wait has ended does not hold execution open.
- An action's agent participates implicitly. Existing explicit participation keeps
  its own grounds.
- While the rule controls execution, `execution_claim` retains the latest observer
  assessment. Different execution values expose the contradiction to the inspector.
  When activity ends, the assessment becomes visible again; without one, execution
  becomes `unknown`. Silence alone never infers success, failure or a wait.
- The independent human decision follows the stage's requests; see
  [Human decision on a stage](#human-decision-on-a-stage).
- An action-level request without an explicit stage applies only while that action
  belongs to the stage's run. Moving it preserves the historical assignment but
  removes its execution wait and requested decision from the old stage.

All writes use the caller's transaction and the existing journal/replay path. The
caller must build the snapshot from current projections in that transaction; an
observer input captured when a call started is not a current runtime snapshot.

## Human decision on a stage

A stage's requests are its questions, permission requests and review requests:
items attached to the stage, and action-level items whose action is assigned to it
and still belongs to the run. Blockers and failed checks are not requests.
The rule `stage-decision` derives the decision from them (ADR-0006):

- While any request is open, including a nonblocking one, the decision is
  `requested` with the opening evidence of every open request.
- Otherwise the most recently closed request decides (by `closed_at`, then id):
  - a rule item linked to a question observation whose decision is `approved`,
    `rejected` or `answered` takes that value and the observation's evidence;
  - another item closed as `answered`, except a permission request, gives
    `answered`;
  - every other closing gives `unknown`: a wait that ended without an answer,
    an observer `resolved` item, or a permission without an observed decision.
  Without an observed decision, the evidence is that of the latest journal change
  that set the item's current resolution or `closed_at`, so refining a closed item
  cites the refinement, while a later priority or other change does not.
- A stage that never had a request keeps its decision. If its requests disappear,
  for example because their action moved to another run, a derived decision
  becomes `unknown` and keeps the evidence of the last derived decision.

`refreshStageExecution` applies this rule together with execution.
`refreshStageDecisions(transaction, { run, at })` applies only the decision for
callers that change attention or question decisions without an observation
snapshot. `applyObserverResponse` uses `refreshStageExecution` when it receives
`observations` and `refreshStageDecisions` otherwise, so a `question.add` or an
`attention.resolve` always reaches the stage in the same transaction. Both record
a rule version only when a decision changes.

## Criteria, cards and the run brief

- `criterion.add` creates a `task` or `plan` criterion with status `not_checked`;
  `plan` requires a plan fact among the evidence.
- `criterion.assess` stores the observer's assessment: `not_checked`, `partial`,
  `failed` or `reported_done`. The basis is `claimed` when every piece of evidence
  is a solver statement and an LLM interpretation otherwise. The protocol has no
  way to express `confirmed`, `passed_unversioned` or `stale`; an output that tries
  is rejected by the schema with the whole response.
- `card.add` cites a fragment of the final text of an agent: a final solver
  message from a transcript or rollout, the `final_message` of a turn end (Stop
  hook, Codex task completion) or of an agent end (SubagentStop). The coordinates
  are UTF-16 offsets into that text, and the card text must equal the fragment.
  The card's `source.fact` leads to the fact and, through its `seq`, to the
  original raw record.
- `brief.update` stores a nonempty retelling of the run goal beside the observed
  goal from the first prompt. A user change of the brief after the base version is
  a conflict.

## Attention operations

`question.add` and `attention.add` open observer items (`question`,
`review_request` or `blocker`) without a runtime wait. `attention.resolve`
closes only observer items and needs evidence; aimed at a rule item it rejects the
whole response, and every fact of the batch returns to `pending`.
`attention.likely_resolved` marks a rule item as probably answered with an LLM
interpretation and evidence; the item stays open until a rule closes it or the
user dismisses it. `attention.priority` records a recommendation with the call id
and does not change the order of attention.

## Check contracts

`createEngine` takes the check contracts of each watched root in
`watch.roots[].contracts`, the shape of `~/.aang/config.json`. A run uses the
contracts of every root that contains the `cwd` of its root session, compared after
resolving symbolic links. When roots are nested, a contract of the deepest root
replaces contracts of the same name from outer roots.

The ingest transaction re-evaluates the checks of every run whose sessions received
facts, after the observation projection (ADR-0006):

- A check is a command action of the run, not inherited by a fork, with an
  `action_start` whose command line matches the `command` pattern of a contract.
  The pattern is a Unicode regular expression searched in the line. The line is the
  `command` or `cmd` string of the tool input, or an argument vector joined by
  spaces. The script of a shell vector is also a line: the last argument after a
  flag such as `-c` or `-lc` (`/bin/zsh -lc 'pnpm test'`), the arguments after
  `-Command` or `-c` of `pwsh` and `powershell`, and the arguments after `/c` of
  `cmd`, with the program recognised by its file name on any platform. A command
  that matches no contract is not a check.
- A reported exit code decides the result through `successExitCodes`. Without an
  exit code, an error is a failure, and a successful completion is exit code 0
  unless the command was started in the background (`run_in_background`), whose
  result is not observed. An interrupted or denied action, an action without an end
  and an end with an unknown outcome and no exit code give no result. The result
  time is the earliest end of the action that has an exit code or a known outcome,
  so an interim output, such as a Codex `function_call_output` of a command that
  is still running, does not date it; results of the same contract are ordered by
  it.
- Failures of a contract without a success between them form one `failed_check`
  item of the rule: an action-level item without a stage and without a runtime
  wait, with observed basis. Its evidence is the matching start, the dating end and
  the deciding end of every failure; it names the latest failure and its exit code,
  and opens at the first. The next success of the same contract closes it with the
  resolution `answered` and its time; the closing journal change cites the success.
  A failure after that success opens a new item.
- Items are reconciled with the full result history of the run, so a transcript
  read at once records a failure that was already fixed as an item opened and
  closed in one version. An item id derives from the run, the contract name and one
  failure of its streak, and a streak keeps the item of any of its failures: a late
  earlier failure joins the open item, a late success between failures splits it,
  and repeated delivery changes nothing. When streaks merge, the streak keeps its
  open item, which the success after the merged failures closes; the other items
  of the merged streaks stay closed in history. Without an open item it keeps an
  item that already describes it, otherwise the item of its earliest failure.
  Observer fields of an item (likely resolution, priority) are kept. An open item
  whose id derives from an action that now succeeds, for example after its facts
  are read again, is closed with the resolution `answered` and the time of that
  success; the closing journal change cites the success, and the remaining
  failures of its former streak form their own item. An item whose failures no
  longer match a contract after the configuration changes keeps its last state.
- A session moved out of the run takes its failures and successes along. Besides
  the items its failures name by id, a streak considers the items that no failure
  names, cite any of its failures and have an id derived from the same contract and
  a failure in the item's journal, because the failure their id derives from left.
  It keeps one of them by the same preference, so the open item goes on with the
  rest of the streak, also when a success that left merges two streaks, and closes
  on its next success. An item that no streak keeps leaves the current state with
  a rule `session.move` removal at the time of the transfer when none of its cited
  facts remain in the run or when the success that closed it left. Its history
  stays in the journal, and a streak that moves back gets its item id again. A
  transfer is never recorded as a success or a removal by the user.

The run of a session is the run of its `session_membership`, or the run of its own
root key when there is none, the rule that run linking (E.4) uses for projections.
The root session of a run comes from its `run` entity; without one, a session that
is its own root uses its `cwd`.

## Contract criteria

Each contract with a check result in a run has one criterion of the rule (ADR-0006):
source `contract`, the contract name, the text `Check "<name>" passes`, no stage,
and an id derived from the run and the contract name. The latest result of the
contract decides its status with observed basis, and every change is a
`criterion.status` rule change in the journal:

- a failed check gives `failed` with the evidence of the check;
- a passing check gives `confirmed` only when the contract has a `commitPattern`,
  the outputs of the check report exactly one object name through it, and that
  name is a commit of the repository of the check directory. The name is the
  named group `commit`, otherwise the first group, otherwise the whole match; it
  must be 7 to 64 hexadecimal digits, a shorter name that prefixes a longer one
  counts as the same name, and the commit is resolved with `git rev-parse --verify
  --quiet <name>^{commit}` and must start with the name, so a tag or a tree is not
  a commit. `checked_commit` is the full name. The contract is responsible for the
  check reading that commit, for example by checking out the commit in an isolated
  `git worktree` and printing its `HEAD`; the output alone links them, so a check
  read by backfill is confirmed as well. The evidence cites the facts of the check
  and every result of the action whose output reported the name, so a commit
  reported only by a later transcript result of a call is cited as well;
- every other passing check gives `passed_unversioned`: no commit pattern, no
  reported name, several names, a name that is not a commit, a directory outside a
  git repository. When the snapshot taken after the start of the check was ingested
  and before its end, and the first snapshot after its end, are both clean on the
  same `HEAD`, `clean_tree_commit` notes that commit and the evidence cites both
  snapshots. The note never confirms: the input could change and return between
  them;
- snapshots of the working tree of the check directory under the masks of the
  contract taken after the end of a confirming check decide `stale`: when the latest
  of them is not clean on `checked_commit` (another `HEAD`, a change under the
  masks or a failed git command), the criterion is `stale` and cites the first
  snapshot since the tree last showed the commit. A failed snapshot names the check
  directory instead of its working tree and belongs to the criterion as well, so a
  deleted check directory makes it `stale`. A later snapshot clean on the commit
  confirms it again, since the current state is the checked version.

Once a result has given `checked_commit`, the commit stays established for that
result: while the latest result is the same and the criterion cites its facts, a
later evaluation keeps `checked_commit` without resolving the name again, so a check
directory that is gone after a restart leaves the criterion `stale`, not
`passed_unversioned`.

The order of snapshots and check facts is the order of their raw records, so it
does not depend on the clocks of the runtime and the daemon.

A criterion with `checked_commit` is watched:

- at the end of every turn of its run (`turn_end` facts), the ingest takes a
  `turn_end` snapshot of its check directory;
- `engine.refreshCriteria()` takes a `restart` snapshot for every such criterion
  of the store; the daemon calls it once after start;
- with `fsWatch` (on by default, `collector.fsWatch` in the daemon), the engine
  watches the paths of the masks inside the working tree: a directory recursively,
  a file through its parent directory, a mask with a wildcard (`*`, `?`, `[`)
  through the path before its first wildcard segment, recursively, ignoring `.git`.
  A change takes a `fs_watch` snapshot after 100 ms of quiet, and the snapshot
  decides whether the change is under the masks. A notification is only a signal: a
  missed one is caught by the next snapshot at a turn end or a restart.

A binding that moves a session to another run moves its checks along: the binding
transaction evaluates the criteria of the run the session left and of the run it
joined, and a run with no check of a contract any more loses the criterion of that
contract with a `session.move` rule change, as failed check items do. Snapshots stay
in the run they were taken for, and an evaluation reads only the snapshots of its own
run, so a binding never confirms on snapshots of another run. A passing check that a
binding moves or brings forward gives `passed_unversioned` without `checked_commit`
and without the note, with a `session.move` rule change as its reason, and keeps it
for good. A criterion lists its carried checks in `carried_checks`, by the id of the
check action, and the binding transaction adds them with a `session.move` change of
the criterion even when another check still covers it:

- a carried check is any check of a moved session that has a result in the run when
  the binding moves the session, whether or not it is the latest check of the
  criterion;
- a check brought forward is the latest check of a criterion in the binding
  transaction that the criterion did not cite before, such as an earlier check of
  the run the session left that a later check of the moved session covered;
- a check is carried for good once any state of a criterion of any run has listed
  its action in the journal; every evaluation reads these actions with one query
  over the journals of all criteria. The status holds in whichever run the action
  has a result later, whichever check covers the criterion in between and however
  the results of the action change: a transcript read after a check of another
  session can put the moved check in front again, a detach can uncover it, a
  reparse can remove its result, a binding can take its session to another run
  while it has no result, the criterion can be removed and created again, and turn
  end snapshots, `engine.refreshCriteria()` and `engine.reparse()` evaluate it the
  same way, before and after a restart. `carried_checks` of a criterion lists the
  carried actions among its checks that have a result in the run. Only a check of
  another action confirms the criterion again;
- a check that the moved session runs after the binding is not affected, since its
  action has no result at the binding and every snapshot after it belongs to the run
  it joined.

`engine.reparse()` evaluates the criteria of the runs it rebuilds in its transaction
the same way.

The ingest evaluates the criteria of every run whose sessions received facts in the
transaction of the batch, together with its facts and cursors (ADR-0005). The git
state that a verdict needs (the working tree of the check directory and the commit
of the reported name) is read before that transaction: when the transaction meets a
check whose git state is not known yet, it is rolled back, the engine reads the git
state and repeats the transaction once; a binding and a reparse do the same. The git
state is read once for each result (its check directory, the facts of the check and
the reported name with its facts) and kept for the life of the engine. A later
result reads git again and finds a repository created or a commit fetched since; a
result already read keeps its state even when a later result of the same directory
finds a repository, so the state of one check never changes the verdict of another.
After a restart a result without an established commit is read again. The snapshots
of the batch are taken after
the commit and recorded together with the evaluation they change in one more
transaction. A crash between the two loses only these snapshots: a confirmed
criterion is checked again by the `restart` snapshot, and the note of an
unversioned pass, which needs the snapshot after the check, is not given.
`engine.close()` stops watching and waits for queued work; a failure of work started
by a notification is raised by the next call of the engine.

## Working tree snapshots

When the ingest transaction stores the start or the end of a check (a command
action of a run that matches a contract), the engine takes a snapshot of the
working tree after the commit and before `ingest` resolves (ADR-0006). A batch
that holds both the start and the end of a check takes one snapshot; a start and
an end read in separate batches give snapshots around the check. Checks read by
backfill are snapshotted when they are read, so `taken_at` tells later readers
whether a snapshot can precede the check.

The snapshot runs in the directory of the check, finds the top of the working tree
and runs read-only commands with `GIT_OPTIONAL_LOCKS=0` and `core.fsmonitor=false`:

- `git rev-parse --verify --quiet HEAD^{commit}`;
- `git status --porcelain=v1 -z --ignored=traditional --untracked-files=normal
  --ignore-submodules=none -- <pathspecs>`.

User settings that hide untracked files or submodule changes do not apply, and
git neither refreshes the index nor takes `index.lock`. `inputMasks` of a contract
are paths relative to the watched root that declares the contract, interpreted as
git pathspecs. A mask that covers the whole working tree becomes `.`, and masks
outside the working tree are dropped; when no mask remains, no snapshot is taken.
The snapshot records the masks resolved against that root as absolute paths, so the
same mask of contracts with different roots names different inputs, and a criterion
reads only the snapshots of its working tree with the masks of its contract resolved
the same way.

A snapshot is clean only when `HEAD` resolves to a commit and the status under the
masks is empty: an uncommitted, staged, renamed, untracked or ignored path under a
mask makes it unclean. A failed git command (no repository, a missing directory)
gives an unclean snapshot without a head and with the error.

Each snapshot is a raw record of the `snapshot` channel (position `daemon`, no
runtime or stream), one `git_snapshot` fact keyed by the run of the root session
with speaker `runtime`, and a `GitSnapshot` object with its trigger: `check` for
checks, `turn_end`, `restart` and `fs_watch` for confirmed criteria (see Contract
criteria). Daemon
records are not session evidence: they do not move `last_event_at`, freshness or
the turn state.

The directory of an action comes from all of its starts. An explicit directory of
the tool wins: `workdir` of a Codex `exec_command` or `cwd` of a Codex
`CommandExecution`, given as a path or a `file://` URL. A relative explicit
directory resolves against the ambient one. The ambient directory is the `cwd` of
a start, otherwise of the session. A check without any directory runs in the
`cwd` of its root session.

## Artifact versions

The ingest transaction projects artifact versions from the actions whose start or
end it stores. A version belongs to the run of the action's session, its artifact
is the absolute path, and it records the action in `produced_by`. Inherited
actions give no versions. Paths come from:

- Claude `Write` (`file_path` with `content`), `Edit` and `MultiEdit`
  (`file_path` with the replacements as a patch), `NotebookEdit`
  (`notebook_path`);
- Codex `apply_patch` (`*** Add File` with its content, `*** Update File` with
  its hunks as a patch and its `*** Move to`) and `FileChange` items (`add`,
  `update` with `move_path`); deletions give no version;
- shell scripts of command actions (a `command` or `cmd` string, or the script of
  a shell argument vector): redirection targets and the file arguments of `tee`.
  Comments, quoted text, expansions and globs are not targets; duplications such
  as `2>&1`, devices, and targets with expansions, globs or a leading `~` are
  skipped, and relative targets are skipped when the script changes directory.

Relative paths resolve against the directory of the action (see Working tree
snapshots). A script is read with the rules of its shell:

- POSIX (`sh`, `bash`, `zsh`): `>`, `>>`, `>|`, `&>`, `&>>`, `N>`; heredoc bodies,
  `[[ ]]`, `(( ))` and process substitutions are skipped; a backslash escapes any
  character outside quotes and only `$`, `` ` ``, `"`, `\` and a newline inside
  double quotes; `/dev/*` are devices; `cd`, `pushd` and `popd` change directory;
- PowerShell: `>`, `>>`, `N>`, `*>`, `*>>`; the backtick is the escape character,
  quotes are doubled inside quotes, `$` expands in double quotes, block comments
  and here-strings are skipped; `nul`, `con` and other reserved names are devices;
  `cd`, `Set-Location`, `Push-Location`, `Pop-Location` and their aliases change
  directory; `tee` and `Tee-Object` write files;
- `cmd`: `>`, `>>`, `N>`; `^` escapes, quotes are literal, `%` and `!` expand, `rem`
  and `::` lines are remarks; reserved names are devices; `cd`, `chdir`,
  `pushd`, `popd` and a bare drive change directory.

The shell of an argument vector is its program (`pwsh`, `powershell`, `cmd`,
otherwise POSIX). A command string uses the `shell` of the input when it is given;
otherwise Claude `PowerShell` is PowerShell, Claude `Bash` is POSIX (Git Bash on
Windows), and a Codex command runs in the host shell: PowerShell on Windows, POSIX
elsewhere.

A file tool gives a version after an end with outcome `ok`; an end with an unknown
outcome, such as a Codex `PostToolUse` or tool output, is not enough. A command
gives a version after any end except `denied`, because a failing command still
writes its redirections.
Full content in the payload (Claude `Write`, an added file of a Codex patch) makes
the identity the content hash. Otherwise the version is known only by reference:
its identity is the earliest stored start that names the path. The projection is
repeatable, keeps the stored retention, and dates a version by its earliest
qualifying end.

Actions that write the same content to the same path share one content version.
Its `produced_by` and `observed_at` are those of the earliest qualifying end, ties
broken by the smaller action id, so the result does not depend on the order in
which the evidence arrives, and a late hook of a known action changes nothing. An
`action_payload` retention names the same action: the payload of every producer
holds the same bytes.

## Retention of bases

`engine.retainBases(runs?)` retains every version of the given runs (all runs by
default) that is still known only by reference and is a basis: the version of an
`artifact` link or the `via` of a `dependency` link. Callers run it after applying
an observer response and after a restart; the engine queue orders it with ingest.

- A content version whose payload still holds that content is retained from the
  payload as `action_payload`: the version the action produced.
- A version written by a patch (Claude `Edit`/`MultiEdit`, a Codex `*** Update
  File`) is rebuilt from the patch and its base and retained as `action_payload`
  of the patching action. See Patch bases below.
- Otherwise a regular file at the path is read as `file_read` with `read_at`, the
  state of the file at the moment of reading, not proven to be the output of the
  action.
- Content larger than `maxBlobBytes` (5 MiB by default) keeps only `hash_only`
  with its SHA-256 and size; no blob is stored.
- A missing path, a directory or an unreadable file keeps the version known only
  by reference; a later call reads it again.

### Patch bases

The base of a patch is the content of the patched path that the action changed. It
is established only when it is proven:

- a Claude `Edit` or `MultiEdit` that reports `originalFile` in its result has that
  content as its base: the tool read it right before applying the change. When the
  result says `userModified`, the change differs from the input and the version is
  not rebuilt. Only an edit without a reported original looks for a base in the run;
- otherwise the base is the latest known state of the source path (the path before a
  `*** Move to`) before the patch started: the end of a write of the run (all its
  sessions), that is a successful file tool or a command that redirects to the path,
  or a stored `file_read` of the path with its `read_at`. Two states at the same time
  make it ambiguous;
- the content of a write is known from payloads: full content of the action, or a
  patch to its own established base. A command write has no known content. The
  content of a stored read is its blob, decoded as strict UTF-8 with its byte order
  mark kept;
- nothing may have changed the path between that state and the end of the patch: no
  other action that could write it ran in that window. Every command, MCP tool, code
  cell and unknown tool could write any path, a file tool could write the paths it
  names; reads, searches, web, questions, plans and agent calls, whose own actions
  are observed in their sessions, do not write. Denied actions did not run; an
  action without an end and a Claude command `run_in_background` are still running.
  A Codex command whose call returned `Process running with session ID N` runs until
  its own result settles with an exit code or an outcome, or a `write_stdin` poll of
  session `N` reports `Process exited with code`; a return of the call is not the
  end of the process;
- every replacement applies exactly: Claude `old_string` occurs once (or at least
  once with `replace_all`), and an empty `new_string` does not touch a following
  newline; Codex hunks match their context and lines exactly, with the matching
  and end-of-file rules of `apply_patch`.

When any condition fails the version is read from the file as before. Writes the
daemon does not observe at all, such as an editor outside the sessions, are out of
reach of these rules; a reported original covers them for Claude edits. Codex
`FileChange` diffs are not used as patches; the `apply_patch` input of the same
action is.

Blobs are stored once per hash with a reference per version and its source; the
last reference removes the blob. Retention changes the version, so it reaches the
change feed. Versions of URLs, commits and pull requests are not retained here.

## Input scope and needs

`inputScope(reader, { run, backend, crossVendor })` is the single filter for the
observer input; chat materials (K.1) use the same filter. An object is in scope only
when its session belongs to the run. A session of a vendor other than `backend`, the
vendor that receives the input, is excluded unless `crossVendor` is set. A raw record
is attributed through its facts, so a record without facts is out of scope. A
`context` fact follows the rule of its record: it is in scope only when every
session the context was assembled from is, whichever session keys it. A model
entity of the run is attributed through its grounds, the evidence of every change in
its journal: it is excluded when a ground comes from a vendor other than `backend`
without `crossVendor`. A ground from a session that has since left the run does not
exclude the entity. A ground fact that a reparse no longer produces is attributed
through the stored input of the observer call that wrote a change of the entity: the
input keeps the raw record of every batch fact, and the raw record keeps its
runtime. A ground whose vendor cannot be established this way, such as a deleted
fact cited by a rule, excludes the entity without `crossVendor`. The run goal and
brief follow the same rule through the journal of the run. An artifact version is in
scope only when it is bound to the run and the action that produced it is stored and
in scope itself. A version whose producer is gone, such as an action of a session
moved to another run that was then pruned, is `out_of_scope` whatever the backend and
`crossVendor`: its vendor and session can no longer be established.

`inputViolations(reader, scope, input)` applies the scope to the whole input: the
sessions and agents of the run description, the context record, the stages,
criteria and attention items of the snapshot, the facts of the batch with their
sessions, agents and actions, the agents of collapsed facts and of the backlog, and
the artifact versions with the actions that produced them. Snapshot entities and the
stages they refer to must belong to the run and pass the grounds rule. The context
record follows the raw record rule through its `context` facts, one keyed by the
run of the root session and one for every other
session whose data the context was assembled from (F.7a). A context that read a
session of another vendor is therefore refused without `crossVendor`, whether it is
the context of the input, the input checked again before a follow-up or a requested
raw record. An artifact version must be stored and pass the version rule above.
`beginObserverCall` refuses an input with any violation and a first call that already
carries materials; `beginObserverFollowUp` checks the stored input
again with the current `crossVendor`. The call records the backend it was started
for.

`resolveObserverNeeds` answers each distinct need, up to `MaterialLimits.needs`, with
a material or with an `unavailable` reason: `out_of_scope`, `cross_vendor` or
`not_found`. Thinking is removed from raw records before truncation, only at the
positions where the runtimes write it: the `thinking` and `redacted_thinking` blocks
of `message.content` in Claude assistant lines and the `reasoning` items of
`replacement_history` in Codex `compacted` lines. Tool inputs and results are kept as
they are, even when they contain objects with the same `type`. Codex records that
hold only reasoning produce no facts and are out of scope. A transcript or rollout
record nested deeper than 256 levels is never sent and answers `out_of_scope`. An
action is sent with the input of `action_start` and the
output of `action_end` or `PostToolBatch`. When the action has a structured result,
such as an edit patch or an MCP result, the output is the JSON text
`{"output": <text>, "result": <result>}`. Texts longer than
`MaterialLimits.textLength` are cut, each string of a structured value separately,
and report their path and original length. A string is cut only when the cut text
and its truncation entry together are shorter in JSON than the whole string, so a
cut never lengthens a material, and a cut never splits a surrogate pair. An
artifact version of the run (E.7b) is sent with its retained content, decoded as
UTF-8 and cut like a record payload, with its retention (`action_payload` or
`file_read`) and the read time of a file read; a version out of scope by the version
rule answers that exclusion, and a version whose content is not stored (a reference,
a hash only or a missing blob) `not_retained`. A context request returns the stored run context
of F.7a with its entries cut at `MaterialLimits.textLength`; a record of another
channel answers `not_found`, a context out of scope its exclusion.

A response with nonempty `needs` to a call without materials is not applied. When
at least one requested material fits a follow-up within its input limit,
`applyObserverResponse` records the verdict `needs_requested` and leaves the batch
`in_call`; the response option `followUp` (`crossVendor`, material limits,
`inputTokens`) must match the options later given to `beginObserverFollowUp`.
Otherwise the response is rejected with the cause `limit`: the batch returns to
`pending`, spends the attempt like any rejected response, and the next call gets the
reason in `previous_attempt`. A follow-up therefore always carries materials, and a
call with materials is a follow-up whose `needs` are ignored.
`beginObserverFollowUp` starts the only follow-up with the same snapshot
and batch plus the resolved materials, with the backend of the first call. It hands
the batch over to the follow-up without spending an attempt. The follow-up response
is applied or rejected as usual, and its `needs` are ignored. After a restart the
batch returns to `pending`, and the cycle starts again with a new first call. The
scheduler (F.8) starts the follow-up immediately, outside the minimum interval
between calls of a run. `skipObserverFollowUp` gives the follow-up up the same way
at run time: the batch returns to `pending` and the summarized deferred facts are
released, both with the attempt given back. The scheduler (F.9) does so when the
backend is no longer `ok` by the time of the follow-up.

## Observer queue

The ingest transaction queues every new fact as `pending` in the run of its session
after the observation projection, including the facts of OTel records normalized in
that transaction (ADR-0005). `context` and `git_snapshot` facts are never queued: the daemon writes
them as run context, which reaches the observer through the context of the run (ADR-0007), not
through a batch. A redelivered record adds no facts and queues nothing.
A reparse queues the facts it adds the same way after it rebuilds the projections,
including the OTel facts it resolves; the facts it keeps keep their status and
attempts.

`startObserverBatch(transaction, { run, backend, crossVendor, id, at, limits, context, catchUpMs? })`
starts the next call of a run from its pending facts in the order of their records:

- a queued `context` or `git_snapshot` fact leaves the queue without a status;
- a fact that the input scope excludes, from a session of another vendor without
  `crossVendor` or outside the run, becomes `not_interpreted`, and its session gets
  an open gap `cross_vendor_excluded` or `not_interpreted`;
- the candidates are the first facts up to `limits.facts` whose payload size in UTF-8
  bytes stays within `limits.bytes`; the first fact always goes;
- catch-up (ADR-0007): when the oldest pending fact was observed more than `catchUpMs`
  before `at`, the candidates are the latest facts that fit these limits instead, and
  the earlier pending facts become `deferred` with the run gap `summarized_backlog`.
  The packing then keeps the latest candidates as well, and the earlier candidates
  it leaves out are deferred into the same summary instead of staying `pending`;
- every `deferred` fact of the run that no accepted call has summarized yet goes into
  `batch.backlog`: the time range, the number of facts and, per agent in scope, the
  facts by tool (the fact kind when the fact has no action). A deferred fact outside
  the input scope becomes `not_interpreted` like a pending one. The summary rides with
  a batch; when no pending fact is eligible, the call carries the summary alone with
  an empty batch, so a run whose whole queue was deferred still reaches the observer;
- the input carries the run description with the sessions and agents in scope, the
  given run context when its record is in scope (otherwise `null`), the snapshot of
  the current version (active stages, criteria, open attention items), the batch
  facts with their session, agent and action, the collapsed routine facts and the
  reasons of the latest rejected call of these facts as `previous_attempt`. The run
  goal and brief, stages, criteria and attention items enter only when their grounds
  are in scope; a reference to a stage left out becomes `null`. The reasons carry
  over calls that ended without a response, so a backend failure or a restart after
  a rejection does not drop them. A summary takes them from the latest call of the
  run when that call carried a summary and was not accepted, with or without batch
  facts; the reasons of the batch and of the summary are joined without repeats;
- `batch.artifact_versions` lists the artifact versions of the run whose
  `produced_by` is the action of a fact in the batch, sorted by id. A version is
  `retained` when its content is kept (`action_payload`, `file_read`, `commit`), not
  when it is known only by hash or by reference. The list is rendered with the facts,
  so it counts toward the input limit, and a fact left for the next batch takes the
  versions of its action with it. A version whose action has facts in two batches is
  sent with both;
- the input is packed within the limit (see "Observer input" below);
- the call is recorded by `beginObserverCall`, and the summarized deferred facts refer
  to it. Without a run entity or an eligible fact or deferred fact, or when the run
  description, the snapshot and the context leave no room even for one fact without
  its payload, nothing starts, the facts stay `pending` and the result is `null`.

`beginObserverCall` refuses a second call of a run while facts of the run are
`in_call` or summarized by an unfinished call, and refuses a call with neither a fact
nor a summary.

### Observer input

The size of an input is its JSON in UTF-8 bytes divided by four, rounded up, in
tokens (`observerInputTokens`); `limits.inputTokens` bounds it (ADR-0007, 24 000 by
default in the scheduler). A first call is packed within seven eighths of the limit,
so that the follow-up for `needs` has room for its materials under the full limit.

Routine facts are folded into counters (`batch.collapsed`) before the size is
measured. A fact is routine when it starts an action that reads files or searches
(`file_read`, `search`), or ends one with the outcome `ok`, and is not urgent. The
facts of each session and agent are taken in batch order; a series of routine facts
of the same tool that covers at least three actions becomes one counter with the
tool, the action kind, the agent, the fact ids and the time span. Any other fact of
the same agent ends the series; facts of other agents do not. Collapsed facts belong
to the batch: they may be cited as evidence and are interpreted with it.

When the input exceeds the limit, the packing gives up detail in this order and
stops at the first input that fits:

1. the strings of the batch fact payloads and the context entries are cut to the
   longest common length between 256 characters and `limits.textLength`; every cut
   reports its path and original length;
2. with those strings at 256 characters, the texts of the run description, the
   snapshot and `previous_attempt` are cut to the longest length from 64 characters
   and end with `…`;
3. the batch keeps the longest prefix of the candidates that fits with full model
   texts, and the strings of that prefix get the longest length that still fits; the
   other candidates stay `pending` for the next batch;
4. one fact with 256-character strings and model texts cut from 64 characters;
5. the first candidate alone with its payload omitted: `payload` is `null` and its
   only truncation entry has the path `payload` and the length of the payload JSON.
   The observer can request the raw record by the `seq` of the fact. The other
   candidates stay `pending` for the next batch.

In catch-up the steps keep the suffix of the candidates instead of the prefix, and
step 5 takes the last candidate. The candidates left out become `deferred` and join
`batch.backlog`; the summary is measured with each tried input, so the input with
it stays within the limit.

A string or a model text is cut only when the cut, together with its truncation
entry or the `…` mark, is shorter in JSON than the whole text. The input size
therefore never grows when the length goes down, and each length above is found by
trying the longest one first and then by bisection.

`beginObserverFollowUp` packs the stored input with the resolved materials within
`inputTokens` (24 000 by default) by steps 1–4. The materials are resolved with the
same string length as the batch facts and the context, which can be cut further than
in the first call; step 3 drops materials from the end instead of facts and keeps at
least one. The batch, the snapshot version and the ids stay those of the first call.

`failObserverCall` ends a call without an applicable response. `rejected`, an output
the backend could not read against the schema, returns the batch to `pending` as a
schema rejection and keeps the attempt; `failed`, a backend failure, returns it to
`pending` and gives the attempt back. Both store the backend error class and message
when the caller passes them. `applyObserverResponse` and `failObserverCall` store the
usage of the call. An accepted response stores the delay of its batch: from the
earliest `observed_at` of the batch records to the acceptance, so a `needs` follow-up
counts the time of the first call. A call with the summary alone has no batch records
and no delay. A response that arrives after a session transfer ended its call is not
applied: `chargeEndedObserverCall` stores its usage on the ended call, leaves its
verdict, reasons and facts as they are, and returns `true`; for a call that is still
running it returns `false`.

The summarized deferred facts stay with an accepted call. A rejected or failed call
releases them, and the next batch summarizes them again; a `needs` follow-up takes
them over with the batch. Attempts of a deferred fact count its summaries: deferral
resets them, each summary spends one, a failed call gives it back, and a rejection
keeps it.

When the store opens, facts left `in_call` by a stopped process return to `pending`
and get the attempt of the interrupted call back: a stop is not a content failure.
They keep the reference to the interrupted call, which carries the reasons of the
previous rejection. Deferred facts summarized by a call without an accepted response
are released for the next summary and get the attempt back.

`exhaustObserverCall` turns the facts of a rejected call that reached the attempt
limit into `not_interpreted` and opens a gap `not_interpreted` for the call. The
released deferred facts of its run that reached the limit become `not_interpreted`
with them, so a summary rejected `attempts` times stops being sent.
`boundObserverQueue` defers the pending facts older than `bounds.ageMs` and, of the
rest, the oldest beyond `bounds.facts`, opens the run gap `summarized_backlog` when it
defers any, and returns the active queue. Deferred facts reach the observer only in
the backlog summary of a later call.

## Chat input and answers

The chat (K.1, ADR-0008) answers on one version of the map. `startChat(transaction,
{ run, stage, question, backend, crossVendor, at, limits? })` builds the input and
records the question `pending` with the current version V and the backend and
`crossVendor` of its input in the same transaction; it returns `null` for an unknown
run. The input passes the same scope as the observer input (`inputScope` with the
backend and `crossVendor` of the call):

- `history` — the latest answered questions of the run (`limits.history`, 10), with
  the version each was answered on; failed and pending questions are left out. An
  answer carries the data of the input it was built from, so without `crossVendor`
  only answers to questions asked for the same backend without `crossVendor` are
  kept; an answer built for another backend or with `crossVendor` is left out of the
  input and stays in the history of the run;
- `run` and `model` — the run description and the snapshot of version V, as in a
  batch;
- `focus` with a stage — the stage of the run in scope (any lifecycle) with its
  current evidence and the input and output facts of the actions assigned to it,
  ordered by time, these actions with their input and output, and the artifact
  versions linked to it in scope, `retained` when their content is stored. A stage outside
  the run or out of scope is refused with `ChatError` `unknown_stage`;
- `focus` without a stage — the attention zone in its order, with items in scope, and
  the journal changes of stages, criteria, cards and attention items in scope of the
  last `limits.focus` (20) versions, with their states and evidence.

The first input is packed within seven eighths of `limits.inputTokens` like a batch:
the strings of facts, actions and journal states are cut first, then the texts of the
run, the snapshot and the history, then the focus keeps fewer entries (the first items
of the zone, the latest facts, actions, versions and changes), down to none. A
question that does not fit even so is refused with `ChatError` `input_limit` and
nothing is recorded.

`followUpChat(reader, { input, needs, backend, crossVendor, limits? })` builds the
only follow-up: the same input of version V with the resolved materials, packed within
`limits.inputTokens` with at least one material, or `null` when none fits. Up to
`limits.needs` (8) distinct needs are answered in order. Stages and journals are
answered as of version V: a stage with its state and lifecycle at V, including a
replaced one, and the journal entries of a stage, criterion, card or attention item up
to V; an entity created after V answers `not_found`. Facts, raw records, actions and
artifact versions are answered as for the observer; facts and records keep the scope
and thinking rules above. An entity, fact, action or version outside the run or out
of scope answers its exclusion.

`answerChat(transaction, { run, message, input, output, at })` stores the answer with
version V. `verifyCitations(input, citations)` keeps a citation only when the input of
the answer holds its id under its kind: stages of the snapshot, the focus, materials
and journal targets; facts of the focus, materials and evidence lists; actions of
facts, actions, materials and producers of versions; artifact versions of the focus
and materials; attention items of the snapshot, the zone and journal targets.
Repeated citations are kept once. Removed citations mark the answer
`unconfirmed_citations`, and an answer without text or with `insufficient_data` is
marked `insufficient_data`. `failChat` ends a question with an error, and
`failInterruptedChats` ends the questions a stopped process left `pending`. Both and
`answerChat` leave a question that is no longer pending alone and return `null`.

The run feed carries the chat of the run: each question that changed after the
position is a `chat` event with the message in its latest state and its
`change_seq`. `reads.chat(run)` returns the history of the run, or `null` for an
unknown run.

## Forks, bindings and session transfer

Run linking for forks follows ADR-0006 and does not depend on the order in which
the fork, its original or other forks are read.

- A Claude fork is recognized by a `SessionStart` with `source: fork` or by its
  transcript. The records that open the file are the launch `queue-operation`
  lines; the records after them with a time before the launch, up to the first
  record of the launch's own time, are inherited. Only the opening launch of a
  transcript is considered, since a fork always starts a new file and a resume
  appends to the original one. The decision for a record depends only on the
  records before it in the same file, so it is final when the record is read.
- Inherited records are not repeated as the fork's own activity. Their actions
  are stored with `inherited: true`; their agents and questions are not
  projected; the session start and the run creation time come from the fork's
  own records. Usage accounting (E.8) uses the same inherited records.
- The fork starts its own run with a `common_origin` link. The link lists every
  visible session other than the fork that has a fact with the `uuid` of an
  inherited record, and names it as `parent_candidate` only when it is the only
  one. The evidence is the fork markers and the earliest shared fact of each
  listed session. When a session gets new records, the forks that share their
  `uuid` are recomputed, so reading the original before or after the fork gives
  the same objects and links; without the original only the list differs.
- A Codex rollout with `forked_from_id` starts its own run with a `forked_from`
  link to the run of the parent thread, with the `session_meta` fact as evidence.
- The links stay in the run created by the fork even when its session is moved.
  The `forked_from` link points at the run that holds the parent session now:
  a transfer of the parent session updates the links of its forks in the same
  transaction, so naming the parent or reading the fork before or after the
  transfer gives the same link.

Bindings are user changes journaled in the model (`binding.add`,
`binding.revoke`) and applied by `engine.bind` and `engine.revokeBinding`:

- `attach` moves a session into a run, `detach` returns it to its own run. A
  session has at most one active `attach` or `detach`: a new one revokes the
  active one in the same transaction, and revoking the active binding returns
  the session to its own run. The binding is stored in the run the session moves
  into.
- `fork_parent` names the immediate parent of a fork run. While it is active the
  run has a `forked_from` link to the parent's run with no fact evidence; it
  overrides the parent named by a Codex fork, and revoking it restores that
  parent or removes the link. The parent is never inferred.
- Unknown sessions, runs and bindings, a parent for a run that is not a fork and
  a fork as its own parent are rejected with `BindingError` (`not_found`,
  `invalid_request`) without any change.

A transfer (`session.move` rule changes) is journaled in both runs in the
binding's transaction:

- the session membership and the spawn links of the session's agents leave the
  source run and enter the target run;
- the rule attention items of the session's questions leave the source run and
  enter the target run with their state, without a stage and without the marks
  of the source run's observer (likely resolution, priority), so a question is
  in the attention zone of one run only and its later answer closes it there.
  The change that brings an item in cites the item's evidence, so the input scope
  attributes its text to the vendor of the question's session in the target run
  too;
- every stage that references the session's actions or agents by assignment or
  participation is marked `session_moved` while any of them lies outside its run;
- the session's facts become `pending` in the target run and leave the pending
  queue of the source run. Its `context` and `git_snapshot` facts are not queued:
  they are run context and are never interpreted as facts;
- an observer call of the source run whose batch or summary holds any of these
  facts or whose input describes the session is ended as `rejected` with a `scope`
  reason, a call with the summary alone included: the rest of its batch returns to
  `pending` in the source run, the rest of its summary is released for the next
  summary, and both get their attempt back, since a transfer is not a content
  failure. A late response to it is not applied, so neither a rejection nor a
  restart returns the moved facts to the source run, and a session moved back gets
  its facts `pending` again. A call that already ended as `needs_requested` keeps
  its verdict: its batch and summary are released the same way, and its follow-up
  is refused;
- the session and its objects are projected again with the target run, so usage
  follows it; checks are recomputed for the target run and for the source run
  with its remaining sessions, as described in Check contracts; view marks and
  view rules stay with their runs;
- the `forked_from` links that point at the source run are recomputed.

## Questions, decisions and rule attention

The ingestion transaction projects every question of a session and reconciles
its rule attention item in the same transaction as the facts. The item is
written through the model journal by the author `rule` into the run that holds
the session's `session_membership`; a session without a run gets no items until
run linking (E.4) records its membership. Reconciliation is deterministic: a
repeated or reordered delivery leaves the model unchanged.

Each question yields three independent values:

- `Question.action` links a `PermissionRequest` to a `PreToolUse` of the same
  session and agent with an equal tool and canonical input that started in the
  request's turn and had not ended before the request (`rule:permission-link`).
  The turn starts after the latest event of the agent before the request that
  ends permission waits: a turn start or end, a human prompt, the agent's end or
  the session end. A call cancelled in an earlier turn is therefore never a
  candidate, while its own request still takes the call's late result. Several
  candidates mark the link ambiguous; the latest candidate is kept, and the
  attention item then has no action. `AskUserQuestion` and `ExitPlanMode` are
  linked to their own call.
- `Question.decision`:
  - `codex.tool_decision` for the linked call with `source: User` is an observed
    approval or rejection; `Config` and `AutomatedReviewer` give `none`, and no
    human decision is inferred for that call;
  - otherwise `rule:permission-decision` infers an approval from an execution
    of the call after the request, and a rejection from a denied completion or a
    `PostToolBatch` without a completion. An execution is a `Post*` hook or a
    completion with a known result (`item_completed`, a transcript
    `tool_result`); a Codex `function_call_output` alone has no known result,
    because Codex also writes it for a request cancelled with Esc. A Codex
    `turn_aborted` or `Interrupt` while the request waits is a rejection as well;
  - an ambiguous link is decided only when every candidate call is settled: the
    request gets their common decision, or `unknown` if they differ. Until then
    the request keeps waiting; if the wait ends first, the request ends without
    an answer and its decision is the one shared by the settled candidates and
    the ended wait, otherwise `unknown`;
  - `answers` and `ElicitationResult` (correlated by `elicitation_id`) are
    observed: `accept` answers, `decline` and `cancel` reject;
  - an `ExitPlanMode` completion is a plan approval or rejection
    (`rule:plan-approval`);
  - an ended wait without any of these is `unknown`; an open request is
    `requested`.
- The attention item keeps `runtime_wait` and `resolution` apart:
  - `permission` waits until it is decided (`answered`) or until the turn of its
    agent ends, a new turn or human prompt starts, the agent ends or the session
    ends (`ended_without_answer`);
  - a rule `question` is closed only by a correlated answer. A new prompt, the
    end of the turn or of the session only end the runtime wait, so the item
    stays open after the session. Asynchronous Codex questions never wait;
  - an automatic denial without a host opens and closes the item in one model
    version, so it remains in the history and leaves the attention zone at once.

Rule fields never touch `likely_resolved` and `priority`, which belong to the
observer. Dismissal by the user is view state (`AttentionView.dismissed_at`) and
is not part of the item. Notifications other than requests for input
(`idle_prompt`, `permission_prompt`) open no item.

## Reparse

`engine.reparse()` runs in the same queue as `ingest` and applies its result in
one transaction. A failure leaves facts, raw records, objects and the model
unchanged.

It parses again every collector record that has no fact of the current
adapter's `normalizer_version`: records whose facts come from another
normalizer, and records without facts (`unknown`, `invalid` or parsed without
facts). A record that already has facts of the current version is skipped,
because parsing is deterministic. The adapter receives the stored payload,
stream, position and hook envelope; the dedupe key never changes. Daemon
channels (`snapshot`, `context`) are not reparsed.

Fact ids derive from the dedupe key, kind, entity key and the ordinal among facts
of the same kind and key, so a fact keeps its id when the order of the facts in
its record changes. Facts that are no longer produced are deleted, new facts are
inserted, and a record is rewritten with new `change_seq` values only when its
facts or parse state differ. A resolved OTel decision keeps its resolved stream.
OTel records without a stream are then resolved through the stored streams in
the same transaction, with the scope and observer checks of `ingest`, so a
decision of a known thread is recovered without another `ingest`; one whose
thread is not known yet stays pending until `ingest` sees the thread.

Afterwards every session that has facts, owns records or has stored objects is
projected again with the current time and source losses. Records are owned the
same way `ingest` attributes them, without OTel records. A session stays while
it has facts or owned records; its `unknown_records` is recounted from the owned
records that are still not parsed, and its `unknown_records` gap closes when the
count drops to zero. Fields that `ingest` keeps from earlier records, such as
the support mode and the event times, are kept. A session without facts or owned
records is deleted with its objects, and action and question objects that no
fact supports any longer are deleted.

An agent that no fact supports any longer is replaced when the records that
named it now name exactly one other projected agent of its session: the records
whose facts lost the agent and gained other agents give the candidates, resolved
through the teammate identity of the session. The agent is then removed with
that replacement in the same transaction, as an identity refinement of
ADR-0006: removals that named it are redirected to the replacement, and its
model links are retargeted by the run linking rule through the journal, with
the moved facts as evidence. An agent without such a replacement is deleted.
The store refuses to delete an object that stored removals name as their
replacement, so a reparse that would leave such an agent without a replacement
fails and changes nothing: the contract has no removal without a replacement.

A deleted fact, object or discarded record leaves no row in the change feed, so
every deletion advances `change_seq`, and a record whose facts were added or
removed is rewritten with a new `change_seq`. The head therefore moves with
every visible change and a reparse that changes nothing keeps it. A reparse that
moves the head stores the new head as the reparse boundary in the same
transaction, because a client that holds an earlier position cannot learn its
deletions from the feed. `feed` refuses such a position, and the daemon answers it
with the SSE `reset` with reason `reparsed`, also after a restart. An object that
is deleted and later projected again starts without fields owned by other rules,
such as its run.

The deterministic rules of `ingest` run on the rebuilt sessions in the same
transaction: run linking (E.4), the rule attention of questions (E.6) and the
failed check rule (E.7a) with the current contracts. A request, answer or check
result that only the current normalizer recognises therefore opens or closes its
item without another `ingest`, and an open item of a failure that the current
normalizer reads as a success of the same action is closed. Their changes are
appended to the journal; earlier journal changes are never rewritten.
`resolveEvidence(facts, evidence)` returns each referenced fact, or `unavailable`
for a fact the current normalizer no longer produces. The facts a reparse adds
enter the observer queue in the same transaction; the statuses of the facts it
keeps do not change.

## Run context

`recordRunContext(store, { run, backend, crossVendor, at, claudeConfigDir, limits })`
collects the context of a run for the observer input (ADR-0007) from the allowed
sources only:

- `task`: the earliest nonempty prompt of a human to the main agent of the root
  session; `ref` is the id of the prompt fact.
- `instructions`: the files named by `InstructionsLoaded` facts of a session, or,
  when a session has none, `CLAUDE.md` (Claude) or `AGENTS.md` (Codex) in its `cwd`
  and every ancestor directory; `ref` is the path.
- `agent_definition`: for each subagent or teammate type of a Claude session, the
  file `.claude/agents/<type>.md` in the nearest directory of the session's `cwd`
  hierarchy, or `agents/<type>.md` in `claudeConfigDir`; `ref` is the path of the
  file. Types without such a file, such as built-in and plugin agents, have no entry.
- `skill`: only skills invoked through the `Skill` tool of a Claude session, except
  calls that ended with an error or were denied. A skill listed in the catalog but
  not invoked is never included. The text is the `description` of `SKILL.md` in
  `.claude/skills/<name>/` of the nearest directory of the session's `cwd` hierarchy
  or in `skills/<name>/` of `claudeConfigDir`, and `ref` is the path of that file.
  When there is no such file, `ref` is the name of the skill and the text is empty.
  Codex has no skill tool, so a Codex run has no skill entries.
- `mcp_server`: the servers of MCP actions with the names of the tools called.
- `git`: one entry per worktree, whose `ref` is the top of the worktree (or the `cwd`
  of a session outside git): the branch of each session working there and, for each
  set of masks, the latest git snapshot (`git_snapshot` fact of the run): the masks,
  the commit, whether the tree is clean under those masks, changed paths and error.

Only sessions of the run are read, and a session of a vendor other than `backend` is
skipped unless `crossVendor` is set; when the root session is skipped, or the run is
unknown, there is no context. Skills and agent definitions are resolved in the
directory of each session, so files of the same name in different projects stay
separate entries. The `cwd` of each session that is read and the working directories
of its facts are resolved to the top of their git worktree with
`git rev-parse --show-toplevel`, as the snapshot writer of E.7b does. A git snapshot
is included only when its worktree is one of these tops or exactly one of these
directories, which is where a failed snapshot is recorded. A worktree or repository
nested in another tree is a separate worktree, so a snapshot of the enclosing tree
used only by a skipped session stays out, while a worktree shared with a skipped
session stays in. A directory that no longer resolves to a worktree admits no
snapshot of a worktree. Relative paths are ignored.
Each text is cut to `limits.textLength` characters (4000 by default) and reports its
original length; files are read up to 1 MiB, and a larger file reports its size in
bytes.

Names of the solver's hooks, definitions of plugin agents, of agents given by the
`--agents` flag and of Codex roles, and descriptions of plugin skills are allowed
sources that need facts or formats the adapters do not provide yet; plan item F.7d
adds them.

Entries are ordered by kind and `ref`, and `content_hash` is the SHA-256 of their
canonical JSON. A nonempty context is stored as a raw record of the `context` channel
(position `daemon`, no runtime or stream). Its `context` facts list the sources and
record where they come from: one fact is keyed by the run of the root session, and
each other session that was read gets a fact keyed by that session. The scope of
the observer input (F.7c) admits the record only when it admits every one of these
sessions, so a context that includes another vendor reaches the observer only with
`crossVendor`. The dedupe key is the run, the hash and the sessions that were read. An
unchanged context assembled from the same sessions, including one that returns to an
earlier state, reuses the existing record, so it is written once and its `seq` can
be cited; the same text assembled from other sessions, for example with
`crossVendor`, is a separate record with its own facts.
`storedRunContext(rawRecords, seq)` reproduces the `RunContext` of a record.
Records of the `context` and `snapshot` channels are not events of a session: they do
not change its projection, freshness or `last_event_at`. The `context` facts are not
queued for interpretation.

## Read queries

`createReadQueries({ store, observer })` answers the reads of the API (ADR-0011).
Each query runs in one read transaction of the store, so its data and its
`change_seq`, the head of the change feed, describe the same state. `observer(run)`
supplies the scheduler state of a run (`state`, `isolation_unverified`); the queue
counts come from the interpretation statuses.

- `runs()` lists run summaries, the latest activity first.
- `snapshot(run)` returns the run, its summary, the semantic model, the observation
  objects and gaps of its sessions, its plan facts, attention items with their views,
  the view mark and the attention zone, and bindings.
- `feed(run, after)` returns the changes of that snapshot after a position as the
  contract deltas. Applying them to the snapshot taken at `after` gives the snapshot
  taken at `position`:
  - consecutive changes of facts, observation objects, gaps and retractions form one
    `facts` event, consecutive views and dismissals of attention items one
    `attention` event with their views, every model version forms one `model`
    event, a new view mark forms one `run` event at the `change_seq` of the mark, and
    every chat message changed after the position forms one `chat` event with the
    message in its latest state. An event id is the last `change_seq` it contains, so
    ids grow and never repeat;
  - objects and gaps arrive in their current state, `removed` names retracted agents
    and their replacements, and `facts` carries plan facts, the only facts of the
    snapshot;
  - a model event replaces the changed entities of the run; a removed
    `session_membership` takes the objects of that session out of the run;
  - `run` is the current summary, view and bindings, which the transport delivers
    after the events; a `run` event carries the same current state;
  - a position ahead of the change feed is an `InvalidPositionError` with reason
    `stale_position`; a position before the reparse boundary is one with reason
    `reparsed`.
- `inspector(run, stage)`, `changes(run, { version, change_seq })`,
  `observerCalls(run)` and `chat(run)` serve the inspector, the changes since a view
  mark, the observer calls and the chat history.
- `artifactVersion(id)` resolves to the stored version with its content, or `null`
  for an unknown id. The version and a stored blob are read in one read
  transaction; the content follows the retention:
  - `reference` and `hash_only` are unavailable with reasons `reference_only` and
    `hash_only`;
  - `action_payload` and `file_read` give the blob with that source, and `read_at`
    for a file read; a blob that is gone is unavailable with reason `blob_missing`;
  - `commit` reads the file at that commit with `git cat-file blob`, read-only and
    with `GIT_OPTIONAL_LOCKS=0` like a snapshot, by its path relative to the
    repository. A path outside the repository, a ref that is not a file or a failed
    read is unavailable with reason `commit_missing`;
  - stored bytes that decode as strict UTF-8 come as `utf8` text, any others as
    `base64`; `size_bytes` counts the bytes.

The run summary:

- `execution` is the most active execution among the sessions: running, waiting for
  a human, for background work, for an unknown reason, idle after an answer, then
  failed, cancelled, unknown, planned and done. A run without sessions is unknown;
- `freshness` takes the sessions in the order of a single session: lost, hooks
  inactive, quiet, ok;
- open attention items are the items of the attention zone: resolution `open` and
  not dismissed; an item waits for a human while its runtime wait is active;
- `pending_facts` counts pending facts and facts in a call, `oldest_pending_at` is
  the time of the oldest of them, `last_success_at` the end of the last accepted
  call;
- `change_seq` is the last change of these inputs: the model version, the sessions,
  the agents, the observer calls and the attention views.

The stage inspector shows the assigned actions that still belong to the run, the
participating agents together with the agents of those actions, the items of the
stage and the action-level items of its actions, and the facts of the current
grounds of the stage. Its time runs from the first start to the last end once every
action has ended; the active time is the union of the action intervals, so parallel
work is not added up (ADR-0009). Its history holds the journal entries of the
stage, of the links that name it before or after the change (dependencies in both
directions, assignments, participation and artifact links), of its criteria and of
the attention items it shows. Its observer calls made these entries or were rejected
while naming the stage. Its inputs and outputs are its artifact links of that
direction with the stored version of the run, by the time the version was observed,
then by version and link id; a link whose version is missing or belongs to another
run is left out. Its criteria are those of the stage and the contract criteria of
the run (no stage) whose checks are assigned to the stage: an action of a fact that
the status cites, or a carried check, like a failed check item of an assigned
action. Each comes with the git snapshots of the run that its status cites as
evidence, by the time they were taken, and its journal entries join the history.

The changes since a model version and a change position list stage and criterion
transitions from their state at the version to the current state with the journal
entries in between, cards added after the version, plan facts, new actions and the
artifact versions created after the position in their current state, and attention
items opened after the version and still open or closed after it. An action is new when every fact of it came after the position; inherited
actions are not new. A change of a link changes every stage the link names before or
after it, so a dependency changes both of its stages. A stage changed only through its
links has the same state before and after, and its journal entries are those link
changes.

The attempt of an observer call is one more than the number of earlier rejected
calls that contained a fact of its batch. A call that asked for materials and its
follow-up are one call (ADR-0007): it has the id, verdict and output of the
follow-up, starts with the request, and its latency includes the follow-up, whose
own duration is `needs_latency_ms`. A call without a result is running while it holds
its batch; once a restart returns the batch to the queue, it has failed, as has a call
recorded as `failed`. The result
version of an accepted call is the last version of its transaction, including the
rule changes that follow its operations, as returned by `applyObserverResponse`.

Some parts of the contract have no source yet and stay empty: the artifact versions
and git snapshots of the snapshot and the feed (E.7b, E.7c); the CLI version, model
and error of observer calls (F.8, F.9). The usage of an observer call is what the CLI
results of the call reported: a request for materials and its follow-up add up
(Observer and chat usage). The usage records of a run come with its objects, and the
inspector shows the usage of a stage as `stageUsage` gives it (Solver usage).
The queue of a run counts every fact of it that is `pending` or in a call, since the
ingest transaction queues each new fact (Observer queue).

## Solver usage

The solver journal follows ADR-0009. The ingestion transaction projects a usage
record for every `usage` entity of a session, next to its actions:

- A Claude record is keyed by `message.id` and groups every transcript record of
  the message. Input and cache tokens come from any of them, output and reasoning
  output are the largest. When no record of the group has a `stop_reason`, the
  output is marked as a lower bound (`output_lower_bound`), which is how the
  understated output of subagents shows. A `<synthetic>` message is stored with
  `synthetic: true`. The agent is the one of the file: the main thread or the
  subagent.
- A Codex record is keyed by `(thread_id, response_id)` of `token_usage_record`;
  its output is never a lower bound. `turn.completed`, `thread_token_usage` and
  `token_count` are not summed.
- Records copied by a Claude fork are stored with `inherited: true`, by the same
  rule as inherited actions (Forks, bindings and session transfer).
- The session keeps the last `cost-state` line of its transcript as
  `cost_state`; it is never added to the records. The line is cumulative through
  resume, so the last one has the largest total duration, then the largest cost;
  the line number breaks a tie. The order of reading does not decide it: a backfill
  of an earlier part or a superseded file of the stream may be read last.
- An agent of a Codex thread that has no `token_usage_record` keeps the total of
  the thread with the largest ordinal as `thread_total`. A thread with records,
  and the root thread of a fork, whose counter includes its parent, have none.

`solverUsage(source, run)` reads the journal of a run from the projected objects
and the session facts; `source` is the store or a transaction:

- Totals count records that are neither inherited nor synthetic: the run, each
  of its sessions and each of its agents is the sum of its records, so the
  sessions of a run add up to the run. `cost_usd` is `null`: money comes only
  from `cost-state`, shown per session.
- A session of the journal tells whether it is a fork (`fork`), by the same
  lineage that marks its inherited records. The `cost-state` of a Claude fork
  includes the usage of the history it copied, so a reader of it has to say so;
  the records of the fork count only its own usage.
- `thread_totals` of a session gives the `thread_total` of each of its agents
  that has one: the cumulative total of a Codex thread without
  `token_usage_record`. It is never added to the records, and a fork has none.
- The `cost-state` of a session is final only when the data show that no launch
  runs after the one that wrote it; when they cannot show it, it is not final.
  Each launch ends with a `cost-state` line. Lines of the same content in several
  files of the stream, such as a superseded copy, are copies of one line. A line
  has no time. It was written after the latest time of the records stored before
  any of its copies in their own files, and before the first of its copies was
  read. A later launch shows:
  - as a record with a time after the first of its copies was read;
  - as a record with a time after a copy of the line in the same file, of any
    parse state and with or without facts;
  - as a record with a time after that moment in a file of the stream that holds
    no copy of the line;
  - or as a `SessionStart` hook after that moment that no launch which wrote its
    line after it explains. The `cost-state` lines written after the moment end
    launches in the order of their totals: the first one the launch active at
    that moment, each next one a launch that started after it and wrote no
    record with a time, such as a run that made no API call. Hooks are matched
    to these launches in the order of time, each to a launch whose line was read
    after the hook. Each `SessionStart` is a launch of its own: a possible
    redelivery from another registration does not prove one launch. A hook left
    without a launch starts a launch that still runs, such as a resumed session
    before its first new line, or one that started after the lines of the
    earlier launches were read. `SessionEnd` does not count.

  Two limits follow from what the data can show. A record read in several files
  is stored once, in the file read first, so the file of a copy may keep no
  dated record before it; the records of the other files are not taken in its
  place, and such a line is not final. A launch that writes no record with a time
  is told from a launch still running only by the time its line was read, so a
  hook that fired before the line was read is taken as the start of the launch
  that wrote it.

  While a later launch runs, an interactive session has not written its line
  yet, so the money and compaction usage it shows are of an earlier launch.
- A record belongs to a stage when the actions of its response are known, not
  empty, and each of them is assigned to that stage and to no other one. The
  actions of a Claude response are the tool calls of its `message.id`. A Codex
  item names no response, so the actions of a Codex record are all actions of
  its turn: the record belongs to a stage only when every action of the turn
  does. The other records are `unassigned`. `stageUsage(source, run, stage)`
  gives the stage's records and the unassigned records of the sessions whose
  actions or agents are linked to the stage. There is no proportional estimate.
- The duration of a run runs from the first to the last activity of its sessions.
  Activity is a fact of a record that carries its own time, or of a hook, whose
  time is the moment it was written. A line without a timestamp, such as
  `cost-state`, a registry entry or a file read whole, takes the time it was read,
  which a backfill moves arbitrarily, so it is not activity. A silence of at least
  `pauseAfterMs` (5 minutes by default) between two activities of the run is a
  pause; pauses stay inside the duration.
- The active time of an agent is the sum of its turns, from its own activity
  without the inherited facts. A turn opens with a turn start, an agent start or
  a prompt that is not a slash command or a synthetic line, or with the first
  message, action or usage after a closed turn. It closes with a final message,
  a turn end, an agent end or the session end. A turn still open lasts until the
  last activity of the agent. The active times of parallel agents overlap, so their
  sum is not the duration of the run.
- A transfer projects the session again with its new run, so both runs read the
  moved usage on the next query.

## Observer and chat usage

The observer and the chat keep their journals in `observer_calls`, apart from the
solver journal and from each other (ADR-0009). The usage of a call is what its CLI
result reported (`usage`, `modelUsage` and `total_cost_usd` of Claude,
`turn.completed.usage` of Codex); a call is ephemeral, so nothing accumulates.

- The observer journal of a run is its batch calls. A call that asked for materials
  and its follow-up are one call, as in the observer calls of the run (Read
  queries): it starts with the request, ends with the follow-up and spends the usage
  of both. A call counts once it has ended: a call that still holds its batch is
  running. The lag of a call is the delay of its accepted batch, from the reading of
  its oldest fact to the model version (`delay_ms`, ADR-0007).
- Probes on the synthetic input spend the observer usage of no run. Authorization
  checks spend nothing.
- The chat journal of a run is its chat calls (K.1 writes them with
  `observerCalls.chat`). A follow-up that resolves `needs` names the call it
  continues, and the chain is one call from the first start to the last end.

`usage(query)` of the read queries gives the usage report of `aang usage` and the
usage panel; `query` takes a run, a period from `from` (inclusive) to `to`
(exclusive), or both, and an unknown run gives `null`:

- A solver record counts in the period of its time and a call in the period of its
  end. The activity of the solver counts in the period of its time, so the duration
  of a run in the report runs from its first to its last activity in the period, and
  the agents and stages of `solverUsage(source, run, { period })` take the same
  records and activity.
- Without a run the report lists every run with solver records, solver activity,
  observer calls or chat calls in the period, the earliest activity first; a run
  with only calls comes last. With a run it lists that run and has no probes,
  which belong to no run.
- `observer` and `chat` are the journals over the listed runs, `probes` the probes
  of the period. The latency of calls and the lag of batches are the nearest-rank
  50th and 95th percentiles and the maximum, in milliseconds. `records` of a call
  journal counts the CLI results that reported usage; their output is never a lower
  bound. `cost_usd` adds the money the CLI reported and is `null` when no call
  reported any, as for Codex.
- The sessions of a run come as `solverUsage` gives them: the Claude Code total
  (`cost_state`) and whether it is final, whether the session is a fork, whose
  Claude Code total includes the inherited usage, and the thread totals of Codex
  threads without usage records. The Claude Code total and the thread totals are
  cumulative over the whole session or thread, so a period does not cut them, and
  they are never added to a journal.
- `totals` sums each journal: the solver over the runs, the observer over the runs
  and the probes, the chat over the runs. The journals are never added together.
- An active hour is a clock hour of UTC in which the solver of a listed run was
  active; the observer and the chat do not make an hour active. Two runs active in
  the same hour count it once. `per_active_hour` divides each journal by the active
  hours of the report and is `null` without them.

## Watch and prune

A scope decision of a root session keeps the starting directory it was judged by
(`session_scopes.cwd`). `engine.rewatch(watch, persist)` judges every stored
decision again with the new roots, in one transaction with `persist`, where the
daemon saves the watch settings. Observer sessions keep their decision.

- A session that leaves the roots becomes `external` together with its streams:
  those whose records belong to it and those pruned with it (`pruned_streams`).
  Appended lines are discarded while the records already taken stay until
  `prune`.
- A session that enters the roots becomes `watched`, but its streams keep the
  `external` decision: their lines were never stored. A stream decision tells how
  the lines read so far were taken, so an `external` stream of a watched session
  is history still to reread. `rewatch` returns every `external` stream, and the
  daemon asks the collector to reread them from the beginning within the lookback
  (ADR-0004). A reread file is held like a new one; the decision of its session
  wins over the stream decision, and the stream decision follows it.
- Until such a reread the stream stays `external`, across restarts too, so a
  later `watch` with a longer lookback or a repeated one after an interrupted
  reread still takes the whole file. A stream whose reread finds nothing past its
  prune boundary stays `external` as well, and the next `watch` rereads it from
  the boundary.
- New records follow the decision of the session that owns them: appended lines,
  hooks, OTel records and gaps of a watched session are taken while its stream
  waits for the reread, and none of them marks the history as taken. Appended
  lines of a session that left the roots are discarded and make the stream
  `external`. A hook decides the stream it names only when the stream has no
  decision yet.
- A hook record is stored with the stream its adapter names: Codex the thread,
  Claude the main or subagent transcript of the event; a Claude registry entry
  names the main transcript. A stream whose only stored records are such records
  still belongs to their session, so a gap of its file, such as `source_lost`
  after the file is deleted before the reread, is taken by the session's
  decision and attached to the session and its run.

`engine.prune(request, prefixHash)` removes the runs of `aang prune --run` or of
`aang prune --before`: the runs whose sessions had their last event before the
date. In one transaction it deletes the raw records of the run's streams and
sessions with their facts, objects, gaps, the model and its journal, observer
calls, view state, chat and bindings, and saves a boundary per stream in
`pruned_streams` (ADR-0005). Cursors and scope decisions stay.

- The streams of a run are the streams of any decision whose records, lines or
  hooks, belong to one of its sessions, and the streams pruned with those
  sessions before. Since a hook record keeps the stream its adapter names, a
  session known only from hooks is bounded too.
- A context record and a git snapshot belong to the run they were recorded for,
  named by their fact about the run, and go only with that run, even when its
  root session has moved to the pruned run. A context record also names the other
  sessions it read; pruning one of them removes only that reference, so the
  context of a run that keeps it stays whole for its observer calls (ADR-0007).
- A Claude boundary is the offset of the furthest cursor of the stream with the
  hash of the file prefix up to it, from `prefixHash`. Without a cursor the
  boundary is the empty prefix. When the file can no longer be read, the boundary
  keeps the offset with the hash of the empty prefix, which no prefix of that
  length matches, so a file that reappears stops with a gap instead of returning
  the deleted lines.
- A Codex boundary is the largest `last_ordinal` of the stream's cursors.
- Hook records of a pruned session observed before the latest boundary of the
  session are discarded, and so are pending OTel records of a pruned stream.
- A run created again for a session with boundaries has `start_pruned`.
- A pruned run can be pruned again: its sessions are found by the root sessions
  saved with the boundaries, except a session observed in another run since,
  such as one resumed after the prune and then attached elsewhere, which stays
  with that run. This is how a stream stopped with
  `stream_changed_after_prune` is taken again whole (ADR-0005): a Claude stream
  with that gap open gets the empty prefix as its new boundary, the gap goes with
  the other layers of the run, and the collector rereads the stopped files from
  the start.

## View rules

View rules change what the map shows and nothing else: the model, the journal, the
usage and the attention zone stay as they are (ADR-0008). A rule belongs to one run.

- `addViewRule(transaction, { run, rule, source, at })` checks a `ViewRuleSpec`
  from the chat or the UI, stores it and returns it with the elements its selector
  selects now, which is the count shown to the user. Text in a selector and the
  group name are trimmed. A rule the run cannot hold is a `ViewRuleError` that
  explains it and stores nothing: `invalid_rule` when it does not match the schema,
  `invalid_selector` for an empty text, an empty stage list or a stage the run does
  not have, `invalid_params` for an empty group name. An unknown run gives `null`.
  The caller's transaction lets a chat answer and its rule commit together.
- `revokeViewRule(transaction, { run, id, at })` records the revocation once, with
  a new `change_seq`, and returns the rule; a revocation is never before the
  creation of its rule. A revoked rule stays in the store. An unknown rule or a rule
  of another run gives `null`.

Rules apply when a view is read, never when it is written, so a rule selects
elements that appear after it and a revocation restores the view. The snapshot and
every `run` delta of the feed carry `view.rules`, the active rules in creation
order with the elements they select, and `view.placements`. Rules survive a
restart with the store.

Selectors are deterministic. Agent type, name and role and a tool name match a
whole value without regard to case or surrounding spaces; the role is the runtime
role (`agent_role`) or the role in aang (`main`, `subagent`, `teammate`,
`service`). Service agents are the agents with the service role. A stage title
matches a fragment, and stage ids and action kinds match exactly. Stage selectors
see every stage of the run, replaced ones included.

The tree of an element is what a rule on it covers:

- a stage covers its substages, the actions assigned to any of them that still
  belong to the run, the participating agents and the agents of those actions;
- an agent covers the agents spawned under it and the actions of all of them;
- an action covers the actions of its code cell.

A placement is the effect of the rules on one selected element. On each aspect of
it the latest rule wins:

- visibility: `collapse` shows the element as one node with the totals of its tree,
  `hide` leaves it out together with its tree;
- `group` names the node the element is shown under;
- `detail` sets the level of its tree: only stages, stages and agents, or every
  action. The element itself stays shown.

The default rule collapses service agents (ADR-0006); its placements name the rule
`null`. It comes before every stored rule, so a later rule overrides it until that
rule is revoked.

The totals of a collapsed element count the agents and actions of its tree, the
running actions and the finished ones by outcome, the versions its actions produced
and, for a stage, the outputs linked to its tree. Usage is that of the solver
journal: the records of the agents of the tree, or for a stage the records that
belong to its tree, as `solverUsage` attributes them. An action has no usage of its
own. A hidden or collapsed element keeps its share in every total outside the view:
the run, its sessions, stages and agents and the inspector count it as before.

No rule removes an open attention item from the zone. A placement lists, in
`attention`, the open items its element takes off the map: those of its whole tree
when it is hidden or collapsed, and those of the agents and actions below the level
of a detail rule. An item belongs to the action it names or its question names, to
the agent of the question or of that action, and to its stage. The UI marks these
items as coming from a hidden element.

## Since the last view and the attention zone

`createViewState({ store, now })` records the explicit view actions of the user
(ADR-0008). They are view state: they change neither the model nor the journal and
send nothing to the solver, and "viewed" never means "approved".

- `markViewed(run, { version, change_seq })` sets the one view mark of the run
  (ADR-0005). The pair must describe one state: `version` is the model version of the
  run at `change_seq`, the last version committed at or before that position, and
  the position is not ahead of the change feed. The client sends the position of the
  snapshot it shows together with the events it applied; any other pair is an
  `InvalidPositionError`, and the previous mark stays. A later mark replaces the
  mark, even with an earlier position. Only this call sets the mark: ingestion, the
  observer and reads never move it. A new mark is a visible change with its own
  `change_seq`, after the position it marks; the marked pair stays as sent. The
  snapshot and the `run` delta carry the mark, and the feed delivers it as a `run`
  event at its `change_seq`. Repeating the same mark at the same time changes
  nothing.
- `viewItem(run, item)` and `dismissItem(run, item)` record that the user viewed or
  dismissed an attention item of the run, with a new `change_seq`. The first time
  of each is kept, so repeating either changes nothing. A dismissed item leaves the
  attention zone and stays among the items of the snapshot with its view, which is
  its history entry "dismissed by the user"; its resolution, runtime wait and the
  stage state stay as they are. Viewing does not dismiss. An unknown run or an item
  of another run gives `null`.

The changes since the mark are `changes(run, mark)`: the model journal after the
mark version and the observation layer after the mark position. Rule items, such as
a question asked or a check failed while the observer was unavailable, are journal
entries of the author `rule`, so they are in the changes without the observer. Later
observer changes of such an item, a priority or a likely resolution, do not open it
again, so after a new mark it is not announced a second time. An artifact version
written while the observer was unavailable is in the changes as well: a version is
new when it was created after the mark position. The store keeps the position at
which a version was first stored, so storing it again when its base is retained,
when an earlier producer is found or after a restart does not announce it again.

The attention zone (`view.zone`) lists the open items that are not dismissed, in the
order of ADR-0008. Each place explains itself:

1. items not viewed come before viewed ones: viewing lowers an item, which stays in
   the zone until it is closed or dismissed;
2. `waiting_for_human`: the solver waits for the human on a known request, the
   runtime wait of the item is active;
3. `dependent_stages`: the active stages that depend on the item, more first. They
   are the stage of the item, or for an action-level item the stages its action is
   assigned to while the action belongs to the run, together with every stage that
   depends on them through dependency links, directly or through other stages.
   Dependency links pass through replaced, merged and split stages, but such stages
   do not count;
4. age: the older `opened_at` first; then the item id.

The priority of the observer (`attention.priority`) is a recommendation shown with
the item and never changes the order.
