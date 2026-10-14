# ADR-0015: UI simplification

Status: accepted (owner, 2026-10-14)

## Context

The run screen shows a status strip, a facts header, an attention zone, the map, chat with a view-rules list, trace, plan history and "Since last review"; a stage inspector and a usage page sit beside it. The owner wants a chat list, a full-screen stage map and a collapsible chat panel only.

Basis: the design spec `docs/superpowers/specs/2026-10-12-ui-simplification-design.md`, decisions D1–D11 agreed with the owner in conversation on 2026-10-12.

## Decision

1. Screens: chat list (`/`) and chat (`/?run=<id>[&stage=<id>]`). Usage pages, `mode=changes` and the stage inspector are removed from the UI.
2. Map nodes stay observer stages. A card shows name, execution state, basis and an attention badge. The human-decision axis, origin, counts and participants leave the card.
3. The chat panel is on the right of the map and collapses to a rail. Selecting a stage narrows the chat and shows a stage summary at its top.
4. Narrowing the map to a goal uses the existing chat view rules. Active rules are chips above the map; ✕ revokes the rule.
5. Attention: a badge on the stage, a "waiting for you" chip in the header for the items the map cannot show, a count in the chat list. The chip holds an open item whose stage is absent, unknown to the snapshot, inactive (replaced, merged or split) or hidden by a view rule on the stage or an ancestor. A collapsed card, whether collapsed by hand or by a filter, rolls up the open items of the substages it hides into its badge, and the stage summary of a selected collapsed stage lists them with the substage name. The chat list row counts every open item of the run (`attention.open`), the same items as the badges and the chip together, not only the items the runtime waits on. No attention zone; no viewed or dismiss controls.
6. Observation health: one dot in the header, only when a non-coverage lamp is not normal; the popover lists the problems. `aang status` keeps the details. The dot ignores these signals, which stay in `aang status` only: hooks that are `not_installed`; `cli_missing` for a vendor with no runs; an observer whose admission is still pending; unverified engine versions; coverage, including "Not observable" modes.
7. Trace, plan history, "Since last review" and the usage page are removed from the UI. `aang usage` stays.
8. `RunSummary` gains `cwd`: the root session's working directory, shown as the project folder in the chat list.
9. The backend, API, tables and observer are unchanged. Endpoints used only by removed views stay served.
10. The support matrix drops the `after_iteration` (E2E 4) column: its E2E variants went with "Since last review". A row's user scenarios are E2E 1 only, and the 18 `passed` marks without a test behind them leave the matrix (owner, 2026-10-14).

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
- Supersedes in ADR-0010: the display of the unverified-version and unrecognized-records signals in the status bar. Unrecognized records light the health dot and are listed in its popover; an unverified version never lights the dot and appears only in `aang status`.
- Supersedes in ADR-0004: the persistent "Not observable" notice for Cowork and cloud modes in the status bar. Coverage does not light the health dot; "Not observable" stays in `/api/status` and `aang status`.
- E2E scenarios of removed views are deleted; the RFC scenario coverage table in `docs/plan/mvp.md` is rewritten.
- Supersedes in ADR-0012: the rows of the mandatory E2E table that go through the removed views (inspector, attention zone, usage panel, "Since last review" diff: E2E 2, 4, 11, 16, 17 and the inspector part of E2E 1). They are replaced by the scenarios listed in Stage 4 of `docs/plan/mvp.md`; E2E 10 and 12 are covered without E2E by the functional tests named in its coverage table. E2E 3 (its attention part) and E2E 15 stay as E2E in `e2e/attention-badges.test.ts`, asserting badges and the header chip instead of the attention zone.
- View rules on agents, actions or detail levels stay valid, but the map shows stages only, so they change nothing on it; their chip and the chat note say "does not change the stage map". The chat prompt steers map requests to stage selectors.
- RFC §2 "returning to results" loses its dedicated mode; the chat answers "what changed" questions.
