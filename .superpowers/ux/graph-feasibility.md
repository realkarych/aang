# Is a graph view a good idea for aang? — evidence and recommendation

Date: 2026-09-11. Data: the real 20-node `.aang/map.json` (8 decisions, 6 tacit, 6 open) plus
synthetic 50- and 100-node maps generated with the edge density measured on the real one. Layouts were
run headlessly (d3-force 3.x, 400 ticks, deterministic) and as a deterministic time × kind layout; the
renders were inspected in a 1400×900 browser viewport. Everything here is reproducible with
`node gen.mjs` in this directory (needs `d3-force` on the import path at the top of the script).

## Recommendation

**Do not build a graph view. Build typed edges into the schema and show them in the list.**

- There is no node count at which a graph beats the list. Its best case is the real 20-node map, where a
  force layout is legible but not more informative than the list (13 edges, 5 nodes with no edge at all,
  one crossing) — and it already overprints the hub's label and loses every position on the next run.
- The force-directed graph becomes unreadable at **~40–50 nodes** (labels collide first, then edges run
  through labels). The deterministic time-layered graph keeps labels apart at any size but its edges become a
  mesh at **~50 nodes** (161 crossings; 889 at 100).
- The stability objection is **confirmed** for force layouts: adding 3 nodes to the real map moved all 20
  existing nodes, median 205 px, none within 20 px of where it was; warm-starting from old positions does not
  fix it (median 133 px); pinning old positions fixes it only with a fixed scale, and then the map rots
  (2.7× more collisions than a fresh layout by 100 nodes). The only layout that keeps positions is one where
  position is a pure function of the node's own data (turn, kind) at a fixed scale — i.e. a timeline, not a
  graph — and that is the layout whose edges are least readable.
- The relationships themselves are worth having. The model already writes them in prose (`o1.why:
  «Осиротело решением d6»`) and the reader has to chase them by hand. A list row that names its neighbours
  as chips (`→ d6 orphaned by`), a detail pane that lists the neighbourhood, and related rows highlighted
  on selection deliver the relationship-reading benefit with zero layout instability and zero label
  collisions at every size tested. A gutter of arcs for *all* edges is pleasant at 20, decorative at 50,
  noise at 100; arcs for the *selected node only* stay readable at any size because a node's arc count is
  its degree (≤ 5 on the real map).

## 1. What edges would exist

Every relationship in the real map, found by reading each node's `why` / `consequence` / `cites`
(`edges.json` has the evidence line for each):

| tier | count | what it means | examples |
|---|---|---|---|
| strong | 5 | typed field, or the other node named by id in prose | d3→d4 `superseded_by`; o1→d6 «Осиротело решением d6»; o6→d7 «Следствие d7»; t6→t1 «Расходится с t1»; d11→d5 «узел d5 цитировал…» |
| medium | 8 | referent unambiguous from the prose, id not written | t3→d2 (identical quote, turn 5); d6→d5 (d6 undoes d5's supervisory-control frame); d4→d6 («снимается … протухание»); o1→d2; t5→d7; d11→d7; o2→d6; o3→d6 |
| weak | 5 | plausible; a model would assert them inconsistently | t4→d6, o4→d2, o5→d2, t1~d1 (co-cited turn), t2→d6 |

- Edges per node: **0.25** (strong) / **0.65** (strong+medium — the density used below) / 0.90 (all).
- No node has more than **2** edges to earlier nodes (d6, o1, d11 have 2; nine nodes have 0).
- With strong+medium edges, **5 of 20 nodes are isolated** (d1, t2, t4, o4, o5). The graph has nothing to
  say about a quarter of the map; those nodes are just a scattered list.
- Degree is concentrated: d6 (the product decision) carries 5 of 26 edge-endpoints; d7 3; the rest ≤ 2.

**Growth is linear, not faster.** A new node attaches to the decision it follows from, supersedes, or
conflicts with — at most two, whatever the size of the map, because the IBIS grammar (a position answers one
question; an argument attaches to one position) forbids the pairwise cross-links that would make edge count
quadratic. So a session twice as long has **twice** the relationships (synthetic prefixes: 20 → 15 edges,
50 → 36, 100 → 76). What does grow faster than n is (a) **hub degree** — the same decision keeps collecting
consequences (synthetic max degree 5 → 10 → 20), and (b) **crossings in any planar drawing** — measured
below, ×4.7 for force and ×5.5 for layered when going from 50 to 100 nodes.

Synthesis method: nodes in time order (35 % share the previous node's turn, else +1–8 turns), kinds
40/30/30, each node attaches to 0/1/2 earlier nodes with probability 0.45/0.35/0.20 (the real
distribution), targets are decisions 93 % of the time with preferential attachment, ~1 supersession per 20
nodes. 50 and 100 are prefixes of the same synthetic session, so "50 → 100" is genuinely "the same session,
later". Caveat: preferential attachment makes hubs heavier than the real d6; this affects edge crossings,
not label collisions, so the label-collision numbers are conservative.

## 2. Readability by size (measured on the renders)

Label boxes: 12 px sans, truncated to 38 chars (≈250 px). Force: d3-force with collision radius covering
the label, then the drawing scaled to fit 1400×900. Layered: x = turn, y = kind lane (tacit / open /
decision), sub-rows so labels never overlap; straight edges.

| nodes / edges | layout | label collisions | edge crossings | edges through a foreign label | fit scale / width |
|---|---|---|---|---|---|
| 20 / 13 (real) | force | 4 | 1 | 10 | 1.0 |
| 20 / 13 | layered, fit to width | 0 | 4 | 13 | 1.0 |
| 20 / 13 | layered, 14 px/turn | 0 | 9 | 20 | 1018 px (0.7 screen) |
| 50 / 36 | force | 12 | 14 | 62 | 0.63 |
| 50 / 36 | layered, fit | 0 | 161 | 153 | 1.0 |
| 50 / 36 | layered, 14 px/turn | 0 | 136 | 93 | 2642 px (1.9 screens) |
| 100 / 76 | force | 61 | 66 | 263 | 0.47 |
| 100 / 76 | layered, fit | 0 | 889 | 516 | 1.0 |
| 100 / 76 | layered, 14 px/turn | 0 | 667 | 212 | 5078 px (3.6 screens) |
| 100 / 116 (all-tier density) | force | 98 | 245 | 401 | 0.50 |

What the screenshots show:

- **`shot-01-graph-20-force.png`** — legible. You can read "d6 is the hub", "d7 has a cluster", "t1–t6 are
  a pair". But the superseded d3's struck-through label lies directly across d6's label — the single most
  important node in the map is the one that got overprinted — and o5, t4, t2, o4, d1 float unattached in
  the corners. Compare `shot-00-real-viewer.png`: the list shows 6 of 20 nodes per screen with full text,
  no truncation.
- **`shot-02-graph-20-layered.png`** — labels clean; the time-shape of the session (tacit early, open late,
  decisions throughout) is visible and is the one thing this view says that the list does not. But the
  edges are 400 px lines cutting across lanes and through labels; reading "what is o1 attached to" means
  tracing a line 500 px diagonally.
- **`shot-03-graph-50-force.png`** — a hairball with three hub clusters. Labels overprint (o3/t14, d17/o5,
  d8/o8), labels are clipped at the right edge (d19, d16, d13), 19 nodes are unattached. Identifying a
  specific node requires hovering. **This is where the force graph stops working; what fails first is
  labels, not crossings** (14 crossings, 62 edges through labels).
- **`shot-04-graph-100-force.png`** — unreadable. The hub cluster's labels are illegible; everything is
  compressed to 47 %.
- **`shot-05-graph-100-layered.png`** — every label is still readable (the staircase sub-rows work), but
  the edges are a mesh (889 crossings) and the decision lane runs out of vertical room. **Layered fails on
  edges, at ~50.**

Bottom line: the force graph is readable to roughly **25–30 nodes** and broken by **50**; the time-layered
graph keeps its labels at any size but loses its edges by **50**. The tool's own README describes maps
that grow across repeated `/aang` runs in the same session; 50 is a long afternoon.

## 3. The stability objection, tested directly

Three nodes a later session would add (a decision refining d6, an open consequence of it, a tacit
parameter of it), then the layout re-run. Displacement of the **20 original nodes**, in screen pixels
after fitting to the viewport (what the user sees). "Pair order kept" = share of node pairs whose
left/right and above/below relation survived.

| 20 → 23 | median px | mean px | max px | within 20 px | pair order kept | same quadrant |
|---|---|---|---|---|---|---|
| force, re-run from scratch | **205** | 217 | 477 | **0 / 20** | 68 % | 11 / 20 |
| force, warm-started from old positions | 133 | 196 | 481 | 0 / 20 | 69 % | 12 / 20 |
| force, old nodes pinned | 0 | 0 | 0 | 20 / 20 | 100 % | 20 / 20 |
| layered, fit to width | 80 | 69 | 113 | 4 / 20 | 92 % | 19 / 20 |
| layered, fixed 14 px/turn | **0** | 0 | 0 | **20 / 20** | 100 % | 20 / 20 |

The same at 50 → 53 and 100 → 103:

| | force fresh | force warm | force pinned | layered fit | layered fixed |
|---|---|---|---|---|---|
| 50 → 53, median px / within 20 px | 311 / 0 | 284 / 0 | 165 / 0 | 14 / 32 | 0 / 50 |
| 100 → 103, median px / within 20 px | 171 / 1 | 93 / 10 | 219 / 0 | 10 / 97 | 0 / 100 |

- **`shot-06-stability-force-fresh.png`** (dashed = old position, red = where it went): every node moved.
  o5 crossed from bottom-right to top-right; the t1/t6 pair migrated from the left edge; d1 slid along the
  bottom; the hub d6 moved 100+ px. Nothing is where it was. Warm-starting (`stability-20+3-force-warm.html`)
  looks the same — d3-force re-equilibrates the whole system when a new node pushes on a hub.
- **Pinning works only at a fixed scale.** At 20 → 23 the pinned run shows zero movement because the
  drawing still fit the viewport at scale 1. At 50 and 100 the three new nodes extended the bounding box,
  the fit rescaled, and every "pinned" node moved 165–219 px on screen. So a stable graph also needs
  pan/zoom instead of fit-to-view, and then:
- **Pinned growth rots.** Growing 20 → 100 three nodes at a time with every earlier session's nodes pinned
  (`incremental-pinned-100.html`, `shot-11-incremental-pinned-100.png`) reaches 100 nodes with **176 label
  collisions and 162 crossings vs 61 and 66 for a fresh layout** — the new nodes are jammed into whatever
  gaps remain. The pinned 100 is the worst image in the set. This is the "paper strips" point made
  quantitatively: you can have stable positions or a tidy layout, not both, and the tidy one is the
  default in every graph library.
- **`shot-07-stability-layered-fixed.png`**: zero displacement — no ghost markers at all; the three new
  nodes simply appear at the right end of their lanes. This layout defeats the objection because a node's
  position is its turn and its kind, not a negotiation with its neighbours. It costs horizontal scrolling
  (3.6 screens at 100 nodes) and, as §2 shows, its edges are the part that is unreadable. Fit-to-width
  instead of fixed scale re-introduces a proportional slide (69 px mean at 20, shrinking as the map
  grows), which is tolerable but not free.

Verdict: the objection is right for anything a user would recognise as "a graph". It is defeated only by
turning the graph into a timeline, at which point the edges are the problem.

## 4. The honest alternative: the list, carrying the edges

Mocked as the existing spine with three additions: a **gutter** of arcs joining related rows, **chips**
in every row naming its neighbours and the relation (`→ d6 orphaned by`, `← t5 parameter of`), and
**selection highlighting** (the selected row's arcs go blue and its neighbours' rows tint). Row height
46 px; labels full-width, never truncated to a graph label.

| rows / edges | order | arc crossings | mean arc span (rows) | arcs longer than one screen | label collisions | height |
|---|---|---|---|---|---|---|
| 20 / 13 | spine (tacit, open, decision; newest first) | 17 | 5.1 | 0 | 0 | 1.0 screen |
| 20 / 13 | time | 3 | 4.4 | 0 | 0 | 1.0 screen |
| 50 / 36 | spine | 218 | 22.6 | 22 | 0 | 2.6 screens |
| 50 / 36 | time | 140 | 16.3 | 15 | 0 | 2.6 screens |
| 100 / 76 | spine | 1083 | 46.4 | 59 | 0 | 5.1 screens |
| 100 / 76 | time | 774 | 38.8 | 52 | 0 | 5.1 screens |

Stability on +3 nodes: time order — **0 rows move**; spine order — the 20 rows shift down by 1, 2 or 3
rows (46 px each) because new items enter at the top of their group; relative order kept 100 % in both.
Movement is uniform, predictable and in one axis — the opposite of a force layout's shuffle.

- **`shot-08-alt-list-20-spine-sel.png`** — d6 selected: its five arcs and five neighbour rows light up;
  the chips read the relation in words, so nothing has to be traced. The whole real map fits one screen
  with full question text. The un-selected arcs are a faint tangle in the top-left (17 crossings) — visible
  shape, no information lost because they collide with nothing.
- **`shot-09-alt-list-20-time.png`** — in time order the session reads as a story top-to-bottom, every arc
  points backward to an earlier row ("follows from"), the d3→d4 supersession is a short red arc, only
  3 crossings. Time order gives up the spine's grouping (R3 wants tacit and open first), so I would keep
  the spine order and offer time order as a sort, not replace it.
- **`shot-10-alt-list-100-time.png`, `shot-10b-…-full.jpeg`** — at 100 rows the gutter degenerates into a
  bundle hugging the left edge (52 arcs longer than a screen) — as a whole-map picture it has stopped
  saying anything. The **chips do not degrade**: every row still states its neighbours; the busiest row
  (12+ neighbours) overflows and needs wrapping or "+8 more", but stays readable. Selected-node arcs are
  always ≤ that node's degree, so selection highlighting works at any size.

Compared with the graph on the same data: at 20 the two are roughly equal in what they let you read
(the list is better on text, the graph marginally better on "shape at a glance"); at 50 the list is
strictly better (0 collisions vs 12, chips vs hairball); at 100 the graph is unusable and the list is a
long list with working chips — the same list the tool has today plus relations.

## 5. What the tool should do

1. **Schema**: add typed edges. Suggested shape, one field per node so hand-editing stays trivial:
   `"relates": [{"to": "d6", "rel": "orphaned_by"}]`, with a closed vocabulary — `supersedes` (already
   there as `superseded_by`; keep it and treat it as an edge), `consequence_of`, `orphaned_by`,
   `derives_from`, `parameter_of`, `refines`, `revises`, `conflicts_with`, `questions`. The validator
   checks the target id exists and the vocabulary; IBIS rules bound the fan-out (a node points at ≤ 2–3
   earlier nodes). The prompt asks the model to name the id it already names in prose.
2. **Spine row**: neighbour chips (`→ d6 orphaned by`), clickable, and "ни с чем не связано" when empty —
   the isolated nodes are informative too (a decision nothing depends on).
3. **Detail pane**: a "Связи" section listing the neighbourhood with the relation and the neighbour's
   question; clicking navigates. This is the per-node neighbourhood view — a graph of ≤ 6 nodes, and it
   never needs a layout.
4. **Selection highlight**: tint neighbour rows; optionally draw arcs in a gutter **for the selected node
   only**. Do not draw all arcs by default past ~30 rows.
5. **Do not persist positions, do not add a canvas, do not add a graph library.** Nothing in the
   measurements rewards it at any size, and the one stable layout (time × kind at fixed scale) is
   already the list sorted by turn, with worse edges.

If the user still wants a picture, the least-bad one is the time × kind timeline at fixed scale
(`graph-20-layered-fixed.html`) with edges drawn only for the selected node — but it should be understood as
a sort order of the list rendered sideways, not as a graph.

## Files kept in this directory

- `edges.json` — the hand-derived edge list with evidence per edge.
- `gen.mjs` — generator, both layouts, metrics, renders (throwaway; needs d3-force).
- `metrics.json` — every number above, as emitted.
- Graph mockups: `graph-{20,50,100}-force.html`, `graph-{20,50,100}-layered.html`,
  `graph-{20,50,100}-layered-fixed.html`, `graph-100-dense-force.html`, `graph-20-force-alltiers.html`.
- Stability: `stability-20+3-force-{fresh,warm,pinned}.html`, `stability-20+3-layered-{fit,fixed}.html`,
  `incremental-pinned-{50,100}.html`.
- Alternative: `alt-list-{20,50,100}-{spine,time}.html`, `alt-list-20-spine-sel.html` (d6 selected).
- Screenshots `shot-00` … `shot-11` as referenced above; `shot-00-real-viewer.png` is the current viewer
  on the same map, for comparison.

Servers used for viewing were started on 8791/8792 and are stopped.
