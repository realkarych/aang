# Three Blocks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the viewer with a read-only page of three blocks (Решено / Под вопросом / Отвергнуто) whose rows are grouped by model-written topics, with a per-topic graph view; strip every write path (verdicts, seen, hand edits, outbox) from server, hook, skill and schema.

**Architecture:** One new Python module `src/aang/blocks.py` (block / line / topics rules) replaces `triage.py`; `schema` gains `topic` and loses `seen_at`; `store.export_markdown` groups by blocks and topics; `server.annotate` serves `block`, `topic`, `topics` and drops `cell`, `tail` and every `POST`. `ui/model.js` carries the same three rules plus `topicLayout` and `isNew`; `ui/index.html` is rewritten from scratch (list view, row expansion, topic view, footer, SSE). Hook, session, cli, skill and README lose the outbox. Tasks are ordered so that `master` stays whole after every PR: the new page computes blocks and topics client-side from `ui/model.js`, so it lands before the server stops sending `cell` and `tail`.

**Tech Stack:** Python 3.9 standard library only (comment-style type hints, `http.server`), vanilla JS/SVG in one HTML page plus one JS file, `unittest`, `node` for JS parity tests.

**Spec:** `docs/superpowers/specs/2026-09-12-three-blocks-design.md` (read it first; this plan argues from it). Still binding underneath: `docs/spec.md` (R1–R8), `docs/superpowers/specs/2026-09-11-live-companion-design.md` for the hook, install and Codex sections only.

## Global Constraints

- Python 3.9, standard library only; comment-style type hints (`# type: (...) -> ...`); no `match`, no `X | Y` unions.
- UI is one HTML file and one JS file, no dependencies, no `http://`/`https://` in the page. Server binds `127.0.0.1` and keeps the `Host` gate on `GET`.
- **The server never writes.** No `POST` route survives Task 8; nothing in the page calls `fetch` with a method other than `GET`.
- All user-facing strings are Russian. Block titles are exactly «Решено», «Под вопросом», «Отвергнуто».
- Tests: `python3 -m unittest discover -s tests -t .` from the worktree root. Tests that run JS use `node` and are skipped without it (`@unittest.skipUnless(shutil.which("node"), ...)`), as `tests/test_server.py` already does.
- Commit after each task with the trailer lines from the session's attribution reminder.
- Work in the worktree `/Users/karych/src/aang/.claude/worktrees/three-blocks`, branch `worktree-three-blocks`. Never `cd` to the main checkout. Each task is its own branch `blocks/<n>-<name>` off the previous task's branch (stacked), pushed as its own PR; the controller merges them in order.
- **No line comments** (`# …`, `// …`) in any code you write or touch; module and function docstrings are allowed and are where the contract lives; `# type: (...) -> ...` hints are syntax and stay. Where a code block in this plan carries a comment, drop the comment and keep the code.
- **PRs under 400 added lines** (tests count; deletions do not). A task whose additions would exceed 400 is split into two commits that can be two PRs.
- Subagents dispatched for this plan run on `fable` or `opus` only.

## File Structure

| file | responsibility |
|---|---|
| `src/aang/blocks.py` (new) | `BLOCKS`, `block(node)`, `line(node)`, `topic_key`, `topics(nodes)`, `topic_of(nodes)`, `titles()` — derived arrangement of the map |
| `src/aang/triage.py` (deleted in Task 8) | cells and verdicts — gone |
| `src/aang/schema.py` | `topic` validation, `seen_at` dropped in `normalize` |
| `src/aang/store.py` | `CONTENT_FIELDS` + `topic`; `STAMP_FIELDS` = `added_at` only; `VIEW_FIELDS` with `block`; export by blocks and topics |
| `src/aang/server.py` | `annotate` serves `block`, `topic`, `topics`; no `tail`, no `cell`, no `POST` |
| `src/aang/hook.py` | no outbox; coverage line computed from `coverage` |
| `src/aang/session.py` | no outbox functions |
| `src/aang/cli.py` | `.gitignore` hint without `outbox.jsonl` |
| `ui/model.js` | `BLOCKS`, `blockOf`, `lineOf`, `topicKey`, `topicsOf`, `topicLayout`, `isNew`; old cell/timeline/neighbourhood/verdict functions deleted in Task 8 |
| `ui/index.html` | the page: list, expansion, topic view, footer, SSE, «новое» via `localStorage` |
| `tests/test_blocks.py` (new) | rules of `blocks.py` |
| `tests/test_server.py` | API shape, page words, JS parity, layout |
| `tests/test_store.py`, `tests/test_schema.py`, `tests/test_hook.py`, `tests/test_session.py`, `tests/test_cli.py` | updated per task |
| `.claude/skills/aang/SKILL.md`, `README.md` | `topic`, no outbox, no `seen_at`, three blocks |

---

### Task 1: `blocks.py` — block, line, topics

**Files:**
- Create: `src/aang/blocks.py`
- Test: `tests/test_blocks.py`

**Interfaces:**
- Produces: `blocks.BLOCKS`, `blocks.block(node) -> Optional[str]`, `blocks.line(node) -> (glyph, verb, text)`, `blocks.topic_key(name) -> str`, `blocks.topics(nodes) -> [{"name": str, "ids": [str]}]`, `blocks.topic_of(nodes) -> {id: name}`, `blocks.titles() -> {key: title}`. Later tasks (export, server, JS parity) consume exactly these.

- [ ] **Step 1: Write the failing tests**

```python
"""Rules of src/aang/blocks.py: which block, which line, which topic."""

import unittest

from aang import blocks


def node(node_id, kind="decision", status="accepted", **extra):
    base = {"id": node_id, "kind": kind, "status": status, "question": "вопрос %s" % node_id,
            "decision": "решение %s" % node_id, "why": "", "against": [], "consequence": "",
            "cites": [], "relates": [], "superseded_by": None, "decided_by": None, "triage": None,
            "topic": None, "added_at": ""}
    base.update(extra)
    return base


class BlockTest(unittest.TestCase):
    def test_rules_in_order(self):
        self.assertEqual("rejected", blocks.block(node("d1", status="rejected")))
        self.assertEqual("rejected", blocks.block(node("t1", kind="tacit", status="rejected")))
        self.assertIsNone(blocks.block(node("d1", status="superseded", superseded_by="d2")))
        self.assertEqual("open", blocks.block(node("o1", kind="open", status="proposed")))
        self.assertEqual("open", blocks.block(node("d1", status="proposed", decided_by="agent")))
        self.assertEqual("open", blocks.block(node("d1", status="proposed", decided_by="user")))
        self.assertEqual("open", blocks.block(node("d1", status="proposed", triage="research")))
        self.assertEqual("decided", blocks.block(node("d1")))
        self.assertEqual("decided", blocks.block(node("t1", kind="tacit")))

    def test_blocks_are_ordered_and_titled(self):
        self.assertEqual(["decided", "open", "rejected"], [k for k, _, _ in blocks.BLOCKS])
        self.assertEqual({"decided": "Решено", "open": "Под вопросом", "rejected": "Отвергнуто"},
                         blocks.titles())


class LineTest(unittest.TestCase):
    def test_table(self):
        self.assertEqual(("●", "решили", "решение d1"), blocks.line(node("d1")))
        self.assertEqual(("◌", "молча", "решение t1"), blocks.line(node("t1", kind="tacit")))
        self.assertEqual(("◆", "агент сам", "решение d1"),
                         blocks.line(node("d1", status="proposed", decided_by="agent")))
        self.assertEqual(("◇", "предложено", "решение d1"),
                         blocks.line(node("d1", status="proposed", decided_by="user")))
        self.assertEqual(("◇", "предложено", "решение d1"), blocks.line(node("d1", status="proposed")))
        self.assertEqual(("?", "изучить", "решение d1"),
                         blocks.line(node("d1", status="proposed", decided_by="agent", triage="research")))
        self.assertEqual(("?", "обсудить", "вопрос o1"),
                         blocks.line(node("o1", kind="open", status="proposed", triage="discuss")))
        self.assertEqual(("○", "открыто", "вопрос o1"), blocks.line(node("o1", kind="open", status="proposed")))
        self.assertEqual(("✖", "отвергнуто", "решение d1"), blocks.line(node("d1", status="rejected")))
        self.assertEqual(("●", "заменено", "решение d1"),
                         blocks.line(node("d1", status="superseded", superseded_by="d2")))

    def test_open_text_is_the_question_and_missing_text_is_empty(self):
        self.assertEqual("вопрос o1", blocks.line(node("o1", kind="open", status="proposed", decision=""))[2])
        self.assertEqual("", blocks.line(node("d1", decision=None))[2])


class TopicKeyTest(unittest.TestCase):
    def test_whitespace_and_case_are_forgiven(self):
        self.assertEqual("размер pr", blocks.topic_key("  Размер   PR "))
        self.assertEqual("", blocks.topic_key(None))
        self.assertEqual("", blocks.topic_key(""))


class TopicsTest(unittest.TestCase):
    def names(self, groups):
        return [(g["name"], g["ids"]) for g in groups]

    def test_explicit_topics_group_and_keep_the_first_spelling(self):
        groups = blocks.topics([node("d1", topic="Модели"), node("d2", topic="вьюер"),
                                node("d3", topic="модели ")])
        self.assertEqual([("вьюер", ["d2"]), ("Модели", ["d1", "d3"])], self.names(groups))

    def test_unnamed_nodes_join_the_component_of_their_edges(self):
        groups = blocks.topics([
            node("t1", kind="tacit", topic="вьюер"),
            node("d1", relates=[{"to": "t1", "rel": "rests_on"}]),
            node("o1", kind="open", status="proposed", relates=[{"to": "d1", "rel": "orphaned_by"}]),
            node("d2", topic="модели"),
        ])
        self.assertEqual([("модели", ["d2"]), ("вьюер", ["t1", "d1", "o1"])], self.names(groups))

    def test_superseded_by_is_an_edge_too(self):
        groups = blocks.topics([node("d1", status="superseded", superseded_by="d2"),
                                node("d2", topic="порт")])
        self.assertEqual([("порт", ["d1", "d2"])], self.names(groups))

    def test_a_component_with_two_named_nodes_lends_the_earliest_name(self):
        groups = blocks.topics([
            node("d1", topic="a"),
            node("d2", topic="b", relates=[{"to": "d1", "rel": "rests_on"}]),
            node("d3", relates=[{"to": "d2", "rel": "rests_on"}]),
        ])
        by_name = dict((g["name"], g["ids"]) for g in groups)
        self.assertEqual(["d1", "d3"], by_name["a"])
        self.assertEqual(["d2"], by_name["b"])

    def test_a_nameless_component_is_called_by_its_first_question(self):
        groups = blocks.topics([
            node("d1", question="Чем мерить качество прогона теперь?"),
            node("o1", kind="open", status="proposed", question="Кто платит?",
                 relates=[{"to": "d1", "rel": "orphaned_by"}]),
            node("d2", question="Порт вьюера"),
        ])
        self.assertEqual([("Порт вьюера", ["d2"]), ("Чем мерить качество…", ["d1", "o1"])],
                         self.names(groups))

    def test_a_node_without_question_or_topic_is_called_by_its_id(self):
        self.assertEqual([("d1", ["d1"])], self.names(blocks.topics([node("d1", question="")])))

    def test_order_is_latest_added_then_latest_position(self):
        groups = blocks.topics([
            node("d1", topic="старая", added_at="2026-09-11T10:00:00Z"),
            node("d2", topic="новая", added_at="2026-09-11T12:00:00Z"),
            node("d3", topic="старая", added_at="2026-09-11T11:00:00Z"),
            node("d4", topic="без штампа"),
            node("d5", topic="без штампа тоже"),
        ])
        self.assertEqual(["новая", "старая", "без штампа тоже", "без штампа"],
                         [g["name"] for g in groups])

    def test_ids_come_in_list_order_and_junk_is_skipped(self):
        groups = blocks.topics([node("d2", topic="x"), "junk", {"kind": "open"},
                                node("d1", topic="x", relates=[{"to": "d2", "rel": "rests_on"}])])
        self.assertEqual([("x", ["d2", "d1"])], self.names(groups))

    def test_topic_of(self):
        names = blocks.topic_of([node("d1", topic="x"), node("d2", relates=[{"to": "d1", "rel": "rests_on"}]),
                                 node("o1", kind="open", status="proposed", question="Кто платит теперь и зачем")])
        self.assertEqual({"d1": "x", "d2": "x", "o1": "Кто платит теперь…"}, names)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python3 -m unittest tests.test_blocks -v`
Expected: `ImportError: cannot import name 'blocks'`.

- [ ] **Step 3: Write `src/aang/blocks.py`**

```python
"""Blocks, lines and topics: how the read-only viewer and the export arrange the map.

Spec: docs/superpowers/specs/2026-09-12-three-blocks-design.md, «Блоки», «Строка», «Темы».
Everything here is derived from `kind`, `status`, `decided_by`, `triage`, `topic`,
`relates`, `superseded_by` and `added_at`; nothing is stored. `ui/model.js` carries the
same rules for the screen, and a test in `tests/test_server.py` compares the two.
"""

from typing import Any, Dict, List, Optional, Tuple

BLOCKS = (
    ("decided", "Решено", "в силе — выбрано или принято молча"),
    ("open", "Под вопросом", "ждёт вас: предложено агентом, спрошено, отложено"),
    ("rejected", "Отвергнуто", "остаётся в записи, чтобы не предлагать снова"),
)  # type: Tuple[Tuple[str, str, str], ...]

NAME_WORDS = 3


def block(node):  # type: (Dict[str, Any]) -> Optional[str]
    """The block a node is listed under; None for a superseded node, which lives inside
    the expansion of what replaced it."""
    status = node.get("status")
    if status == "rejected":
        return "rejected"
    if status == "superseded":
        return None
    if node.get("kind") == "open" or status == "proposed" or node.get("triage"):
        return "open"
    return "decided"


def line(node):  # type: (Dict[str, Any]) -> Tuple[str, str, str]
    """Glyph, one-word verb and text of a node's line. Triage outranks everything else:
    a node under research reads «изучить» whoever proposed it."""
    kind, status = node.get("kind"), node.get("status")
    text = (node.get("question") if kind == "open" else node.get("decision")) or ""
    triage = node.get("triage")
    if triage == "research":
        return ("?", "изучить", text)
    if triage == "discuss":
        return ("?", "обсудить", text)
    if status == "rejected":
        return ("✖", "отвергнуто", text)
    if status == "superseded":
        return ("●", "заменено", text)
    if kind == "open":
        return ("○", "открыто", text)
    if kind == "tacit":
        return ("◌", "молча", text)
    if status == "proposed":
        if node.get("decided_by") == "agent":
            return ("◆", "агент сам", text)
        return ("◇", "предложено", text)
    return ("●", "решили", text)


def topic_key(name):  # type: (Any) -> str
    """Two spellings of one topic compare equal: whitespace collapsed, case folded."""
    if not isinstance(name, str):
        return ""
    return " ".join(name.split()).casefold()


def _targets(node):  # type: (Dict[str, Any]) -> List[str]
    out = [r.get("to") for r in node.get("relates") or [] if isinstance(r, dict)]
    out.append(node.get("superseded_by"))
    return [t for t in out if isinstance(t, str) and t]


def _fallback_name(node):  # type: (Dict[str, Any]) -> str
    words = str(node.get("question") or "").split()
    if not words:
        return str(node.get("id") or "")
    name = " ".join(words[:NAME_WORDS])
    return name + "…" if len(words) > NAME_WORDS else name


def topics(nodes):  # type: (List[Any]) -> List[Dict[str, Any]]
    """Topics in display order, each `{"name", "ids"}` with ids in list order.

    A node with a `topic` is in that topic. A node without one joins the connected
    component its edges (`relates`, `superseded_by`, both directions) put it in: the
    component's earliest named node lends its topic, and a component nobody named is
    called by the first three words of its earliest question. Topics sort by the latest
    `added_at` among their nodes, then by the latest list position — the topic that
    moved last comes first. Non-dict entries and nodes without an id are skipped.
    """
    nodes = [n for n in nodes if isinstance(n, dict) and isinstance(n.get("id"), str) and n["id"]]
    index = dict((n["id"], i) for i, n in enumerate(nodes))
    by_id = dict((n["id"], n) for n in nodes)
    parent = dict((n["id"], n["id"]) for n in nodes)

    def find(x):  # type: (str) -> str
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for n in nodes:
        for target in _targets(n):
            if target in parent:
                a, b = find(n["id"]), find(target)
                if a != b:
                    first, second = (a, b) if index[a] < index[b] else (b, a)
                    parent[second] = first

    members = {}  # type: Dict[str, List[str]]
    for n in nodes:
        members.setdefault(find(n["id"]), []).append(n["id"])

    groups = {}  # type: Dict[str, Dict[str, Any]]

    def add(name, node_id):  # type: (str, str) -> None
        key = topic_key(name)
        group = groups.get(key)
        if group is None:
            group = groups[key] = {"name": " ".join(name.split()), "ids": []}
        group["ids"].append(node_id)

    for root in sorted(members, key=lambda r: index[r]):
        ids = members[root]
        named = [i for i in ids if topic_key(by_id[i].get("topic"))]
        lent = by_id[named[0]]["topic"] if named else _fallback_name(by_id[ids[0]])
        for i in ids:
            own = by_id[i].get("topic")
            add(own if topic_key(own) else lent, i)

    def rank(group):  # type: (Dict[str, Any]) -> Tuple[str, int]
        ids = group["ids"]
        return (max(str(by_id[i].get("added_at") or "") for i in ids), max(index[i] for i in ids))

    out = sorted(groups.values(), key=rank, reverse=True)
    for group in out:
        group["ids"].sort(key=lambda i: index[i])
    return out


def topic_of(nodes):  # type: (List[Any]) -> Dict[str, str]
    """Node id → resolved topic name, what `server.annotate` puts on each node."""
    names = {}  # type: Dict[str, str]
    for group in topics(nodes):
        for node_id in group["ids"]:
            names[node_id] = group["name"]
    return names


def titles():  # type: () -> Dict[str, str]
    return dict((key, title) for key, title, _ in BLOCKS)
```

- [ ] **Step 4: Run the tests**

Run: `python3 -m unittest tests.test_blocks -v`
Expected: all PASS. Then the whole suite: `python3 -m unittest discover -s tests -t .` — still green (nothing else touched).

- [ ] **Step 5: Commit**

```bash
git checkout -b blocks/1-blocks
git add src/aang/blocks.py tests/test_blocks.py
git commit -m "blocks: block, line and topics rules"
```

---

### Task 2: `topic` in the schema, `seen_at` out

**Files:**
- Modify: `src/aang/schema.py` (module docstring line 5; `_validate_node` around lines 194–196; `normalize` around line 387)
- Modify: `src/aang/store.py:29-34` (`CONTENT_FIELDS`, `STAMP_FIELDS`) and the `merge` docstring lines 145–150; grep `seen_at` in `store.py` and drop every mention
- Test: `tests/test_schema.py`, `tests/test_store.py` (the `seen_at` test at line 615 becomes a `topic` test)

**Interfaces:**
- Produces: `schema.TOPIC_MAX = 40`; a normalized node has `topic` (str or None) and never `seen_at`; `store.CONTENT_FIELDS` includes `"topic"`; `store.STAMP_FIELDS == ("added_at",)`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_schema.py` (reuse its `_node` helper and `_map` helpers; look at lines 60–100 for their signatures):

```python
class TopicTest(unittest.TestCase):
    def test_topic_is_a_short_string_or_null(self):
        self.assertEqual([], schema.validate(_map(_node("d1", topic="размер PR"))))
        self.assertEqual([], schema.validate(_map(_node("d1", topic=None))))
        errors = schema.validate(_map(_node("d1", topic=5)))
        self.assertTrue(any("поле topic" in e and "строка" in e for e in errors), errors)
        errors = schema.validate(_map(_node("d1", topic="x" * (schema.TOPIC_MAX + 1))))
        self.assertTrue(any("поле topic" in e and str(schema.TOPIC_MAX) in e for e in errors), errors)

    def test_normalize_fills_topic_and_blanks_an_empty_one(self):
        m = schema.normalize(_map(_node("d1")))
        self.assertIsNone(m["nodes"][0]["topic"])
        m = schema.normalize(_map(_node("d1", topic="   ")))
        self.assertIsNone(m["nodes"][0]["topic"])

    def test_normalize_drops_seen_at(self):
        m = schema.normalize(_map(_node("d1", seen_at="2026-09-11T12:00:00Z")))
        self.assertNotIn("seen_at", m["nodes"][0])
        self.assertEqual([], schema.validate(m))
```

If `_map` does not exist under that name, use whatever helper the file already has for wrapping nodes in a valid map (`test_schema.py` lines 60–100) and keep the assertions.

In `tests/test_store.py`, replace `test_seen_at_survives_a_regeneration_and_is_never_taken_from_the_candidate` (line 615) with:

```python
    def test_topic_is_content_and_comes_from_the_candidate(self):
        old = {"version": 1, "nodes": [self.node("d1", topic="старая", added_at="2026-09-11T11:00:00Z")]}
        new = {"version": 1, "nodes": [self.node("d1", topic="новая"), self.node("d2", topic=None)]}
        by_id = dict((n["id"], n) for n in store.merge(old, new)["nodes"])
        self.assertEqual("новая", by_id["d1"]["topic"])
        self.assertEqual("2026-09-11T11:00:00Z", by_id["d1"]["added_at"])
        self.assertIsNone(by_id["d2"]["topic"])
        self.assertNotIn("seen_at", by_id["d1"])
```

Rename the class from `SeenAndCellMergeTest` to `TopicAndCellMergeTest`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python3 -m unittest tests.test_schema tests.test_store -v`
Expected: `TopicTest` fails (`topic` not validated; `seen_at` kept); the store test fails on `topic`.

- [ ] **Step 3: Change `schema.py`**

Add after `_TRIAGE_STATUSES`:

```python
TOPIC_MAX = 40
```

Replace the `seen_at` block in `_validate_node` (the three lines starting `seen_at = node.get("seen_at")`) with:

```python
    topic = node.get("topic")
    if topic is not None:
        if not _is_str(topic):
            errors.append("%s, поле topic: ожидается строка или null" % label)
        elif len(topic.strip()) > TOPIC_MAX:
            errors.append("%s, поле topic: не длиннее %d символов, получено %d"
                          % (label, TOPIC_MAX, len(topic.strip())))
```

In `normalize`, replace `for field in ("decided_by", "triage", "seen_at"):` with:

```python
        node.pop("seen_at", None)
        for field in ("decided_by", "triage", "topic"):
            node.setdefault(field, None)
        if isinstance(node.get("topic"), str) and not node["topic"].strip():
            node["topic"] = None
```

Fix the module docstring (line 5) so it names `decided_by`, `triage` and `topic` and not `seen_at`.

- [ ] **Step 4: Change `store.py`**

```python
CONTENT_FIELDS = ("kind", "question", "decision", "why", "against", "consequence", "cites", "relates",
                  "decided_by", "triage", "topic")

STAMP_FIELDS = ("added_at",)
```

Rewrite the `merge` docstring bullet about stamps so it speaks of `added_at` only. Run `grep -n seen_at src/aang/store.py` and remove every remaining mention (there should be none in code once `STAMP_FIELDS` changed; the loop over `STAMP_FIELDS` stays).

- [ ] **Step 5: Run the whole suite**

Run: `python3 -m unittest discover -s tests -t .`
Expected: green. If `tests/test_server.py` or `tests/test_triage.py` still construct nodes with `seen_at`, they still pass — `normalize` drops the field and `triage.is_unseen` reads the raw node in those tests; leave them for Task 8.

- [ ] **Step 6: Commit**

```bash
git checkout -b blocks/2-schema-topic
git add src/aang/schema.py src/aang/store.py tests/test_schema.py tests/test_store.py
git commit -m "schema: topic on every node, seen_at gone"
```

---

### Task 3: export by blocks and topics

**Files:**
- Modify: `src/aang/store.py:351-400` (`export_markdown`), `_node_markdown` heading level (`###` → `####`)
- Test: `tests/test_store.py` (`CellExportTest` at line 641 becomes `BlockExportTest`)

**Interfaces:**
- Consumes: `blocks.BLOCKS`, `blocks.block`, `blocks.topics` (Task 1).
- Produces: export sections `## Решено` / `## Под вопросом` / `## Отвергнуто`, `### <topic>` under each, `#### <node>` under that.

- [ ] **Step 1: Write the failing test**

Replace `CellExportTest` with:

```python
class BlockExportTest(unittest.TestCase):
    def node(self, node_id, **extra):
        base = {"id": node_id, "kind": "decision", "status": "accepted", "question": "Вопрос %s?" % node_id,
                "decision": "решение %s" % node_id, "why": "почему", "against": [], "consequence": "",
                "cites": [], "relates": [], "superseded_by": None, "topic": None}
        base.update(extra)
        return base

    def test_sections_are_blocks_then_topics_then_nodes(self):
        m = {"version": 1, "title": "т", "nodes": [
            self.node("d1", topic="модели"),
            self.node("d2", status="superseded", superseded_by="d3", topic="порт"),
            self.node("d3", topic="порт"),
            self.node("o1", kind="open", status="proposed", decision="", topic="модели"),
            self.node("d4", status="rejected", topic="модели"),
        ]}
        text = store.export_markdown(m)
        heads = [l for l in text.splitlines() if l.startswith("#")]
        self.assertEqual(["# т",
                          "## Решено", "### порт", "#### решение d3", "#### решение d2", "### модели", "#### решение d1",
                          "## Под вопросом", "### модели", "#### Вопрос o1?",
                          "## Отвергнуто", "### модели", "#### решение d4"],
                         [h.split(" (")[0].split(" — ")[0] for h in heads])

    def test_an_empty_block_is_omitted(self):
        text = store.export_markdown({"version": 1, "nodes": [self.node("d1", topic="x")]})
        self.assertIn("## Решено", text)
        self.assertNotIn("## Под вопросом", text)
        self.assertNotIn("## Отвергнуто", text)
```

Read `_node_markdown` (lines 395–500) before finalizing the expected heading text: the node heading may carry the id or a status mark after the text. The `split(" (")[0].split(" — ")[0]` above strips a trailing ` (…)` or ` — …`; adjust that stripping to whatever `_node_markdown` actually prints, but keep the order and the levels.

- [ ] **Step 2: Run the test to verify it fails**

Run: `python3 -m unittest tests.test_store.BlockExportTest -v`
Expected: FAIL — headings are the old cells.

- [ ] **Step 3: Rewrite the grouping in `export_markdown`**

Replace `from . import schema, triage` (or however `triage` is imported at the top of `store.py`) with `from . import blocks, schema` (keep other names). Replace the docstring's sentence about cells with: «Sections are the three blocks of `blocks.BLOCKS`, then `###` per topic in `blocks.topics` order, then one `####` per node, newest first; a superseded node prints under «Решено» inside its topic, struck, next to what replaced it.» Replace the loop from `nodes = [...]` to `return` with:

```python
    nodes = [n for n in map_dict["nodes"] if isinstance(n, dict)]
    by_id = dict((n.get("id"), n) for n in nodes)
    groups = blocks.topics(nodes)
    for key, title, subtitle in blocks.BLOCKS:
        wanted = set(n.get("id") for n in nodes if _export_block(n) == key)
        if not wanted:
            continue
        lines.append("## %s" % title)
        lines.append("")
        lines.append("_%s_" % subtitle)
        lines.append("")
        for group in groups:
            ids = [i for i in group["ids"] if i in wanted]
            if not ids:
                continue
            lines.append("### %s" % group["name"])
            lines.append("")
            for node_id in reversed(ids):
                lines.extend(_node_markdown(by_id[node_id], by_id, transcript_error))
    return "\n".join(lines).rstrip("\n") + "\n"


def _export_block(node):  # type: (Dict[str, Any]) -> str
    """A superseded node prints under «Решено», struck, next to what replaced it."""
    return blocks.block(node) or "decided"
```

In `_node_markdown`, change the node heading from `###` to `####` and update its docstring («One `####` section»).

- [ ] **Step 4: Run the suite**

Run: `python3 -m unittest discover -s tests -t .`
Expected: green. `tests/test_cli.py` export tests that look for `### ` node headings need their level changed to `#### ` — do that in the same commit.

- [ ] **Step 5: Commit**

```bash
git checkout -b blocks/3-export
git add src/aang/store.py tests/test_store.py tests/test_cli.py
git commit -m "export: three blocks, topics inside"
```

---

### Task 4: `ui/model.js` — blocks, lines, topics, layout, new

**Files:**
- Modify: `ui/model.js` (add functions; keep the old ones — Task 8 removes them)
- Test: `tests/test_server.py` (new class `BlocksModelTest`, next to the existing JS parity tests around line 990; uses the existing `_model_call` helper)

**Interfaces:**
- Produces on `window.AangModel`: `BLOCKS` (`[{key,title,sub}]`), `blockOf(n)`, `lineOf(n) -> {glyph, verb, text}`, `topicKey(name)`, `topicsOf(nodes) -> [{name, ids}]`, `isNew(n, since)`, `topicLayout(nodes, width, opts) -> {width, height, lanes, boxes, edges, outside}`, `EDGE_LABELS`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/test_server.py` (imports: add `from aang import blocks`):

```python
def _grid_nodes():
    """Every combination the block and line rules distinguish."""
    out = []
    i = 0
    for kind in ("decision", "tacit", "open"):
        for status in ("accepted", "proposed", "rejected", "superseded"):
            for decided_by in (None, "user", "agent"):
                for triage in (None, "research", "discuss"):
                    i += 1
                    out.append({"id": "n%d" % i, "kind": kind, "status": status, "decided_by": decided_by,
                                "triage": triage, "question": "вопрос %d" % i, "decision": "решение %d" % i,
                                "superseded_by": "n1" if status == "superseded" else None,
                                "relates": [], "topic": None, "added_at": ""})
    return out


def _topic_nodes():
    return [
        {"id": "t1", "kind": "tacit", "status": "accepted", "topic": "Вьюер", "question": "Порт?",
         "decision": "8790", "relates": [], "superseded_by": None, "added_at": "2026-09-11T10:00:00Z"},
        {"id": "d1", "kind": "decision", "status": "accepted", "topic": None, "question": "Как читать?",
         "decision": "файлы", "relates": [{"to": "t1", "rel": "rests_on"}], "superseded_by": None,
         "added_at": "2026-09-11T11:00:00Z"},
        {"id": "d2", "kind": "decision", "status": "superseded", "topic": None, "question": "Сколько портов?",
         "decision": "два", "relates": [], "superseded_by": "d3", "added_at": "2026-09-11T11:00:00Z"},
        {"id": "d3", "kind": "decision", "status": "accepted", "topic": "вьюер ", "question": "Сколько портов?",
         "decision": "один", "relates": [], "superseded_by": None, "added_at": "2026-09-11T12:00:00Z"},
        {"id": "o1", "kind": "open", "status": "proposed", "topic": None,
         "question": "Кто платит за это всё?", "decision": "", "relates": [], "superseded_by": None,
         "added_at": "2026-09-11T09:00:00Z"},
        {"id": "d4", "kind": "decision", "status": "rejected", "topic": "модели", "question": "Sonnet?",
         "decision": "sonnet для ревью", "relates": [{"to": "o1", "rel": "moots"}], "superseded_by": None,
         "added_at": "2026-09-11T12:30:00Z"},
    ]


@unittest.skipUnless(shutil.which("node"), "node is not on PATH")
class BlocksModelTest(unittest.TestCase):
    """ui/model.js and src/aang/blocks.py are two copies of one rule; these keep them equal."""

    def test_blocks_match_python(self):
        self.assertEqual([list(b) for b in blocks.BLOCKS],
                         _model_call("M.BLOCKS.map(function (b) { return [b.key, b.title, b.sub]; })"))

    def test_block_of_agrees_with_python_on_a_grid(self):
        nodes = _grid_nodes()
        got = _model_call("%s.map(M.blockOf)" % json.dumps(nodes))
        self.assertEqual([blocks.block(n) for n in nodes], got)

    def test_line_of_agrees_with_python_on_a_grid(self):
        nodes = _grid_nodes()
        got = _model_call("%s.map(function (n) { var l = M.lineOf(n); return [l.glyph, l.verb, l.text]; })"
                          % json.dumps(nodes))
        self.assertEqual([list(blocks.line(n)) for n in nodes], got)

    def test_topics_agree_with_python(self):
        nodes = _topic_nodes()
        got = _model_call("M.topicsOf(%s)" % json.dumps(nodes))
        self.assertEqual(blocks.topics(nodes), got)
        self.assertEqual(["модели", "Вьюер"], [g["name"] for g in got])
        self.assertEqual(["o1", "d4"], got[0]["ids"])

    def test_is_new(self):
        self.assertEqual([False, True, False, False], _model_call(
            "[M.isNew({added_at: '2026-09-11T10:00:00Z'}, ''), M.isNew({added_at: '2026-09-11T10:00:00Z'}, '2026-09-11T09:00:00Z'),"
            " M.isNew({added_at: '2026-09-11T10:00:00Z'}, '2026-09-11T10:00:00Z'), M.isNew({added_at: ''}, '2026-09-11T09:00:00Z')]"))

    def test_topic_layout_places_every_node_in_its_lane_and_fits_the_width(self):
        nodes = [n for n in _topic_nodes() if n["id"] in ("t1", "d1", "d2", "d3")]
        for width in (450, 750):
            lay = _model_call("M.topicLayout(%s, %d)" % (json.dumps(nodes), width))
            self.assertEqual({"t1", "d1", "d2", "d3"}, set(b["id"] for b in lay["boxes"]))
            self.assertEqual(["decided", "open", "rejected"], [l["key"] for l in lay["lanes"]])
            lanes = dict((l["key"], l) for l in lay["lanes"])
            for box in lay["boxes"]:
                self.assertGreaterEqual(box["x"], 0)
                self.assertLessEqual(box["x"] + box["w"], width)
                self.assertEqual("decided", box["lane"])
                lane = lanes[box["lane"]]
                self.assertGreaterEqual(box["y"], lane["y"])
                self.assertLessEqual(box["y"] + box["h"], lane["y"] + lane["height"])
            self.assertTrue([b for b in lay["boxes"] if b["id"] == "d2"][0]["struck"])
            self.assertEqual(lay["height"], sum(l["height"] for l in lay["lanes"]))
            self.assertGreater(lay["height"], 0)

    def test_topic_layout_edges_join_boxes_and_count_the_outside(self):
        nodes = [n for n in _topic_nodes() if n["id"] in ("t1", "d1", "d2", "d3", "d4")]
        lay = _model_call("M.topicLayout(%s, 600)" % json.dumps(nodes))
        boxes = dict((b["id"], b) for b in lay["boxes"])
        edges = dict(((e["from"], e["to"]), e) for e in lay["edges"])
        self.assertEqual({("d1", "t1"), ("d2", "d3")}, set(edges))
        self.assertEqual("держится на", edges[("d1", "t1")]["label"])
        self.assertEqual("заменено на", edges[("d2", "d3")]["label"])
        e = edges[("d1", "t1")]
        self.assertEqual((boxes["d1"]["x"] + boxes["d1"]["w"] / 2, boxes["t1"]["x"] + boxes["t1"]["w"] / 2),
                         (e["x1"], e["x2"]))
        self.assertEqual({"d4": 1}, lay["outside"])
        self.assertEqual("rejected", boxes["d4"]["lane"])
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python3 -m unittest tests.test_server.BlocksModelTest -v`
Expected: `TypeError: M.blockOf is not a function` and similar.

- [ ] **Step 3: Add the functions to `ui/model.js`**

Insert after `var SUPERSEDED_GAP = 60;`:

```js
  var BLOCKS = [
    { key: "decided", title: "Решено", sub: "в силе — выбрано или принято молча" },
    { key: "open", title: "Под вопросом", sub: "ждёт вас: предложено агентом, спрошено, отложено" },
    { key: "rejected", title: "Отвергнуто", sub: "остаётся в записи, чтобы не предлагать снова" }
  ];
  var NAME_WORDS = 3;
  var EDGE_LABELS = { rests_on: "держится на", orphaned_by: "осиротело", moots: "обесценило", superseded_by: "заменено на" };

  function blockOf(n) {
    if (n.status === "rejected") return "rejected";
    if (n.status === "superseded") return null;
    if (n.kind === "open" || n.status === "proposed" || n.triage) return "open";
    return "decided";
  }

  function lineOf(n) {
    var text = (n.kind === "open" ? n.question : n.decision) || "";
    if (n.triage === "research") return { glyph: "?", verb: "изучить", text: text };
    if (n.triage === "discuss") return { glyph: "?", verb: "обсудить", text: text };
    if (n.status === "rejected") return { glyph: "✖", verb: "отвергнуто", text: text };
    if (n.status === "superseded") return { glyph: "●", verb: "заменено", text: text };
    if (n.kind === "open") return { glyph: "○", verb: "открыто", text: text };
    if (n.kind === "tacit") return { glyph: "◌", verb: "молча", text: text };
    if (n.status === "proposed") {
      if (n.decided_by === "agent") return { glyph: "◆", verb: "агент сам", text: text };
      return { glyph: "◇", verb: "предложено", text: text };
    }
    return { glyph: "●", verb: "решили", text: text };
  }

  function topicKey(name) {
    if (typeof name !== "string") return "";
    return name.split(/\s+/).filter(Boolean).join(" ").toLowerCase();
  }

  function targetsOf(n) {
    var out = (n.relates || []).map(function (r) { return r && r.to; });
    out.push(n.superseded_by);
    return out.filter(function (t) { return typeof t === "string" && t; });
  }

  function fallbackName(n) {
    var words = String(n.question || "").split(/\s+/).filter(Boolean);
    if (!words.length) return String(n.id || "");
    var name = words.slice(0, NAME_WORDS).join(" ");
    return words.length > NAME_WORDS ? name + "…" : name;
  }

  function topicsOf(input) {
    var nodes = (input || []).filter(function (n) { return n && typeof n === "object" && typeof n.id === "string" && n.id; });
    var index = {}, byId = {}, parent = {};
    nodes.forEach(function (n, i) { index[n.id] = i; byId[n.id] = n; parent[n.id] = n.id; });
    function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
    nodes.forEach(function (n) {
      targetsOf(n).forEach(function (t) {
        if (!(t in parent)) return;
        var a = find(n.id), b = find(t);
        if (a === b) return;
        if (index[a] < index[b]) parent[b] = a; else parent[a] = b;
      });
    });
    var members = {};
    nodes.forEach(function (n) { var r = find(n.id); (members[r] = members[r] || []).push(n.id); });
    var groups = {}, order = [];
    function add(name, id) {
      var key = topicKey(name);
      if (!groups[key]) { groups[key] = { name: name.split(/\s+/).filter(Boolean).join(" "), ids: [] }; order.push(key); }
      groups[key].ids.push(id);
    }
    Object.keys(members).sort(function (a, b) { return index[a] - index[b]; }).forEach(function (root) {
      var ids = members[root];
      var named = ids.filter(function (i) { return topicKey(byId[i].topic); });
      var lent = named.length ? byId[named[0]].topic : fallbackName(byId[ids[0]]);
      ids.forEach(function (i) { var own = byId[i].topic; add(topicKey(own) ? own : lent, i); });
    });
    function rank(g) {
      var added = "", pos = -1;
      g.ids.forEach(function (i) { var a = String(byId[i].added_at || ""); if (a > added) added = a; if (index[i] > pos) pos = index[i]; });
      return { added: added, pos: pos };
    }
    var out = order.map(function (k) { return groups[k]; });
    out.sort(function (a, b) {
      var ra = rank(a), rb = rank(b);
      if (ra.added !== rb.added) return ra.added > rb.added ? -1 : 1;
      return rb.pos - ra.pos;
    });
    out.forEach(function (g) { g.ids.sort(function (a, b) { return index[a] - index[b]; }); });
    return out;
  }

  function isNew(n, since) {
    return !!since && !!n.added_at && n.added_at > since;
  }

  function clipText(s, n) { s = String(s || ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; }

  function topicLayout(nodes, width, opts) {
    opts = opts || {};
    var charW = opts.charW || 7, pad = opts.pad || 10, boxH = opts.boxH || 26, gapX = opts.gapX || 10,
        gapY = opts.gapY || 12, laneHead = opts.laneHead || 24, laneFoot = opts.laneFoot || 12,
        maxChars = opts.maxChars || 40, margin = opts.margin || 8;
    var ids = {};
    nodes.forEach(function (n) { ids[n.id] = true; });
    var outside = {};
    nodes.forEach(function (n) {
      targetsOf(n).forEach(function (t) { if (!ids[t]) outside[n.id] = (outside[n.id] || 0) + 1; });
      (n.related_by || []).forEach(function (r) { if (r && !ids[r.from]) outside[n.id] = (outside[n.id] || 0) + 1; });
    });
    var lanes = [], boxes = [], byId = {}, y = 0;
    BLOCKS.forEach(function (b) {
      var members = nodes.filter(function (n) { return (blockOf(n) || "decided") === b.key; });
      var x = margin, row = 0, top = y + laneHead;
      members.forEach(function (n) {
        var l = lineOf(n);
        var label = clipText(l.glyph + " " + l.text, maxChars) + (outside[n.id] ? " +" + outside[n.id] : "");
        var w = Math.min(width - 2 * margin, pad * 2 + label.length * charW);
        if (x + w > width - margin && x > margin) { x = margin; row += 1; }
        var box = { id: n.id, label: label, struck: n.status === "superseded", lane: b.key,
                    x: x, y: top + row * (boxH + gapY), w: w, h: boxH };
        boxes.push(box);
        byId[n.id] = box;
        x += w + gapX;
      });
      var height = laneHead + (members.length ? (row + 1) * (boxH + gapY) : boxH) + laneFoot;
      lanes.push({ key: b.key, title: b.title, y: y, height: height, count: members.length });
      y += height;
    });
    var edges = [];
    nodes.forEach(function (n) {
      var from = byId[n.id];
      var rels = (n.relates || []).filter(Boolean).map(function (r) { return { to: r.to, rel: r.rel }; });
      if (n.superseded_by) rels.push({ to: n.superseded_by, rel: "superseded_by" });
      rels.forEach(function (r) {
        var to = byId[r.to];
        if (!to) return;
        edges.push({ from: n.id, to: r.to, rel: r.rel, label: EDGE_LABELS[r.rel] || r.rel,
                     x1: from.x + from.w / 2, y1: from.y + from.h / 2, x2: to.x + to.w / 2, y2: to.y + to.h / 2 });
      });
    });
    return { width: width, height: y, lanes: lanes, boxes: boxes, edges: edges, outside: outside };
  }
```

Extend the `api` object at the bottom:

```js
  var api = {
    CELLS: CELLS, LANES: LANES, hasRel: hasRel, isUnseen: isUnseen, cellOf: cellOf, authorOf: authorOf,
    firstTurn: firstTurn, verdictButtons: verdictButtons, timelineLayout: timelineLayout,
    neighbourhoodLayout: neighbourhoodLayout,
    BLOCKS: BLOCKS, EDGE_LABELS: EDGE_LABELS, blockOf: blockOf, lineOf: lineOf, topicKey: topicKey,
    topicsOf: topicsOf, isNew: isNew, topicLayout: topicLayout
  };
```

- [ ] **Step 4: Run the tests**

Run: `python3 -m unittest tests.test_server.BlocksModelTest -v`
Expected: PASS. Then the whole suite: green.

- [ ] **Step 5: Commit**

```bash
git checkout -b blocks/4-model-js
git add ui/model.js tests/test_server.py
git commit -m "model.js: blocks, lines, topics, layout, new"
```

---

### Task 5: the page — list view, footer, live updates

**Files:**
- Rewrite: `ui/index.html` (the whole file; the old page is discarded)
- Test: `tests/test_server.py` — delete `test_index_carries_the_relation_vocabulary`, `test_index_carries_the_cells_verdicts_and_live_words`, `test_index_carries_the_timeline_words`, `test_index_editor_keeps_its_draft_and_every_status`, the earlier page-words test around lines 150–165 (the one asserting «ход не найден», «правлено вручную» …), and `NewMarksTest` (lines 675–712; it lifts `newIds` from the old page). Keep `test_index_is_self_contained` and `viewer_text`. Add the tests below.

**Interfaces:**
- Consumes: `window.AangModel` from Task 4 (`BLOCKS`, `blockOf`, `lineOf`, `topicsOf`, `isNew`); `/api/map` as it is today (`nodes`, `coverage`, `hook`, `errors`, `transcript_error`, `root`, `session_id`); `/api/events`.
- Produces: page state `state = { map, expanded, topic, since, sinceRead, fetchError }`; `rowHtml(n, topic)`, `expandHtml(n, map)`, `render()`, `load()`, `reveal(id)` — Task 6 extends `expandHtml`, Task 7 adds the topic view into `render()`.

- [ ] **Step 1: Write the failing tests**

```python
    def test_index_carries_the_three_blocks_and_the_footer_words(self):
        text = self.viewer_text()
        for word in ("Решено", "Под вопросом", "Отвергнуто", "карта пуста", "запустите /aang",
                     "карта отстаёт на", "карта покрывает всю сессию", "карта ещё ничего не покрывает",
                     "транскрипт не найден", "хук не установлен", "aang install", "карта невалидна",
                     "/api/events", "aang:visit:", "visibilitychange", "pagehide"):
            self.assertIn(word, text, word)

    def test_index_has_no_controls_and_never_writes(self):
        page = self.request("GET", "/")[2].decode("utf-8")
        for word in ("<input", "<button", "<form", "<select", "<textarea", "method:", "/api/node/",
                     "вердикт", "видел", "скопировать ссылку", "Окрестность", "Ход сессии",
                     "Входящее", "не на карте"):
            self.assertNotIn(word, page, word)
        self.assertEqual(1, page.count("fetch("))
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python3 -m unittest tests.test_server -k index -v`
Expected: the two new tests fail; the deleted ones are gone.

- [ ] **Step 3: Write `ui/index.html`**

```html
<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>aang · что решено</title>
<style>
  :root {
    --bg: #faf9f6; --fg: #1f1d1a; --mute: #7a746c; --line: #e6e1d8; --new: #5b6ee1;
    --decided: #2f7d4f; --open: #b7791f; --rejected: #b23b3b; --c: var(--mute);
  }
  * { box-sizing: border-box; }
  html { font: 15px/1.45 -apple-system, "Segoe UI", system-ui, sans-serif; color: var(--fg); background: var(--bg); }
  body { margin: 0; padding: 18px 20px 28px; max-width: 760px; }
  h2 { display: flex; justify-content: space-between; margin: 24px 0 8px; font-size: 12px; font-weight: 600;
       letter-spacing: .08em; text-transform: uppercase; color: var(--c); }
  section:first-child h2 { margin-top: 0; }
  .b-decided { --c: var(--decided); }
  .b-open { --c: var(--open); }
  .b-rejected { --c: var(--rejected); }
  .group { border-left: 2px solid var(--line); margin: 0 0 10px; padding-left: 10px; }
  .row { position: relative; display: flex; gap: 8px; align-items: baseline; padding: 4px 0; cursor: pointer; }
  .row.new::before { content: ""; position: absolute; left: -12px; top: 7px; bottom: 7px; width: 3px;
                     border-radius: 2px; background: var(--new); }
  .row .g { flex: none; width: 1.2em; text-align: center; color: var(--c); }
  .row .v { flex: none; font-size: 13px; color: var(--c); }
  .row .t { flex: 1; min-width: 0; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .row.open .t { -webkit-line-clamp: unset; }
  .row.struck .t { text-decoration: line-through; color: var(--mute); }
  .row .topic { flex: none; font-size: 12px; color: var(--mute); }
  .row .topic:empty { display: none; }
  .empty { color: var(--mute); padding: 2px 0 2px 12px; }
  .x { padding: 2px 0 10px calc(1.2em + 8px); font-size: 14px; }
  .x .f { display: flex; gap: 10px; margin: 3px 0; }
  .x .k { flex: none; width: 5.5em; padding-top: 2px; font-size: 12px; color: var(--mute); }
  .x .val { flex: 1; min-width: 0; }
  .foot { margin-top: 28px; font-size: 12px; color: var(--mute); }
  .foot code { font: inherit; }
  .bad { color: var(--rejected); }
  @media (max-width: 519px) {
    .row { flex-wrap: wrap; }
    .row .topic { width: 100%; padding-left: calc(1.2em + 8px); }
  }
</style>
</head>
<body>
<main id="main"></main>
<p class="foot" id="foot"></p>
<script src="model.js"></script>
<script>
(function () {
  "use strict";
  var M = window.AangModel;
  var state = { map: null, expanded: {}, topic: null, since: "", sinceRead: false, fetchError: null };

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c];
    });
  }
  function plural(n, one, few, many) {
    var m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }

  function visitKey(map) { return "aang:visit:" + (map.root || "") + ":" + (map.session_id || ""); }
  function readSince(map) { try { return localStorage.getItem(visitKey(map)) || ""; } catch (e) { return ""; } }
  function writeVisit() {
    if (!state.map) return;
    try { localStorage.setItem(visitKey(state.map), new Date().toISOString()); } catch (e) {}
  }

  function nodesOf(map) { return (map.nodes || []).filter(function (n) { return n && n.id; }); }
  function byId(map, id) {
    var nodes = nodesOf(map);
    for (var i = 0; i < nodes.length; i++) if (nodes[i].id === id) return nodes[i];
    return null;
  }

  function fieldHtml(k, v) {
    if (!v) return "";
    return "<div class=\"f\"><span class=\"k\">" + esc(k) + "</span><span class=\"val\">" + v + "</span></div>";
  }

  function expandHtml(n, map) {
    var html = fieldHtml(n.kind === "tacit" ? "откуда" : "почему", esc(n.why));
    if ((n.against || []).length) html += fieldHtml("против", n.against.map(esc).join("<br>"));
    html += fieldHtml("следствие", esc(n.consequence));
    return "<div class=\"x\">" + html + "</div>";
  }

  function rowHtml(n, topic, map) {
    var l = M.lineOf(n);
    var cls = "row" + (M.isNew(n, state.since) ? " new" : "") + (state.expanded[n.id] ? " open" : "") +
              (n.status === "superseded" ? " struck" : "");
    return "<div class=\"" + cls + "\" data-id=\"" + esc(n.id) + "\">" +
      "<span class=\"g\">" + esc(l.glyph) + "</span><span class=\"v\">" + esc(l.verb) + "</span>" +
      "<span class=\"t\">" + esc(l.text) + "</span>" +
      "<span class=\"topic\" data-topic=\"" + esc(topic) + "\">" + esc(topic) + "</span></div>" +
      (state.expanded[n.id] ? expandHtml(n, map) : "");
  }

  function listHtml(map) {
    var nodes = nodesOf(map), groups = M.topicsOf(nodes), lookup = {};
    nodes.forEach(function (n) { lookup[n.id] = n; });
    if (!nodes.length) return "<p class=\"empty\">карта пуста — запустите /aang</p>";
    return M.BLOCKS.map(function (b) {
      var members = {}, count = 0;
      nodes.forEach(function (n) { if (M.blockOf(n) === b.key) { members[n.id] = true; count += 1; } });
      var html = "<section class=\"b-" + b.key + "\"><h2 title=\"" + esc(b.sub) + "\"><span>" + esc(b.title) +
                 "</span><span>" + count + "</span></h2>";
      if (!count) html += "<p class=\"empty\">—</p>";
      groups.forEach(function (g) {
        var ids = g.ids.filter(function (id) { return members[id]; });
        if (!ids.length) return;
        html += "<div class=\"group\">" + ids.slice().reverse().map(function (id) { return rowHtml(lookup[id], g.name, map); }).join("") + "</div>";
      });
      return html + "</section>";
    }).join("");
  }

  function footHtml(map) {
    if (state.fetchError) return "не удалось прочитать /api/map: " + esc(state.fetchError) + " — запущен ли aang view?";
    var parts = [];
    if (map.transcript_error) {
      parts.push("транскрипт не найден: " + esc(map.transcript_error));
    } else {
      var cov = map.coverage || {};
      if (cov.covered_to == null) {
        parts.push("карта ещё ничего не покрывает");
      } else {
        var behind = (cov.turns || 0) - cov.covered_to;
        parts.push(behind > 0 ? "карта отстаёт на " + behind + " " + plural(behind, "ход", "хода", "ходов")
                              : "карта покрывает всю сессию");
      }
    }
    if (map.hook && !map.hook.installed) parts.push("хук не установлен: <code>aang install</code>");
    return parts.join(" · ");
  }

  function render() {
    var map = state.map;
    if (!map) { $("main").innerHTML = ""; $("foot").innerHTML = footHtml({}); return; }
    if (map.errors && map.errors.length) {
      $("main").innerHTML = "<p class=\"bad\">карта невалидна</p><ul>" +
        map.errors.map(function (e) { return "<li>" + esc(e) + "</li>"; }).join("") + "</ul>";
    } else {
      $("main").innerHTML = listHtml(map);
    }
    $("foot").innerHTML = footHtml(map);
  }

  function reveal(id) {
    var map = state.map, n = byId(map, id), guard = 0;
    while (n && n.status === "superseded" && n.superseded_by && guard++ < 50) {
      state.expanded[n.id] = true;
      n = byId(map, n.superseded_by);
    }
    if (n) state.expanded[n.id] = true;
    render();
    var el = document.querySelector("[data-id=\"" + id + "\"]");
    if (el && el.scrollIntoView) el.scrollIntoView({ block: "center" });
  }

  function load() {
    fetch("/api/map", { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function (map) {
      state.fetchError = null;
      state.map = map;
      if (!state.sinceRead) { state.since = readSince(map); state.sinceRead = true; }
      var ids = {};
      nodesOf(map).forEach(function (n) { ids[n.id] = true; });
      Object.keys(state.expanded).forEach(function (id) { if (!ids[id]) delete state.expanded[id]; });
      render();
    }).catch(function (err) {
      state.fetchError = err && err.message ? err.message : String(err);
      render();
    });
  }

  function connect() {
    if (!window.EventSource) return;
    var es = new EventSource("/api/events");
    es.onmessage = function (ev) {
      var data;
      try { data = JSON.parse(ev.data); } catch (e) { return; }
      if (data && data.changed) load();
    };
  }

  document.addEventListener("click", function (ev) {
    var t = ev.target;
    var go = t.closest ? t.closest("[data-go]") : null;
    if (go) { ev.stopPropagation(); reveal(go.getAttribute("data-go")); return; }
    var row = t.closest ? t.closest("[data-id]") : null;
    if (!row) return;
    var id = row.getAttribute("data-id");
    if (state.expanded[id]) delete state.expanded[id]; else state.expanded[id] = true;
    render();
  });
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "hidden") writeVisit(); });
  window.addEventListener("pagehide", writeVisit);
  load();
  connect();
})();
</script>
</body>
</html>
```

- [ ] **Step 4: Look at it**

Run in the worktree: `bin/aang view --port 8791` (or whatever free port; `aang view` may reuse a running server for the same root — use a port the main checkout's viewer does not hold), open `http://127.0.0.1:8791/` at ~560 px width (Playwright `browser_resize` to 560×900 and `browser_take_screenshot`). Expect three block headings with counts, rows with glyph/verb/text and grey topic labels, a footer line. Stop the server afterwards.

- [ ] **Step 5: Run the suite and commit**

Run: `python3 -m unittest discover -s tests -t .` — green.

```bash
git checkout -b blocks/5-page-list
git add ui/index.html tests/test_server.py
git commit -m "viewer: three blocks, one row per node, a footer, live"
```

---

### Task 6: row expansion — question, links, predecessors, citation, author

**Files:**
- Modify: `ui/index.html` (`expandHtml` and helpers; CSS for `.id`, `.unv`, `.sub`)
- Test: `tests/test_server.py`

**Interfaces:**
- Consumes: `state`, `rowHtml`, `fieldHtml`, `esc`, `byId`, `nodesOf` from Task 5; `related_by` and `verified` from `/api/map`.
- Produces: the expansion fields the spec lists under «Раскрытие строки».

- [ ] **Step 1: Write the failing tests**

```python
    def test_index_expansion_words_and_relation_labels(self):
        page = self.request("GET", "/")[2].decode("utf-8")
        for word in ("вопрос", "почему", "откуда", "против", "следствие", "связи", "заменило", "цитата",
                     "не проверено", "без цитаты", "data-go", "заменено на"):
            self.assertIn(word, page, word)
        for rel, label in store.REL_LABELS.items():
            binding = re.compile(r"(?<![\w$])" + re.escape(rel) + r"[\"']?\s*:\s*[\"']" + re.escape(label) + r"[\"']")
            self.assertTrue(binding.search(page), "%s: the viewer does not bind this key to %r" % (rel, label))
        for rel, label in store.REL_LABELS_BACK.items():
            self.assertIn(label, page, label)
```

- [ ] **Step 2: Run to verify it fails**

Run: `python3 -m unittest tests.test_server -k expansion -v` — FAIL on «вопрос»/«связи».

- [ ] **Step 3: Extend the page**

CSS, after `.x .val`:

```css
  .x .id { cursor: pointer; text-decoration: underline dotted; }
  .x .unv { font-size: 12px; color: var(--rejected); }
  .x .sub { margin-top: 4px; border-left: 2px solid var(--line); padding-left: 8px; }
```

JS, after `var state = …`:

```js
  var REL = { orphaned_by: "осиротело решением", rests_on: "опирается на", moots: "сделало неактуальным" };
  var REL_BACK = { orphaned_by: "оставило висеть", rests_on: "на этом держится", moots: "неактуально из-за" };
```

Replace `expandHtml` with:

```js
  function idLink(id) { return "<span class=\"id\" data-go=\"" + esc(id) + "\">" + esc(id) + "</span>"; }

  function linksHtml(n) {
    var parts = [];
    (n.relates || []).forEach(function (r) { if (r && r.to) parts.push(esc(REL[r.rel] || r.rel) + " " + idLink(r.to)); });
    (n.related_by || []).forEach(function (r) { if (r && r.from) parts.push(esc(REL_BACK[r.rel] || r.rel) + " " + idLink(r.from)); });
    if (n.superseded_by) parts.push("заменено на " + idLink(n.superseded_by));
    return parts.join("; ");
  }

  function predecessors(n, map) {
    return nodesOf(map).filter(function (m) { return m.superseded_by === n.id; });
  }

  function citeHtml(n) {
    var c = (n.cites || [])[0];
    if (!c) return "<span class=\"unv\">без цитаты</span>";
    var who = c.role === "user" ? ", вы" : c.role === "assistant" ? ", агент" : "";
    var where = c.ok && typeof c.turn === "number" ? "ход " + c.turn + who + ": " : "";
    var mark = n.verified ? "" : " <span class=\"unv\" title=\"" + esc(c.reason || "") + "\">не проверено</span>";
    return esc(where) + "«" + esc(c.quote) + "»" + mark;
  }

  function authorText(n) {
    if (n.kind !== "decision") return "";
    if (n.triage) return n.decided_by === "agent" ? "предложил агент" : n.decided_by === "user" ? "предложили вы" : "";
    if (n.status === "accepted" && n.decided_by === "agent") return "решил агент";
    if (n.status === "rejected" && n.decided_by === "agent") return "предлагал агент";
    return "";
  }

  function expandHtml(n, map) {
    var l = M.lineOf(n), html = "";
    if (n.question && n.question !== l.text) html += fieldHtml("вопрос", esc(n.question));
    html += fieldHtml(n.kind === "tacit" ? "откуда" : "почему", esc(n.why));
    if ((n.against || []).length) html += fieldHtml("против", n.against.map(esc).join("<br>"));
    html += fieldHtml("следствие", esc(n.consequence));
    html += fieldHtml("связи", linksHtml(n));
    predecessors(n, map).forEach(function (p) {
      html += fieldHtml("заменило", "<div class=\"sub\">" + rowHtml(p, "", map) + "</div>");
    });
    html += fieldHtml("цитата", citeHtml(n));
    html += fieldHtml("кто", esc(authorText(n)));
    return "<div class=\"x\">" + html + "</div>";
  }
```

- [ ] **Step 4: Look at it, run the suite, commit**

Start the viewer as in Task 5, click a row that has relations and one that supersedes another; check the id links scroll and expand. Suite green.

```bash
git checkout -b blocks/6-page-expand
git add ui/index.html tests/test_server.py
git commit -m "viewer: what a row opens into"
```

---

### Task 7: the topic view

**Files:**
- Modify: `ui/index.html` (topic view rendering; click on topic label; `Esc`; resize)
- Test: `tests/test_server.py`

**Interfaces:**
- Consumes: `M.topicLayout`, `M.topicsOf`, `M.EDGE_LABELS` (Task 4); `state.topic`, `render`, `rowHtml` (Tasks 5–6).

- [ ] **Step 1: Write the failing test**

```python
    def test_index_topic_view_words(self):
        page = self.request("GET", "/")[2].decode("utf-8")
        for word in ("← все темы", "data-back", "topicLayout(", "marker-end", "Escape", "вне темы",
                     "data-topic", "lane b-", "box b-"):
            self.assertIn(word, page, word)
```

- [ ] **Step 2: Run to verify it fails**, then **Step 3: extend the page**.

CSS:

```css
  .tv-head { display: flex; gap: 12px; align-items: baseline; margin: 0 0 10px; }
  .tv-head .back { color: var(--mute); cursor: pointer; }
  .mute { font-size: 12px; color: var(--mute); }
  .tv { position: relative; }
  .tv svg { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
  .tv line { stroke: var(--mute); stroke-width: 1; }
  .tv text { font-size: 10px; fill: var(--mute); paint-order: stroke; stroke: var(--bg); stroke-width: 3px; }
  .lane { position: absolute; left: 0; right: 0; border-top: 1px solid var(--line); }
  .lane .lh { position: absolute; top: 4px; left: 0; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--c); }
  .box { position: absolute; padding: 3px 9px; border: 1px solid var(--line); border-left: 3px solid var(--c);
         border-radius: 6px; background: #fff; font-size: 13px; white-space: nowrap; overflow: hidden;
         text-overflow: ellipsis; cursor: pointer; }
  .box.struck { text-decoration: line-through; color: var(--mute); }
  .box.open { border-color: var(--c); }
  .tv-x { margin-top: 12px; }
```

JS: add before `render`:

```js
  function edgeSvg(e) {
    var mx = (e.x1 + e.x2) / 2, my = (e.y1 + e.y2) / 2;
    return "<line x1=\"" + e.x1 + "\" y1=\"" + e.y1 + "\" x2=\"" + e.x2 + "\" y2=\"" + e.y2 + "\" marker-end=\"url(#arr)\"/>" +
           "<text x=\"" + mx + "\" y=\"" + (my - 4) + "\" text-anchor=\"middle\">" + esc(e.label) + "</text>";
  }

  function topicHtml(map, name) {
    var nodes = nodesOf(map), groups = M.topicsOf(nodes), g = null, lookup = {};
    groups.forEach(function (x) { if (x.name === name) g = x; });
    if (!g) return null;
    nodes.forEach(function (n) { lookup[n.id] = n; });
    var members = g.ids.map(function (id) { return lookup[id]; });
    var width = Math.max(300, $("main").clientWidth || 600);
    var L = M.topicLayout(members, width);
    var html = "<p class=\"tv-head\"><span class=\"back\" data-back=\"1\">← все темы</span><b>" + esc(name) +
               "</b><span class=\"mute\">" + members.length + " " + plural(members.length, "узел", "узла", "узлов") + "</span></p>";
    html += "<div class=\"tv\" style=\"height:" + L.height + "px\">";
    L.lanes.forEach(function (lane) {
      html += "<div class=\"lane b-" + lane.key + "\" style=\"top:" + lane.y + "px;height:" + lane.height + "px\">" +
              "<span class=\"lh\">" + esc(lane.title) + "</span></div>";
    });
    html += "<svg width=\"" + width + "\" height=\"" + L.height + "\"><defs><marker id=\"arr\" viewBox=\"0 0 8 8\" refX=\"8\" refY=\"4\" markerWidth=\"6\" markerHeight=\"6\" orient=\"auto\"><path d=\"M0,0 L8,4 L0,8 z\" fill=\"#7a746c\"/></marker></defs>" +
            L.edges.map(edgeSvg).join("") + "</svg>";
    L.boxes.forEach(function (b) {
      var n = lookup[b.id];
      var title = M.lineOf(n).text + (L.outside[b.id] ? " · " + L.outside[b.id] + " " + plural(L.outside[b.id], "связь", "связи", "связей") + " вне темы" : "");
      html += "<div class=\"box b-" + b.lane + (b.struck ? " struck" : "") + (state.expanded[b.id] ? " open" : "") +
              "\" data-id=\"" + esc(b.id) + "\" title=\"" + esc(title) + "\" style=\"left:" + b.x + "px;top:" + b.y +
              "px;width:" + b.w + "px;height:" + b.h + "px\">" + esc(b.label) + "</div>";
    });
    html += "</div>";
    members.forEach(function (n) { if (state.expanded[n.id]) html += "<div class=\"tv-x\">" + rowHtml(n, "", map) + "</div>"; });
    return html;
  }
```

In `render`, replace `$("main").innerHTML = listHtml(map);` with:

```js
      var html = state.topic ? topicHtml(map, state.topic) : null;
      if (html === null) state.topic = null;
      $("main").innerHTML = html === null ? listHtml(map) : html;
```

In the click handler, before the `[data-go]` check:

```js
    var back = t.closest ? t.closest("[data-back]") : null;
    if (back) { state.topic = null; render(); return; }
    var topic = t.closest ? t.closest("[data-topic]") : null;
    if (topic && topic.getAttribute("data-topic")) { ev.stopPropagation(); state.topic = topic.getAttribute("data-topic"); render(); return; }
```

After the `pagehide` listener:

```js
  document.addEventListener("keydown", function (ev) { if (ev.key === "Escape" && state.topic) { state.topic = null; render(); } });
  window.addEventListener("resize", function () { if (state.topic) render(); });
```

- [ ] **Step 4: Look at it, run the suite, commit**

Open a topic with three or more nodes and an edge; check the arrow lands on the target box and the label reads. Suite green.

```bash
git checkout -b blocks/7-topic-view
git add ui/index.html tests/test_server.py
git commit -m "viewer: one topic as three lanes with edges"
```

---

### Task 8: server read-only; `triage.py` and the old model functions go

**Files:**
- Modify: `src/aang/server.py` — module docstring; imports (`triage` → `blocks`); delete `TAIL_TEXT_CAP`, `EDITABLE_FIELDS`, `MAX_BODY`, `do_POST`, `_mutate`, `_post_edit`, `_post_verdict`, `_post_seen`, `_read_body`, `_origin_allowed`, `_content_type_is_json`, `Server.write_lock`; change `annotate`
- Modify: `src/aang/store.py:32` — `VIEW_FIELDS = ("related_by", "verified", "block")`
- Modify: `src/aang/hook.py` — the coverage line no longer reads `tail`
- Delete: `src/aang/triage.py`, `tests/test_triage.py`
- Modify: `ui/model.js` — delete `CELLS`, `LANES`, `SUPERSEDED_GAP`, `hasRel`, `isUnseen`, `cellOf`, `authorOf`, `firstTurn`, `verdictButtons`, `timelineLayout`, `neighbourhoodLayout` and their helpers; `api` keeps only the Task 4 names
- Test: `tests/test_server.py` — delete `EditTest`, `VerdictRouteTest`, `SeenRouteTest`, `EditNewFieldsTest`, `CellAndTailTest`, the POST/Origin tests (`test_post_and_index_gated_too`, `test_reviewers_cross_site_post_is_refused`, `test_foreign_origins_403`, `test_own_origins_accepted`, `test_origin_and_content_type_checked_before_the_body_is_touched`), the cell/timeline/neighbourhood/verdict JS tests (`test_cells_match_python_order` … `test_every_offered_button_is_a_verdict_python_accepts`), `_TIMELINE_OPTS`, `_NEIGHBOURHOOD_OPTS`; rewrite `ViewOverHttpHasNewKeysTest`; add the tests below. `tests/test_store.py::test_cell_is_stripped_like_related_by` → `block`. `tests/test_hook.py`: any test that feeds a view with `tail` to `prompt_context` builds `coverage` instead.

**Interfaces:**
- Produces: `/api/map` nodes carry `block`, `topic`, `related_by`, `verified`; top level carries `topics`; no `cell`, no `tail`; `POST` anything → 501 from `BaseHTTPRequestHandler`.

- [ ] **Step 1: Write the failing tests**

```python
class ReadOnlyApiTest(ServerTestCase):
    def test_api_map_carries_block_topic_topics_and_not_cell_or_tail(self):
        view = json.loads(self.request("GET", "/api/map")[2])
        self.assertNotIn("tail", view)
        self.assertEqual([g["name"] for g in blocks.topics(view["nodes"])], [g["name"] for g in view["topics"]])
        for node in view["nodes"]:
            self.assertNotIn("cell", node)
            self.assertEqual(blocks.block(node), node["block"])
            self.assertEqual(node["topic"], blocks.topic_of(view["nodes"])[node["id"]])
        self.assertIn("coverage", view)
        self.assertIn("hook", view)

    def test_post_is_not_a_thing_and_changes_nothing(self):
        before = store.load(self.root)
        status = self.request("POST", "/api/node/d1/verdict", body=json.dumps({"verdict": "rejected", "text": ""}),
                              origin="http://127.0.0.1:%d" % self.port)[0]
        self.assertEqual(501, status)
        status = self.request("POST", "/api/node/d1", body=json.dumps({"why": "x"}),
                              origin="http://127.0.0.1:%d" % self.port)[0]
        self.assertEqual(501, status)
        self.assertEqual(before, store.load(self.root))
```

Check `ServerTestCase.request` (lines 55–90) still lets you send a `POST` with a body and origin after the helper edits; keep whatever parameters it needs.

- [ ] **Step 2: Run to verify they fail** (`POST` still answers 200/4xx; `cell` present).

- [ ] **Step 3: Change `server.py`**

Imports: `from . import blocks, schema, session, store, transcript`. Delete the constants and methods listed above. Module docstring: drop the `POST` lines; describe `GET /api/map` as carrying `block`, `topic`, `topics`, `coverage`, `hook`, `root`.

In `annotate`: remove `"tail": []` from `view`; replace the `cell` loop tail and the tail computation with:

```python
    reverse = {}  # type: Dict[str, List[Dict[str, str]]]
    for node in view["nodes"]:
        for rel in node.get("relates") or []:
            target = rel.get("to")
            if target:
                reverse.setdefault(target, []).append({"from": node["id"], "rel": rel.get("rel", "")})
    names = blocks.topic_of(view["nodes"])
    for node in view["nodes"]:
        node["related_by"] = reverse.get(node["id"], [])
        node["block"] = blocks.block(node)
        node["topic"] = names.get(node["id"], "")
    view["topics"] = blocks.topics(view["nodes"])
    view["coverage"]["covered_to"] = max(covered) if covered else None
    return view
```

and add `"topics": []` to the initial `view` dict so an invalid map keeps its shape. Update the docstring: `cell`/`tail` paragraphs become one about `block`, `topic` (the resolved name — a node without its own `topic` gets its component's) and `topics`.

In `Server.__init__`, delete `self.write_lock = threading.Lock()`; if `threading` is then unused apart from `Watcher`, it stays imported for `Watcher`.

- [ ] **Step 4: `hook.py`, `store.py`, `model.js`, deletions**

`hook.py`, in `prompt_context`, replace

```python
    if parts and view.get("tail"):
```

with

```python
    behind = cov.get("covered_to") is not None and (cov.get("turns") or 0) > cov["covered_to"]
    if parts and behind:
```

(move the `cov = view.get("coverage") or {}` line above it). `store.VIEW_FIELDS = ("related_by", "verified", "block")`. `git rm src/aang/triage.py tests/test_triage.py`. In `ui/model.js` delete everything the file list above names; the `api` object becomes:

```js
  var api = {
    BLOCKS: BLOCKS, EDGE_LABELS: EDGE_LABELS, blockOf: blockOf, lineOf: lineOf, topicKey: topicKey,
    topicsOf: topicsOf, isNew: isNew, topicLayout: topicLayout
  };
```

`grep -rn "triage\b" src tests` must show nothing but the `triage` *field* (`node.get("triage")`, `"triage":`) — no module references.

- [ ] **Step 5: Run the suite, commit**

```bash
git checkout -b blocks/8-server-read-only
git add -A src/aang ui/model.js tests
git commit -m "server: read-only; blocks and topics on the API; triage.py gone"
```

---

### Task 9: outbox out of hook, session, cli

**Files:**
- Modify: `src/aang/hook.py` (`_prompt`: drop the `_after` branch; `prompt_context`: drop the outbox block and `VERDICT_WORDS`; `run`: if it pops `_after`, remove that too — grep `_after`), `src/aang/session.py` (delete `OUTBOX_FILE`, `outbox_append`, `outbox_read`, `outbox_clear`; docstring), `src/aang/cli.py` (`_gitignore_missing`: `wanted` without `outbox.jsonl`; docstring «two files»), `.gitignore` (drop `.aang/outbox.jsonl`)
- Test: `tests/test_session.py` (delete `OutboxTest`), `tests/test_hook.py` (delete `test_outbox_is_delivered_then_cleared`, `test_outbox_is_cleared_only_after_the_answer_was_written`; add the test below), `tests/test_cli.py` (`test_merge_hints_gitignore_once` expects two names)

- [ ] **Step 1: Write the failing test** (in `tests/test_hook.py`, in the class that tests `UserPromptSubmit`; use its helpers for a root with a map and a payload):

```python
    def test_a_stale_outbox_is_ignored_and_left_alone(self):
        path = os.path.join(self.root, ".aang", "outbox.jsonl")
        with open(path, "w", encoding="utf-8") as handle:
            handle.write('{"at": "2026-09-11T12:00:00Z", "kind": "rejected", "node": "d1", "text": ""}\n')
        answer = self.prompt("что с d1?")
        self.assertNotIn("Из вьюера", answer["hookSpecificOutput"]["additionalContext"])
        self.assertNotIn("_after", answer)
        with open(path, encoding="utf-8") as handle:
            self.assertEqual(1, len(handle.read().splitlines()))
```

Adapt `self.prompt(...)` to whatever helper the file uses to run a `UserPromptSubmit` payload through `hook.handle`.

- [ ] **Step 2: Run to verify it fails**, **Step 3: make the deletions**, **Step 4: suite green**, **Step 5: commit**

```bash
git checkout -b blocks/9-no-outbox
git add -A src/aang tests .gitignore
git commit -m "hook: no outbox — verdicts are words in the chat"
```

---

### Task 10: skill, README, spec pointer

**Files:**
- Modify: `.claude/skills/aang/SKILL.md`, `README.md`, `docs/superpowers/specs/2026-09-11-live-companion-design.md` (one paragraph at the top)

This PR is documentation and is the plan's allowed exception to the 400-line cap.

- [ ] **Step 1: SKILL.md**

1. In «The file» (the JSON example around line 342–376): add `"topic": "оценка"` to the example node after `"triage"`, and a bullet after the `triage` bullet:

   > - `topic`: the part of the work this node belongs to, 1–3 words, lower case, no full stop («размер PR», «модели», «вьюер»). It answers «what was this about», never «what kind of node is this». Nodes joined by edges are almost always one topic — if you give them two, check the edge. A map usually has 3–7 topics; past ten they are too fine. The viewer groups the three blocks (решено / под вопросом / отвергнуто) by topic and draws one topic at a time as a graph; a node without a topic falls into the topic of whatever it is linked to, or into one named by the first words of its question.

2. In «Пачка в конце шага», the bullet «A verdict the user gave in the chat»: delete the sentence «The same four verdicts arrive from the viewer through `.aang/outbox.jsonl` (Procedure, step 0); they mean the same thing and are written the same way.» and end the bullet with: «The viewer is read-only: a verdict is always words in the chat, and you are the one who writes it into the map.»

3. In «Procedure»: delete step 0 entirely; renumber nothing (steps stay 1…). In the step that reports the result (around line 466–468, «marked seen»): drop «marked seen».

4. In «Never»: delete the `seen_at` bullet.

5. Anywhere else `grep -n "outbox\|seen_at\|Входящ\|видел" .claude/skills/aang/SKILL.md` still hits, rewrite the sentence to the read-only world.

- [ ] **Step 2: README.md**

1. «Live» section: replace the two paragraphs about verdicts and cells with:

   > On `UserPromptSubmit` the hook adds to your prompt, when you name a node by id («что с d4?»), that node in full: question, status, author, its relations and what rests on it. On `Stop` … (keep the nudge sentences as they are).
   >
   > The viewer is three blocks — **Решено**, **Под вопросом**, **Отвергнуто** — one line per node, grouped by the `topic` the model wrote. A topic runs through all three blocks; click its name and the page shows that topic alone, its nodes in the same three lanes with the edges drawn between them. Rows added since you last looked carry a thin blue stripe; the browser remembers the visit, the server writes nothing. One line at the bottom says how far the map trails the transcript. The page follows the files by itself: a merge or a new turn redraws it without losing what you opened. It is read-only — a verdict is a sentence to the agent in the chat, and the next `/aang` writes it down.

2. The `.gitignore` sentence: «`.aang/session.json` and `.aang/candidate.json` are this machine's working state».
3. The node example: drop `"seen_at": null`, add `"topic": "оценка"` after `"triage"`.
4. The paragraph «Three more fields carry state…»: replace the `seen_at` sentences and the cell sentences with: «`topic` is the part of the work the node belongs to, 1–3 words, written by the model; the viewer and the export group by it. From `kind`, `status` and `triage` the viewer derives each node's **block** — Решено, Под вопросом or Отвергнуто — a rule, never a stored field.»
5. Files table: drop the `outbox.jsonl` row.
6. `grep -n "outbox\|seen_at\|видел\|Входящее\|cell" README.md` — rewrite every remaining hit.

- [ ] **Step 3: old spec pointer**

At the top of `docs/superpowers/specs/2026-09-11-live-companion-design.md`, after the title, add:

> **2026-09-12:** the viewer, cells, verdicts, timeline, neighbourhood, header and outbox in this document are superseded by `2026-09-12-three-blocks-design.md`. The hook, install and Codex sections stand.

- [ ] **Step 4: Commit**

```bash
git checkout -b blocks/10-docs
git add .claude/skills/aang/SKILL.md README.md docs/superpowers/specs/2026-09-11-live-companion-design.md
git commit -m "docs: topic, three blocks, no outbox"
```

---

### Task 11: dogfood map with topics, then perception review rounds

This task is run by the controller, not by an implementer; it produces the last PR (map + `docs/decisions.md`, a docs exception) and drives the fix rounds the spec's «Процесс проверки восприятия» requires.

- [ ] **Step 1: a map with topics.** Build `.aang/candidate.json` from `.aang/map.json` in the worktree by a scratchpad script: keep every node's content fields, drop `added_at`/`hand_edited`/turn numbers, and add a `topic` to each node (the controller was in the session and names them: «модели», «размер PR», «комментарии», «вьюер», «хук», «карта», «авторство» — whatever the nodes are actually about). Run `bin/aang merge` (with `--session d77840c4-ca7d-450d-9536-c95f625f992a` if `.aang/session.json` is absent in the worktree), then `bin/aang check`, then `bin/aang export > docs/decisions.md`.
- [ ] **Step 2: round 1 review.** Start `bin/aang view --port 8791` in the worktree. Dispatch a reviewer on `fable` with the Playwright tools: resize to 560×900, screenshot the list, expand two rows (one with relations, one with a predecessor), open the largest topic, screenshot each; answer the spec's three questions and list every element that answers none of them, with a concrete fix per item. Report to a file in the plan workspace.
- [ ] **Step 3: fix.** Dispatch an implementer on `fable` with the report; fixes go into `ui/index.html` / `ui/model.js` (and tests when a rule changes) as one commit on `blocks/11-polish`.
- [ ] **Step 4: round 2 review**, same reviewer prompt, fresh agent. Repeat 3–4 until the reviewer finds nothing under questions 1–2. Every round is a commit on the same branch.
- [ ] **Step 5: commit the map**

```bash
git checkout -b blocks/11-dogfood
git add .aang/map.json docs/decisions.md
git commit -m "aang: this session's map with topics"
```
