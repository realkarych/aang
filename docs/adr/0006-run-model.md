# ADR-0006: Run and link model

Status: accepted by the owner 2026-10-01; revocation of observation objects on identity refinement (decision 7) accepted by the owner 2026-10-03; the addendum on `PermissionRequest` for a question tool (section "Observation objects and their keys") approved by the owner 2026-10-10.

## Context

RFC §6 defines the unit of observation — the run. Links are established by runtime identifiers or explicit binding; a matching directory is not enough. Execution, basis of inference and human decision are shown independently; nesting, result dependency and time order are distinguished. The spike (sections 6–9, 5.2-G) showed differences between runtimes:

- a Claude fork copies the history without a reference to the parent, a Codex fork references the parent explicitly;
- the Claude compaction agent produces a false `SubagentStop`;
- Claude teammates are linked by name;
- in Codex code mode one JS cell spawns several commands.

## Decision

The model has two layers. **Observation objects** are built by the daemon deterministically from facts. The **semantic model** (stages and what is linked to them) changes only through the journal (ADR-0005); changes are proposed by the observer, daemon rules and the user.

### Facts

- A fact carries:
  - a kind;
  - the `entity_key` of the object it belongs to;
  - `speaker` — `human`, `solver`, `tool` or `runtime`; the `claimed` basis is computed from it;
  - the `urgent` flag, which triggers the observer without waiting (ADR-0007): end of turn, final message, subagent completion, error, plan, compaction, question.
- Model thinking (Claude `thinking`, Codex `reasoning`) does not become a content fact and is not passed to the observer: the hidden chain of reasoning is not reconstructed (RFC §6).

### Observation objects and their keys

Run and object ids are the hash of the key; they do not change when projections are rebuilt.

| Object | Claude | Codex |
| --- | --- | --- |
| Session | `sessionId` | root thread id (`session_meta.session_id` of the root) |
| Agent | main — `sessionId`; subagent — `agent_id`; teammate — `name@team`; service — by kind | thread id; guardian — a thread with `thread_source: guardian_review` |
| Action | `tool_use_id` | `call_id`; in code mode the action is the nested command `exec-<uuid>` (also the hooks `tool_use_id`), and the JS cell `custom_tool_call` is a container of actions |
| Message and prompt | `uuid` | `(thread_id, ordinal)` |
| Question | `AskUserQuestion` — `tool_use_id`; `PermissionRequest`, `Notification`, `Elicitation` — spool file name | `AgentMessage` with `questions` — item id; `PermissionRequest` — spool file name |
| Usage record | `message.id` | `(thread_id, response_id)` |
| Artifact | normalized absolute path, URL, commit or PR | same |

- **Session.**
  - Attributes: runtime, surface (with basis), version, `cwd` at start, git.
  - Launches: `startup` and `resume`; by hooks `continue` is indistinguishable from `resume`. Compaction is a session event, not a launch.
  - State: turn in progress, turn finished, session finished, or unknown.
- **Agent** — main, subagent, teammate or service: the Codex guardian, the Claude compaction agent, the Desktop summary helper model.
- **Action** — start, end, outcome (`ok`, `error`, `denied`, `interrupted`, `unknown`), references to input and output.
- **Question** — an explicit request to the human:
  - `PermissionRequest`, `AskUserQuestion`, `ExitPlanMode`, `Elicitation`;
  - `Notification` with `elicitation_*`, `agent_needs_input`;
  - Codex `AgentMessage{delivery:"async", questions}`.

  `Notification(permission_prompt)` arrives 6 s after `PermissionRequest` and is merged with it. `Notification(idle_prompt)` is not a question: it is the session state "turn finished, waiting for input".

  Addendum from the owner's review of 2026-10-08, approved by the owner 2026-10-10: a `PermissionRequest` for a Claude question tool (`AskUserQuestion`, `ExitPlanMode`) is the same dialog as the question of that call and does not become a separate question. The request fact belongs to the session or agent, remains a basis of the human wait and does not open a `permission` item. The adapter recognizes such a request by its own `tool_name` and does not link records to each other (ADR-0011). The Claude normalizer version does not change: the rule applies to records received after the change, while runs stored earlier keep the second question and its item, and `aang reparse` does not rebuild them. Removing them by reparsing is possible only by revoking the question together with closing its item, and revocation of objects other than an agent is a separate decision (section "Identity refinement and object revocation").
- **Artifact version** — the state of a file, URL, commit or PR in the run; version identity is the content hash. A version is either:
  - **stored** — the content is in the aang blob store or is reproducible from a commit available in the repository;
  - **known only by reference** (path, URL, hash without content) — shown as such and not passed off as stored (RFC §6).
- **Retention of basis versions.** When an artifact version becomes a basis (stage output, card, criterion, check), the daemon stores the content in the content-addressed blob store (ADR-0005):
  - from the action payload, if it contains the full content or a patch to an already stored version. Only such a copy counts as the version produced by the action;
  - otherwise by reading the file. Such a copy is marked "file state at the time of reading" T and is not passed off as the version produced by the action: the link to the action is not proven;
  - files over the limit (5 MB by default, decision 2) are stored as a hash only, with a mark.
- **Working tree snapshot** — a record of the `snapshot` channel. The daemon takes it read-only, with `GIT_OPTIONAL_LOCKS=0`, by the contract's path masks:
  - `git rev-parse HEAD`;
  - `git status --porcelain --ignored -- <masks>`.

  The snapshot answers one question: is the version under the masks clean, that is, does all content under the masks, including ignored files, match the committed commit. A clean snapshot identifies the version by the commit; the content is recovered from the repository while the commit is available. A dirty snapshot does not identify a version, and such a version is not used for confirmation.

### Identity refinement and object revocation

- An object key may be refined after the object has already been stored. In the MVP this happens only for a Claude teammate: lines of its transcript `subagents/agent-<id>.jsonl` and hooks, if they carry the file `agent_id`, may arrive before `meta.json` with `name` and `teamName`. Before `meta.json` these facts produce a subagent keyed by `agent_id`, after it a teammate keyed by `name@team`. Session, action and question keys are known from the first fact and are not refined, so the contract allows revocation of agents only; other kinds are added by a separate decision.
- On refinement, in the same intake transaction (ADR-0005), the daemon:
  - stores the object with the refined key;
  - revokes the previous object, pointing to the replacement `replaced_by`;
  - re-stores the observation objects that referenced the previous one (actions, questions, usage records, child agents) with a reference to the replacement;
  - retargets model links by a rule through the journal. `link.retarget` moves the link end to the replacement. `link.remove` removes a link if the same link with the replacement already exists or if the link id is derived from the previous object's key; a link of the replacement with a derived id is added by a regular `link.add`.
- Revocation is a visible change with its own `change_seq`. The change feed and the `facts` event (`removed`) tell consumers that the previous object is gone and what replaced it. The run snapshot does not contain revoked objects.
- The replacement is a stored object of the same kind. If the replacement itself is revoked, previously revoked objects are redirected to the new replacement, so `replaced_by` always points to a stored object. Storing a revoked object again lifts its revocation.
- The result does not depend on delivery order. After receiving the same set of records in any order, observation objects and model links match; only the ids of links assigned by the observer and rules, not by the object key, may differ.
- The journal is not rewritten: earlier changes keep references to the revoked object, and its replacement is visible via the revocation. A reference to a revoked object in an observer response is rejected by validation as a reference to a missing object (ADR-0007).

### The run and its boundaries

- A run is created by a root session: a new session that is not a resume, a subagent or a service thread. The run id is the hash of the root session key.
- A run includes:
  - all launches of the root session (resume and continue keep its id);
  - subagents, teammates and service agents, transitively.
- Links by runtime identifiers:
  - Claude subagent — `meta.toolUseId` and `toolUseResult.agentId`;
  - Codex subagent — `parent_thread_id`, `thread_spawn`, `SubAgentActivity`;
  - Claude teammate — `(sessionId, meta.name, meta.teamName)` ↔ `toolUseResult` and `teams/*/config.json`;
  - background subagent notification — the transcript's `origin.kind`/`promptSource`, not parsing of the prompt text.
- **Scope** is decided once for the root session by its first `cwd` (ADR-0004) and inherited by continuations and agents. A later `cwd` change does not change the scope.
- **A Codex fork** (`forked_from_id`) creates a new run with a "forked from" link; the basis is an observed event.
- **A Claude fork** is recognized by `SessionStart.source=fork` or by the file itself: after the opening lines of the launch (`queue-operation`) come records timestamped earlier than this launch.
  - Records before the launch's first own record whose time is earlier than the fork launch are considered inherited. The rule does not depend on whether the original is present or on intake order.
  - Inherited records are not repeated as new actions and spend (ADR-0009).
  - A new run is created with a "common origin" link and a list of visible sessions with the same `uuid`s. The list is recomputed when new sessions appear.
  - No direct parent is assigned; a single candidate is shown as a guess with a basis.
- A new session after `/clear` and sessions spawned by Desktop without verified metadata become separate runs without a link.
- A false `SubagentStop` of the compaction agent (`agent_type: ""`, no `SubagentStart`, the transcript path does not exist, `PreCompact` nearby) is recognized as a compaction event, not an agent.
- The user can explicitly bind a session to a run, assign a fork's parent or unbind a session. Bindings are journaled and can be undone.
- **Moving a session between runs** (binding, late recognition of a subagent or fork link):
  - is recorded in the journal of both runs;
  - the session's facts become unprocessed in the target run (ADR-0007);
  - stages of the source run that reference its actions get a "session moved" mark;
  - the spend of both runs is recomputed by the projection;
  - view marks and view rules stay with their runs.
- A matching project directory never links sessions.
- In the MVP one root session corresponds to one run; a change of goal within a session is reflected by stages.

### Link kinds

Each link stores a basis.

| Link | Between | Source |
| --- | --- | --- |
| nesting | run ⊃ session ⊃ agent ⊃ action; stage ⊃ substage | runtime; substages — observer |
| spawning | agent → subagent via an action | runtime identifiers |
| fork / common origin | run → run | see above |
| participation | agent ↔ stage, many to many | observer or binding of actions to a stage |
| result dependency | stage B uses the result of stage A | observed, if an artifact version from A is an input of an action in B; otherwise the observer's interpretation |
| time order | stages and actions | time and order in the file; does not imply causality |

### Semantic model

- **Stage.** Fields: `id`, title, expected result, short summary, parent, participants, bound actions, inputs and outputs (artifact versions), criteria, state on three axes, history (creation, renaming, merging, splitting, replacement, session move).
  - Origin `plan` — the stage is taken from an explicit plan. The daemon accepts it only if the bases include a plan fact:
    - Claude — task tools (`Task*`), hooks `TaskCreated`/`TaskCompleted`, `ExitPlanMode`;
    - Codex — `thread_goal_updated` and rollout plan records.

    Apart from `thread_goal_updated`, these records were not observed in the spike. The plan sources for each version are determined by the "plan" reference session (ADR-0010); until then plan parsing is marked as unverified.
  - Origin `inferred` — the stage is reconstructed by the observer; such stages are marked.
  - Stages are created only by the observer. Until its first response the UI shows plan facts in the pre-meaning view.
- **Replanning.** A replaced stage is kept in the `replaced` state with a reference to the replacement and is not deleted.
- **Criterion.** Text, source (`task`, `plan`, `contract`), status (`not_checked`, `confirmed`, `passed_unversioned`, `partial`, `failed`, `stale`, `reported_done`), evidence, the version on which it was checked.
  - `confirmed` with the basis "observed event" is given only by a check contract that links a successful result to the commit actually checked. Conditions:
    - the contract defines a regular expression that extracts the checked commit from the check output;
    - the output of the successful check contains it;
    - the commit exists in the repository.

    The version is this commit. The contract is responsible for the check actually reading this commit: for example, the check runs in an isolated copy of the committed commit (`git worktree`, a clean checkout) and prints its hash, or the check system itself reports the checked version. The link is given by the check's own output, so `confirmed` is possible also for a check read by backfill.
  - In all other cases a successful check gets `passed_unversioned` — "check passed, version not established". This does not count as confirmation. This includes:
    - the tree under the masks was clean at the same `HEAD` before and after the check. Such an observation is shown as a reference note "For reference: the tree was clean at commit X in both snapshots.", but it does not prove the version: the input could have been changed and restored between snapshots, and the daemon processes `PreToolUse` asynchronously, without an exact boundary of the check start;
    - uncommitted or ignored changes, work outside a git repository.
  - fs watch is only a change signal for recomputing `stale`, not proof of the absence of changes.
  - After `confirmed` for commit X, the daemon takes a snapshot on an fs watch signal, at the end of each turn and after a restart. If `HEAD` differs from X or the tree under the masks is not clean, the current state is no longer the version that was checked, and the criterion moves to `stale` ("checked on a different version"). A missed notification is caught by the next snapshot.
  - An adequacy assessment made by an LLM remains an interpretation.
  - Without bases, `reported_done` is kept — "agent reported done".
- **Check contract** is set in `~/.aang/config.json` for a tracked root: name, a regular expression over the command line, the success condition (exit code), path masks of the check input, a regular expression for the checked commit in the output. Without it the contract recognizes checks and their outcome but gives no confirmation. It applies to runs whose root `cwd` lies in this root.
- **Check** — an action that matched the contract (observed basis) or was marked by the observer (interpretation). A failed check without a subsequent success of the same check:
  - creates an item in the attention zone, which is closed by a successful retry or dismissal by the user (ADR-0008);
  - prevents showing the stage as simply "done": the stage is shown as "done, has a failed check".
- **Result card** — a fragment of the agent's final text bound to stages, with coordinates in the source message. The original is always available.
- **Attention item.** Kind (`question`, `permission`, `review_request`, `blocker`, `failed_check`), author (`rule`, `observer`), basis, evidence, stage, open or closed, LLM-recommended priority. Opening, closing and ordering are defined by ADR-0008.
- **Run description** — the goal from the first prompt (observed) and its retelling by the observer (interpretation).

### Three independent axes

- **Execution:** `planned`, `running`, `waiting` (with a reason: human, subagent or background task, idle after the answer, unknown), `done`, `failed`, `cancelled`, `unknown`.
  - For actions, agents and sessions, execution is derived from facts.
  - For a stage, execution is first computed by a rule over bound actions, agents and known waits:
    - there is an action or agent in progress — `running`;
    - there is an active human wait in the runtime — `waiting` (human). This is an open approval request, `AskUserQuestion`, `Elicitation` or `ExitPlanMode` in an unfinished turn, or `status: waiting` in the registry.

    An open non-blocking question (for example, an asynchronous Codex question, a review request, a question after the session end) does not move the stage to `waiting`: it is reflected only on the human decision axis.

    States the rule does not derive (`done`, `failed`, `planned`, `cancelled`) are set by the observer. If what the rule observes contradicts the LLM's claim (for example, "done" with an action in progress), the observed one is shown, and the contradiction is visible in the inspector.
  - Source freshness is shown separately from execution:
    - `ok`;
    - `quiet` — no new events for 5 minutes with an unfinished turn (configurable);
    - `lost` — the source is lost;
    - `hooks_inactive`.

    Silence does not move a stage to `failed` or `waiting`.
- **Basis:** `observed`, `claimed`, `interpreted`; an interpretation names the interpreter — `rule:<name>` or `llm:<call id>`.
  - The basis is computed by the daemon.
  - Observer claims get `claimed` if all evidence is facts with `speaker: solver`, and `interpreted` otherwise; an LLM does not produce `observed`.
  - Inferring a denial from a missing `PostToolUse` and linking a `PermissionRequest` to a call are `interpreted` with a rule.
  - `PermissionRequest` has no `tool_use_id`. It is linked to a `PreToolUse` of the same session and agent without a subsequent `Post*` by `(tool_name, tool_input)`. Order only resolves ties; if there are several candidates, the link is marked ambiguous.
- **Human decision:** `none`, `requested`, `approved`, `rejected`, `answered` — only if this is visible in the source session, otherwise `unknown`.
  - `codex.tool_decision` gives a human decision with the `observed` basis only with `source: User`. `source: AutomatedReviewer` is a decision of the guardian service agent, `source: Config` is a policy (safe command, saved rule, `never`). Neither is shown as a human decision.
  - Claude `answers` and `ElicitationResult` give `observed`.
  - From subsequent events the decision is inferred by a rule (`interpreted`) for both runtimes:
    - approval — `Post*` or `item_completed` of the call after the request;
    - denial — `PostToolBatch` without `Post*` for Claude, `declined` or `turn_aborted` for Codex.
  - If neither is visible, the decision is `unknown`.
  - For a stage, the decision is `requested` while at least one of its questions is open, including a non-blocking one; otherwise it is the last decision on its questions.

## Consequences

- The map never links sessions by directory and does not invent a fork's parent.
- Until the observer's first response, the UI shows observation objects: sessions, agents, actions, questions and plan facts.
- Confirmation with an observed basis is possible only via a contract in which the check itself reports the checked commit. Until the user configures such a contract, successful checks remain `passed_unversioned` — deliberately conservative, without attempts to infer the version from tree observations.
- In the solver's working directory the daemon runs only read-only git commands without index locks, and reads files under contract masks and basis files.
- The store grows due to blobs of basis versions (ADR-0005).

## Owner decisions

Accepted by the owner 2026-10-01:

1. A fork is a new run with a link; the user can merge runs by binding.
2. The check contract with a commit reported by the check itself is accepted. Working tree snapshots are used for `stale`; basis versions are copied to the blob store with a limit of 5 MB per file (configurable).
3. Claude teammates are linked by name and team as an observed link within a session.
4. Service agents are hidden on the map by default; their spend is counted.
5. One root session — one run in the MVP.
6. Stages are created only by the observer; plan facts are visible immediately in the pre-meaning view.

Accepted by the owner 2026-10-03:

7. On identity refinement an observation object may be revoked, pointing to a replacement (`replaced_by`). Links and references to it are retargeted by a journaled rule, the revocation is visible in the change feed by `change_seq`, and the result does not depend on delivery order.
