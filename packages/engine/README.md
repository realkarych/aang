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
- An open question, permission request or review request sets the independent human
  decision to `requested`, including nonblocking requests. Closing the last request
  clears this derived value to `unknown`; the full projection of observed human
  answers and approvals belongs to M.5c. Existing decisions from other rules are
  preserved when there is no open request.
- An action-level request without an explicit stage applies only while that action
  belongs to the stage's run. Moving it preserves the historical assignment but
  removes its execution wait and requested decision from the old stage.

All writes use the caller's transaction and the existing journal/replay path. The
caller must build the snapshot from current projections in that transaction; an
observer input captured when a call started is not a current runtime snapshot.
