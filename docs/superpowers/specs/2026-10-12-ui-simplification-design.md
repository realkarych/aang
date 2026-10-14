# UI simplification: chat list → stage map + collapsible chat

Date: 2026-10-12. Status: approved by the owner in conversation; formalized by ADR-0015.

## Goal

The web UI shows too much around the map: a status strip, a run header with about twelve facts, the attention zone above the map, and trace, plan history, "Since last review" and view rules below it, plus a stage inspector and a usage page. The owner wants three things only:

1. a list of chats (runs);
2. inside a chat, the stage map over the whole screen;
3. a minimal chat panel on the right that can be collapsed to the edge, used to ask about the map and to refocus the map on a goal.

## Owner decisions

| # | Question | Decision |
|---|---|---|
| D1 | What the chat panel is for | Ask questions about the map and narrow the map to a specific goal |
| D2 | What a map node is | Stages from the observer, as today; no backend or observer change |
| D3 | How "narrow the map to a goal" works | A filter over the existing map: the existing chat `view_rule` (hide, collapse, group, detail), undone in one click |
| D4 | Depth | UI only. The backend, API, tables, observer, Codex, Windows, OTel and tools stay. Exception: D9 |
| D5 | Attention (questions, permissions, blockers) | A "waiting for you" badge on the map node and a count in the chat list; no attention zone |
| D6 | Click on a node | Narrows the chat to the stage and shows a 2–3 line stage summary at the top of the chat panel; no inspector |
| D7 | Node card | Name, execution state (colour plus icon), basis icon (observed / claimed by the agent / catacomb's interpretation), attention badge |
| D8 | Observation health | A single dot in the header only while something is wrong; the text on hover or click; details stay in `catacomb status` |
| D9 | Chat list row | Compact: goal, project folder, state, "waiting for you: N", relative time; newest first. Adds `cwd` to `RunSummary` |
| D10 | Trace, "Since last review", PlanFacts, usage page | All removed from the UI. `catacomb usage` stays in the CLI |
| D11 | Formalization | ADR-0015 plus an amendment of RFC §4–§5 and of the coverage table in `docs/plan/mvp.md` |

## Screens

### Header (every screen)

One thin row: the `catacomb` wordmark. On a chat screen also "← Chats" and the run goal. On the right, the health dot (D8), rendered only when a problem exists. The current `Masthead` "Usage" link, `StatusStrip` and the run `Facts` list are removed.

The health dot reuses the problem detection in `lamps.ts`: it is shown when any lamp is in a non-ok state; hover or click opens a small popover listing the problem lamps with their existing text. The lamp row and its expandable details panel are removed.

### Chat list (`/`)

`run-list.tsx` becomes a list of compact rows, sorted by `last_event_at` descending:

- goal (or a placeholder when the goal is unknown);
- project folder: the last two path segments of `RunSummary.cwd`, full path in `title`;
- execution state as icon plus label;
- "waiting for you: N" from `attention.waiting_for_human`, only when N > 0;
- relative time of `last_event_at`.

The whole row is the link to `/?run=<id>`. The existing empty state (how to `watch` a directory) stays.

### Chat screen (`/?run=<id>[&stage=<id>]`)

Layout: header, then a two-column body filling the viewport height. Left: the map. Right: the chat panel.

**Map.** `MapSection`/`StageMap` fill the left column. Nesting, expand/collapse, dependency and order edges, reading-position preservation and lineage succession stay as they are. Before the first observer response the map area shows the existing "The observer builds the stages…" placeholder. There is no other content in the run page: `AttentionZone`, `Trace`, `PlanFacts`, `SinceLastView`/`ChangesView`, `ViewRules` and the `Facts` header are removed.

**Node card** (`map-node.tsx`), D7:

- name;
- execution state: colour plus icon plus accessible label (RFC §5: colour is always paired with a label or icon);
- basis icon with a tooltip: observed, claimed by the agent, interpreted by catacomb;
- attention badge: the number of open attention items whose `stage` is this stage; hidden when zero;
- the existing expand toggle for stages with substages.

Removed from the card: the human-decision axis, origin, counts of substages and actions, participants.

**Attention without a stage.** Open attention items with `stage: null` are shown as a "waiting for you: N" chip next to the run goal in the header; hovering it lists their texts. Viewed/dismiss controls are removed; items close by runtime resolution as today.

**Chat panel** (`chat-panel.tsx`), right column:

- Expanded width about 380 px; collapsed to a narrow rail with an icon button. The collapsed state is kept in `localStorage` per browser (wrapped in try/catch; default expanded).
- Below 1100 px the panel is an overlay sheet over the map, closed by default, opened from a floating button.
- Scope: the whole run, or the selected stage. Selecting a stage on the map (`&stage=`) narrows the chat as it does today for the inspector-local chat.
- Stage summary (D6): when a stage is selected, the top of the panel shows its name, execution state, basis and the stage summary text (2–3 lines, clamped), the open attention texts for the stage, and a "✕ whole run" control that clears `&stage=`.
- History, citations, "insufficient data", "unconfirmed citations" and the "as of map version V" label stay. Citation targets that pointed into removed views (inspector sections, trace steps) render as plain text references instead of links.

**Goal filter** (D3). The chat's existing `view_rule` output stays the mechanism. Active view rules are shown as chips above the map: "Filter: <rule label> ✕". The ✕ calls the existing `DELETE /api/runs/:run/view-rules/:id`. This replaces the `ViewRules` list. The chat system prompt is checked against requests such as "show only what concerns X"; if the observer does not reliably produce a rule for them, the prompt is adjusted in `packages/observer/src/prompt.ts` (allowed under D4 as part of making the chat feature work, not a model change).

### Removed screens and routes

- Usage pages (`/?view=usage…`) and the header link. `route.ts` drops `view` and `mode`.
- `&mode=changes` and the "Since last review" tabs.
- Stage inspector (`&stage=` now only selects and focuses the chat).

Old URLs with removed parameters open the nearest remaining screen and ignore the parameter.

## Code changes

### Backend (D9 only)

- `packages/contract/src/api.ts`: `RunSummary` gets `cwd: text.nullable()`.
- `packages/engine/src/read/summary.ts`: `cwd` is the root session's `cwd` (`sessions.find(s => s.id === run.root_session)?.cwd ?? null`).
- Any fixtures, snapshots or tests asserting the exact `RunSummary` shape are updated.

No endpoint, table, observer behaviour or CLI command is removed. Endpoints that only the removed views called (`/changes`, `/viewed`, attention viewed/dismiss, `/api/admin/usage`, `/api/raw/:seq`, `/api/runs/:run/stages/:stage`) stay served and unused by the web.

### Web

Removed (with their CSS): `status-strip.tsx`, the lamp row part of `lamps.ts`, `attention-zone.tsx`, `stage-inspector.tsx`, `stage-history.tsx`, `stage-artifacts.tsx`, `stage-criteria.tsx`, `grounds.tsx`, `change-grounds.tsx`, `fact-excerpt.ts`, `since.tsx`, `changes.tsx`, `use-changes.ts`, `trace.tsx`, `action-input.ts`, `plan-facts.tsx`, `usage-page.tsx`, `view-rules.tsx`, `inspector.css`, `since.css`, `usage.css`, and the `Facts` part of `run-page.tsx`. Shared helpers left without users are deleted.

New: health dot with popover, collapsible chat panel shell, stage summary block, filter chips, header attention chip.

Rewritten: `app.tsx` (screens, masthead), `run-page.tsx` (two-column layout), `run-list.tsx` (compact rows), `map-node.tsx` (card), `route.ts`, `packages/web/README.md` (screen spec).

### Tests (ADR-0012: E2E first)

Deleted: `attention-zone.test.ts`, `inspector.test.ts`, `inspector-selection.test.ts`, `since-last-view.test.ts`, `since-last-view-variants.test.ts`, `usage.test.ts`, `facts-view.test.ts`.

Rewritten: `shell.test.ts` (header, health dot instead of lamps, list rows), `map.test.ts` (card contents, selection focuses chat), `chat.test.ts` (panel, collapse, filter chips), `surfaces.test.ts` (no inspector grounds), `restart.test.ts` (no view mark), `codex.test.ts` (no trace), `e2e/screens.ts` locators.

New scenarios:

- chat list row shows goal, folder, state, waiting count, relative time;
- chat panel collapse persists across reload;
- clicking a node shows the stage summary and narrows chat scope; "✕ whole run" clears it;
- a chat answer with a view rule shows a filter chip; ✕ removes the rule and restores the map;
- attention badge on a node and the header chip for stage-less items;
- health dot absent when healthy, present with text on a forced problem;
- narrow viewport: chat panel as overlay sheet.

Coverage stays at the ADR-0012 bar for the remaining UI.

## Documents

- `docs/adr/0015-ui-simplification.md`: decisions D1–D11; supersedes the attention zone, "Since last view", view-rules list and status-bar clauses of ADR-0008, the UI part of ADR-0009 and the status-bar display clauses of ADR-0010. Needs owner approval before implementation PRs merge.
- `rfc.md` §4–§5: interface list becomes map plus chat; attention as badges; inspector, changes mode and attention zone removed from MVP.
- `docs/plan/mvp.md`: the RFC scenario coverage table and the H.* items updated; a new stage for this work.

## Delivery

A stack of PRs per AGENTS.md, each with a Codex cross-review:

1. ADR-0015, RFC and plan amendments.
2. Layout: header without strip and facts, two-column run page, collapsible chat panel; remove trace, plan facts, since/changes, usage.
3. Remove the inspector; node click focuses the chat with the stage summary.
4. Node card and attention badges; remove the attention zone; filter chips replace the view-rules list.
5. Health dot; remove the status strip and lamp row.
6. `RunSummary.cwd` and the compact chat list.

## Out of scope

Backend pruning (Codex, OTel, Windows, usage ledgers, criteria, artifacts, tools), a new "decision" node type, observer lenses that rebuild the map per goal, writing into the agent session.
