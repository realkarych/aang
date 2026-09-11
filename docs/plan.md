# aang v1 — Implementation Plan

Spec: `docs/spec.md` (binding authority — read it first).

## Global Constraints

- **Python 3.9.6 system interpreter, stdlib only.** No pip, no venv, no third-party imports.
  No 3.10+ syntax: no `match`, no `X | None` unions, no runtime-evaluated builtin generics
  (`dict[str,int]`). Use `typing.Optional` / `Dict` / `List`, or type comments.
- **No network** anywhere. The server binds `127.0.0.1` only, never `0.0.0.0`, and rejects any
  request whose `Host` is not `127.0.0.1` / `localhost` / `[::1]` (DNS-rebinding defense — a session
  transcript is the most private thing on the machine).
- Package root `src/aang/`. Tests in `tests/`, run from the repo root with
  `python3 -m unittest discover -s tests -t .`.
- **No test may read the user's real `~/.claude`.** Fixtures live in `tests/fixtures/`.
- Every module must import and run when no transcript and no map exist. Missing data is a normal
  state, never an exception.
- User-facing strings are Russian; identifiers, keys and code comments are English.

## The map format (settled — all four tasks depend on it, do not redesign it)

`.aang/map.json`:

```json
{
  "version": 1,
  "session_id": "7df13757-…",
  "generated_at": "2026-09-11T12:00:00Z",
  "title": "aang · пайплайн оценки",
  "nodes": [
    {
      "id": "d1",
      "kind": "decision" | "tacit" | "open",
      "status": "accepted" | "superseded" | "proposed",
      "superseded_by": "d3" | null,
      "question": "Чем мерить качество прогона?",
      "decision": "pass@1 на отложенном наборе",
      "why": "k>1 маскирует нестабильность промпта",
      "against": ["Дисперсия выше, нужен набор существеннее"],
      "consequence": "500 примеров вместо 100, прогон дорожает втрое",
      "cites": [{"turn": 47, "role": "user", "quote": "давай pass@1"}],
      "hand_edited": false
    }
  ]
}
```

- `kind` `"open"` uses `question` and `why` and leaves `decision` empty — it is a question with no
  answer, or a consequence nobody addressed.
- `kind` `"tacit"` is a decision nobody made on purpose; `why` says where the value came from.
- `cites` is never empty for `decision` and `tacit`. `open` may cite the decision that orphaned it.
- `hand_edited: true` marks a node a human wrote or corrected — regeneration must preserve it.

## Task 1 — Schema and transcript citations

Create `src/aang/schema.py` and `src/aang/transcript.py`.

`schema.py`:
- `validate(map_dict)` → list of error strings, empty when valid. Checks: version, required fields
  per `kind`, `status` vocabulary, `superseded_by` points at an existing node id, no node supersedes
  itself, no cycles in the supersede chain, `cites` non-empty where required, ids unique.
- `normalize(map_dict)` → the same map with defaults filled (`hand_edited: false`,
  `superseded_by: null`, empty lists) so downstream code never guards for absent keys.
- Validation errors name the node id and the field. A map that fails validation must never be
  silently rendered.

`transcript.py`:
- `find_session(session_id=None, roots=None)` → path to the session JSONL under
  `~/.claude/projects/**/`, newest when no id given; `None` when nothing is found.
- `index(path)` → list of turns, each `{"turn": int, "role": "user"|"assistant", "ts": str|None,
  "uuid": str, "text": str}`. **A turn is a top-level message**: `type` of `"user"` or `"assistant"`
  with text content, numbered from 1 in file order. Skip control records (`type` of
  `"ai-title"`, `"queue-operation"`, `"system"`, `"attachment"`, and other non-message records),
  skip records whose content is only `tool_use` / `tool_result`, and skip `isSidechain: true`.
  `text` is the concatenated text blocks, capped at 2000 chars.
- `resolve(cites, turns)` → for each citation `{"turn": N, "quote": "…"}` return
  `{"turn": N, "ok": bool, "excerpt": str, "reason": str}`. `ok` is False when the turn number does
  not exist, **or when `quote` is given and does not appear in that turn's text** (normalize
  whitespace and case before comparing). `excerpt` is ±200 chars around the quote, else the turn's
  first 300 chars.
- Stream the file; never load it whole. Never raise on a malformed or truncated line — skip it.

Tests: fixture transcripts covering a normal session, a session with tool-only assistant records,
a truncated final line, an empty file, and a missing directory. Assert turn numbering is stable,
that a quote which is absent fails resolution, and that a valid map passes `validate` while each
malformed variant produces a named error.

## Task 2 — Store, server, CLI

Create `src/aang/store.py`, `src/aang/server.py`, `bin/aang` (executable).

`store.py`:
- `load(root)` / `save(root, map_dict)` for `<root>/.aang/map.json`. Write atomically (temp file in
  the same directory, then `os.replace`). A corrupt or absent file loads as an empty map, never an
  exception.
- `merge(old, new)` — regeneration must not destroy human work: a node in `old` with
  `hand_edited: true` survives into the result even when `new` omits it, and `new` never overwrites a
  hand-edited node's fields. Matching is by `id`. **R6 depends on this; it needs a direct test.**
- `export_markdown(map_dict)` → a decision record document, newest decision first, superseded ones
  kept and marked. This is the file a human commits.

`server.py`:
- `http.server.ThreadingHTTPServer` on `127.0.0.1`. `Host` check per Global Constraints → 403.
- `GET /` serves `ui/index.html`. `GET /api/map` returns the normalized map with every citation
  resolved against the transcript and an added per-node `verified` boolean.
- `POST /api/node/<id>` accepts `{"field": value, …}`, applies the edit, sets `hand_edited: true`,
  saves, and returns the new map. This is R6's write path.
- An unreadable transcript is not fatal: serve the map with every node `verified: false` and a
  top-level `transcript_error` string the UI can show.

`bin/aang`:
- `aang view [--port 8790] [--root .]` — start the server, print the URL.
- `aang check [--root .]` — validate the map and resolve every citation; print a report; **exit 1
  when the map is invalid or any citation fails**. This is the command a human trusts.
- `aang export [--out docs/decisions.md]` — write the Markdown record.

Tests: atomic write leaves no partial file; corrupt map file recovers; `merge` preserves a
hand-edited node and refuses to overwrite its fields; `check` exits 1 on a bad citation; server
routes return the right content types and a bad `Host` gets 403 (bind port 0).

## Task 3 — The viewer

Create `ui/index.html` — one self-contained file. No build step, no CDN, no external requests.

- Two panes. **Left: the spine** — every node as one row, newest first, showing its question, its
  decision, one line of `why`, and its status. **Right: the selected node** in ADR form —
  question, decision, why, against, consequence, status, citations.
- `tacit` and `open` nodes are visually distinct from ordinary decisions **and sort above them** —
  they are the point of the tool (R3).
- `superseded` nodes stay visible, struck through, and name the node that replaced them (R2).
- A node whose `verified` is false is **marked plainly as unverified** (R4). Do not hide it and do
  not let it look the same as a verified one.
- Clicking a citation reveals the resolved excerpt from the transcript inline.
- Editing: a node's fields are editable in place and `POST` to `/api/node/<id>`; an edited node
  shows as hand-edited afterwards.
- Define the full light palette as custom properties on bare `:root`, redefine only those inside
  `@media (prefers-color-scheme: dark)`, give `body` an explicit token background. Responsive to
  400px with a 16px gutter and no horizontal page scroll. Russian UI text.

## Task 4 — The skill

Create `.claude/skills/aang/SKILL.md` plus `README.md` at the repo root.

`SKILL.md` is the prompt that makes the map good, and it is the highest-value artifact in v1. It
must instruct the model to:

- Write the map from **its own context**, not by re-reading the transcript — it was in the
  conversation (see the spec's architectural call).
- Emit exactly the JSON in this plan, to `.aang/map.json`, via the `merge` path so hand edits
  survive.
- Obey the IBIS link rules and the ADR fields (R1, R2).
- **Hunt specifically for the two valuable classes** (R3): values that started mattering without
  anyone choosing them, and consequences that follow from a decision nobody revisited. Give the
  model concrete detection questions for each, not just the label.
- Cite a turn for every node, and quote verbatim from that turn — with the explicit warning that an
  invented citation is the worst failure mode available (R4).
- **Apply a threshold** (R8): state what does not earn a node — restatements, tool mechanics, small
  clarifications, anything the reader could not act on later.
- Never edit a superseded decision; add a new one and set the old one's status.
- Finish by running `aang view` and telling the user the URL.

`README.md`: what `/aang` is, the three commands, the map format, and how to correct a map by hand.
