# Stage operations

`applyObserverResponse` applies the `stage.*`, `actions.assign`,
`agents.participate` and `artifact.link` operations through the model journal.
Replaced, merged and split stages remain addressable, with successor ids in their
lifecycle and all earlier states in `store.model.entityChanges`. Replaying the
journal restores the same stage and relationship ids.

Assignments, participation, artifact links and dependencies are upserts by their
endpoints. Repeating a relationship keeps its id and updates its grounds. Artifact
input and output links are distinct; the same action, agent or version can belong
to several stages. Artifact retention belongs to E.7b.

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
Snapshots around checks, `passed_unversioned`, `confirmed` and `stale` belong to
E.7b and E.7c.

## Input scope and needs

`inputScope(reader, { run, backend, crossVendor })` is the single filter for the
observer input; chat materials (K.1) use the same filter. An object is in scope only
when its session belongs to the run. A session of a vendor other than `backend`, the
vendor that receives the input, is excluded unless `crossVendor` is set. A raw record
is attributed through its facts, so a record without facts is out of scope.

`inputViolations(reader, scope, input)` applies the scope to the whole input: the
sessions and agents of the run description, the context record, the stages,
criteria and attention items of the snapshot, the facts of the batch with their
sessions, agents and actions, the agents of collapsed facts and of the backlog, and
the artifact versions with the actions that produced them. Snapshot entities must
belong to the run. The context record follows the raw record rule, and an artifact
version must be bound to the run, so both are refused until F.7a and E.7b provide
their storage. `beginObserverCall` refuses an input with any violation and a first
call that already carries materials; `beginObserverFollowUp` checks the stored input
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
and report their path and original length. Artifact versions and context records
answer `not_found` until E.7b and F.7a provide their storage.

A response with nonempty `needs` to a call without materials is not applied.
`applyObserverResponse` records the verdict `needs_requested` and leaves the batch
`in_call`. `beginObserverFollowUp` starts the only follow-up with the same snapshot
and batch plus the resolved materials, with the backend of the first call. It hands
the batch over to the follow-up without spending an attempt. The follow-up response
is applied or rejected as usual, and its `needs` are ignored. After a restart the
batch returns to `pending`, and the cycle starts again with a new first call. The
scheduler (F.8) starts the follow-up immediately, outside the minimum interval
between calls of a run.

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
one transaction. A failure leaves facts, raw records and objects unchanged.

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
records is deleted with its objects, and agent, action and question objects that
no fact supports any longer are deleted.

A deleted fact, object or discarded record leaves no row in the change feed, so
every deletion advances `change_seq`, and a record whose facts were added or
removed is rewritten with a new `change_seq`. The head therefore moves with
every visible change and a reparse that changes nothing keeps it. The daemon
publishes the SSE `reset` with reason `reparsed` after a reparse. An object that
is deleted and later projected again starts without fields owned by other rules,
such as its run.

The model journal and model entities are not changed. `resolveEvidence(facts,
evidence)` returns each referenced fact, or `unavailable` for a fact the current
normalizer no longer produces. Reparse does not write `fact_interpretation`.
