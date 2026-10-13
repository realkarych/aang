# Web interface

A React application that the daemon serves as static files from the same origin (ADR-0011). `pnpm build` builds it with Vite into `dist/`; the `aang` package finds the directory via `import.meta.resolve('@aang/web')`, which points to `dist/index.html`. The subpaths `@aang/web/map-graph` and `@aang/web/map-layout` point to the sources of the map modules and are needed only by the package's own tests. The `web` code talks to the daemon only through the API and SSE and imports the response schemas from `contract`.

The interface has two screens: the chat list and the chat screen with a full-screen stage map and a collapsible chat panel (ADR-0015). State is everywhere shown by color together with an icon and a label (RFC §5).

## Shell

- **Sign-in.** The page opens only with the cookie from the one-time `aang open` link (ADR-0003). If any request gets 401 — the token was replaced or the cookie is stale — the application shows the "Signed out" screen with a hint about `aang open`.
- **Address.** The chat list is `/`, a chat is `/?run=<id>`, a selected stage is `/?run=<id>&stage=<id>`. The daemon serves `index.html` only at `/`, so the run is passed as a parameter, not as a path. Old addresses keep working: `/?view=usage` opens the list, `&mode=changes` is ignored.
- **The run page** takes the snapshot `GET /api/runs/:run` and subscribes to `GET /api/stream?run=` with `Last-Event-ID` equal to the snapshot's `change_seq`. The stream is read via `fetch`, not `EventSource`, because the very first request already carries `Last-Event-ID`.
  - The `run`, `facts`, `model`, `attention` and `chat` events are applied to the snapshot by `id`; removed agents are dropped. The position is the `id` of the last event.
  - A broken stream — reconnect from the last position with a pause of 0.25–4 s.
  - `reset` — the snapshot is re-read, the subscription starts from its `change_seq`.
  - A stream 404 — the snapshot is re-read. A snapshot 404 — "Run not found"; the snapshot is re-read once a second, and the page comes back when the run reappears.
  - **Lazy reads.** Facts and stored artifact versions that chat citations expand are read through `cached-read.ts`: one request per id, a failed read is retried no sooner than after 5 s, each read is limited to 10 s.

## Header

One thin row on every screen (`banner`):

- the `aang` wordmark, a link to the list;
- on a chat screen, "← Chats" and the run goal as `h1`: the goal `run.goal` (the human's first prompt, ADR-0006), else the observer's brief, else the runtime and start time;
- **"Waiting for you" chip** — on a chat screen, only while open attention items exist that the map cannot show. An item goes to the chip when its stage is `null`, unknown to the snapshot, not active (replaced, merged or split), or hidden by a view rule on the stage itself or on an ancestor. Items of stages that are on the map, including inside a collapsed stage, are counted on the map instead (see "Node card"). So every open item is either on the map or in the chip. The chip is a button: a caution glyph and the count are visible, "Waiting for you: " is visually hidden, so its accessible name is "Waiting for you: N". Hover or focus shows a tooltip (`role=tooltip`, also the button's description) that lists the items as "kind: text"; Escape hides it.
- **Health dot** — shown only while observation has a problem (D8). The problems are the lamps of `lamps.ts` that are not in the normal level, selected by `problemsOf`; "not observable" modes are never a problem. The dot is a button named "Observation problems: N", coloured by the worst problem; a click opens the region "Observation problems" that lists each problem lamp with its details and points to `aang status` for the rest. The following are **not** problems:
  - hooks that are not installed (`not_installed`) or whose installation was not checked; untrusted and disabled hooks, inactive hooks in sessions and double registration are problems;
  - an observer backend disabled with `cli_missing` when no listed run uses that vendor; it is a problem once a run of that vendor exists;
  - an observer disabled with `version_not_admitted` while its admission is `pending` and no backend failed admission; a failed or absent admission is a problem;
  - versions without full support that are only unverified; a `limited` version is a problem.

  Problem lamps: Link (no connection to the daemon, reconnecting, run not found, list or branches not updating), Observer (lagging, catch-up, retry, unavailable, disabled), Model (the map lags behind pending facts), Mode ("files only", "hooks only"), Hooks, Sources (lost source, read error, unknown layout, change after `prune`), Records (unrecognized records), Spool (over threshold, stopped, no lease, dropped files), Versions. On the list the lamps read the status and the runs, on a chat the run as well.

## Chat list (`/`)

`GET /api/runs`, re-read every 2 s, shown as `<ul aria-label="Chats">`, newest `last_event_at` first. Each row is one link to `/?run=<id>`:

- the goal (or "<runtime>, started <time>" when unknown), cut to one line, full text in the link title;
- the project folder: the last two segments of `RunSummary.cwd` (the root session's directory) in a monospace font, the full path in its title; absent when `cwd` is unknown;
- the execution state as icon and label;
- the waiting count, only when `attention.waiting_for_human` is above zero: a caution glyph and N visible, "Waiting for you: " visually hidden;
- the relative time of the last event ("just now", "5 minutes ago", "2 hours ago", or the date and time after a day), the absolute time in its title.

On a narrow screen (up to 760 px) the goal takes a full line and the rest wraps under it. An empty list explains the scope: `watch --all`, watched directories, or their absence. A failed list request shows a status line; earlier data stays on screen.

## Chat screen (`/?run=<id>[&stage=<id>]`)

The map fills `main.run-main`; the chat panel is an `aside` "Chat panel" on the right.

### Stage map

The "Stage map" section on the run page is built from the snapshot and the stream: stages, model links and observation objects. The map code (`stage-map.tsx`, React Flow and ELK) is loaded as a separate chunk, only when the run has stages. Before the observer's first response the section explains that the observer builds the stages.

- **Stages.** The map shows only active stages (`lifecycle: active`). If a parent was replaced, merged or split, the stage hangs on the nearest active ancestor. The node card is described below.
- **Nesting.** An expanded stage is a frame: its card on the left, substages on the right. A collapsed stage with substages is a "stacked" card. The arrow button next to the name expands and collapses the stage. Top-level stages are expanded by default.
- **Links.** A solid line with an arrow is a result dependency (`dependency`): the stage uses the result of another. A dashed line is time order without a causal link. It connects adjacent stages of one level if one ended before the other began and there is no third between them. A stage's time runs from the start of the first to the end of the last of its actions and delegated participants, including substages; while any of them is running, the stage has no end. A stage whose start and end coincide takes its place in this order like the others; two such stages at the very same moment are not ordered. No dashed line is drawn between stages with a dependency. A link to a hidden substage moves to its collapsed ancestor; there is no line only when both of its ends are collapsed into one card. A dependency of an expanded stage on its own substage, or of a substage on it, goes to the stage's card inside the frame; links with stages outside go to the frame.
- **Layout.** ELK `layered`: time flows left to right; on a narrow screen (up to 760 px), top to bottom. Each nesting level is laid out separately (see "Stable layout"). The card of an expanded stage is a separate ELK node in the first layer of its frame, so lines route around it the same way as around the other cards. Substages are held behind the card by ELK service edges that are not drawn: from the card to each substage that is preceded inside the frame by neither the card nor another substage, and to each substage on a cycle of links between the frame's substages (dependency against time order). If ELK cannot lay out the map with this constraint, the map is laid out without it and without service edges: the card may land in the same layer as the substages, but the whole map is visible. A line between stages of different levels passes through ports on the frame borders: ELK routes its segment inside each frame up to the port and between frames at the common level, and the map joins the segments into one line. Until the user has panned or zoomed the map, it fits entirely after every update and resize; the "Fit the map" button restores this behavior. A click on the map without movement does not pan it.
- **Stable ids.** A map node's `data-id` is the stage id from the API. A line's is `dependency:<from>:<to>` or `order:<from>:<to>` by the ids of the shown stages.
- **Node sizes.** A node gets its size and connection points from the ELK layout (`measured`, `handles`), so React Flow draws lines without measuring the DOM. Nodes are rebuilt on every new `view` from the stream; without ready sizes React Flow reset the measurement on every node replacement, and a node replaced before the redraw after measurement was left without connection points, and its lines were not drawn.

### Updates and selection

ADR-0008, "Map on updates": a new model version does not reset the selected stage or the reading position, the selection moves to the successor, the layout is not rebuilt wholesale.

- **Selection.** A click on a card, or Enter and Space on its name, selects the stage and reveals the chat panel narrowed to it; a repeat deselects. The name is a button with `aria-pressed`; the selected card has a solid outline. If the selected stage is hidden inside a collapsed one, a dashed outline is on the collapsed ancestor. There is one selection per page — the `stage` parameter of the run address, `/?run=<id>&stage=<id>` (`route.ts`): a user selection adds a history entry (`selectStage`), moving to a successor replaces the current one (`replaceStage`). So the selection survives a page reload and a snapshot re-read, and the map and the chat panel show the same stage: a stage link in a chat answer, "Whole run", "Ask about the whole run" and going back in history also change the highlight on the map. A stage from the address that is not in the snapshot (a stale link, the run was rebuilt) is not highlighted by the map and has no stage summary.
- **Updates.** The selection is a stage id, and it is resolved anew on every snapshot, so new model versions do not touch it.
- **Successor.** If the selected stage was replaced, merged or split, the selection moves to the first active successor by the `lifecycle` of the snapshot's stages, including across several revisions. The address is updated, and under the map header, in a `status` live region, the line "Stage "…" was replaced. Selection moved to successor "…"." appears; for a split stage, with the other successors. The line stays until "Hide" or until another stage is selected.
- **Stable layout.** ELK lays out each nesting level separately, with model order (`considerModelOrder` and `forceNodeModelOrder`): nodes already on the map keep their relative order, new ones go after them. Stage order is creation order, and a successor inherits the place of the earliest of its predecessors, so a replaced stage is swapped in the same place. ELK's hierarchical layout (`INCLUDE_CHILDREN`) does not fit this: in ELK 0.12 it reorders substages inside a frame on every addition, and order options on nested graphs crash the layout. That is why a line between different levels is assembled from segments through frame ports rather than routed by ELK across the whole hierarchy at once.
- **Reading position.** The page does not scroll when the map updates. If the user panned or zoomed the map, after a new layout the view shifts so that an anchor card stays at the same spot on the screen: the selected stage if it is at least partially visible, otherwise the card closest to the center. A card the user left partly beyond the edge is not brought back by an update. The anchor when the selection moves is the stage selected before the update: the selection keeps a chain from the user-selected stage to the current successor, and the successor takes the place of the chain link that was on the previous map. So a stage merged from several takes the place of the selected predecessor, not the first of them.
- **Area size.** If the map area changed size (the window became narrower or shorter, the map changed height, the direction changed on a narrow screen) and the anchor card that was visible ended up entirely beyond the edge, the view shifts exactly enough for it to become fully visible with a 16 px margin. Other size changes do not touch the view.
- **Readiness.** The map canvas (`role="application"`) holds `aria-busy="true"` while the shown ELK layout does not match the map view (a new snapshot, expanding or collapsing a stage, a direction change on a narrow screen) or while no view has been set for it yet: fitting or preserving the reading position, including the shift when the new layout changes the area height. `aria-busy="false"` means the nodes and the view belong to the same layout and will not move without a new snapshot, a user action or a window resize. The attribute is computed in the same render where the layout input changes, so right after "Expand" it is already `true`. Before the first view is set, the nodes are hidden (`data-placed="false"`), so the map does not flash at the origin.

### Node card

A card shows the stage name, execution (icon and label), the basis of that state (observed event, solver claim or aang interpretation; for an interpretation the tooltip has the rule or the observer call) and, when open items wait, a "waiting for you" badge: a caution glyph and the count, "Waiting for you: " visually hidden. An expanded stage counts its own items. A collapsed stage, and a stage collapsed by a filter, counts its own items and those of every substage it hides (the roll-up), so no open item disappears from the map. A stage collapsed by a filter also shows "collapsed by a filter" with its tree totals.

### Filter chips

Active view rules (from chat answers or the API) appear above the map as `ul` "Active filters": "Filter: <rule in words>" with a "Remove filter: …" button that calls `DELETE /api/runs/:run/view-rules/:id`. A failed removal is shown under the chips. Rules change only the view: hidden stages leave the map (their items go to the header chip), collapsed stages show totals, groups draw a dashed frame.

### Chat panel

- **Reveal on selection.** Selecting a stage on the map reveals the chat panel: on a wide screen (from 1100 px) a collapsed panel expands, on a narrow screen the panel opens as a sheet over the map. A new selection reveals it again even if the user collapsed it before. The "Collapse chat" / "Expand chat" button toggles the panel; on a wide screen the collapsed state is kept in `localStorage` (`aang:chat-collapsed`), and a refused storage only loses the memory.
- **Stage summary.** With a stage selected, the top of the panel is the region "Selected stage": the stage name, execution and basis, the stage summary, and the stage's open items as "Waiting for you". "Whole run" clears the selection.
- **Question.** The "Question" field and the "Ask" button (or Ctrl/Cmd+Enter) send `POST /api/runs/:run/chat`, scoped to the selected stage or to the whole run; "Ask about the whole run" clears the selection. If the question was not sent, the reason stays under the field with the text.
- **History.** `GET /api/runs/:run/chat` after every snapshot read and the stream's `chat` events; reading it delays neither the map nor the stream; a failure is retried once a second.
- **Answer.** Text, "not enough data", "some citations were unconfirmed and removed", the map version label and its staleness, and citations: a stage link selects the stage (and a replaced one passes to its successor); an attention item, an action, a fact and an artifact version expand in place, read lazily via `GET /api/facts/:id` and `GET /api/artifact-versions/:id`. An answer that applied a view rule says so; the rule then shows as a filter chip.

### Narrow layout

Below 1100 px the chat panel is a sheet over the map, closed until a stage is selected or the toggle is pressed. Below 760 px the map lays out top to bottom.

## Removed by ADR-0015

The status strip and its lamp row, the usage page, the run facts, the trace of sessions and agents, the plan facts, the attention zone with marks and history, the stage inspector, "Since last review" and the changes mode, and the view-rule list. The daemon keeps serving their endpoints; `aang status` and `aang usage` remain in the CLI.

## Limitations of the current version

- The daemon does not yet have `status` events in the stream or a stream without `run` (G.5). So the status and the run list are re-read every 2 s.
- The client learns of a database replacement only via a stream `reset` or the run disappearing. A database replaced by another whose journal is not shorter than the client's position causes neither a reset nor a new generation.

## Verification

E2E in `e2e/`:

- `shell.test.ts` — E2E 9 for Claude and Codex through the health dot; the chat list row (goal, project folder with the full path in its title, state, relative time, no table, newest first); the live stream and `reset` after a database replacement; a failing list request; a Claude-only install without a health dot; an unadmitted CLI version, unknown records, a lost source and an overfull spool in the health dot; the empty list.
- `attention-badges.test.ts` — the waiting badge on a card and its roll-up into a collapsed stage, an item of a hidden stage moving to the header chip and back, a stage-less question in the header chip (hover, focus, Escape) and as "Waiting for you: 1" in the list row, E2E 15 for Claude and Codex and the attention part of E2E 3.
- `stage-focus.test.ts` — a click on a stage shows its summary and narrows the chat; a stage link opened directly; "Whole run".
- `layout.test.ts` — the run screen is the map and the chat panel only; the collapsed panel after a reload; refused storage; the narrow sheet; old usage and changes links.
- `chat.test.ts` — E2E 5 on Claude and Codex with filter chips, E2E 18, every chat state, a failing history read, and the interface view rules.
- `map.test.ts` — the map part of E2E 1 and E2E 14.
- `codex.test.ts` — E2E 7 and E2E 8 on R.4 Codex records; `restart.test.ts` — E2E 6; `access.test.ts` — E2E 13; `runs.test.ts` — `/api/runs` and `RunSummary.cwd`; `support-matrix.test.ts` and `surfaces.test.ts` — the surface variants of E2E 1.

Samples are played back with record times shifted to the moment of playback. E2E 14 runs on all three OSes: the fake `claude` works as the observer CLI on Windows too (`fakeClaude.path`, see `e2e/README.md`); the observer-based tests of the map part of E2E 1 are still skipped on Windows. The Vitest test `test/map-layout.test.ts` verifies the layout when ELK fails, which does not reproduce on real maps: an ELK that rejects the layer constraint is substituted at the external boundary, and the map is laid out entirely without the constraint; if ELK fails even without it, the reason reaches the map section. `web` coverage is Chromium JS coverage from the `page` fixture, which `c8` merges with the daemon coverage via the build's source map.
