# ADR-0008: Chat, map view and attention zone

Status: accepted by the owner on 2026-10-01; the addendum on `PermissionRequest` for the question tool (section "Attention zone", kind `permission`) approved by the owner on 2026-10-10.

## Context

RFC §2, §4 and §5 require:

- a chat over the whole run with narrowing to a stage; an answer refers to a map version and cites its grounds or reports insufficient data;
- view changes as revocable rules that apply to new events and do not rewrite history;
- preserving the selected stage and the reading position on updates; color is complemented by a label or an icon;
- an explicit last-viewed mark and a "Since last review" mode;
- an attention zone with explicit questions, review requests and significant blockers.

Hidden agents keep their contribution to results and cost, important questions stay visible. "Viewed" does not mean "approved" and sends nothing to the solver.

## Decision

### Chat

- The chat works within a single run. The selected stage narrows the context.
- The call goes through the observer mechanism (ADR-0007): the same isolation, vendor, markers, no tools. Authorization is the subscription via the already authorized CLI, without `--bare` (approved by the owner). The chat has its own concurrency slot.
- Input:
  - the question and the latest chat messages of this run;
  - the run description;
  - the model snapshot of version V;
  - the objects and facts of the selected stage, and without a selection, the attention items and the latest changes.
- Output: `{needs, answer, citations[{kind, id}], insufficient_data, view_rule}`.
  - `needs` is a request for materials: stages, including replaced ones, facts, raw records, actions, journal entries, saved artifact versions. If it is non-empty and `answer` is `null`, the daemon resolves the request and makes a second call with the same snapshot of version V. In the response to the second call `needs` is ignored: there is only one follow-up request.
  - The materials pass through the same scope filter as the observer input (ADR-0007).
  - `kind` is a stage, fact, action, artifact version or question.
  - `view_rule` is a proposed view rule or `null`.
- The daemon checks that the citations exist in the snapshot or in the input. Invalid citations are removed, and the answer is marked "some citations were unconfirmed and removed".
- The answer is saved with model version V and shown as "as of map version V". If the model has changed since, the UI marks it.
- The chat does not change the model, except for view rules, and sends nothing to the solver (RFC §4). Chat cost is accounted separately (ADR-0009).

### View rules

- Actions:
  - `collapse` — collapse into a node with totals;
  - `hide` — hide;
  - `group` — group under a named node;
  - `detail` — the detail level of a subtree: stages, stages and agents, all actions.
- The selector is deterministic. It is one of a closed set of variants (`anyOf` in the schema, ADR-0007):
  - an agent by type, name or role;
  - service agents;
  - stages by id or a title substring;
  - actions by tool name or kind.

  The parameters of each action are closed as well: the group name for `group`, the level for `detail`.
- A rule is `{id, action, selector, params, source: chat|ui, created_at, revoked_at}`. The scope is one run.
- The chat proposes a rule, the daemon checks the selector, computes the affected elements and applies the rule immediately. The UI shows the list of active rules with revocation. A rule created from the interface goes through the same mechanism.
- Default rule: service agents are collapsed (ADR-0006).
- Rules are applied when building the view and are recomputed for new elements. They do not change the model or the journal.
- Invariants:
  - a collapsed or hidden element keeps its contribution to results and cost: the collapse node shows totals;
  - a rule does not hide questions, approvals, review requests, blockers and failed checks — they stay in the attention zone marked "from a hidden element".

### Map on updates

- A new model version does not reset the selected stage and the scroll position.
- If the selected stage is replaced, merged or split, the selection moves to its successor according to the stage history, and the UI reports this.
- The ELK layout is recomputed preserving the order of existing nodes, so that the map is not rebuilt entirely.
- The state on each axis is shown by color together with a label or an icon.

### "Since last view" mode

- The per-run mark is set only by the explicit user action "Mark as viewed". It atomically records the pair "model version and `change_seq`" (ADR-0005). Opening the page and incoming events do not set it.
- The mode shows the difference between the mark and the current state using two cursors:
  - over the model journal from the mark's version:
    - new and changed stages — as the resulting transition, intermediate states collapsed;
    - revised decisions: replaced, merged and split stages, changed criteria and plan;
    - new cards;
  - over observation and attention objects from the mark's `change_seq`:
    - new artifact versions;
    - new and closed questions, review requests, blockers, failed checks;
    - a summary of new actions per agent.

  Therefore changes that appeared while the observer was unavailable are not lost.
- Each item references its grounds and journal entries.

### Attention zone

**Opening and closing items**

The end of a runtime wait and the resolution of a semantic question are different: the solver may stop waiting while the question stays unresolved. Therefore an item has three independent fields:

- runtime wait — `active`, `ended` or `none`;
- resolution — `open`, `answered`, `resolved` (only for observer items) or `ended_without_answer`;
- dismissal by the user — a time or empty.

The stage state depends only on an active wait (ADR-0006); the human-decision axis depends on the resolution.

| Kind | Opened by | Closed by |
| --- | --- | --- |
| `permission` | rule: `PermissionRequest` (`Notification(permission_prompt)` is merged into it); a `PermissionRequest` for `AskUserQuestion` and `ExitPlanMode` does not open an item — it is the question of the same call (ADR-0006; addendum approved by the owner on 2026-10-10) | a human decision or a rule (ADR-0006). End of turn, `Interrupt`, `turn_aborted` and end of session end the wait: the item is closed as "wait ended without an answer", because the call was not executed and no longer awaits a decision |
| `question` from a rule | `AskUserQuestion`, `ExitPlanMode`, `Elicitation`, `Notification(elicitation_*, agent_needs_input)`, Codex `AgentMessage.questions` | a correlated answer (`answers`, `ElicitationResult`) or dismissal by the user. The observer does not close rule items. If it sees that a human prompt answers the question (for example, an asynchronous Codex question), it adds the mark "likely answered" (`attention.likely_resolved`, an interpretation), and the item stays open until dismissed. The next prompt and the end of the session do not close the question: after the work ends it stays in the zone marked "session ended" |
| `failed_check` | rule: a failed check per the contract | a successful retry of the same check; dismissal by the user |
| `question`, `review_request`, `blocker` from the observer | operations `question.add` and `attention.add` | the observer's `attention.resolve` with evidence (an answer, cancellation or replacement of the request, evidence of resolution); dismissal by the user. The end of the session and of the run does not close them |

- An auto-denial without a host (Claude `-p`) opens and immediately closes an item: it is visible in history but not in the zone.
- **Dismissal by the user** (decision 3) removes an item from the zone with the history entry "dismissed by the user". This is a view action: it sends nothing to the solver and does not count as a decision or an answer.
- `Notification(idle_prompt)` does not create an item: it is the session state "waiting for input".
- A missing check does not create an item.
- Observation problems (inactive hooks, a lost source, model lag, "Not observable" for Cowork and cloud modes) are shown in the status bar, not in the attention zone.

**Order**

1. The solver is waiting for a human on a known request.
2. The number of stages that depend on the item.
3. Age.

Each item shows an explanation of its order ("awaiting an answer", "blocks 2 stages"). A priority from the LLM is shown with a "recommended" label and does not change the order.

**Viewing.** The user can mark an item as viewed. The item moves down but stays visible until it is closed or dismissed.

## Consequences

- All view changes are reversible and do not affect the model or cost.
- The changes mode relies entirely on the journal and therefore does not depend on repeated LLM calls.
- Unresolved questions and review requests survive the end of the session and are visible when returning to the results. So that they do not accumulate indefinitely, there is explicit dismissal by the user.

## Owner decisions

Accepted by the owner on 2026-10-01:

1. A view rule from the chat is applied immediately and revoked from the list of active rules.
2. The scope of view rules is one run.
3. Dismissal of an attention item by the user is allowed with a history entry; "dismissed" does not mean "resolved" and sends nothing to the solver.
