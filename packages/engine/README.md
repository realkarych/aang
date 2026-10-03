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
  Observer fields of an item (likely resolution, priority) are kept. An item whose
  failures no longer match a contract after the configuration changes keeps its
  last state.

The run of a session is the run of its `session_membership`, or the run of its own
root key when there is none, the rule that run linking (E.4) uses for projections.
The root session of a run comes from its `run` entity; without one, a session that
is its own root uses its `cwd`.

Checks do not produce criterion statuses: a check alone never gives `confirmed`.
`passed_unversioned`, `confirmed` and `stale` belong to E.7c.

## Working tree snapshots

When the ingest transaction stores the start or the end of a check (a command
action of a run that matches a contract), the engine takes a snapshot of the
working tree after the commit and before `ingest` resolves (ADR-0006). A batch
that holds both the start and the end of a check takes one snapshot; a start and
an end read in separate batches give snapshots around the check. Checks read by
backfill are snapshotted when they are read, so `taken_at` tells later readers
whether a snapshot can precede the check.

The snapshot runs in the directory of the check (`cwd` of its start, otherwise of
its session), finds the top of the working tree and runs read-only commands with
`GIT_OPTIONAL_LOCKS=0` and `core.fsmonitor=false`:

- `git rev-parse --verify --quiet HEAD^{commit}`;
- `git status --porcelain=v1 -z --ignored=traditional --untracked-files=normal
  --ignore-submodules=none -- <pathspecs>`.

User settings that hide untracked files or submodule changes do not apply, and
git neither refreshes the index nor takes `index.lock`. `inputMasks` of a contract
are paths relative to the watched root that declares the contract, interpreted as
git pathspecs. A mask that covers the whole working tree becomes `.`, and masks
outside the working tree are dropped; when no mask remains, no snapshot is taken.

A snapshot is clean only when `HEAD` resolves to a commit and the status under the
masks is empty: an uncommitted, staged, renamed, untracked or ignored path under a
mask makes it unclean. A failed git command (no repository, a missing directory)
gives an unclean snapshot without a head and with the error.

Each snapshot is a raw record of the `snapshot` channel (position `daemon`, no
runtime or stream), one `git_snapshot` fact keyed by the run of the root session
with speaker `runtime`, and a `GitSnapshot` object with trigger `check`. Daemon
records are not session evidence: they do not move `last_event_at`, freshness or
the turn state.

## Artifact versions

The ingest transaction projects artifact versions from the actions whose start or
end it stores. A version belongs to the run of the action's session, its artifact
is the absolute path, and it records the action in `produced_by`. Inherited
actions give no versions. Paths come from:

- Claude `Write` (`file_path` with `content`), `Edit` and `MultiEdit`
  (`file_path`), `NotebookEdit` (`notebook_path`), resolved against the `cwd` of
  the start;
- Codex `apply_patch` (`*** Add File`, `*** Update File` and its `*** Move to`)
  and `FileChange` items (`add`, `update` with `move_path`); deletions give no
  version;
- shell scripts of command actions (a `command` or `cmd` string, or the script of
  a shell argument vector): targets of `>`, `>>`, `>|`, `&>`, `&>>` and `N>`, and
  the file arguments of `tee`. Heredoc bodies, comments, quoted text, `[[ ]]`,
  `(( ))` and process substitutions are not redirections; duplications such as
  `2>&1`, `/dev/*`, and targets with expansions, globs or `~` are skipped. Relative
  targets resolve against `workdir` of the input or the `cwd` of the start, and
  are skipped when the script changes directory (`cd`, `pushd`, `popd`).

A file tool gives a version after an end with outcome `ok`; an end with an unknown
outcome, such as a Codex `PostToolUse` or tool output, is not enough. A command
gives a version after any end except `denied`, because a failing command still
writes its redirections.
Full content in the payload (Claude `Write`, an added file of a Codex patch) makes
the identity the content hash. Otherwise the version is known only by reference:
its identity is the earliest stored start that names the path. The projection is
repeatable, keeps the stored retention, and dates a version by its earliest
qualifying end.

## Retention of bases

`engine.retainBases(runs?)` retains every version of the given runs (all runs by
default) that is still known only by reference and is a basis: the version of an
`artifact` link or the `via` of a `dependency` link. Callers run it after applying
an observer response and after a restart; the engine queue orders it with ingest.

- A content version whose payload still holds that content is retained from the
  payload as `action_payload`: the version the action produced.
- Otherwise a regular file at the path is read as `file_read` with `read_at`, the
  state of the file at the moment of reading, not proven to be the output of the
  action.
- Content larger than `maxBlobBytes` (5 MiB by default) keeps only `hash_only`
  with its SHA-256 and size; no blob is stored.
- A missing path, a directory or an unreadable file keeps the version known only
  by reference; a later call reads it again.

Blobs are stored once per hash with a reference per version and its source; the
last reference removes the blob. Retention changes the version, so it reaches the
change feed. Versions of URLs, commits and pull requests are not retained here.
