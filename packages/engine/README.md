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
  Without an observed decision, the evidence is that of the journal change that
  closed the item.
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
