# ADR-0015: UI simplification

Status: proposed (owner approval required)

## Context

The run screen shows a status strip, a facts header, an attention zone, the map, chat with a view-rules list, trace, plan history and "Since last review"; a stage inspector and a usage page sit beside it. The owner wants a chat list, a full-screen stage map and a collapsible chat panel only.

Basis: the design spec `docs/superpowers/specs/2026-10-12-ui-simplification-design.md`, decisions D1–D11 agreed with the owner in conversation on 2026-10-12.

## Decision

1. Screens: chat list (`/`) and chat (`/?run=<id>[&stage=<id>]`). Usage pages, `mode=changes` and the stage inspector are removed from the UI.
2. Map nodes stay observer stages. A card shows name, execution state, basis and an attention badge. The human-decision axis, origin, counts and participants leave the card.
3. The chat panel is on the right of the map and collapses to a rail. Selecting a stage narrows the chat and shows a stage summary at its top.
4. Narrowing the map to a goal uses the existing chat view rules. Active rules are chips above the map; ✕ revokes the rule.
5. Attention: a badge on the stage, a "waiting for you" chip in the header for items without a stage, a count in the chat list. No attention zone; no viewed or dismiss controls.
6. Observation health: one dot in the header, only when a non-coverage lamp is not normal; the popover lists the problems. `aang status` keeps the details.
7. Trace, plan history, "Since last review" and the usage page are removed from the UI. `aang usage` stays.
8. `RunSummary` gains `cwd`: the root session's working directory, shown as the project folder in the chat list.
9. The backend, API, tables and observer are unchanged. Endpoints used only by removed views stay served.

| Spec decision | Decision here |
| --- | --- |
| D1 chat panel purpose | 3, 4 |
| D2 map nodes are observer stages | 2 |
| D3 goal filter through view rules | 4 |
| D4 UI only | 9 |
| D5 attention badges and counts | 5 |
| D6 node click narrows the chat | 1, 3 |
| D7 node card | 2 |
| D8 health dot | 6 |
| D9 chat list row and `RunSummary.cwd` | 8 |
| D10 trace, "Since last review", plan facts, usage removed | 1, 7 |
| D11 formalization | this ADR and the amendments of `rfc.md` and `docs/plan/mvp.md` |

## Consequences

- Supersedes in ADR-0008: the attention zone, "Since last view", the view-rules list and the status-bar clauses. Chat with citations, map version binding and view rules as a mechanism stay.
- Supersedes in ADR-0009: the usage UI. The three ledgers and `aang usage` stay.
- Supersedes in ADR-0010: the display of the unverified-version and unrecognized-records signals in the status bar; they move into the health dot popover.
- E2E scenarios of removed views are deleted; the RFC scenario coverage table in `docs/plan/mvp.md` is rewritten.
- Supersedes in ADR-0012: the rows of the mandatory E2E table that go through the removed views (inspector, attention zone, usage panel, "Since last review" diff: E2E 2, 3, 4, 11, 15, 16, 17 and the inspector part of E2E 1). They are replaced by the scenarios listed in Stage 4 of `docs/plan/mvp.md`; E2E 10 and 12 are covered without E2E by the functional tests named in its coverage table.
- RFC §2 "returning to results" loses its dedicated mode; the chat answers "what changed" questions.
