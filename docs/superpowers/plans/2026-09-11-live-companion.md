# Live Companion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `aang` into a live companion of a Claude Code or Codex session: the map updates itself through harness hooks, the viewer refreshes in place, shows a turn timeline and triage cells, takes verdicts that reach the agent, and both harnesses are served by one implementation.

**Architecture:** Three new Python modules (`triage.py` — cell and verdict rules; `session.py` — `.aang/session.json`, outbox, config; `hook.py` — the `aang hook` command; `install.py` — `aang install`) plus additive changes to `schema`, `store`, `transcript`, `server`, `cli`. The viewer gains `ui/model.js` (pure functions: cells, timeline coordinates, neighbourhood layout, testable under node) and new view code in `ui/index.html` (SSE client, tail strip, cells, verdict buttons, timeline SVG, mini-graph). The skill text and README follow.

**Tech Stack:** Python 3.9 standard library only (no dependencies, comment-style type hints, `http.server`), vanilla JS/SVG in one HTML page plus one JS file, `unittest`.

**Spec:** `docs/superpowers/specs/2026-09-11-live-companion-design.md` (this plan argues from it; read it first). Earlier specs still binding: `docs/spec.md` (R1–R8), `docs/superpowers/specs/2026-09-11-map-relations-and-search-design.md` (U1–U10).

## Global Constraints

- Python 3.9, standard library only; comment-style type hints (`# type: (...) -> ...`); no `match`, no `X | Y` unions, no dataclass slots.
- Server binds `127.0.0.1` only; every new `POST` route keeps the `Host`, `Origin` and `Content-Type` gates that `do_POST` already applies (R7).
- No canvas, no graph library, no persisted positions (U10 / L9). Timeline position is a pure function of `(turn, kind)` at 12 px per turn (L3).
- All user-facing strings are Russian, identifiers as written in the file. Error strings name the node and the field.
- Every new file in `.aang/` is written atomically (temp file + `os.replace`), like `store.save`.
- `aang hook` always exits 0 and prints nothing on stdout when it has nothing to say; internal errors go to stderr.
- Tests: `python3 -m unittest discover -s tests -t .` from the repo root (the `tests/__init__.py` + `-t .` layout puts `src` on the path through `tests/__init__.py`; keep it). Tests that run JS use `node` and are skipped without it (`@unittest.skipUnless(shutil.which("node"), ...)`), as in `tests/test_server.py::NewMarksTest`.
- Commit after each task with the trailer lines from the session's attribution reminder.
- Work in the worktree `/Users/karych/src/aang/.claude/worktrees/live-companion`, branch `worktree-live-companion`. Never `cd` to the main checkout.
- **No line comments** (`# …`, `// …`) in any code you write or touch; module and function docstrings are allowed and are where the contract lives; `# type: (...) -> ...` hints are syntax, not comments, and stay. Where a task's code block above contains a `#` comment, drop the comment and keep the code (move a needed explanation into the docstring).
- **Delivery in PRs under 400 lines** (tests and fixtures count): each PR holds 1–2 plan tasks; when a task's diff would exceed 400 lines, the implementer splits it into two commits that can be two PRs. The stack merges into `master` one PR after another; a later task may depend on an earlier PR being merged.

## File Structure

| file | responsibility |
|---|---|
| `src/aang/schema.py` (modify) | vocabulary: `rejected` status, `decided_by`, `triage`, `seen_at`; validation; `decided_by` remark |
| `src/aang/triage.py` (create) | `cell(node)` — the derived cell; `apply_verdict(node, verdict, text)` — the verdict table; cell titles |
| `src/aang/session.py` (create) | `.aang/session.json`, `.aang/outbox.jsonl`, `.aang/config.json`; `find_root`; `now_iso` |
| `src/aang/store.py` (modify) | merge keeps `seen_at`, strips `cell`; export grouped by cell, shows author and `rejected` |
| `src/aang/transcript.py` (modify) | Codex format detection and indexing; session lookup across both trees; `cwd` preference |
| `src/aang/server.py` (modify) | `TranscriptSource` honours `session.json`; `annotate` adds `cell`, `tail`, `hook`, `root`; routes `/api/node/<id>/verdict`, `/api/node/<id>/seen`, `/api/events`, `/model.js`; file watcher |
| `src/aang/hook.py` (create) | `aang hook`: SessionStart / UserPromptSubmit / Stop for both harnesses |
| `src/aang/install.py` (create) | `aang install`: idempotent hook entries in `~/.claude/settings.json` and `~/.codex/hooks.json` |
| `src/aang/cli.py` (modify) | `hook` and `install` verbs; `merge`/`check`/`export`/`view` use `session.json`; `.gitignore` hint; `view` reuses a running server |
| `ui/model.js` (create) | pure functions: `cellOf`, `cellOrder`, `isUnseen`, `timelineLayout`, `neighbourhoodLayout` |
| `ui/index.html` (modify) | SSE client, tail strip, cells, author marker + filter, verdict buttons, seen, copy link, hook status, timeline SVG, mini-graph |
| `.claude/skills/aang/SKILL.md` (modify) | model-invocable; `merge` without `--session`; outbox step; «Пачка в конце шага»; `decided_by`/`triage`/`rejected` |
| `README.md` (modify) | install lines for hooks and the Codex skill; new commands; new fields |
| `tests/fixtures/codex.jsonl` (create) | a Codex rollout with `session_meta`, `item_completed`, an injected `response_item` |
| `tests/test_triage.py`, `tests/test_session.py`, `tests/test_hook.py`, `tests/test_install.py` (create); others (modify) | as listed per task |

---

### Task 1: Schema vocabulary — `rejected`, `decided_by`, `triage`, `seen_at`

**Files:**
- Modify: `src/aang/schema.py` (constants at top, `_validate_node`, `warnings`, `normalize`)
- Test: `tests/test_schema.py`

**Interfaces:**
- Consumes: nothing new.
- Produces: `schema.STATUSES == ("accepted", "superseded", "proposed", "rejected")`; `schema.DECIDERS == ("user", "agent")`; `schema.TRIAGES == ("research", "discuss")`; `normalize` sets `decided_by`, `triage`, `seen_at` to `None` when absent; `validate` rules and `warnings` remark below.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_schema.py` (the helpers `_node` and `_map` already exist there: `_node(node_id, kind="decision", status="accepted", relates=None, added_at="", **fields)` builds a valid node with a cite):

```python
class TriageFieldsTest(unittest.TestCase):
    def errors(self, *nodes):
        return schema.validate(schema.normalize(_map(list(nodes))))

    def test_rejected_is_a_status(self):
        self.assertEqual([], self.errors(_node("d1", status="rejected")))
        self.assertEqual([], self.errors(_node("t1", kind="tacit", status="rejected")))

    def test_open_cannot_be_rejected_or_accepted(self):
        errs = self.errors(_node("o1", kind="open", status="rejected", decision=""))
        self.assertTrue(any("узел o1, поле status" in e and "open" in e for e in errs), errs)

    def test_decided_by_only_on_decisions(self):
        self.assertEqual([], self.errors(_node("d1", decided_by="user")))
        self.assertEqual([], self.errors(_node("d1", decided_by="agent")))
        self.assertEqual([], self.errors(_node("d1")))  # absent is unknown, not an error
        errs = self.errors(_node("d1", decided_by="nobody"))
        self.assertTrue(any("узел d1, поле decided_by" in e for e in errs), errs)
        errs = self.errors(_node("t1", kind="tacit", decided_by="user"))
        self.assertTrue(any("узел t1, поле decided_by" in e and "tacit" in e for e in errs), errs)
        errs = self.errors(_node("o1", kind="open", decision="", decided_by="user"))
        self.assertTrue(any("узел o1, поле decided_by" in e for e in errs), errs)

    def test_triage_vocabulary_and_placement(self):
        self.assertEqual([], self.errors(_node("d1", status="proposed", triage="research")))
        self.assertEqual([], self.errors(_node("o1", kind="open", status="proposed", decision="", triage="discuss")))
        self.assertEqual([], self.errors(_node("d1", triage=None)))
        errs = self.errors(_node("d1", status="proposed", triage="later"))
        self.assertTrue(any("узел d1, поле triage" in e and "research/discuss" in e for e in errs), errs)
        for status in ("accepted", "rejected"):
            errs = self.errors(_node("d1", status=status, triage="research"))
            self.assertTrue(any("узел d1, поле triage" in e and status in e for e in errs), (status, errs))
        errs = self.errors(_node("d1", status="superseded", superseded_by="d2", triage="research"), _node("d2"))
        self.assertTrue(any("узел d1, поле triage" in e for e in errs), errs)

    def test_seen_at_is_string_or_null(self):
        self.assertEqual([], self.errors(_node("d1", seen_at="2026-09-11T12:00:00Z")))
        self.assertEqual([], self.errors(_node("d1", seen_at=None)))
        errs = self.errors(_node("d1", seen_at=5))
        self.assertTrue(any("узел d1, поле seen_at" in e for e in errs), errs)

    def test_normalize_fills_the_three_fields(self):
        m = schema.normalize(_map([_node("d1")]))
        n = m["nodes"][0]
        self.assertIn("decided_by", n); self.assertIsNone(n["decided_by"])
        self.assertIn("triage", n); self.assertIsNone(n["triage"])
        self.assertIn("seen_at", n); self.assertIsNone(n["seen_at"])


class DecidedByRemarkTest(unittest.TestCase):
    def test_user_claim_without_user_quote_is_a_remark(self):
        node = _node("d1", decided_by="user")
        node["cites"] = [{"quote": "три слова тут есть", "turn": 2, "role": "assistant"}]
        out = schema.warnings(_map([node]))
        self.assertIn("узел d1: заявлено решение пользователя, но среди цитат нет его слов", out)

    def test_user_claim_with_a_user_quote_is_silent(self):
        node = _node("d1", decided_by="user")
        node["cites"] = [{"quote": "три слова тут есть", "turn": 2, "role": "user"}]
        self.assertEqual([], [w for w in schema.warnings(_map([node])) if "decided_by" in w or "пользователя" in w])

    def test_agent_claim_never_remarks(self):
        node = _node("d1", decided_by="agent")
        node["cites"] = [{"quote": "три слова тут есть", "turn": 2, "role": "user"}]
        self.assertEqual([], [w for w in schema.warnings(_map([node])) if "пользователя" in w])
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python3 -m unittest tests.test_schema.TriageFieldsTest tests.test_schema.DecidedByRemarkTest -v`
Expected: FAIL — `rejected` is refused, `decided_by`/`triage` unknown, `normalize` does not fill them.

- [ ] **Step 3: Implement**

In `src/aang/schema.py`:

```python
STATUSES = ("accepted", "superseded", "proposed", "rejected")
DECIDERS = ("user", "agent")
TRIAGES = ("research", "discuss")
# `triage` marks a position still open to question; a settled one carries none.
_TRIAGE_STATUSES = ("proposed",)
```

In `_validate_node`, after the `status` check add the `open` rule and the three fields:

```python
    if kind == "open" and status in ("accepted", "rejected"):
        errors.append("%s, поле status: для kind=open допустимы только proposed/superseded — "
                      "открытый вопрос нельзя принять или отвергнуть, только ответить" % label)

    decided_by = node.get("decided_by")
    if decided_by is not None:
        if decided_by not in DECIDERS:
            errors.append("%s, поле decided_by: ожидается user/agent или null, получено %r" % (label, decided_by))
        elif kind is not None and kind != "decision":
            errors.append("%s, поле decided_by: только у решений, а это kind=%s" % (label, kind))

    triage = node.get("triage")
    if triage is not None:
        if triage not in TRIAGES:
            errors.append("%s, поле triage: ожидается одно из %s или null, получено %r"
                          % (label, "/".join(TRIAGES), triage))
        elif status is not None and status not in _TRIAGE_STATUSES:
            errors.append("%s, поле triage: под вопросом может быть только proposed, а статус %s"
                          % (label, status))

    seen_at = node.get("seen_at")
    if seen_at is not None and not _is_str(seen_at):
        errors.append("%s, поле seen_at: ожидается строка (ISO-8601) или null" % label)
```

In `warnings`, inside the per-node loop (before the `for missing in sorted(mentioned)` loop):

```python
        if node.get("decided_by") == "user" and not any(
                isinstance(c, dict) and c.get("role") == "user" for c in (node.get("cites") or [])):
            out.append("%s: заявлено решение пользователя, но среди цитат нет его слов" % label)
```

In `normalize`, inside the node loop next to `added_at`:

```python
        for field in ("decided_by", "triage", "seen_at"):
            node.setdefault(field, None)
```

Update the module docstring's list of fields and the `docs/plan.md` "The map format" reference is not touched (the spec is the authority now).

- [ ] **Step 4: Run the whole schema suite**

Run: `python3 -m unittest tests.test_schema -v`
Expected: all PASS, including the older tests (none of them used `rejected` or the new fields).

- [ ] **Step 5: Commit**

```bash
git add src/aang/schema.py tests/test_schema.py
git commit -m "schema: rejected status, decided_by, triage, seen_at; remark on user claim without user quote"
```

---

### Task 2: `triage.py` — cells and the verdict table

**Files:**
- Create: `src/aang/triage.py`
- Test: `tests/test_triage.py`

**Interfaces:**
- Consumes: `schema.STATUSES`, `schema.DECIDERS`, `schema.TRIAGES`.
- Produces:
  - `triage.CELLS` — ordered tuple of `(key, title, subtitle)`: `inbox` «Входящее», `research` «Ресерч», `discuss` «Обсудить», `confirmed` «Подтверждено», `rejected` «Отвергнуто», `tacit` «Неявные решения», `orphaned` «Осиротело решениями», `hanging` «Просто висит», `decisions` «Решения» (the residual: superseded, and `proposed` not by the agent).
  - `triage.is_unseen(node) -> bool`
  - `triage.cell(node) -> str` (a key from `CELLS`)
  - `triage.VERDICTS == ("confirmed", "rejected", "research", "discuss")`
  - `triage.apply_verdict(node, verdict, text) -> Optional[str]` — mutates `node` per the spec table, returns an error string or `None`. Sets `hand_edited: True` on success.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_triage.py`:

```python
import unittest

from aang import triage


def node(node_id, kind="decision", status="accepted", **fields):
    base = {"id": node_id, "kind": kind, "status": status, "superseded_by": None,
            "question": "Вопрос?", "decision": "" if kind == "open" else "Ответ", "why": "потому",
            "against": [], "consequence": "", "cites": [], "relates": [], "hand_edited": False,
            "added_at": "2026-09-11T12:00:00Z", "decided_by": None, "triage": None, "seen_at": None}
    base.update(fields)
    return base


class CellTest(unittest.TestCase):
    def test_order_of_rules(self):
        self.assertEqual("rejected", triage.cell(node("d1", status="rejected", triage=None)))
        self.assertEqual("research", triage.cell(node("d1", status="proposed", triage="research", decided_by="agent")))
        self.assertEqual("discuss", triage.cell(node("o1", kind="open", status="proposed", triage="discuss")))
        self.assertEqual("confirmed", triage.cell(node("d1", status="accepted", decided_by="user")))
        self.assertEqual("confirmed", triage.cell(node("d1", status="accepted")))
        self.assertEqual("inbox", triage.cell(node("d1", status="proposed", decided_by="agent")))
        self.assertEqual("inbox", triage.cell(node("o1", kind="open", status="proposed")))

    def test_open_leaves_inbox_once_seen(self):
        seen = node("o1", kind="open", status="proposed", seen_at="2026-09-11T13:00:00Z",
                    relates=[{"to": "d1", "rel": "orphaned_by"}])
        self.assertEqual("orphaned", triage.cell(seen))
        seen["relates"] = []
        self.assertEqual("hanging", triage.cell(seen))
        stale = node("o1", kind="open", status="proposed", seen_at="2026-09-11T11:00:00Z")  # seen before re-added
        self.assertEqual("inbox", triage.cell(stale))

    def test_agent_proposal_stays_in_inbox_after_seen(self):
        self.assertEqual("inbox", triage.cell(node("d1", status="proposed", decided_by="agent", seen_at="2026-09-11T13:00:00Z")))

    def test_residuals(self):
        self.assertEqual("tacit", triage.cell(node("t1", kind="tacit")))
        self.assertEqual("decisions", triage.cell(node("d1", status="superseded", superseded_by="d2")))
        self.assertEqual("decisions", triage.cell(node("d1", status="proposed", decided_by="user")))
        self.assertEqual("decisions", triage.cell(node("d1", status="proposed")))  # author unknown: not the agent's inbox

    def test_cells_are_ordered_and_titled(self):
        keys = [c[0] for c in triage.CELLS]
        self.assertEqual(["inbox", "research", "discuss", "confirmed", "rejected", "tacit", "orphaned", "hanging", "decisions"], keys)
        self.assertEqual("Входящее", dict((k, t) for k, t, _ in triage.CELLS)["inbox"])


class UnseenTest(unittest.TestCase):
    def test_rules(self):
        self.assertTrue(triage.is_unseen(node("d1")))
        self.assertTrue(triage.is_unseen(node("d1", seen_at="2026-09-11T11:00:00Z")))
        self.assertFalse(triage.is_unseen(node("d1", seen_at="2026-09-11T12:00:00Z")))
        self.assertFalse(triage.is_unseen(node("d1", added_at="", seen_at="2026-09-11T12:00:00Z")))
        self.assertTrue(triage.is_unseen(node("d1", added_at="")))  # unknown age, never seen


class VerdictTest(unittest.TestCase):
    def test_confirm_open_needs_text_and_becomes_a_user_decision(self):
        n = node("o1", kind="open", status="proposed", triage="research")
        self.assertIn("ответ", triage.apply_verdict(n, "confirmed", "   "))
        self.assertEqual("open", n["kind"])
        self.assertIsNone(triage.apply_verdict(n, "confirmed", "Меряем на этой машине"))
        self.assertEqual(("decision", "Меряем на этой машине", "accepted", "user", None, True),
                         (n["kind"], n["decision"], n["status"], n["decided_by"], n["triage"], n["hand_edited"]))

    def test_confirm_tacit_keeps_its_value(self):
        n = node("t1", kind="tacit", decision="Python 3.9")
        self.assertIsNone(triage.apply_verdict(n, "confirmed", ""))
        self.assertEqual(("decision", "Python 3.9", "accepted", "user"), (n["kind"], n["decision"], n["status"], n["decided_by"]))

    def test_confirm_proposed_or_rejected_decision(self):
        for status in ("proposed", "rejected"):
            n = node("d1", status=status, decided_by="agent", triage="discuss" if status == "proposed" else None)
            self.assertIsNone(triage.apply_verdict(n, "confirmed", ""))
            self.assertEqual(("accepted", "user", None), (n["status"], n["decided_by"], n["triage"]))

    def test_reject_any_but_superseded_and_keeps_the_comment(self):
        n = node("d1", status="accepted", triage=None, against=["старый довод"])
        self.assertIsNone(triage.apply_verdict(n, "rejected", "не хочу так"))
        self.assertEqual(("rejected", None, ["старый довод", "не хочу так"]), (n["status"], n["triage"], n["against"]))
        t = node("t1", kind="tacit")
        self.assertIsNone(triage.apply_verdict(t, "rejected", ""))
        self.assertEqual(("tacit", "rejected"), (t["kind"], t["status"]))
        s = node("d2", status="superseded", superseded_by="d3")
        self.assertIn("заменён", triage.apply_verdict(s, "rejected", ""))
        self.assertEqual("superseded", s["status"])

    def test_reject_open_turns_it_into_a_rejected_decision_of_the_user(self):
        # An open question cannot carry `rejected` (schema); rejecting it means "this should not be
        # pursued" — recorded as a decision the user made, with the reason as the answer.
        n = node("o1", kind="open", status="proposed")
        self.assertIn("почему", triage.apply_verdict(n, "rejected", ""))
        self.assertIsNone(triage.apply_verdict(n, "rejected", "не нужно"))
        self.assertEqual(("decision", "не нужно", "rejected", "user"), (n["kind"], n["decision"], n["status"], n["decided_by"]))

    def test_research_and_discuss(self):
        n = node("d1", status="accepted", decided_by="user")
        self.assertIsNone(triage.apply_verdict(n, "research", ""))
        self.assertEqual(("proposed", "research"), (n["status"], n["triage"]))
        o = node("o1", kind="open", status="proposed")
        self.assertIsNone(triage.apply_verdict(o, "discuss", ""))
        self.assertEqual(("proposed", "discuss"), (o["status"], o["triage"]))
        r = node("d2", status="rejected")
        self.assertIn("отвергнут", triage.apply_verdict(r, "discuss", ""))
        s = node("d3", status="superseded", superseded_by="d1")
        self.assertIn("заменён", triage.apply_verdict(s, "research", ""))

    def test_unknown_verdict(self):
        self.assertIn("вердикт", triage.apply_verdict(node("d1"), "maybe", ""))
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m unittest tests.test_triage -v`
Expected: FAIL — `ModuleNotFoundError: aang.triage`.

- [ ] **Step 3: Implement `src/aang/triage.py`**

```python
"""Triage: which cell a node falls in, and what a verdict does to it.

Spec: docs/superpowers/specs/2026-09-11-live-companion-design.md, «Ячейки» and «Вердикт».
The cell is derived — never stored — from `status`, `triage`, `kind`, `decided_by` and
`seen_at`; the server puts it on each node of `/api/map` as `cell`, the export groups by
it, and the viewer's `ui/model.js` carries the same rule (a test compares the orders).
"""

from typing import Any, Dict, List, Optional, Tuple

CELLS = (
    ("inbox", "Входящее", "предложения агента и вопросы, которых вы ещё не видели"),
    ("research", "Ресерч", "под вопросом: нужно исследовать"),
    ("discuss", "Обсудить", "под вопросом: нужно обсудить"),
    ("confirmed", "Подтверждено", "принято — вами или агентом"),
    ("rejected", "Отвергнуто", "остаётся в записи, чтобы не предлагать снова"),
    ("tacit", "Неявные решения", "приняты без того, чтобы кто-то выбирал"),
    ("orphaned", "Осиротело решениями", "вопросы, которые повисли из-за принятого решения"),
    ("hanging", "Просто висит", "к этому не вернулись; какое решение виновато — не названо"),
    ("decisions", "Решения", "заменённые и предложенные вами"),
)  # type: Tuple[Tuple[str, str, str], ...]

VERDICTS = ("confirmed", "rejected", "research", "discuss")


def is_unseen(node):  # type: (Dict[str, Any]) -> bool
    """Never marked seen, or marked seen before the node (re)entered the map."""
    seen = node.get("seen_at") or ""
    added = node.get("added_at") or ""
    if not seen:
        return True
    return bool(added) and seen < added


def _has_rel(node, rel):  # type: (Dict[str, Any], str) -> bool
    return any(isinstance(r, dict) and r.get("rel") == rel for r in (node.get("relates") or []))


def cell(node):  # type: (Dict[str, Any]) -> str
    """First matching rule of the spec table."""
    kind = node.get("kind")
    status = node.get("status")
    if status == "rejected":
        return "rejected"
    if node.get("triage") == "research":
        return "research"
    if node.get("triage") == "discuss":
        return "discuss"
    if kind == "decision" and status == "accepted":
        return "confirmed"
    if kind == "decision" and status == "proposed" and node.get("decided_by") == "agent":
        return "inbox"
    if kind == "open" and is_unseen(node):
        return "inbox"
    if kind == "tacit":
        return "tacit"
    if kind == "open":
        return "orphaned" if _has_rel(node, "orphaned_by") else "hanging"
    return "decisions"


def apply_verdict(node, verdict, text):  # type: (Dict[str, Any], str, Optional[str]) -> Optional[str]
    """Mutate `node` per the verdict table; return an error string, or None on success."""
    text = (text or "").strip()
    kind, status = node.get("kind"), node.get("status")
    if verdict not in VERDICTS:
        return "неизвестный вердикт %r — ожидается один из %s" % (verdict, "/".join(VERDICTS))
    if status == "superseded":
        return "узел %s заменён другим — вердикт ставится на замену" % node.get("id")

    if verdict == "confirmed":
        if kind == "open":
            if not text:
                return "чтобы подтвердить открытый вопрос, нужен ответ — это и есть решение"
            node["decision"] = text
        node["kind"] = "decision"
        node["status"] = "accepted"
        node["decided_by"] = "user"
        node["triage"] = None
    elif verdict == "rejected":
        if kind == "open":
            if not text:
                return "чтобы отвергнуть открытый вопрос, скажите почему — это станет решением"
            node["decision"] = text
            node["kind"] = "decision"
            node["decided_by"] = "user"
        elif text:
            against = [a for a in (node.get("against") or []) if isinstance(a, str)]
            against.append(text)
            node["against"] = against
        node["status"] = "rejected"
        node["triage"] = None
    else:  # research / discuss
        if status == "rejected":
            return "узел %s отвергнут — сначала подтвердите его, потом ставьте под вопрос" % node.get("id")
        node["status"] = "proposed"
        node["triage"] = verdict
    node["hand_edited"] = True
    return None


def titles():  # type: () -> Dict[str, str]
    return dict((key, title) for key, title, _ in CELLS)
```

- [ ] **Step 4: Run the tests**

Run: `python3 -m unittest tests.test_triage -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/aang/triage.py tests/test_triage.py
git commit -m "triage: derived cells and the verdict table"
```

---

### Task 3: `session.py` — session file, outbox, config, root discovery

**Files:**
- Create: `src/aang/session.py`
- Test: `tests/test_session.py`

**Interfaces:**
- Consumes: `store.map_dir`, `store.map_path`.
- Produces:
  - `session.SESSION_FILE = "session.json"`, `OUTBOX_FILE = "outbox.jsonl"`, `CONFIG_FILE = "config.json"`, `DEFAULT_CONFIG = {"nudge_turns": 5, "nudge_minutes": 15}`
  - `session.now_iso() -> str` (`2026-09-11T12:00:00Z`)
  - `session.find_root(start) -> Optional[str]` — nearest ancestor of `start` (inclusive) holding `.aang/map.json`
  - `session.read(root) -> Optional[Dict]`, `session.write(root, data) -> str` (atomic), `session.update(root, **fields) -> Dict` (read, merge, write)
  - `session.transcript_path(root) -> Optional[str]` — the recorded path if the file exists, else `None`
  - `session.outbox_append(root, kind, node_id, text, at=None) -> None`, `session.outbox_read(root) -> List[Dict]`, `session.outbox_clear(root) -> None` (truncate to zero bytes; no-op when absent)
  - `session.config(root) -> Dict` (`DEFAULT_CONFIG` overlaid with `.aang/config.json` ints)

- [ ] **Step 1: Write the failing tests**

Create `tests/test_session.py`:

```python
import json
import os
import shutil
import tempfile
import unittest

from aang import session, store


class SessionFileTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="aang-sess-")
        self.addCleanup(shutil.rmtree, self.root, True)

    def test_now_iso_shape(self):
        self.assertRegex(session.now_iso(), r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")

    def test_find_root_walks_up_to_the_map(self):
        store.save(self.root, {"version": 1, "nodes": []})
        deep = os.path.join(self.root, "a", "b")
        os.makedirs(deep)
        self.assertEqual(self.root, session.find_root(deep))
        self.assertEqual(self.root, session.find_root(self.root))
        other = tempfile.mkdtemp(prefix="aang-nomap-")
        self.addCleanup(shutil.rmtree, other, True)
        self.assertIsNone(session.find_root(other))

    def test_write_read_update(self):
        self.assertIsNone(session.read(self.root))
        path = session.write(self.root, {"harness": "claude", "session_id": "s1"})
        self.assertEqual(os.path.join(self.root, ".aang", "session.json"), path)
        self.assertEqual({"harness": "claude", "session_id": "s1"}, session.read(self.root))
        got = session.update(self.root, last_nudge_turn=7)
        self.assertEqual({"harness": "claude", "session_id": "s1", "last_nudge_turn": 7}, got)
        self.assertEqual(got, session.read(self.root))
        self.assertEqual([], [n for n in os.listdir(os.path.join(self.root, ".aang")) if n.endswith(".tmp")])

    def test_corrupt_session_file_reads_as_none(self):
        os.makedirs(os.path.join(self.root, ".aang"))
        with open(os.path.join(self.root, ".aang", "session.json"), "w") as h:
            h.write("{not json")
        self.assertIsNone(session.read(self.root))
        self.assertEqual({"a": 1}, session.update(self.root, a=1))

    def test_transcript_path_only_when_the_file_exists(self):
        self.assertIsNone(session.transcript_path(self.root))
        real = os.path.join(self.root, "t.jsonl")
        open(real, "w").close()
        session.write(self.root, {"transcript_path": real})
        self.assertEqual(real, session.transcript_path(self.root))
        session.write(self.root, {"transcript_path": os.path.join(self.root, "gone.jsonl")})
        self.assertIsNone(session.transcript_path(self.root))


class OutboxTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="aang-outbox-")
        self.addCleanup(shutil.rmtree, self.root, True)

    def test_append_read_clear(self):
        self.assertEqual([], session.outbox_read(self.root))
        session.outbox_append(self.root, "confirmed", "o3", "ответ", at="2026-09-11T12:00:00Z")
        session.outbox_append(self.root, "research", "d9", "")
        got = session.outbox_read(self.root)
        self.assertEqual({"at": "2026-09-11T12:00:00Z", "kind": "confirmed", "node": "o3", "text": "ответ"}, got[0])
        self.assertEqual(("research", "d9", ""), (got[1]["kind"], got[1]["node"], got[1]["text"]))
        self.assertRegex(got[1]["at"], r"Z$")
        session.outbox_clear(self.root)
        self.assertEqual([], session.outbox_read(self.root))
        self.assertTrue(os.path.isfile(os.path.join(self.root, ".aang", "outbox.jsonl")))  # truncated, not removed
        session.outbox_clear(self.root)  # idempotent

    def test_bad_lines_are_skipped(self):
        os.makedirs(os.path.join(self.root, ".aang"))
        with open(os.path.join(self.root, ".aang", "outbox.jsonl"), "w") as h:
            h.write('{"at":"x","kind":"discuss","node":"o1","text":""}\nnot json\n\n[1,2]\n')
        self.assertEqual(1, len(session.outbox_read(self.root)))


class ConfigTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="aang-cfg-")
        self.addCleanup(shutil.rmtree, self.root, True)

    def test_defaults_and_overrides(self):
        self.assertEqual({"nudge_turns": 5, "nudge_minutes": 15}, session.config(self.root))
        os.makedirs(os.path.join(self.root, ".aang"))
        with open(os.path.join(self.root, ".aang", "config.json"), "w") as h:
            json.dump({"nudge_turns": 8, "nudge_minutes": "no", "extra": 1}, h)
        self.assertEqual({"nudge_turns": 8, "nudge_minutes": 15}, session.config(self.root))
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m unittest tests.test_session -v`
Expected: FAIL — `ModuleNotFoundError: aang.session`.

- [ ] **Step 3: Implement `src/aang/session.py`**

```python
"""The harness side of `.aang/`: which session this map belongs to, what the viewer told
the agent, and the hook's thresholds.

`session.json` is written by `aang hook` on every event and read by `merge`, `check`,
`view` and the hook itself. `outbox.jsonl` is appended by the server on a verdict and
drained by the hook (or the manual `/aang` run). `config.json` is the human's; only
`nudge_turns` and `nudge_minutes` are read. None of these is the record — `map.json` is —
and none is committed.
"""

import datetime
import json
import os
import tempfile
from typing import Any, Dict, List, Optional

from . import store

SESSION_FILE = "session.json"
OUTBOX_FILE = "outbox.jsonl"
CONFIG_FILE = "config.json"
DEFAULT_CONFIG = {"nudge_turns": 5, "nudge_minutes": 15}


def now_iso():  # type: () -> str
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _path(root, name):  # type: (str, str) -> str
    return os.path.join(store.map_dir(root), name)


def find_root(start):  # type: (str) -> Optional[str]
    """Nearest directory at or above `start` that holds `.aang/map.json`."""
    current = os.path.abspath(start)
    while True:
        if os.path.isfile(store.map_path(current)):
            return current
        parent = os.path.dirname(current)
        if parent == current:
            return None
        current = parent


def _write_atomic(path, payload):  # type: (str, str) -> str
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".%s-" % os.path.basename(path), suffix=".tmp", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            try:
                os.unlink(tmp)
            except OSError:
                pass
    return path


def read(root):  # type: (str) -> Optional[Dict[str, Any]]
    return store.read_json(_path(root, SESSION_FILE))


def write(root, data):  # type: (str, Dict[str, Any]) -> str
    return _write_atomic(_path(root, SESSION_FILE), json.dumps(data, ensure_ascii=False, indent=2) + "\n")


def update(root, **fields):  # type: (str, **Any) -> Dict[str, Any]
    data = read(root) or {}
    data.update(fields)
    write(root, data)
    return data


def transcript_path(root):  # type: (str) -> Optional[str]
    data = read(root) or {}
    path = data.get("transcript_path")
    if isinstance(path, str) and path and os.path.isfile(path):
        return path
    return None


def outbox_append(root, kind, node_id, text, at=None):  # type: (str, str, str, str, Optional[str]) -> None
    path = _path(root, OUTBOX_FILE)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    event = {"at": at or now_iso(), "kind": kind, "node": node_id, "text": text or ""}
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(event, ensure_ascii=False) + "\n")
        handle.flush()
        os.fsync(handle.fileno())


def outbox_read(root):  # type: (str) -> List[Dict[str, Any]]
    out = []  # type: List[Dict[str, Any]]
    try:
        with open(_path(root, OUTBOX_FILE), "r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                if isinstance(event, dict) and isinstance(event.get("node"), str):
                    out.append(event)
    except OSError:
        pass
    return out


def outbox_clear(root):  # type: (str) -> None
    path = _path(root, OUTBOX_FILE)
    if os.path.exists(path):
        with open(path, "w", encoding="utf-8"):
            pass


def config(root):  # type: (str) -> Dict[str, int]
    out = dict(DEFAULT_CONFIG)
    data = store.read_json(_path(root, CONFIG_FILE)) or {}
    for key in DEFAULT_CONFIG:
        value = data.get(key)
        if isinstance(value, int) and not isinstance(value, bool) and value > 0:
            out[key] = value
    return out
```

Then in `src/aang/cli.py` replace the body of `_now_iso` with `return session.now_iso()` (import `session` there) so there is one clock.

- [ ] **Step 4: Run the tests**

Run: `python3 -m unittest tests.test_session tests.test_cli -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/aang/session.py src/aang/cli.py tests/test_session.py
git commit -m "session: session.json, outbox, config and root discovery"
```

---

### Task 4: Store — merge keeps `seen_at`, strips `cell`; export by cells

**Files:**
- Modify: `src/aang/store.py` (`CONTENT_FIELDS`, `VIEW_FIELDS`, `merge`, `STATUS_RU`, `export_markdown`, `_node_markdown`)
- Test: `tests/test_store.py`

**Interfaces:**
- Consumes: `triage.CELLS`, `triage.cell`.
- Produces: `store.VIEW_FIELDS == ("related_by", "verified", "cell")`; `store.CONTENT_FIELDS` gains `"decided_by", "triage"`; `store.STATUS_RU["rejected"] == "отвергнуто"`; `store.DECIDER_RU == {"user": "вы", "agent": "агент"}`; export sections are `## <cell title>` in `triage.CELLS` order, empty cells omitted.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_store.py` (its existing helpers build maps; if there is no `_node` helper in this file, use the literal dicts below):

```python
class SeenAndCellMergeTest(unittest.TestCase):
    def node(self, node_id, **fields):
        base = {"id": node_id, "kind": "decision", "status": "accepted", "question": "В?",
                "decision": "Р", "why": "п", "cites": [{"quote": "три слова тут есть"}]}
        base.update(fields)
        return base

    def test_seen_at_survives_a_regeneration_and_is_never_taken_from_the_candidate(self):
        old = {"version": 1, "nodes": [self.node("d1", seen_at="2026-09-11T12:00:00Z", added_at="2026-09-11T11:00:00Z")]}
        new = {"version": 1, "nodes": [self.node("d1", seen_at="2026-09-11T13:00:00Z", why="переписано"),
                                       self.node("d2", seen_at="2026-09-11T13:00:00Z")]}
        merged = store.merge(old, new)
        by_id = dict((n["id"], n) for n in merged["nodes"])
        self.assertEqual("2026-09-11T12:00:00Z", by_id["d1"]["seen_at"])
        self.assertEqual("переписано", by_id["d1"]["why"])
        self.assertIsNone(by_id["d2"]["seen_at"])

    def test_cell_is_stripped_like_related_by(self):
        old = {"version": 1, "nodes": [self.node("d1", cell="inbox")]}
        new = {"version": 1, "nodes": [self.node("d1", cell="rejected")]}
        self.assertNotIn("cell", store.merge(old, new)["nodes"][0])
        self.assertIn("cell", store.VIEW_FIELDS)

    def test_decided_by_and_triage_travel_with_the_candidate_and_stick_on_hand_edits(self):
        old = {"version": 1, "nodes": [self.node("d1", status="proposed", decided_by="agent", triage="research"),
                                       self.node("d2", status="rejected", decided_by="user", hand_edited=True)]}
        new = {"version": 1, "nodes": [self.node("d1", status="accepted", decided_by="user"),
                                       self.node("d2", status="accepted", decided_by="agent")]}
        by_id = dict((n["id"], n) for n in store.merge(old, new)["nodes"])
        self.assertEqual(("accepted", "user", None), (by_id["d1"]["status"], by_id["d1"]["decided_by"], by_id["d1"]["triage"]))
        self.assertEqual(("rejected", "user"), (by_id["d2"]["status"], by_id["d2"]["decided_by"]))


class CellExportTest(unittest.TestCase):
    def test_sections_follow_the_cells(self):
        m = {"version": 1, "title": "т", "nodes": [
            {"id": "d1", "kind": "decision", "status": "accepted", "decided_by": "user", "question": "Принято?", "decision": "да", "why": "п", "cites": []},
            {"id": "d2", "kind": "decision", "status": "proposed", "decided_by": "agent", "question": "Предложено агентом?", "decision": "да", "why": "п", "cites": []},
            {"id": "d3", "kind": "decision", "status": "rejected", "decided_by": "agent", "question": "Отвергнуто?", "decision": "да", "why": "п", "against": ["нет"], "cites": []},
            {"id": "o1", "kind": "open", "status": "proposed", "triage": "research", "question": "Изучить?", "why": "п", "cites": []},
            {"id": "t1", "kind": "tacit", "status": "accepted", "question": "Неявно?", "decision": "да", "why": "п", "cites": []},
        ]}
        text = store.export_markdown(m)
        heads = [line for line in text.splitlines() if line.startswith("## ")]
        self.assertEqual(["## Входящее", "## Ресерч", "## Подтверждено", "## Отвергнуто", "## Неявные решения"], heads)
        self.assertIn("**Статус:** отвергнуто", text)
        self.assertIn("**Решил:** вы", text)
        self.assertIn("**Решил:** агент", text)
        self.assertIn("**Под вопросом:** ресерч", text)
        self.assertNotIn("seen_at", text)
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m unittest tests.test_store.SeenAndCellMergeTest tests.test_store.CellExportTest -v`
Expected: FAIL (`seen_at` overwritten, `cell` kept, headings are the old three).

- [ ] **Step 3: Implement**

In `src/aang/store.py`:

```python
from . import schema, transcript, triage

CONTENT_FIELDS = ("kind", "question", "decision", "why", "against", "consequence", "cites", "relates",
                  "decided_by", "triage")
VIEW_FIELDS = ("related_by", "verified", "cell")
# aang's own stamps: never taken from a candidate, always kept from the stored node.
STAMP_FIELDS = ("added_at", "seen_at")
```

In `merge`, the ordinary-node branch becomes:

```python
        else:
            incoming["hand_edited"] = False
            for field in STAMP_FIELDS:
                incoming[field] = previous.get(field) if previous is not None else None
            if incoming.get("added_at") is None:
                incoming["added_at"] = ""
            result.append(incoming)
```

(`_merge_hand_edited` copies `previous` whole, so hand-edited nodes already keep both stamps and their `decided_by`/`triage`/`status`.)

Export: replace `KIND_TITLES` usage. Add:

```python
STATUS_RU = {"accepted": "принято", "superseded": "заменено", "proposed": "предложено", "rejected": "отвергнуто"}
DECIDER_RU = {"user": "вы", "agent": "агент"}
TRIAGE_RU = {"research": "ресерч", "discuss": "обсуждение"}
```

In `export_markdown`, replace the `for kind, title, subtitle in KIND_TITLES:` loop with:

```python
    for key, title, subtitle in triage.CELLS:
        group = [n for n in nodes if triage.cell(n) == key]
        if not group:
            continue
        lines.append("## %s" % title)
        if subtitle:
            lines.append("")
            lines.append("_%s_" % subtitle)
        lines.append("")
        for node in reversed(group):
            lines.extend(_node_markdown(node, by_id, transcript_error))
```

Keep `KIND_TITLES` defined (nothing else imports it, but deleting it is not this task's job — delete it if grep shows no user). In `_node_markdown`, after the status flag:

```python
    if node.get("kind") == "decision" and node.get("decided_by") in DECIDER_RU:
        flags.append("**Решил:** %s" % DECIDER_RU[node["decided_by"]])
    if node.get("triage") in TRIAGE_RU:
        flags.append("**Под вопросом:** %s" % TRIAGE_RU[node["triage"]])
```

`seen_at` is not printed anywhere (verify with the test).

- [ ] **Step 4: Run the store and cli suites**

Run: `python3 -m unittest tests.test_store tests.test_cli -v`
Expected: PASS. If an older export test pins the heading «Решения» first for a map of accepted decisions, that expectation moves to «Подтверждено» — update the assertion, it is the spec's new grouping.

- [ ] **Step 5: Commit**

```bash
git add src/aang/store.py tests/test_store.py tests/test_cli.py
git commit -m "store: keep seen_at across merges, strip cell, export grouped by triage cells"
```

---

### Task 5: Transcript — Codex format, lookup across both trees, `cwd` preference

**Files:**
- Create: `tests/fixtures/codex.jsonl`
- Create: `tests/fixtures/codex-sessions/2026/09/11/rollout-2026-09-11T10-00-00-cccc1111-0000-0000-0000-000000000001.jsonl` (copy of the fixture) and `.../rollout-2026-09-11T11-00-00-cccc2222-0000-0000-0000-000000000002.jsonl` (same content, `cwd` `/Users/x/proj-b`)
- Modify: `src/aang/transcript.py` (`default_roots`, `find_session`, `index`, new `_index_codex`, `_codex_meta`, `project_of`)
- Test: `tests/test_transcript.py`

**Interfaces:**
- Consumes: nothing new.
- Produces: `transcript.index(path)` handles both formats; `transcript.find_session(session_id=None, roots=None, cwd=None)`; `transcript.default_roots()` returns `[~/.claude/projects, ~/.codex/sessions]`; `transcript.CODEX_ROOT_MARK = "session_meta"`; `transcript.project_of(path) -> Optional[str]` (the project directory a transcript belongs to: Codex `session_meta.cwd`, Claude the folder name decoded `-Users-x-proj` → `/Users/x/proj`); `transcript.harness_of(path) -> str` (`"codex"` | `"claude"`).

- [ ] **Step 1: Write the fixture**

`tests/fixtures/codex.jsonl` — five lines (one JSON object per line; the `base_instructions` text is shortened):

```json
{"timestamp":"2026-09-11T19:00:59.844Z","ordinal":0,"type":"session_meta","payload":{"session_id":"cccc1111-0000-0000-0000-000000000001","id":"cccc1111-0000-0000-0000-000000000001","timestamp":"2026-09-11T18:58:53.150Z","cwd":"/Users/x/proj-a","originator":"codex-tui","cli_version":"0.154.0","source":"cli","thread_source":"user","model_provider":"openai"}}
{"timestamp":"2026-09-11T19:01:00.289Z","ordinal":5,"type":"response_item","payload":{"type":"message","id":"msg_1","role":"user","content":[{"type":"input_text","text":"<environment_context>\n  <cwd>/Users/x/proj-a</cwd>\n</environment_context>"}]}}
{"timestamp":"2026-09-11T19:01:00.329Z","ordinal":9,"type":"event_msg","payload":{"type":"item_completed","thread_id":"cccc1111-0000-0000-0000-000000000001","turn_id":"turn-1","item":{"type":"UserMessage","id":"um-1","content":[{"type":"text","text":"Начнём с метрик: давай тогда pass@1 на отложенном наборе"}]}}}
{"timestamp":"2026-09-11T19:01:04.634Z","ordinal":11,"type":"event_msg","payload":{"type":"item_completed","thread_id":"cccc1111-0000-0000-0000-000000000001","turn_id":"turn-1","item":{"type":"AgentMessage","id":"am-1","content":[{"type":"Text","text":"Хорошо: нужно 500 примеров вместо 100, прогон дорожает втрое."}]}}}
{"timestamp":"2026-09-11T19:01:05.000Z","ordinal":12,"type":"event_msg","payload":{"type":"item_completed","thread_id":"cccc1111-0000-0000-0000-000000000001","turn_id":"turn-1","item":{"type":"CommandExecution","id":"exec-1","command":["/bin/zsh","-lc","ls"]}}}
```

Create the two session-tree copies with `mkdir -p` and `cp`, editing `cwd` and both ids in the second one (`sed 's/cccc1111-0000-0000-0000-000000000001/cccc2222-0000-0000-0000-000000000002/g; s#/Users/x/proj-a#/Users/x/proj-b#'`).

- [ ] **Step 2: Write the failing tests**

Append to `tests/test_transcript.py` (`FIXTURES` is defined at the top of that file):

```python
CODEX = os.path.join(FIXTURES, "codex.jsonl")
CODEX_ROOT = os.path.join(FIXTURES, "codex-sessions")
CLAUDE_ROOT = os.path.join(FIXTURES, "projects")


class CodexIndexTest(unittest.TestCase):
    def test_turns_come_from_item_completed_only(self):
        turns = transcript.index(CODEX)
        self.assertEqual([("user", 1), ("assistant", 2)], [(t["role"], t["turn"]) for t in turns])
        self.assertIn("pass@1 на отложенном", turns[0]["text"])
        self.assertNotIn("environment_context", turns[0]["text"])
        self.assertEqual("2026-09-11T19:01:00.329Z", turns[0]["ts"])
        self.assertEqual("um-1", turns[0]["uuid"])

    def test_quotes_resolve_against_codex_turns(self):
        turns = transcript.index(CODEX)
        got = transcript.resolve([{"quote": "нужно 500 примеров вместо 100"}], turns)
        self.assertTrue(got[0]["ok"]); self.assertEqual(2, got[0]["turn"]); self.assertEqual("assistant", got[0]["role"])

    def test_harness_and_project(self):
        self.assertEqual("codex", transcript.harness_of(CODEX))
        self.assertEqual("/Users/x/proj-a", transcript.project_of(CODEX))
        claude = os.path.join(CLAUDE_ROOT, "-Users-x-proj-a", "aaaa1111-0000-0000-0000-000000000001.jsonl")
        self.assertEqual("claude", transcript.harness_of(claude))
        self.assertEqual("/Users/x/proj-a", transcript.project_of(claude))


class CrossHarnessLookupTest(unittest.TestCase):
    roots = [CLAUDE_ROOT, CODEX_ROOT]

    def test_codex_id_found_by_suffix(self):
        path = transcript.find_session("cccc2222-0000-0000-0000-000000000002", self.roots)
        self.assertTrue(path and path.endswith("-cccc2222-0000-0000-0000-000000000002.jsonl"), path)

    def test_claude_id_still_found(self):
        path = transcript.find_session("aaaa1111-0000-0000-0000-000000000001", self.roots)
        self.assertTrue(path and path.endswith("aaaa1111-0000-0000-0000-000000000001.jsonl"), path)

    def test_cwd_wins_over_recency(self):
        # Touch a proj-b transcript so it is newest; asking for proj-a must still return proj-a's.
        newest = transcript.find_session(None, [CODEX_ROOT])
        target = os.path.join(CODEX_ROOT, "2026", "09", "11",
                              "rollout-2026-09-11T11-00-00-cccc2222-0000-0000-0000-000000000002.jsonl")
        os.utime(target, None)
        self.assertEqual(target, transcript.find_session(None, [CODEX_ROOT]))
        got = transcript.find_session(None, self.roots, cwd="/Users/x/proj-a")
        self.assertEqual("/Users/x/proj-a", transcript.project_of(got))

    def test_default_roots_include_both_trees(self):
        roots = transcript.default_roots()
        self.assertTrue(any(r.endswith(os.path.join(".claude", "projects")) for r in roots))
        self.assertTrue(any(r.endswith(os.path.join(".codex", "sessions")) for r in roots))
```

- [ ] **Step 3: Run to verify failure**

Run: `python3 -m unittest tests.test_transcript.CodexIndexTest tests.test_transcript.CrossHarnessLookupTest -v`
Expected: FAIL (no turns from the Codex file; `find_session` has no `cwd`; `harness_of` missing).

- [ ] **Step 4: Implement**

In `src/aang/transcript.py`:

```python
CODEX_ROOT_MARK = "session_meta"
CODEX_ITEM_ROLES = {"UserMessage": "user", "AgentMessage": "assistant"}
CODEX_TEXT_TYPES = ("text", "Text", "input_text", "output_text")


def default_roots():  # type: () -> List[str]
    return [os.path.expanduser("~/.claude/projects"), os.path.expanduser("~/.codex/sessions")]


def _candidates(roots):  # type: (Optional[List[str]]) -> List[str]
    """Every session file under the roots: Claude `<root>/<project>/<id>.jsonl`, Codex
    `<root>/YYYY/MM/DD/rollout-<ts>-<id>.jsonl`. Subagent and memory files are never sessions."""
    out = []  # type: List[str]
    for root in roots if roots is not None else default_roots():
        try:
            root = os.path.expanduser(root)
            if not os.path.isdir(root):
                continue
            for path in glob.iglob(os.path.join(glob.escape(root), "*", "*.jsonl")):
                if os.path.isfile(path):
                    out.append(path)
            for path in glob.iglob(os.path.join(glob.escape(root), "*", "*", "*", "rollout-*.jsonl")):
                if os.path.isfile(path):
                    out.append(path)
        except (OSError, ValueError):
            continue
    return out


def find_session(session_id=None, roots=None, cwd=None):
    # type: (Optional[str], Optional[List[str]], Optional[str]) -> Optional[str]
    """Path to a session transcript, or None.

    With `session_id`: the Claude file `<id>.jsonl` or the Codex file `rollout-*-<id>.jsonl`,
    else a unique prefix match on the Claude name. Without: among the candidates whose
    project is `cwd` (when given and any match), the most recently modified; else the most
    recently modified of all.
    """
    candidates = _candidates(roots)
    if not candidates:
        return None
    if session_id:
        exact = [p for p in candidates
                 if os.path.basename(p) in (session_id + ".jsonl",)
                 or os.path.basename(p).endswith("-" + session_id + ".jsonl")]
        if exact:
            return _newest(exact)
        prefixed = [p for p in candidates if os.path.basename(p).startswith(session_id)]
        if len(prefixed) == 1:
            return prefixed[0]
        return None
    if cwd:
        wanted = os.path.normpath(cwd)
        mine = [p for p in candidates if project_of(p) == wanted]
        if mine:
            return _newest(mine)
    return _newest(candidates)


def harness_of(path):  # type: (str) -> str
    return "codex" if _codex_meta(path) is not None else "claude"


def project_of(path):  # type: (str) -> Optional[str]
    """The working directory the session ran in: Codex records it; Claude encodes it in the
    project folder name (`/` → `-`), which is decoded here — lossy for a path with `-` in it,
    so it is a preference, never an identity."""
    meta = _codex_meta(path)
    if meta is not None:
        cwd = meta.get("cwd")
        return os.path.normpath(cwd) if isinstance(cwd, str) and cwd else None
    folder = os.path.basename(os.path.dirname(path))
    if folder.startswith("-"):
        return os.path.normpath("/" + folder[1:].replace("-", "/"))
    return None


def _codex_meta(path):  # type: (str) -> Optional[Dict[str, Any]]
    """The `session_meta` payload when `path` is a Codex rollout, else None."""
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            for line in handle:
                record = _parse_line(line)
                if record is None:
                    continue
                if record.get("type") == CODEX_ROOT_MARK and isinstance(record.get("payload"), dict):
                    return record["payload"]
                return None
    except (OSError, TypeError):
        return None
    return None
```

In `index`, right after opening the handle and before the Claude loop, detect the format:

```python
    if _codex_meta(path) is not None:
        with handle:
            return _index_codex(handle, text_cap)
```

and add:

```python
def _index_codex(handle, text_cap):  # type: (Any, Optional[int]) -> List[Dict[str, Any]]
    """Codex rollouts: one turn per completed UserMessage / AgentMessage item. The
    `response_item` copies of the same messages (which also carry injected wrappers such
    as `<environment_context>`) are ignored, so nothing arrives twice or unasked."""
    turns = []  # type: List[Dict[str, Any]]
    for line in handle:
        record = _parse_line(line)
        if record is None or record.get("type") != "event_msg":
            continue
        payload = record.get("payload")
        if not isinstance(payload, dict) or payload.get("type") != "item_completed":
            continue
        item = payload.get("item")
        if not isinstance(item, dict) or item.get("type") not in CODEX_ITEM_ROLES:
            continue
        parts = []  # type: List[str]
        for block in item.get("content") or []:
            if isinstance(block, dict) and block.get("type") in CODEX_TEXT_TYPES:
                text = block.get("text")
                if isinstance(text, str) and text.strip():
                    parts.append(text)
        if not parts:
            continue
        _append_turn(turns, {"role": CODEX_ITEM_ROLES[item["type"]], "parts": parts,
                             "uuid": item.get("id"), "ts": record.get("timestamp")}, text_cap)
    return turns
```

Extend the module docstring with a paragraph on the two formats.

- [ ] **Step 5: Run the transcript suite, then everything**

Run: `python3 -m unittest tests.test_transcript -v && python3 -m unittest discover -s tests -t .`
Expected: PASS. The existing `FindSessionTest` still passes because Claude lookups are unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/aang/transcript.py tests/test_transcript.py tests/fixtures/codex.jsonl tests/fixtures/codex-sessions
git commit -m "transcript: Codex rollouts, lookup across both trees, cwd preference"
```

---

### Task 6: Server — `session.json` as the transcript source; `cell`, `tail`, `hook`, `root` in `/api/map`

**Files:**
- Modify: `src/aang/server.py` (`TranscriptSource.__init__`/`locate`, `annotate`, `Handler._view`, `make_server`)
- Test: `tests/test_server.py`

**Interfaces:**
- Consumes: `session.transcript_path`, `session.read`, `transcript.find_session(..., cwd=)`, `triage.cell`.
- Produces:
  - `TranscriptSource(path=None, session_id=None, roots=None, root=None)`; `locate()` order: pinned `path` → `session.transcript_path(root)` → `find_session(session_id or map's, roots, cwd=root)`.
  - `annotate(map_dict, turns, transcript_error=None, transcript_path=None, session_info=None, root=None)` adds per node `cell` (string) and top-level `tail` (list of `{"turn", "role", "text"}` for turns after `coverage.covered_to`, `text` cut to 200 chars; `[]` when `covered_to` is `None` or the transcript is missing), `hook` (`{"installed": bool, "harness": str|None, "last_event_at": str|None}` from `session_info`), `root` (absolute root path or `None`).
  - `TAIL_TEXT_CAP = 200`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_server.py` (helpers `_turns`, `_node`, `_map`, `_by_id`, `ServerTestCase` exist there):

```python
class CellAndTailTest(unittest.TestCase):
    def test_every_node_carries_its_cell(self):
        view = server.annotate(_map([_node("d1", status="proposed", decided_by="agent",
                                           cites=[{"quote": "живая цитата отсюда, ход 2"}]),
                                     _node("t1", kind="tacit")]), _turns(6))
        self.assertEqual("inbox", _by_id(view, "d1")["cell"])
        self.assertEqual("tacit", _by_id(view, "t1")["cell"])

    def test_tail_is_the_turns_after_coverage(self):
        view = server.annotate(_map([_node("d1", cites=[{"quote": "живая цитата отсюда, ход 2"}])]), _turns(5))
        self.assertEqual(2, view["coverage"]["covered_to"])
        self.assertEqual([3, 4, 5], [t["turn"] for t in view["tail"]])
        self.assertEqual({"turn", "role", "text"}, set(view["tail"][0]))

    def test_tail_text_is_capped(self):
        long_turns = _turns(3, text="слово " * 100 + "ход %d")
        view = server.annotate(_map([_node("d1", cites=[{"quote": "слово слово слово слово"}])]), long_turns)
        self.assertTrue(all(len(t["text"]) <= server.TAIL_TEXT_CAP for t in view["tail"]))

    def test_tail_empty_without_coverage_or_transcript(self):
        self.assertEqual([], server.annotate(_map([_node("o1", kind="open", status="proposed", cites=[])]), _turns(4))["tail"])
        self.assertEqual([], server.annotate(_map([_node("d1")]), [], transcript_error="нет")["tail"])

    def test_hook_and_root_in_the_view(self):
        view = server.annotate(_map([]), [], session_info={"harness": "codex", "last_event_at": "2026-09-11T12:00:00Z"}, root="/x")
        self.assertEqual({"installed": True, "harness": "codex", "last_event_at": "2026-09-11T12:00:00Z"}, view["hook"])
        self.assertEqual("/x", view["root"])
        view = server.annotate(_map([]), [])
        self.assertEqual({"installed": False, "harness": None, "last_event_at": None}, view["hook"])
        self.assertIsNone(view["root"])


class SessionFileSourceTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="aang-src-")
        self.addCleanup(shutil.rmtree, self.root, True)

    def test_session_json_wins_over_lookup(self):
        from aang import session
        store.save(self.root, sample_map())
        session.write(self.root, {"harness": "claude", "transcript_path": NORMAL})
        source = server.TranscriptSource(roots=[], root=self.root)
        turns, error = source.turns("does-not-matter")
        self.assertIsNone(error)
        self.assertEqual(NORMAL, source.path)

    def test_explicit_path_still_wins_over_session_json(self):
        from aang import session
        store.save(self.root, sample_map())
        session.write(self.root, {"transcript_path": os.path.join(FIXTURES, "tool_only.jsonl")})
        source = server.TranscriptSource(path=NORMAL, roots=[], root=self.root)
        source.turns()
        self.assertEqual(NORMAL, source.path)

    def test_stale_session_json_falls_back_to_lookup(self):
        from aang import session
        store.save(self.root, sample_map())
        session.write(self.root, {"transcript_path": os.path.join(self.root, "gone.jsonl")})
        source = server.TranscriptSource(roots=[os.path.join(FIXTURES, "projects")], root=self.root)
        source.turns("aaaa1111-0000-0000-0000-000000000001")
        self.assertTrue(source.path and source.path.endswith("aaaa1111-0000-0000-0000-000000000001.jsonl"))


class ViewOverHttpHasNewKeysTest(ServerTestCase):
    def test_api_map_carries_cell_tail_hook_root(self):
        view = self.get_json("/api/map")
        self.assertIn("tail", view); self.assertIn("hook", view); self.assertEqual(self.root, view["root"])
        self.assertTrue(all("cell" in n for n in view["nodes"]))
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m unittest tests.test_server.CellAndTailTest tests.test_server.SessionFileSourceTest tests.test_server.ViewOverHttpHasNewKeysTest -v`
Expected: FAIL (`TypeError: unexpected keyword 'root'`, missing keys).

- [ ] **Step 3: Implement**

In `src/aang/server.py`:

```python
from . import schema, session, store, transcript, triage

TAIL_TEXT_CAP = 200


class TranscriptSource(object):
    def __init__(self, path=None, session_id=None, roots=None, root=None):
        # type: (Optional[str], Optional[str], Optional[List[str]], Optional[str]) -> None
        self.pinned = path
        self.session_id = session_id
        self.roots = roots
        self.root = root
        ...  # unchanged fields

    def locate(self, session_id=None):  # type: (Optional[str]) -> Optional[str]
        if self.pinned:
            return self.pinned
        if self.root:
            recorded = session.transcript_path(self.root)
            if recorded:
                return recorded
        return transcript.find_session(self.session_id or session_id or None, self.roots, cwd=self.root)
```

`annotate` signature and additions:

```python
def annotate(map_dict, turns, transcript_error=None, transcript_path=None, session_info=None, root=None):
    # type: (Any, List[Dict[str, Any]], Optional[str], Optional[str], Optional[Dict[str, Any]], Optional[str]) -> Dict[str, Any]
    ...
    view = {
        ...,
        "root": root,
        "hook": _hook_info(session_info),
        "tail": [],
        ...
    }
    ...  # after the coverage line at the end:
    for node in view["nodes"]:
        node["cell"] = triage.cell(node)
    covered_to = view["coverage"]["covered_to"]
    if covered_to is not None and not transcript_error:
        view["tail"] = [{"turn": t["turn"], "role": t["role"], "text": (t.get("text") or "")[:TAIL_TEXT_CAP]}
                        for t in turns if t["turn"] > covered_to]
    return view


def _hook_info(session_info):  # type: (Optional[Dict[str, Any]]) -> Dict[str, Any]
    info = session_info if isinstance(session_info, dict) else None
    return {"installed": info is not None,
            "harness": info.get("harness") if info else None,
            "last_event_at": info.get("last_event_at") if info else None}
```

The early `return view` for an invalid map keeps the new keys at their empty values. In `Handler._view`:

```python
    def _view(self, map_dict):  # type: (Dict[str, Any]) -> Dict[str, Any]
        root = self.server.root  # type: ignore[attr-defined]
        source = self.server.transcript_source  # type: ignore[attr-defined]
        turns, error = source.turns(map_dict.get("session_id") or None)
        return annotate(map_dict, turns, error, source.path, session.read(root), root)
```

In `make_server`, when `transcript_source` is `None`, build `TranscriptSource(root=root)`; when one is passed with `root` unset, set `source.root = root`.

- [ ] **Step 4: Run the server suite**

Run: `python3 -m unittest tests.test_server -v`
Expected: PASS (existing `AnnotateTest.test_does_not_mutate_input` and the coverage tests are unaffected).

- [ ] **Step 5: Commit**

```bash
git add src/aang/server.py tests/test_server.py
git commit -m "server: session.json as transcript source; cell, tail, hook and root in the view"
```

---

### Task 7: Server — verdict and seen routes

**Files:**
- Modify: `src/aang/server.py` (`do_POST`, new `_post_verdict`, `_post_seen`, `EDITABLE_FIELDS`)
- Test: `tests/test_server.py`

**Interfaces:**
- Consumes: `triage.apply_verdict`, `session.outbox_append`, `session.now_iso`.
- Produces: `POST /api/node/<id>/verdict` body `{"verdict": ..., "text": ...}` → 200 with the view; 400 bad body; 404 unknown node; 409 invalid map; 422 `{"errors": [...]}` from the verdict rule or the schema, nothing written. `POST /api/node/<id>/seen` (empty JSON object body `{}`) → 200 with the view; sets `seen_at = now`, no `hand_edited`, no outbox. `EDITABLE_FIELDS` gains `"decided_by", "triage"` (the plain edit route accepts them).

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_server.py`:

```python
class VerdictRouteTest(ServerTestCase):
    def outbox(self):
        from aang import session
        return session.outbox_read(self.root)

    def test_confirm_open_with_text(self):
        status, _, data = self.request("POST", "/api/node/o1/verdict", {"verdict": "confirmed", "text": "Платит заказчик"})
        self.assertEqual(200, status, data)
        view = json.loads(data)
        o1 = _by_id(view, "o1")
        self.assertEqual(("decision", "Платит заказчик", "accepted", "user", True, "confirmed"),
                         (o1["kind"], o1["decision"], o1["status"], o1["decided_by"], o1["hand_edited"], o1["cell"]))
        saved = store.load(self.root)
        self.assertEqual("decision", [n for n in saved["nodes"] if n["id"] == "o1"][0]["kind"])
        self.assertEqual([("confirmed", "o1", "Платит заказчик")], [(e["kind"], e["node"], e["text"]) for e in self.outbox()])

    def test_confirm_open_without_text_is_422_and_writes_nothing(self):
        status, _, data = self.request("POST", "/api/node/o1/verdict", {"verdict": "confirmed", "text": ""})
        self.assertEqual(422, status, data)
        self.assertIn("ответ", json.loads(data)["errors"][0])
        self.assertEqual("open", [n for n in store.load(self.root)["nodes"] if n["id"] == "o1"][0]["kind"])
        self.assertEqual([], self.outbox())

    def test_reject_and_research(self):
        status, _, data = self.request("POST", "/api/node/d1/verdict", {"verdict": "rejected", "text": "нет"})
        self.assertEqual(200, status, data)
        d1 = _by_id(json.loads(data), "d1")
        self.assertEqual(("rejected", ["нет"], "rejected"), (d1["status"], d1["against"], d1["cell"]))
        status, _, data = self.request("POST", "/api/node/d2/verdict", {"verdict": "research"})
        self.assertEqual(200, status, data)
        d2 = _by_id(json.loads(data), "d2")
        self.assertEqual(("proposed", "research", "research"), (d2["status"], d2["triage"], d2["cell"]))
        self.assertEqual(["rejected", "research"], [e["kind"] for e in self.outbox()])

    def test_bad_bodies_and_unknown_node(self):
        self.assertEqual(400, self.request("POST", "/api/node/d1/verdict", {"text": "x"})[0])
        self.assertEqual(422, self.request("POST", "/api/node/d1/verdict", {"verdict": "maybe"})[0])
        self.assertEqual(404, self.request("POST", "/api/node/zz/verdict", {"verdict": "rejected"})[0])
        self.assertEqual([], self.outbox())

    def test_cross_site_verdict_is_refused(self):
        status, _, _ = self.request("POST", "/api/node/d1/verdict", {"verdict": "rejected"}, origin="http://evil.example")
        self.assertEqual(403, status)
        self.assertEqual("accepted", [n for n in store.load(self.root)["nodes"] if n["id"] == "d1"][0]["status"])


class SeenRouteTest(ServerTestCase):
    def test_seen_stamps_without_hand_edit_or_outbox(self):
        from aang import session
        status, _, data = self.request("POST", "/api/node/o1/seen", {})
        self.assertEqual(200, status, data)
        o1 = _by_id(json.loads(data), "o1")
        self.assertRegex(o1["seen_at"], r"Z$")
        self.assertFalse(o1["hand_edited"])
        self.assertEqual("hanging", o1["cell"])
        self.assertEqual([], session.outbox_read(self.root))

    def test_unknown_node_404(self):
        self.assertEqual(404, self.request("POST", "/api/node/zz/seen", {})[0])


class EditNewFieldsTest(ServerTestCase):
    def test_decided_by_and_triage_are_editable(self):
        status, _, data = self.request("POST", "/api/node/d1", {"decided_by": "agent", "status": "proposed", "triage": "discuss"})
        self.assertEqual(200, status, data)
        self.assertEqual("discuss", _by_id(json.loads(data), "d1")["cell"])
        status, _, data = self.request("POST", "/api/node/o1", {"decided_by": "user"})
        self.assertEqual(422, status, data)
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m unittest tests.test_server.VerdictRouteTest tests.test_server.SeenRouteTest tests.test_server.EditNewFieldsTest -v`
Expected: FAIL (404 «Нет такого пути» for the new routes; 400 for the new fields).

- [ ] **Step 3: Implement**

In `src/aang/server.py`, `EDITABLE_FIELDS = (..., "relates", "decided_by", "triage")`. Restructure `do_POST` after the gates and the `/api/node/` prefix check:

```python
        rest = unquote(path[len("/api/node/"):])
        parts = rest.split("/")
        node_id = parts[0]
        action = parts[1] if len(parts) == 2 else ("" if len(parts) == 1 else None)
        if action is None or not node_id:
            self._text(404, "Нет такого пути: %s" % path)
            return
        body = self._read_body()
        if body is None:
            return
        try:
            payload = json.loads(body.decode("utf-8")) if body else {}
        except (ValueError, UnicodeDecodeError):
            self._json(400, {"errors": ["тело запроса — не JSON"]})
            return
        if not isinstance(payload, dict):
            self._json(400, {"errors": ["ожидался объект JSON"]})
            return
        if action == "":
            self._post_edit(node_id, payload)
        elif action == "verdict":
            self._post_verdict(node_id, payload)
        elif action == "seen":
            self._post_seen(node_id)
        else:
            self._text(404, "Нет такого пути: %s" % path)
```

`_post_edit` is the existing body (the `if not isinstance(edit, dict) or not edit` check stays inside it). The two new handlers share a locked load-mutate-validate-save helper:

```python
    def _mutate(self, node_id, change, after_save=None):
        # type: (str, Any, Any) -> None
        """Load under the write lock, apply `change(node) -> Optional[str]`, validate, save,
        run `after_save(node)`, answer with the view. Errors: 404 unknown node, 409 invalid
        map, 422 refused change (nothing written), 500 save failure."""
        root = self.server.root  # type: ignore[attr-defined]
        with self.server.write_lock:  # type: ignore[attr-defined]
            map_dict = store.load(root)
            node = next((n for n in map_dict["nodes"] if isinstance(n, dict) and n.get("id") == node_id), None)
            if node is None:
                self._json(404, {"errors": ["узла %s нет в карте" % node_id]})
                return
            before = schema.validate(map_dict)
            if before:
                self._json(409, {"errors": ["карта невалидна, сначала исправьте файл .aang/map.json"] + before})
                return
            refused = change(node)
            if refused:
                self._json(422, {"errors": [refused]})
                return
            errors = schema.validate(schema.normalize(map_dict))
            if errors:
                self._json(422, {"errors": errors})
                return
            try:
                store.save(root, map_dict)
            except OSError as exc:
                self._json(500, {"errors": ["не удалось сохранить карту: %s" % exc]})
                return
            if after_save is not None:
                after_save(node)
        self._json(200, self._view(map_dict))

    def _post_verdict(self, node_id, payload):  # type: (str, Dict[str, Any]) -> None
        verdict = payload.get("verdict")
        text = payload.get("text") or ""
        if not isinstance(verdict, str) or not isinstance(text, str):
            self._json(400, {"errors": ["ожидался объект {\"verdict\": ..., \"text\": ...}"]})
            return
        root = self.server.root  # type: ignore[attr-defined]
        self._mutate(node_id,
                     lambda node: triage.apply_verdict(node, verdict, text),
                     lambda node: session.outbox_append(root, verdict, node_id, text.strip()))

    def _post_seen(self, node_id):  # type: (str) -> None
        def stamp(node):  # type: (Dict[str, Any]) -> Optional[str]
            node["seen_at"] = session.now_iso()
            return None
        self._mutate(node_id, stamp)
```

Rewrite `_post_edit` to use `_mutate` too (`change` = `node.update(edit); node["hand_edited"] = True`), keeping its 400 checks before the call. Update the module docstring's route table.

- [ ] **Step 4: Run the server suite**

Run: `python3 -m unittest tests.test_server -v`
Expected: PASS, including `EditTest` and `CrossSiteWriteTest` unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/aang/server.py tests/test_server.py
git commit -m "server: verdict and seen routes; decided_by and triage editable"
```

---

### Task 8: Server — `/api/events` (SSE) with a file watcher, and `/model.js`

**Files:**
- Modify: `src/aang/server.py` (new `Watcher` class, `Server.__init__`/`server_close`, `do_GET`)
- Test: `tests/test_server.py`

**Interfaces:**
- Consumes: `session.SESSION_FILE`, `store.map_path`, `TranscriptSource.path`.
- Produces:
  - `server.Watcher(paths_fn, interval=1.0)` — daemon thread; `subscribe() -> queue.Queue`, `unsubscribe(q)`, `stop()`; `snapshot()` returns `{path: (mtime, size) | None}`; on any change puts `{"changed": [labels]}` into every subscriber queue. Labels: `"map"`, `"session"`, `"transcript"`.
  - `GET /api/events` → `text/event-stream`, first frame `: connected\n\n`, then `data: {"changed": [...]}\n\n` per change, `: ping\n\n` every `PING_SECONDS = 30` idle; `Cache-Control: no-store`.
  - `GET /model.js` → `ui/model.js` as `application/javascript; charset=utf-8` (404 with a Russian message when absent). `server._MODEL_PATH` next to `_UI_PATH`.
  - `Server.watcher` attribute; `make_server(..., watch_interval=1.0)`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_server.py`:

```python
class WatcherTest(unittest.TestCase):
    def test_reports_the_label_of_the_file_that_changed(self):
        root = tempfile.mkdtemp(prefix="aang-watch-")
        self.addCleanup(shutil.rmtree, root, True)
        a = os.path.join(root, "a.json"); b = os.path.join(root, "b.json")
        open(a, "w").close()
        w = server.Watcher(lambda: {"map": a, "session": b}, interval=0.05)
        q = w.subscribe()
        w.start()
        self.addCleanup(w.stop)
        with open(a, "w") as h:
            h.write("changed")
        self.assertEqual({"changed": ["map"]}, q.get(timeout=2))
        open(b, "w").close()  # a file appearing is a change too
        self.assertEqual({"changed": ["session"]}, q.get(timeout=2))
        w.unsubscribe(q)


class EventsRouteTest(ServerTestCase):
    def test_stream_announces_map_changes(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        self.addCleanup(conn.close)
        conn.putrequest("GET", "/api/events", skip_host=True)
        conn.putheader("Host", "127.0.0.1")
        conn.endheaders()
        resp = conn.getresponse()
        self.assertEqual(200, resp.status)
        self.assertEqual("text/event-stream; charset=utf-8", resp.getheader("Content-Type"))
        self.assertEqual(b": connected\n\n", resp.readline() + resp.readline())
        m = store.load(self.root); m["title"] = "изменено"; store.save(self.root, m)
        line = resp.readline()
        deadline = time.time() + 3
        while not line.startswith(b"data:") and time.time() < deadline:
            line = resp.readline()
        self.assertIn(b'"map"', line)

    def test_events_gated_by_host(self):
        status, _, _ = self.request("GET", "/api/events", host="evil.example")
        self.assertEqual(403, status)


class ModelJsRouteTest(ServerTestCase):
    def test_model_js_is_served_when_present(self):
        status, ctype, data = self.request("GET", "/model.js")
        if os.path.isfile(server._MODEL_PATH):
            self.assertEqual((200, "application/javascript; charset=utf-8"), (status, ctype))
        else:
            self.assertEqual(404, status)
```

Add `import time` at the top of the test file if missing, and set `watch_interval=0.05` in `ServerTestCase.setUp`'s `make_server` call so the stream test is fast.

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m unittest tests.test_server.WatcherTest tests.test_server.EventsRouteTest tests.test_server.ModelJsRouteTest -v`
Expected: FAIL (`AttributeError: Watcher`, 404 on `/api/events`).

- [ ] **Step 3: Implement**

```python
import queue
import time

PING_SECONDS = 30
_MODEL_PATH = os.path.join(os.path.dirname(_UI_PATH), "model.js")


class Watcher(threading.Thread):
    """Polls `(mtime, size)` of a few files and tells subscribers which label changed."""

    def __init__(self, paths_fn, interval=1.0):  # type: (Any, float) -> None
        threading.Thread.__init__(self, daemon=True)
        self.paths_fn = paths_fn
        self.interval = interval
        self._subs = []  # type: List[queue.Queue]
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._last = self.snapshot()

    def snapshot(self):  # type: () -> Dict[str, Any]
        out = {}  # type: Dict[str, Any]
        for label, path in (self.paths_fn() or {}).items():
            try:
                st = os.stat(path) if path else None
                out[label] = (st.st_mtime, st.st_size) if st else None
            except OSError:
                out[label] = None
        return out

    def subscribe(self):  # type: () -> queue.Queue
        q = queue.Queue()  # type: queue.Queue
        with self._lock:
            self._subs.append(q)
        return q

    def unsubscribe(self, q):  # type: (queue.Queue) -> None
        with self._lock:
            if q in self._subs:
                self._subs.remove(q)

    def stop(self):  # type: () -> None
        self._stop.set()

    def run(self):  # type: () -> None
        while not self._stop.wait(self.interval):
            current = self.snapshot()
            changed = sorted(label for label in set(current) | set(self._last)
                             if current.get(label) != self._last.get(label))
            self._last = current
            if not changed:
                continue
            with self._lock:
                subs = list(self._subs)
            for q in subs:
                q.put({"changed": changed})
```

In `Server.__init__`, after the base init:

```python
        self.watcher = Watcher(self._watched_paths, interval=watch_interval)
        self.watcher.start()

    def _watched_paths(self):  # type: () -> Dict[str, Optional[str]]
        return {"map": store.map_path(self.root),
                "session": os.path.join(store.map_dir(self.root), session.SESSION_FILE),
                "transcript": self.transcript_source.locate(store.load(self.root).get("session_id") or None)}

    def server_close(self):  # type: () -> None
        self.watcher.stop()
        ThreadingHTTPServer.server_close(self)
```

(`_watched_paths` reading `store.load` once a second is fine for a small JSON; it exists so a session file written after start is picked up.) `make_server(root, port=DEFAULT_PORT, transcript_source=None, ui_path=None, verbose=False, watch_interval=1.0)` passes it through.

Routes in `do_GET`:

```python
        elif path == "/api/events":
            self._events()
        elif path == "/model.js":
            self._file(getattr(self.server, "model_path", _MODEL_PATH), "application/javascript; charset=utf-8",
                       "ui/model.js не найден — интерфейс собран не полностью.")
```

with `_file(path, ctype, missing)` generalizing the index-serving code, and:

```python
    def _events(self):  # type: () -> None
        watcher = self.server.watcher  # type: ignore[attr-defined]
        q = watcher.subscribe()
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(b": connected\n\n")
            self.wfile.flush()
            while True:
                try:
                    event = q.get(timeout=PING_SECONDS)
                    frame = "data: %s\n\n" % json.dumps(event, ensure_ascii=False)
                except queue.Empty:
                    frame = ": ping\n\n"
                self.wfile.write(frame.encode("utf-8"))
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            watcher.unsubscribe(q)
```

`daemon_threads = True` on the server already lets these long-lived handler threads die with the process; `shutdown()` in tests does not wait for them.

- [ ] **Step 4: Run the server suite**

Run: `python3 -m unittest tests.test_server -v`
Expected: PASS. `HEAD /api/events` is not special-cased; `do_HEAD` calling `do_GET` would stream — add `if self.command == "HEAD": self._send(200, b"", "text/event-stream; charset=utf-8"); return` at the top of `_events`.

- [ ] **Step 5: Commit**

```bash
git add src/aang/server.py tests/test_server.py
git commit -m "server: /api/events over SSE with a file watcher; /model.js"
```

---

### Task 9: `hook.py` — `aang hook` for both harnesses

**Files:**
- Create: `src/aang/hook.py`
- Modify: `src/aang/cli.py` (add the `hook` verb; see Task 11 for the rest of the CLI)
- Test: `tests/test_hook.py`

**Interfaces:**
- Consumes: `session.*`, `store.load`, `transcript.index`, `server.annotate` (for `coverage`), `schema.validate`.
- Produces:
  - `hook.run(stdin_text, environ, out, err, now=None) -> int` — always returns 0; writes the JSON answer (or nothing) to `out`.
  - `hook.harness_of(payload, environ) -> str` (`"claude"` | `"codex"`).
  - `hook.ID_RE = re.compile(r"\b([dto]\d+)\b")`, `hook.MAX_DEIXIS = 5`.
  - `hook.prompt_context(root, map_dict, prompt, view) -> str` (the three parts), `hook.should_nudge(root, map_dict, view, payload, cfg, now) -> Optional[str]` (the reason text or `None`), `hook.continue_answer(harness, reason) -> Dict`.
  - CLI: `aang hook` reads stdin, calls `hook.run(sys.stdin.read(), os.environ, out, err)`.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_hook.py`:

```python
import io
import json
import os
import shutil
import tempfile
import unittest

from aang import hook, session, store

FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")
NORMAL = os.path.join(FIXTURES, "normal.jsonl")
NOW = "2026-09-11T12:30:00Z"


def a_map(*nodes, generated_at="2026-09-11T12:00:00Z"):
    return {"version": 1, "session_id": "s1", "generated_at": generated_at, "title": "т", "nodes": list(nodes)}


def decision(node_id, quote, **fields):
    base = {"id": node_id, "kind": "decision", "status": "accepted", "question": "Вопрос %s?" % node_id,
            "decision": "Решение %s" % node_id, "why": "почему", "cites": [{"quote": quote}]}
    base.update(fields)
    return base


class HookCase(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="aang-hook-")
        self.addCleanup(shutil.rmtree, self.root, True)

    def run_hook(self, payload, environ=None, now=NOW):
        out, err = io.StringIO(), io.StringIO()
        code = hook.run(json.dumps(payload), environ or {}, out, err, now=now)
        return code, out.getvalue(), err.getvalue()

    def claude(self, event, **extra):
        p = {"session_id": "s1", "transcript_path": NORMAL, "cwd": self.root, "hook_event_name": event,
             "prompt_id": "p1"}
        p.update(extra)
        return p

    def codex(self, event, **extra):
        p = {"session_id": "c1", "transcript_path": NORMAL, "cwd": self.root, "hook_event_name": event,
             "turn_id": "t1", "model": "gpt-6"}
        p.update(extra)
        return p


class NoMapTest(HookCase):
    def test_silent_without_a_map(self):
        code, out, err = self.run_hook(self.claude("Stop"))
        self.assertEqual((0, ""), (code, out))
        self.assertIsNone(session.read(self.root))

    def test_broken_stdin_is_silent(self):
        out, err = io.StringIO(), io.StringIO()
        self.assertEqual(0, hook.run("{nope", {}, out, err))
        self.assertEqual("", out.getvalue())
        self.assertNotEqual("", err.getvalue())


class SessionStartTest(HookCase):
    def test_writes_session_json_with_harness(self):
        store.save(self.root, a_map())
        code, out, _ = self.run_hook(self.codex("SessionStart", source="startup"))
        self.assertEqual((0, ""), (code, out))
        data = session.read(self.root)
        self.assertEqual(("codex", "c1", NORMAL, NOW), (data["harness"], data["session_id"], data["transcript_path"], data["last_event_at"]))

    def test_finds_the_map_above_cwd_and_keeps_last_nudge(self):
        store.save(self.root, a_map())
        session.write(self.root, {"last_nudge_turn": 4})
        deep = os.path.join(self.root, "sub"); os.makedirs(deep)
        self.run_hook(self.claude("SessionStart", cwd=deep))
        data = session.read(self.root)
        self.assertEqual(("claude", 4), (data["harness"], data["last_nudge_turn"]))

    def test_harness_detection(self):
        self.assertEqual("claude", hook.harness_of({"prompt_id": "x"}, {}))
        self.assertEqual("claude", hook.harness_of({"turn_number": 3}, {}))
        self.assertEqual("codex", hook.harness_of({"turn_id": "t"}, {}))
        self.assertEqual("claude", hook.harness_of({}, {"CLAUDE_CODE_SESSION_ID": "s"}))
        self.assertEqual("codex", hook.harness_of({}, {}))


class PromptTest(HookCase):
    def setUp(self):
        HookCase.setUp(self)
        store.save(self.root, a_map(decision("d1", "давай тогда pass@1"), decision("d2", "нужно 500 примеров вместо 100")))

    def context(self, out):
        return json.loads(out)["hookSpecificOutput"]

    def test_silent_when_nothing_to_say(self):
        code, out, _ = self.run_hook(self.claude("UserPromptSubmit", prompt="просто вопрос без ссылок"))
        self.assertEqual("", out)

    def test_outbox_is_delivered_then_cleared(self):
        session.outbox_append(self.root, "rejected", "d1", "не так")
        session.outbox_append(self.root, "confirmed", "d2", "")
        code, out, _ = self.run_hook(self.claude("UserPromptSubmit", prompt="дальше"))
        ctx = self.context(out)
        self.assertEqual("UserPromptSubmit", ctx["hookEventName"])
        self.assertIn("Из вьюера aang", ctx["additionalContext"])
        self.assertIn("отверг d1 «Вопрос d1?»: «не так»", ctx["additionalContext"])
        self.assertIn("подтвердил d2", ctx["additionalContext"])
        self.assertEqual([], session.outbox_read(self.root))

    def test_deixis_expands_existing_ids_only(self):
        code, out, _ = self.run_hook(self.claude("UserPromptSubmit", prompt="пересмотри d2 и d9, а d1?"))
        ctx = self.context(out)["additionalContext"]
        self.assertIn("d2 — Вопрос d2?", ctx)
        self.assertIn("Решение d2", ctx)
        self.assertIn("d1 — Вопрос d1?", ctx)
        self.assertNotIn("d9", ctx)

    def test_deixis_capped_at_five(self):
        nodes = [decision("d%d" % i, "давай тогда pass@1") for i in range(1, 9)]
        store.save(self.root, a_map(*nodes))
        code, out, _ = self.run_hook(self.claude("UserPromptSubmit", prompt=" ".join("d%d" % i for i in range(1, 9))))
        ctx = self.context(out)["additionalContext"]
        self.assertEqual(5, ctx.count(" — Вопрос d"))
        self.assertIn("и ещё 3", ctx)

    def test_coverage_line_only_with_a_tail(self):
        code, out, _ = self.run_hook(self.claude("UserPromptSubmit", prompt="d1"))
        self.assertIn("покрывает ходы до", self.context(out)["additionalContext"])


class StopTest(HookCase):
    def covered_map(self):
        # NORMAL has 6 turns; a quote from turn 1 covers only turn 1 → 5 turns of tail, 2 of them user.
        return a_map(decision("d1", "Начнём с метрик"))

    def test_nudges_after_enough_user_turns_and_records_the_turn(self):
        store.save(self.root, self.covered_map())
        with open(os.path.join(self.root, ".aang", "config.json"), "w") as h:
            json.dump({"nudge_turns": 2}, h)
        code, out, _ = self.run_hook(self.claude("Stop", turn_number=3, stop_hook_active=False))
        ans = json.loads(out)["hookSpecificOutput"]
        self.assertEqual(("Stop", True), (ans["hookEventName"], ans["continueConversation"]))
        self.assertIn("обнови карту", ans["continueReason"].lower())
        self.assertIn("skill \"aang\"", ans["continueReason"])
        self.assertEqual(6, session.read(self.root)["last_nudge_turn"])

    def test_codex_answer_shape(self):
        store.save(self.root, self.covered_map())
        with open(os.path.join(self.root, ".aang", "config.json"), "w") as h:
            json.dump({"nudge_turns": 2}, h)
        code, out, _ = self.run_hook(self.codex("Stop", stop_hook_active=False))
        ans = json.loads(out)
        self.assertEqual("block", ans["decision"])
        self.assertIn("$aang", ans["reason"])

    def test_silent_below_threshold(self):
        store.save(self.root, self.covered_map())  # 2 user turns since coverage < default 5
        code, out, _ = self.run_hook(self.claude("Stop", turn_number=3, stop_hook_active=False), now="2026-09-11T12:05:00Z")
        self.assertEqual("", out)

    def test_minutes_rule(self):
        store.save(self.root, self.covered_map())
        code, out, _ = self.run_hook(self.claude("Stop", turn_number=3, stop_hook_active=False), now="2026-09-11T12:20:00Z")
        self.assertNotEqual("", out)

    def test_no_double_nudge_and_no_nudge_while_candidate_exists(self):
        store.save(self.root, self.covered_map())
        session.write(self.root, {"last_nudge_turn": 6})
        code, out, _ = self.run_hook(self.claude("Stop", turn_number=3, stop_hook_active=False), now="2026-09-11T13:00:00Z")
        self.assertEqual("", out)
        session.write(self.root, {"last_nudge_turn": 0})
        with open(store.candidate_path(self.root), "w") as h:
            h.write("{}")
        code, out, _ = self.run_hook(self.claude("Stop", turn_number=3, stop_hook_active=False), now="2026-09-11T13:00:00Z")
        self.assertEqual("", out)

    def test_stop_hook_already_active_is_silent(self):
        store.save(self.root, self.covered_map())
        code, out, _ = self.run_hook(self.claude("Stop", turn_number=3, stop_hook_active=True), now="2026-09-11T13:00:00Z")
        self.assertEqual("", out)

    def test_missing_transcript_is_silent(self):
        store.save(self.root, self.covered_map())
        code, out, err = self.run_hook(self.claude("Stop", transcript_path=os.path.join(self.root, "none.jsonl"),
                                                   turn_number=3, stop_hook_active=False), now="2026-09-11T13:00:00Z")
        self.assertEqual((0, ""), (code, out))
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m unittest tests.test_hook -v`
Expected: FAIL — `ModuleNotFoundError: aang.hook`.

- [ ] **Step 3: Implement `src/aang/hook.py`**

```python
"""`aang hook`: the harness calls this on SessionStart, UserPromptSubmit and Stop.

Spec: docs/superpowers/specs/2026-09-11-live-companion-design.md, «Хук». Both Claude Code
and Codex send the same JSON on stdin (`session_id`, `transcript_path`, `cwd`,
`hook_event_name`, …) and read the same `hookSpecificOutput.additionalContext`; only the
"continue the turn" answer from Stop differs. Exit code is always 0 and stdout is empty
whenever there is nothing to say: a broken aang must never break a session.
"""

import datetime
import json
import re
from typing import Any, Dict, List, Optional

from . import schema, server, session, store, transcript

ID_RE = re.compile(r"\b([dto]\d+)\b")
MAX_DEIXIS = 5
REL_WORDS = {"orphaned_by": "осиротело решением", "rests_on": "держится на", "moots": "сделало неактуальным"}
VERDICT_WORDS = {"confirmed": "подтвердил", "rejected": "отверг", "research": "отправил в ресерч", "discuss": "отправил обсудить"}


def run(stdin_text, environ, out, err, now=None):  # type: (str, Dict[str, str], Any, Any, Optional[str]) -> int
    try:
        payload = json.loads(stdin_text) if stdin_text.strip() else {}
        if not isinstance(payload, dict):
            raise ValueError("hook payload is not an object")
        answer = handle(payload, environ, now or session.now_iso())
        if answer:
            out.write(json.dumps(answer, ensure_ascii=False))
            out.flush()
            after = answer.pop("_after", None)
            if after:
                after()
    except Exception as exc:  # noqa: BLE001 — a hook must never fail the session
        err.write("aang hook: %s\n" % exc)
    return 0


def harness_of(payload, environ):  # type: (Dict[str, Any], Dict[str, str]) -> str
    if "prompt_id" in payload or "turn_number" in payload:
        return "claude"
    if "turn_id" in payload:
        return "codex"
    return "claude" if environ.get("CLAUDE_CODE_SESSION_ID") else "codex"


def handle(payload, environ, now):  # type: (Dict[str, Any], Dict[str, str], str) -> Optional[Dict[str, Any]]
    root = session.find_root(payload.get("cwd") or ".")
    if not root:
        return None
    harness = harness_of(payload, environ)
    session.update(root, harness=harness, session_id=payload.get("session_id") or "",
                   transcript_path=payload.get("transcript_path") or "", cwd=payload.get("cwd") or "",
                   last_event_at=now)
    event = payload.get("hook_event_name")
    if event == "UserPromptSubmit":
        return _prompt(root, payload)
    if event == "Stop":
        return _stop(root, payload, harness, now)
    return None


def _view(root):  # type: (str) -> Dict[str, Any]
    map_dict = store.load(root)
    path = session.transcript_path(root)
    turns = transcript.index(path) if path else []
    error = None if turns else "транскрипт не найден"
    return server.annotate(map_dict, turns, error, path, session.read(root), root)


def _prompt(root, payload):  # type: (str, Dict[str, Any]) -> Optional[Dict[str, Any]]
    view = _view(root)
    if view["errors"]:
        return None
    text = prompt_context(root, view, str(payload.get("prompt") or ""))
    if not text:
        return None
    answer = {"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": text}}
    if session.outbox_read(root):
        answer["_after"] = lambda: session.outbox_clear(root)  # cleared only after stdout was written
    return answer


def prompt_context(root, view, prompt):  # type: (str, Dict[str, Any], str) -> str
    by_id = dict((n["id"], n) for n in view["nodes"])
    parts = []  # type: List[str]
    events = session.outbox_read(root)
    if events:
        lines = ["Из вьюера aang с прошлого хода (обязательно отреагируй в ответе и учти при следующем обновлении карты):"]
        for e in events:
            node = by_id.get(e["node"])
            q = " «%s»" % node["question"] if node else ""
            word = VERDICT_WORDS.get(e.get("kind"), e.get("kind"))
            tail = ""
            if e.get("text"):
                tail = " ответом: «%s»" % e["text"] if e.get("kind") == "confirmed" else ": «%s»" % e["text"]
            lines.append("- %s %s%s%s" % (word, e["node"], q, tail))
        parts.append("\n".join(lines))
    ids = []  # type: List[str]
    for found in ID_RE.findall(prompt):
        if found in by_id and found not in ids:
            ids.append(found)
    if ids:
        blocks = [_node_block(by_id[i], by_id) for i in ids[:MAX_DEIXIS]]
        if len(ids) > MAX_DEIXIS:
            blocks.append("…и ещё %d: %s" % (len(ids) - MAX_DEIXIS, ", ".join(ids[MAX_DEIXIS:])))
        parts.append("Узлы карты aang, упомянутые в промпте:\n" + "\n".join(blocks))
    cov = view.get("coverage") or {}
    if view.get("tail"):
        parts.append("Карта aang покрывает ходы до %s из %s." % (cov.get("covered_to"), cov.get("turns")))
    return "\n\n".join(parts)


def _node_block(n, by_id):  # type: (Dict[str, Any], Dict[str, Dict[str, Any]]) -> str
    lines = ["%s — %s" % (n["id"], n["question"])]
    lines.append("  вид: %s; статус: %s%s%s" % (
        n["kind"], n["status"],
        "; решил: %s" % n["decided_by"] if n.get("decided_by") else "",
        "; под вопросом: %s" % n["triage"] if n.get("triage") else ""))
    if n.get("decision"):
        lines.append("  решение: %s" % n["decision"])
    if n.get("why"):
        lines.append("  почему: %s" % n["why"])
    if n.get("consequence"):
        lines.append("  следствие: %s" % n["consequence"])
    rel = ["%s %s" % (REL_WORDS.get(r["rel"], r["rel"]), r["to"]) for r in n.get("relates") or []]
    holds = [r["from"] for r in n.get("related_by") or [] if r.get("rel") in ("rests_on", "orphaned_by")]
    if n.get("superseded_by"):
        rel.append("заменено %s" % n["superseded_by"])
    if rel:
        lines.append("  связи: " + "; ".join(rel))
    if holds:
        lines.append("  на этом держатся: " + ", ".join(holds))
    return "\n".join(lines)


def _stop(root, payload, harness, now):  # type: (str, Dict[str, Any], str, str) -> Optional[Dict[str, Any]]
    if payload.get("stop_hook_active") is True:
        return None
    view = _view(root)
    reason = should_nudge(root, view, session.config(root), now)
    if not reason:
        return None
    session.update(root, last_nudge_turn=view["turns"])
    return continue_answer(harness, reason)


def should_nudge(root, view, cfg, now):  # type: (str, Dict[str, Any], Dict[str, int], str) -> Optional[str]
    """The reason text when the map should be refreshed now, else None."""
    import os
    if view["errors"] or view.get("transcript_error") or not view["turns"]:
        return None
    if os.path.exists(store.candidate_path(root)):
        return None
    data = session.read(root) or {}
    if view["turns"] <= int(data.get("last_nudge_turn") or 0):
        return None
    covered = view["coverage"].get("covered_to") or 0
    user_since = sum(1 for t in view["tail"] if t["role"] == "user") if covered else \
        sum(1 for t in view["tail"] if t["role"] == "user")
    minutes = _minutes_between(view.get("generated_at") or "", now)
    if user_since >= cfg["nudge_turns"] or (minutes is not None and minutes >= cfg["nudge_minutes"] and user_since >= 1):
        return ("aang: с последнего обновления карты прошло %d %s пользователя. Обнови карту сейчас: "
                "выполни скилл aang (Claude Code: инструмент Skill, skill \"aang\"; Codex: $aang). "
                "Не спрашивай разрешения — это плановое обновление. После обновления заверши ход как обычно."
                % (user_since, _turns_word(user_since)))
    return None
```

Note on `tail` when nothing is covered: `annotate` returns `tail: []` when `covered_to` is `None`. For the nudge a map with no verified citation still needs a count, so make `_view` compute `user_since` itself when `covered_to` is `None`: replace the `user_since` lines with

```python
    covered = view["coverage"].get("covered_to")
    if covered is None:
        user_since = sum(1 for t in transcript.index(session.transcript_path(root)) if t["role"] == "user")
    else:
        user_since = sum(1 for t in view["tail"] if t["role"] == "user")
```

and finish the module:

```python
def continue_answer(harness, reason):  # type: (str, str) -> Dict[str, Any]
    if harness == "codex":
        return {"decision": "block", "reason": reason}
    return {"hookSpecificOutput": {"hookEventName": "Stop", "continueConversation": True, "continueReason": reason}}


def _minutes_between(then_iso, now_iso):  # type: (str, str) -> Optional[float]
    try:
        then = datetime.datetime.strptime(then_iso, "%Y-%m-%dT%H:%M:%SZ")
        now = datetime.datetime.strptime(now_iso, "%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        return None
    return (now - then).total_seconds() / 60.0


def _turns_word(n):  # type: (int) -> str
    if n % 10 == 1 and n % 100 != 11:
        return "ход"
    if 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14:
        return "хода"
    return "ходов"
```

Move `import os` to the top of the module. In `src/aang/cli.py` add the verb:

```python
    p_hook = sub.add_parser("hook", help="обработать событие среды (stdin: JSON хука Claude Code / Codex)")
    p_hook.set_defaults(func=cmd_hook)


def cmd_hook(args, out, err):  # type: (argparse.Namespace, Any, Any) -> int
    return hook.run(sys.stdin.read(), dict(os.environ), out, err)
```

- [ ] **Step 4: Run the hook suite**

Run: `python3 -m unittest tests.test_hook -v`
Expected: PASS. If `test_nudges_after_enough_user_turns` reports `last_nudge_turn` ≠ 6, check that `NORMAL` indexes to 6 turns (`python3 -c "from aang import transcript; print(len(transcript.index('tests/fixtures/normal.jsonl')))"` from `src` on the path) and adjust the expected number to that count — the rule is "the transcript's length at nudge time".

- [ ] **Step 5: Commit**

```bash
git add src/aang/hook.py src/aang/cli.py tests/test_hook.py
git commit -m "hook: aang hook for Claude Code and Codex — session file, outbox and deixis on prompt, nudge on stop"
```

---

### Task 10: `install.py` — `aang install`

**Files:**
- Create: `src/aang/install.py`
- Modify: `src/aang/cli.py` (verb `install`)
- Test: `tests/test_install.py`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces:
  - `install.EVENTS = ("SessionStart", "UserPromptSubmit", "Stop")`, `install.TIMEOUT = 20`
  - `install.entry(command, harness, event) -> Dict` — the hook group to append (`matcher: "*"` only for Claude `SessionStart`)
  - `install.add_hooks(settings, command, harness) -> (settings, added: List[str], present: List[str])` — pure; `settings` is the parsed JSON object
  - `install.is_aang_hook(hook_dict) -> bool` — command ends with ` hook` and contains `aang`
  - `install.run(targets, command, out, print_only=False) -> int` where `targets` is a list of `(harness, path)`; reads/creates the file, applies `add_hooks`, writes atomically with indent 2, prints per harness what was added / already present; with `print_only` prints the resulting JSON and writes nothing
  - `install.default_targets(home) -> List[(harness, path)]` — `("claude", ~/.claude/settings.json)` if `~/.claude` exists, `("codex", ~/.codex/hooks.json)` if `~/.codex` exists
  - `install.codex_hooks_disabled(config_toml_path) -> bool` — `hooks = false` under `[features]`
  - CLI: `aang install [--claude] [--codex] [--print]`; command path = `os.path.realpath(sys.argv[0])` when it ends with `aang`, else `aang`.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_install.py`:

```python
import io
import json
import os
import shutil
import tempfile
import unittest

from aang import install

CMD = "/opt/aang/bin/aang"


class AddHooksTest(unittest.TestCase):
    def test_adds_three_events_to_an_empty_settings(self):
        settings, added, present = install.add_hooks({}, CMD, "claude")
        self.assertEqual(["SessionStart", "UserPromptSubmit", "Stop"], added)
        self.assertEqual([], present)
        self.assertEqual("*", settings["hooks"]["SessionStart"][0]["matcher"])
        self.assertNotIn("matcher", settings["hooks"]["Stop"][0])
        self.assertEqual({"type": "command", "command": CMD + " hook", "timeout": 20},
                         settings["hooks"]["Stop"][0]["hooks"][0])

    def test_codex_entries_have_no_matcher(self):
        settings, _, _ = install.add_hooks({}, CMD, "codex")
        self.assertNotIn("matcher", settings["hooks"]["SessionStart"][0])

    def test_keeps_foreign_hooks_and_is_idempotent(self):
        foreign = {"hooks": {"SessionStart": [{"matcher": "*", "hooks": [{"type": "command", "command": "bash herdr.sh session", "timeout": 10}]}]}}
        settings, added, present = install.add_hooks(json.loads(json.dumps(foreign)), CMD, "claude")
        self.assertEqual(2, len(settings["hooks"]["SessionStart"]))
        self.assertEqual("bash herdr.sh session", settings["hooks"]["SessionStart"][0]["hooks"][0]["command"])
        again, added2, present2 = install.add_hooks(settings, "/elsewhere/aang", "claude")
        self.assertEqual(([], ["SessionStart", "UserPromptSubmit", "Stop"]), (added2, present2))
        self.assertEqual(2, len(again["hooks"]["SessionStart"]))

    def test_is_aang_hook(self):
        self.assertTrue(install.is_aang_hook({"command": "/x/bin/aang hook"}))
        self.assertTrue(install.is_aang_hook({"command": "aang hook"}))
        self.assertFalse(install.is_aang_hook({"command": "bash aang-ish.sh"}))
        self.assertFalse(install.is_aang_hook({"command": "/x/other hook"}))


class RunTest(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp(prefix="aang-home-")
        self.addCleanup(shutil.rmtree, self.home, True)

    def test_creates_and_updates_files(self):
        os.makedirs(os.path.join(self.home, ".claude"))
        os.makedirs(os.path.join(self.home, ".codex"))
        out = io.StringIO()
        targets = install.default_targets(self.home)
        self.assertEqual(2, len(targets))
        self.assertEqual(0, install.run(targets, CMD, out))
        claude = json.load(open(os.path.join(self.home, ".claude", "settings.json")))
        codex = json.load(open(os.path.join(self.home, ".codex", "hooks.json")))
        self.assertIn("Stop", claude["hooks"]); self.assertIn("Stop", codex["hooks"])
        self.assertIn("добавлено", out.getvalue())
        out2 = io.StringIO()
        install.run(targets, CMD, out2)
        self.assertIn("уже есть", out2.getvalue())
        self.assertNotIn("добавлено", out2.getvalue())

    def test_print_only_writes_nothing(self):
        os.makedirs(os.path.join(self.home, ".claude"))
        out = io.StringIO()
        install.run(install.default_targets(self.home), CMD, out, print_only=True)
        self.assertFalse(os.path.exists(os.path.join(self.home, ".claude", "settings.json")))
        self.assertIn("\"UserPromptSubmit\"", out.getvalue())

    def test_default_targets_skip_absent_harnesses(self):
        os.makedirs(os.path.join(self.home, ".codex"))
        self.assertEqual([("codex", os.path.join(self.home, ".codex", "hooks.json"))], install.default_targets(self.home))

    def test_broken_settings_file_is_refused_not_overwritten(self):
        os.makedirs(os.path.join(self.home, ".claude"))
        path = os.path.join(self.home, ".claude", "settings.json")
        with open(path, "w") as h:
            h.write("{broken")
        out = io.StringIO()
        self.assertEqual(1, install.run([("claude", path)], CMD, out))
        self.assertEqual("{broken", open(path).read())

    def test_codex_hooks_disabled_detection(self):
        path = os.path.join(self.home, "config.toml")
        with open(path, "w") as h:
            h.write("model = \"x\"\n[features]\nhooks = false\n[other]\nhooks = true\n")
        self.assertTrue(install.codex_hooks_disabled(path))
        with open(path, "w") as h:
            h.write("[features]\nhooks = true\n")
        self.assertFalse(install.codex_hooks_disabled(path))
        self.assertFalse(install.codex_hooks_disabled(os.path.join(self.home, "none.toml")))
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m unittest tests.test_install -v`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/aang/install.py`**

```python
"""`aang install`: register `aang hook` in the harness settings, idempotently.

Claude Code reads `~/.claude/settings.json` (`hooks.<Event>[].hooks[]`), Codex reads
`~/.codex/hooks.json` with the same shape. Foreign entries are kept; an aang entry is
recognised by its command (`… aang … hook`) so a moved checkout does not add a second one.
"""

import json
import os
import re
import tempfile
from typing import Any, Dict, List, Optional, Tuple

EVENTS = ("SessionStart", "UserPromptSubmit", "Stop")
TIMEOUT = 20
_MATCHER_EVENTS = {"claude": ("SessionStart",), "codex": ()}


def is_aang_hook(hook):  # type: (Any) -> bool
    command = hook.get("command") if isinstance(hook, dict) else None
    return isinstance(command, str) and command.rstrip().endswith(" hook") and "aang" in command


def entry(command, harness, event):  # type: (str, str, str) -> Dict[str, Any]
    group = {"hooks": [{"type": "command", "command": "%s hook" % command, "timeout": TIMEOUT}]}  # type: Dict[str, Any]
    if event in _MATCHER_EVENTS.get(harness, ()):
        group = dict([("matcher", "*")] + list(group.items()))
    return group


def add_hooks(settings, command, harness):
    # type: (Dict[str, Any], str, str) -> Tuple[Dict[str, Any], List[str], List[str]]
    hooks = settings.get("hooks")
    if not isinstance(hooks, dict):
        hooks = {}
        settings["hooks"] = hooks
    added, present = [], []  # type: List[str], List[str]
    for event in EVENTS:
        groups = hooks.get(event)
        if not isinstance(groups, list):
            groups = []
            hooks[event] = groups
        if any(isinstance(g, dict) and any(is_aang_hook(h) for h in (g.get("hooks") or [])) for g in groups):
            present.append(event)
            continue
        groups.append(entry(command, harness, event))
        added.append(event)
    return settings, added, present


def default_targets(home=None):  # type: (Optional[str]) -> List[Tuple[str, str]]
    home = home or os.path.expanduser("~")
    out = []  # type: List[Tuple[str, str]]
    if os.path.isdir(os.path.join(home, ".claude")):
        out.append(("claude", os.path.join(home, ".claude", "settings.json")))
    if os.path.isdir(os.path.join(home, ".codex")):
        out.append(("codex", os.path.join(home, ".codex", "hooks.json")))
    return out


def codex_hooks_disabled(config_toml):  # type: (str) -> bool
    try:
        with open(config_toml, "r", encoding="utf-8") as handle:
            text = handle.read()
    except OSError:
        return False
    section = None
    for line in text.splitlines():
        stripped = line.strip()
        m = re.match(r"^\[([^\]]+)\]$", stripped)
        if m:
            section = m.group(1).strip()
            continue
        if section == "features" and re.match(r"^hooks\s*=\s*false\b", stripped):
            return True
    return False


def run(targets, command, out, print_only=False):  # type: (List[Tuple[str, str]], str, Any, bool) -> int
    code = 0
    for harness, path in targets:
        settings = {}  # type: Dict[str, Any]
        if os.path.exists(path):
            try:
                with open(path, "r", encoding="utf-8") as handle:
                    settings = json.load(handle)
            except (OSError, ValueError) as exc:
                out.write("%s: файл %s не читается как JSON (%s) — не тронут\n" % (harness, path, exc))
                code = 1
                continue
            if not isinstance(settings, dict):
                out.write("%s: файл %s — не объект JSON, не тронут\n" % (harness, path))
                code = 1
                continue
        settings, added, present = add_hooks(settings, command, harness)
        if print_only:
            out.write("%s → %s\n%s\n" % (harness, path, json.dumps(settings, ensure_ascii=False, indent=2)))
            continue
        if added:
            _write(path, settings)
        out.write("%s: %s\n" % (harness, path))
        if added:
            out.write("  добавлено: %s\n" % ", ".join(added))
        if present:
            out.write("  уже есть: %s\n" % ", ".join(present))
        if harness == "codex" and codex_hooks_disabled(os.path.join(os.path.dirname(path), "config.toml")):
            out.write("  внимание: в config.toml стоит [features] hooks = false — хуки не сработают\n")
    return code


def _write(path, settings):  # type: (str, Dict[str, Any]) -> None
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".%s-" % os.path.basename(path), suffix=".tmp", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(json.dumps(settings, ensure_ascii=False, indent=2) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        if os.path.exists(path):
            os.chmod(tmp, os.stat(path).st_mode & 0o777)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
```

CLI verb in `cli.py`:

```python
    p_install = sub.add_parser("install", help="подключить `aang hook` к Claude Code и Codex (идемпотентно)")
    p_install.add_argument("--claude", action="store_true", help="только ~/.claude/settings.json")
    p_install.add_argument("--codex", action="store_true", help="только ~/.codex/hooks.json")
    p_install.add_argument("--print", action="store_true", dest="print_only", help="показать результат, ничего не писать")
    p_install.set_defaults(func=cmd_install)


def cmd_install(args, out, err):  # type: (argparse.Namespace, Any, Any) -> int
    targets = install.default_targets()
    if args.claude or args.codex:
        wanted = set(h for h, flag in (("claude", args.claude), ("codex", args.codex)) if flag)
        targets = [t for t in targets if t[0] in wanted]
    if not targets:
        err.write("Не найдено ни ~/.claude, ни ~/.codex — устанавливать некуда.\n")
        return 1
    return install.run(targets, _aang_command(), out, print_only=args.print_only)


def _aang_command():  # type: () -> str
    argv0 = os.path.realpath(sys.argv[0]) if sys.argv and sys.argv[0] else ""
    return argv0 if os.path.basename(argv0) == "aang" else "aang"
```

- [ ] **Step 4: Run the tests**

Run: `python3 -m unittest tests.test_install tests.test_cli -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/aang/install.py src/aang/cli.py tests/test_install.py
git commit -m "install: aang install registers the hook in Claude Code and Codex settings"
```

---

### Task 11: CLI — `merge`/`check`/`export`/`view` use `session.json`; gitignore hint; `view` reuses a running server

**Files:**
- Modify: `src/aang/cli.py` (`_source`, `cmd_merge`, `cmd_view`, `cmd_check`)
- Test: `tests/test_cli.py`

**Interfaces:**
- Consumes: `server.TranscriptSource(root=)`, `session.read`, `session.transcript_path`.
- Produces: `_source(args, root)` passes `root`; `merge` prints `Транскрипт: <path> (из .aang/session.json | по --transcript | по --session | самый свежий)`; `merge` prints a `.gitignore` hint when the project's `.gitignore` lacks any of `candidate.json`, `session.json`, `outbox.jsonl` under `.aang/`; `view` on `EADDRINUSE` probes `http://127.0.0.1:<port>/api/map` and, when it answers with `root` equal to this root, prints `aang: уже запущен — http://127.0.0.1:<port>/` and exits 0.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_cli.py` (`CliTestCase`, `candidate`, `decision`, `NORMAL` exist there):

```python
class SessionJsonInCliTest(CliTestCase):
    def write_candidate(self, *nodes):
        os.makedirs(os.path.join(self.root, ".aang"), exist_ok=True)
        with open(store.candidate_path(self.root), "w", encoding="utf-8") as h:
            json.dump(candidate(*nodes), h)

    def test_merge_takes_the_transcript_from_session_json_and_says_so(self):
        from aang import session
        session.write(self.root, {"harness": "codex", "transcript_path": NORMAL})
        self.write_candidate(decision("d1", "давай тогда pass@1"))
        code, out, err = self.run_cli("merge", "--root", self.root, "--transcript-root", os.path.join(self.root, "nowhere"))
        self.assertEqual(0, code, err)
        self.assertIn("из .aang/session.json", out)
        self.assertIn("найдено: 1", out)

    def test_merge_hints_gitignore_once(self):
        self.write_candidate(decision("d1", "давай тогда pass@1"))
        code, out, _ = self.run_cli("merge", "--root", self.root, "--transcript", NORMAL)
        self.assertIn(".gitignore", out)
        self.assertIn("outbox.jsonl", out)
        with open(os.path.join(self.root, ".gitignore"), "w") as h:
            h.write(".aang/candidate.json\n.aang/session.json\n.aang/outbox.jsonl\n")
        self.write_candidate(decision("d1", "давай тогда pass@1"))
        code, out, _ = self.run_cli("merge", "--root", self.root, "--transcript", NORMAL)
        self.assertNotIn(".gitignore", out)

    def test_check_uses_session_json_too(self):
        from aang import session
        self.write_candidate(decision("d1", "давай тогда pass@1"))
        self.run_cli("merge", "--root", self.root, "--transcript", NORMAL)
        session.write(self.root, {"harness": "claude", "transcript_path": NORMAL})
        code, out, _ = self.run_cli("check", "--root", self.root, "--transcript-root", os.path.join(self.root, "nowhere"))
        self.assertEqual(0, code, out)


class ViewReuseTest(CliTestCase):
    def test_second_view_on_the_same_root_prints_the_running_url(self):
        import threading
        from aang import server
        store.save(self.root, candidate())
        srv = server.make_server(self.root, 0, server.TranscriptSource(path=NORMAL, roots=[], root=self.root))
        port = srv.server_address[1]
        t = threading.Thread(target=srv.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True); t.start()
        self.addCleanup(srv.server_close); self.addCleanup(srv.shutdown)
        code, out, err = self.run_cli("view", "--root", self.root, "--port", str(port))
        self.assertEqual(0, code, err)
        self.assertIn("уже запущен", out)
        self.assertIn("http://127.0.0.1:%d/" % port, out)

    def test_port_held_by_someone_else_is_still_an_error(self):
        import socket
        other = tempfile.mkdtemp(prefix="aang-other-"); self.addCleanup(shutil.rmtree, other, True)
        s = socket.socket(); s.bind(("127.0.0.1", 0)); s.listen(1); self.addCleanup(s.close)
        code, out, err = self.run_cli("view", "--root", self.root, "--port", str(s.getsockname()[1]))
        self.assertEqual(1, code)
        self.assertIn("порт", err.lower())
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m unittest tests.test_cli.SessionJsonInCliTest tests.test_cli.ViewReuseTest -v`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `cli.py`:

```python
def _source(args, root):  # type: (argparse.Namespace, str) -> server.TranscriptSource
    return server.TranscriptSource(path=args.transcript, session_id=args.session,
                                   roots=args.transcript_roots, root=root)


def _source_origin(args, root, source):  # type: (argparse.Namespace, str, server.TranscriptSource) -> str
    if args.transcript:
        return "по --transcript"
    if source.path and session.transcript_path(root) == source.path:
        return "из .aang/session.json"
    if args.session:
        return "по --session"
    return "самый свежий"
```

Every `_source(args)` call becomes `_source(args, root)`. In `cmd_merge`, after `turns, transcript_error = source.turns(session_id)`:

```python
    if not transcript_error:
        out.write("Транскрипт: %s (%s)\n" % (source.path, _source_origin(args, root, source)))
```

and before `return 0`:

```python
    missing = _gitignore_missing(root)
    if missing:
        out.write("Совет: добавьте в .gitignore проекта — %s\n" % ", ".join(missing))


def _gitignore_missing(root):  # type: (str) -> List[str]
    wanted = [".aang/candidate.json", ".aang/session.json", ".aang/outbox.jsonl"]
    try:
        with open(os.path.join(root, ".gitignore"), "r", encoding="utf-8") as handle:
            lines = set(l.strip() for l in handle)
    except OSError:
        lines = set()
    return [w for w in wanted if w not in lines and ".aang/" not in lines and ".aang" not in lines]
```

In `cmd_view`, on `OSError` from `make_server`:

```python
    except OSError as exc:
        running = _running_here(args.port, root)
        if running:
            out.write("aang: уже запущен — %s\n" % running)
            return 0
        err.write("Не удалось занять порт %d: %s\n" % (args.port, exc))
        return 1


def _running_here(port, root):  # type: (int, str) -> Optional[str]
    """URL of an `aang view` already serving `root` on `port`, else None."""
    import http.client
    try:
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=1)
        conn.request("GET", "/api/map", headers={"Host": "127.0.0.1"})
        resp = conn.getresponse()
        data = json.loads(resp.read().decode("utf-8")) if resp.status == 200 else None
        conn.close()
    except (OSError, ValueError):
        return None
    if isinstance(data, dict) and data.get("root") == root:
        return "http://127.0.0.1:%d/" % port
    return None
```

(`import json` at the top of `cli.py`.)

- [ ] **Step 4: Run the CLI suite and everything**

Run: `python3 -m unittest tests.test_cli -v && python3 -m unittest discover -s tests -t .`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/aang/cli.py tests/test_cli.py
git commit -m "cli: transcript from session.json, gitignore hint on merge, view reuses a running server"
```

---

### Task 12: `ui/model.js` — pure viewer logic, tested under node

**Files:**
- Create: `ui/model.js`
- Modify: `tests/test_server.py` (`_viewer_function` reads both files; new tests), `ui/index.html` (load `model.js`; `test_index_is_self_contained` allows the relative script)
- Test: `tests/test_server.py`

**Interfaces:**
- Consumes: `/model.js` route (Task 8), `triage.CELLS` order (a test compares).
- Produces (all top-level `function name(` declarations in `ui/model.js`, attached to `window.AangModel` at the end and also usable under node via `module.exports` when `module` exists):
  - `CELLS` — array of `{key, title, sub}` in the same order as `triage.CELLS`
  - `isUnseen(node) -> bool`, `cellOf(node) -> string` — same rules as `triage.py`
  - `authorOf(node) -> "user" | "agent" | "unknown" | null` (`null` for non-decisions)
  - `firstTurn(node) -> number | null` — smallest `turn` among `cites` with `ok === true`
  - `timelineLayout(map, opts) -> {width, height, lanes, marks, coverage}`: `opts = {pxPerTurn: 12, laneHeight: 28, gutter: 60, stepDown: 6}`; `lanes = [{kind: "tacit", y}, {kind: "open", y}, {kind: "decision", y}]`; `marks = [{id, kind, x, y, turn, cell, author, unseen, superseded, rejected, noTurn}]` — `x = gutter + (turn - 1) * pxPerTurn` for turns, nodes without a turn get `x = gutter / 2` and `noTurn: true`; nodes sharing `(turn, kind)` step down by `stepDown` in `nodes` order; `coverage = {x: gutter + coveredTo * pxPerTurn}` or `null`; `width = gutter + turns * pxPerTurn`.
  - `neighbourhoodLayout(node, map, opts) -> {center, left, right, top, bottom, overflow}`: `opts = {width: 320, height: 180, max: 6}`; `left` = targets of `relates` (`rests_on`, `orphaned_by`, `moots`) as `{id, rel, x, y}`, `right` = `related_by` sources with `rel` in `rests_on`/`orphaned_by` (dependants) plus `moots` sources, `top` = `superseded_by` target, `bottom` = nodes whose `superseded_by` is this node; columns spread evenly in `y`; when the total exceeds `max`, the last slot becomes `{id: "+N", overflow: N}` and `overflow = N`.
  - `verdictButtons(node) -> string[]` — subset of `["confirmed", "research", "discuss", "rejected"]` per the spec: `superseded` → `[]`; `rejected` → `["confirmed"]`; `accepted` decision → `["research", "discuss", "rejected"]`; otherwise all four.

- [ ] **Step 1: Write the failing tests**

In `tests/test_server.py` change `_viewer_function` to search `server._UI_PATH` and then `server._MODEL_PATH`:

```python
def _viewer_function(name):
    """The source of one top-level `function <name>(...) {...}` from ui/index.html or ui/model.js."""
    for path in (server._UI_PATH, server._MODEL_PATH):
        with open(path, encoding="utf-8") as handle:
            page = handle.read()
        start = page.find("function %s(" % name)
        if start < 0:
            continue
        depth = 0
        for i in range(start, len(page)):
            if page[i] == "{":
                depth += 1
            elif page[i] == "}":
                depth -= 1
                if depth == 0:
                    return page[start:i + 1]
        raise AssertionError("unbalanced braces in %s" % name)
    raise AssertionError("no function %s in the viewer" % name)


def _model_call(expr):
    """Evaluate `expr` against ui/model.js under node; returns the parsed JSON result."""
    script = ("var module = {exports: {}}; var window = {};\n" + open(server._MODEL_PATH, encoding="utf-8").read() +
              "\nvar M = module.exports; process.stdout.write(JSON.stringify(" + expr + "));")
    done = subprocess.run(["node", "-e", script], capture_output=True, check=True)
    return json.loads(done.stdout.decode("utf-8"))
```

Add tests:

```python
@unittest.skipUnless(shutil.which("node"), "node not on PATH")
class ModelJsTest(unittest.TestCase):
    def test_cells_match_python_order(self):
        from aang import triage
        keys = _model_call("M.CELLS.map(function (c) { return c.key; })")
        self.assertEqual([c[0] for c in triage.CELLS], keys)

    def test_cell_of_agrees_with_python_on_a_grid(self):
        from aang import triage
        import itertools
        cases = []
        for kind, status, decided_by, tri, seen in itertools.product(
                ("decision", "tacit", "open"), ("accepted", "proposed", "superseded", "rejected"),
                (None, "user", "agent"), (None, "research", "discuss"), (None, "2026-09-11T11:00:00Z", "2026-09-11T13:00:00Z")):
            cases.append({"id": "x", "kind": kind, "status": status, "decided_by": decided_by, "triage": tri,
                          "seen_at": seen, "added_at": "2026-09-11T12:00:00Z",
                          "relates": [{"to": "d0", "rel": "orphaned_by"}] if kind == "open" and status == "proposed" else []})
        got = _model_call("%s.map(M.cellOf)" % json.dumps(cases))
        self.assertEqual([triage.cell(c) for c in cases], got)

    def test_timeline_positions_are_a_function_of_turn_and_kind(self):
        m = {"coverage": {"covered_to": 4, "turns": 10}, "nodes": [
            {"id": "d1", "kind": "decision", "status": "accepted", "cites": [{"turn": 3, "ok": True}]},
            {"id": "d2", "kind": "decision", "status": "accepted", "cites": [{"turn": 3, "ok": True}]},
            {"id": "t1", "kind": "tacit", "status": "accepted", "cites": [{"turn": 1, "ok": True}, {"turn": 9, "ok": True}]},
            {"id": "o1", "kind": "open", "status": "proposed", "cites": []}]}
        lay = _model_call("M.timelineLayout(%s, {pxPerTurn: 12, laneHeight: 28, gutter: 60, stepDown: 6})" % json.dumps(m))
        marks = dict((k["id"], k) for k in lay["marks"])
        self.assertEqual(60 + 2 * 12, marks["d1"]["x"]); self.assertEqual(marks["d1"]["x"], marks["d2"]["x"])
        self.assertEqual(marks["d1"]["y"] + 6, marks["d2"]["y"])  # staircase, not overlap
        self.assertEqual(60, marks["t1"]["x"])  # first verified turn
        self.assertTrue(marks["o1"]["noTurn"]); self.assertEqual(30, marks["o1"]["x"])
        self.assertEqual(60 + 4 * 12, lay["coverage"]["x"])
        self.assertEqual(60 + 10 * 12, lay["width"])
        grown = dict(m); grown["coverage"] = {"covered_to": 12, "turns": 30}
        grown["nodes"] = m["nodes"] + [{"id": "d3", "kind": "decision", "status": "accepted", "cites": [{"turn": 20, "ok": True}]}]
        lay2 = _model_call("M.timelineLayout(%s, {pxPerTurn: 12, laneHeight: 28, gutter: 60, stepDown: 6})" % json.dumps(grown))
        old = dict((k["id"], (k["x"], k["y"])) for k in lay["marks"])
        for k in lay2["marks"]:
            if k["id"] in old:
                self.assertEqual(old[k["id"]], (k["x"], k["y"]), k["id"])  # U9: nothing moved

    def test_neighbourhood_layout(self):
        m = {"nodes": [
            {"id": "t5", "kind": "tacit", "relates": [], "related_by": [{"from": "d7", "rel": "rests_on"}, {"from": "o6", "rel": "rests_on"}]},
            {"id": "d7", "kind": "decision", "relates": [{"to": "t5", "rel": "rests_on"}], "related_by": [{"from": "o6", "rel": "orphaned_by"}], "superseded_by": None},
            {"id": "o6", "kind": "open", "relates": [{"to": "d7", "rel": "orphaned_by"}, {"to": "t5", "rel": "rests_on"}], "related_by": []},
            {"id": "d8", "kind": "decision", "relates": [], "related_by": [], "superseded_by": "d7"}]}
        lay = _model_call("M.neighbourhoodLayout(%s, %s, {width: 320, height: 180, max: 6})" % (json.dumps(m["nodes"][1]), json.dumps(m)))
        self.assertEqual("d7", lay["center"]["id"])
        self.assertEqual(["t5"], [n["id"] for n in lay["left"]])
        self.assertEqual(["o6"], [n["id"] for n in lay["right"]])
        self.assertEqual(["d8"], [n["id"] for n in lay["bottom"]])
        self.assertEqual(0, lay["overflow"])
        self.assertTrue(all(n["x"] < 160 for n in lay["left"]) and all(n["x"] > 160 for n in lay["right"]))

    def test_neighbourhood_overflow(self):
        rb = [{"from": "o%d" % i, "rel": "rests_on"} for i in range(1, 10)]
        m = {"nodes": [{"id": "t1", "kind": "tacit", "relates": [], "related_by": rb}] +
             [{"id": "o%d" % i, "kind": "open", "relates": [{"to": "t1", "rel": "rests_on"}], "related_by": []} for i in range(1, 10)]}
        lay = _model_call("M.neighbourhoodLayout(%s, %s, {width: 320, height: 180, max: 6})" % (json.dumps(m["nodes"][0]), json.dumps(m)))
        self.assertEqual(6, len(lay["right"]))
        self.assertEqual(4, lay["overflow"])
        self.assertEqual("+4", lay["right"][-1]["id"])

    def test_verdict_buttons(self):
        self.assertEqual([], _model_call("M.verdictButtons({kind:'decision', status:'superseded'})"))
        self.assertEqual(["confirmed"], _model_call("M.verdictButtons({kind:'decision', status:'rejected'})"))
        self.assertEqual(["research", "discuss", "rejected"], _model_call("M.verdictButtons({kind:'decision', status:'accepted'})"))
        self.assertEqual(["confirmed", "research", "discuss", "rejected"], _model_call("M.verdictButtons({kind:'open', status:'proposed'})"))
```

Change `test_index_is_self_contained` to also assert the page references `model.js` relatively: `self.assertIn('src="model.js"', page)`.

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m unittest tests.test_server.ModelJsTest -v`
Expected: FAIL (`ui/model.js` missing).

- [ ] **Step 3: Implement `ui/model.js`**

```js
/* aang viewer — pure model functions. No DOM. Loaded by index.html; run under node by tests.
   Rules mirror src/aang/triage.py (cells, unseen) — a test compares CELLS order and cellOf on a grid. */
(function (root) {
  "use strict";

  var CELLS = [
    { key: "inbox", title: "Входящее", sub: "предложения агента и вопросы, которых вы ещё не видели" },
    { key: "research", title: "Ресерч", sub: "под вопросом: нужно исследовать" },
    { key: "discuss", title: "Обсудить", sub: "под вопросом: нужно обсудить" },
    { key: "confirmed", title: "Подтверждено", sub: "принято — вами или агентом" },
    { key: "rejected", title: "Отвергнуто", sub: "остаётся в записи, чтобы не предлагать снова" },
    { key: "tacit", title: "Неявные решения", sub: "приняты без того, чтобы кто-то выбирал" },
    { key: "orphaned", title: "Осиротело решениями", sub: "вопросы, которые повисли из-за принятого решения" },
    { key: "hanging", title: "Просто висит", sub: "к этому не вернулись; какое решение виновато — не названо" },
    { key: "decisions", title: "Решения", sub: "заменённые и предложенные вами" }
  ];
  var LANES = ["tacit", "open", "decision"];

  function hasRel(n, rel) {
    return (n.relates || []).some(function (r) { return r && r.rel === rel; });
  }
  function isUnseen(n) {
    var seen = n.seen_at || "", added = n.added_at || "";
    if (!seen) return true;
    return !!added && seen < added;
  }
  function cellOf(n) {
    if (n.status === "rejected") return "rejected";
    if (n.triage === "research") return "research";
    if (n.triage === "discuss") return "discuss";
    if (n.kind === "decision" && n.status === "accepted") return "confirmed";
    if (n.kind === "decision" && n.status === "proposed" && n.decided_by === "agent") return "inbox";
    if (n.kind === "open" && isUnseen(n)) return "inbox";
    if (n.kind === "tacit") return "tacit";
    if (n.kind === "open") return hasRel(n, "orphaned_by") ? "orphaned" : "hanging";
    return "decisions";
  }
  function authorOf(n) {
    if (n.kind !== "decision") return null;
    return n.decided_by === "user" || n.decided_by === "agent" ? n.decided_by : "unknown";
  }
  function firstTurn(n) {
    var best = null;
    (n.cites || []).forEach(function (c) {
      if (c && c.ok === true && typeof c.turn === "number" && (best === null || c.turn < best)) best = c.turn;
    });
    return best;
  }
  function verdictButtons(n) {
    if (n.status === "superseded") return [];
    if (n.status === "rejected") return ["confirmed"];
    if (n.kind === "decision" && n.status === "accepted") return ["research", "discuss", "rejected"];
    return ["confirmed", "research", "discuss", "rejected"];
  }

  // Position is a pure function of (turn, kind): a later map moves nothing that was already there (U9).
  function timelineLayout(map, opts) {
    var px = opts.pxPerTurn, lh = opts.laneHeight, g = opts.gutter, step = opts.stepDown;
    var cov = map.coverage || {};
    var turns = cov.turns || 0;
    var lanes = LANES.map(function (kind, i) { return { kind: kind, y: lh * i + lh / 2 }; });
    var laneY = {}; lanes.forEach(function (l) { laneY[l.kind] = l.y; });
    var stacked = {};
    var marks = (map.nodes || []).map(function (n) {
      var t = firstTurn(n);
      var kind = laneY.hasOwnProperty(n.kind) ? n.kind : "decision";
      var key = kind + ":" + (t === null ? "-" : t);
      var k = stacked[key] || 0; stacked[key] = k + 1;
      var x = t === null ? g / 2 : g + (t - 1) * px;
      if (t !== null && t > turns) turns = t;
      return { id: n.id, kind: kind, x: x, y: laneY[kind] + k * step, turn: t, cell: cellOf(n),
               author: authorOf(n), unseen: isUnseen(n), superseded: n.status === "superseded",
               rejected: n.status === "rejected", noTurn: t === null };
    });
    return { width: g + turns * px, height: lh * LANES.length, lanes: lanes, marks: marks,
             coverage: typeof cov.covered_to === "number" ? { x: g + cov.covered_to * px } : null };
  }

  function neighbourhoodLayout(n, map, opts) {
    var w = opts.width, h = opts.height, max = opts.max;
    var byId = {}; (map.nodes || []).forEach(function (m) { byId[m.id] = m; });
    var left = (n.relates || []).map(function (r) { return { id: r.to, rel: r.rel }; });
    var right = (n.related_by || []).map(function (r) { return { id: r.from, rel: r.rel }; });
    var top = n.superseded_by ? [{ id: n.superseded_by, rel: "superseded_by" }] : [];
    var bottom = (map.nodes || []).filter(function (m) { return m.superseded_by === n.id; })
      .map(function (m) { return { id: m.id, rel: "superseded_by" }; });
    var total = left.length + right.length + top.length + bottom.length;
    var overflow = 0;
    if (total > max) {
      overflow = total - max + 1;
      var keep = max - 1;
      var cols = [left, right, top, bottom], i = 0;
      while (left.length + right.length + top.length + bottom.length > keep) {
        var col = cols[i % cols.length]; i++;
        if (col.length) col.pop();
      }
      right.push({ id: "+" + overflow, rel: "", overflow: overflow });
    }
    var place = function (list, x) {
      list.forEach(function (e, idx) { e.x = x; e.y = h * (idx + 1) / (list.length + 1); });
      return list;
    };
    place(left, w * 0.15); place(right, w * 0.85);
    top.forEach(function (e) { e.x = w / 2; e.y = h * 0.12; });
    bottom.forEach(function (e, idx) { e.x = w / 2 + (idx - (bottom.length - 1) / 2) * 60; e.y = h * 0.88; });
    return { center: { id: n.id, x: w / 2, y: h / 2 }, left: left, right: right, top: top, bottom: bottom, overflow: overflow };
  }

  var api = { CELLS: CELLS, LANES: LANES, hasRel: hasRel, isUnseen: isUnseen, cellOf: cellOf, authorOf: authorOf,
              firstTurn: firstTurn, verdictButtons: verdictButtons, timelineLayout: timelineLayout,
              neighbourhoodLayout: neighbourhoodLayout };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AangModel = api;
})(typeof window !== "undefined" ? window : this);
```

Write the inner functions as top-level `function name(` declarations inside the IIFE (as above) so `_viewer_function` can lift them. In `ui/index.html`, add `<script src="model.js"></script>` right before the inline `<script>` and, at the top of the inline IIFE, `var M = window.AangModel;`.

- [ ] **Step 4: Run the tests**

Run: `python3 -m unittest tests.test_server -v`
Expected: PASS (`ModelJsTest` skipped without node — install node if that happens; the test must actually run at least once).

- [ ] **Step 5: Commit**

```bash
git add ui/model.js ui/index.html tests/test_server.py
git commit -m "viewer: model.js — cells, timeline and neighbourhood layouts, verdict buttons"
```

---

### Task 13: Viewer — cells, author, verdicts, seen, copy link, hook status, tail strip, live updates

**Files:**
- Modify: `ui/index.html` (header, tools, spine groups, detail pane, boot)
- Test: `tests/test_server.py::ViewerStringsTest` (strings), Playwright smoke in the final task

**Interfaces:**
- Consumes: `M.CELLS`, `M.cellOf`, `M.authorOf`, `M.verdictButtons`, `M.isUnseen`; routes `/api/events`, `/api/node/<id>/verdict`, `/api/node/<id>/seen`; view keys `cell`, `tail`, `hook`, `root`.
- Produces: DOM ids used by Task 14/15: `#timeline` (empty `<section>` between `header.top` and `main.panes`), `#detail` unchanged; functions `applyMap(map, opts)` where `opts.keepScroll` preserves scroll; `state.seenPending`, `state.lastBodyHash`.

- [ ] **Step 1: Write the failing string tests**

Add to `ViewerStringsTest`:

```python
    def test_index_carries_the_cells_verdicts_and_live_words(self):
        page = self.request("GET", "/")[2].decode("utf-8")
        for word in ("Входящее", "Ресерч", "Обсудить", "Подтверждено", "Отвергнуто", "ничего нового",
                     "подтвердить", "в ресерч", "обсудить", "отвергнуть", "видел", "скопировать ссылку",
                     "не на карте", "хук не установлен", "aang install", "связь потеряна", "/api/events",
                     "решил: вы", "решил: агент", "\"мои\"", "\"агента\""):
            self.assertIn(word, page, word)
        self.assertNotIn("ordered(map)", page.split("function ordered(")[0])  # spine groups come from M.CELLS
```

(The last assertion pins that the old `GROUPS`/`ordered` pair is gone: remove `GROUPS`, `ordered`, `flatOrder` and derive everything from `M.CELLS`; `test_index_triage_titles_bound_to_the_orphan_predicate` is deleted — the predicate now lives in `model.js` and is covered by `ModelJsTest.test_cell_of_agrees_with_python_on_a_grid`.)

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m unittest tests.test_server.ViewerStringsTest -v`
Expected: FAIL on the new words.

- [ ] **Step 3: Implement in `ui/index.html`**

Header (`<header class="top">`): add after `#meta-coverage`:

```html
    <span id="meta-hook"></span>
    <span id="meta-live" hidden></span>
```

After the header, before `#banner-errors`:

```html
<section class="tail" id="tail" hidden>
  <details><summary id="tail-summary"></summary><ol id="tail-list"></ol></details>
</section>
<section class="timeline" id="timeline" aria-label="Ход сессии" hidden></section>
```

Tools: add a filter group `<span class="fg" data-group="author" role="group" aria-label="Автор">` with buttons `data-v="user"` «мои» and `data-v="agent"` «агента»; `state.filter.author = []`; in `passes`: `if (f.author.length && f.author.indexOf(M.authorOf(n)) < 0) return false;`; `filterActive` includes it; `filter-reset` resets it.

Spine: replace `GROUPS`/`ordered`/`flatOrder` with

```js
  function grouped(map) {
    var out = {};
    M.CELLS.forEach(function (c) { out[c.key] = []; });
    map.nodes.forEach(function (n) { out[n.cell || M.cellOf(n)].push(n); });
    Object.keys(out).forEach(function (k) { out[k].reverse(); });  // newest first
    return out;
  }
  function flatOrder(map) {
    var g = grouped(map);
    return M.CELLS.reduce(function (acc, c) { return acc.concat(g[c.key]); }, []);
  }
```

and in `renderSpine` iterate `M.CELLS`: a cell with no nodes is skipped except `inbox`, which renders `<p class="empty-group">ничего нового</p>`; each `<h2>` gets class `cell-<key>` and, for `inbox` with nodes, a button `<button class="btn" data-seen-all="1">видел всё</button>`. Row additions: for decisions an author tag `<span class="tag author-<a>">решил: вы|агент|?</span>`; the `unseen` state adds class `unseen` on the `<li>` and a small button `<button class="btn tiny" data-seen="<id>">видел</button>` in `.state`. Status label map gains `rejected: "отвергнуто"`; the status filter group gains a button for `rejected`.

Detail pane, after the kicker: the verdict block

```js
  function verdictHtml(n) {
    var buttons = M.verdictButtons(n);
    if (!buttons.length) return "";
    var label = { confirmed: "подтвердить", research: "в ресерч", discuss: "обсудить", rejected: "отвергнуть" };
    var v = state.verdict && state.verdict.id === n.id ? state.verdict : null;
    var html = "<section class=\"verdict\" aria-label=\"Вердикт\"><h3>Вердикт</h3><p class=\"vbtns\">" +
      buttons.map(function (b) { return "<button type=\"button\" class=\"btn v-" + b + (v && v.kind === b ? " primary" : "") + "\" data-verdict=\"" + b + "\">" + label[b] + "</button>"; }).join("") +
      "<button type=\"button\" class=\"btn\" data-copy=\"1\" title=\"Скопировать id и вопрос для промпта\">скопировать ссылку</button>" +
      (M.isUnseen(n) ? "<button type=\"button\" class=\"btn\" data-seen=\"" + esc(n.id) + "\">видел</button>" : "") + "</p>";
    if (v) {
      var need = n.kind === "open" && (v.kind === "confirmed" || v.kind === "rejected");
      html += "<form class=\"editor\" data-verdict-form=\"1\"><label class=\"hint\" for=\"vd-text\">" +
        (v.kind === "confirmed" && n.kind === "open" ? "Ответ (станет решением)" : v.kind === "rejected" ? "Почему" : "Комментарий (необязательно)") + "</label>" +
        "<textarea id=\"vd-text\" name=\"text\"" + (need ? " required" : "") + ">" + esc(v.text || "") + "</textarea>" +
        "<div class=\"actions\"><button type=\"submit\" class=\"btn primary\"" + (v.busy ? " disabled" : "") + ">" + label[v.kind] + "</button>" +
        "<button type=\"button\" class=\"btn\" data-cancel-verdict=\"1\">Отмена</button></div>" +
        (v.errors ? "<div class=\"err\" role=\"alert\">✗ " + v.errors.map(esc).join("<br>") + "</div>" : "") + "</form>";
    }
    return html + "</section>";
  }
```

Bind in `bindDetail`: `[data-verdict]` → `state.verdict = {id, kind, text: "", busy: false, errors: null}; renderDetail`; the form submit → `postJson("/api/node/" + id + "/verdict", {verdict, text})` then `applyMap(view, {keepScroll: true})`, errors into `state.verdict.errors`; `[data-copy]` → `navigator.clipboard.writeText(n.id + " — " + n.question)` with a fallback `prompt()`; `[data-seen]` (both in spine and pane) → `postJson("/api/node/" + id + "/seen", {})` then `applyMap`; `[data-seen-all]` → sequential `seen` posts for every `inbox` node that `M.isUnseen`. `postJson(url, body)` is one helper returning `{ok, status, json}`.

Header: `renderHeader` adds cell counts (`"<span>" + title + ": <b>" + count + "</b></span>"` for the five triage cells with non-zero counts, `inbox` always), and the hook line:

```js
    var hk = map.hook || {};
    if (!hk.installed) {
      $("meta-hook").innerHTML = "хук не установлен — <code>aang install</code>";
    } else {
      var ago = hk.last_event_at ? Math.round((Date.now() - new Date(hk.last_event_at).getTime()) / 60000) : null;
      $("meta-hook").textContent = "хук: " + (hk.harness || "?") + (ago === null ? "" : ago > 30 ? ", сигнала не было " + ago + " мин" : ", сигнал " + ago + " мин назад");
    }
```

Tail strip:

```js
  function renderTail(map) {
    var tail = map.tail || [];
    $("tail").hidden = !tail.length;
    if (!tail.length) return;
    var mine = tail.filter(function (t) { return t.role === "user"; }).length;
    $("tail-summary").textContent = "не на карте: " + tail.length + " " + plural(tail.length, "ход", "хода", "ходов") + ", " + mine + " " + plural(mine, "ваш", "ваших", "ваших");
    $("tail-list").innerHTML = tail.map(function (t) {
      return "<li class=\"r-" + esc(t.role) + "\"><span class=\"turn\">ход " + esc(t.turn) + "</span> " + esc(t.text) + "</li>";
    }).join("");
  }
```

Live updates, at the boot section:

```js
  function connectEvents() {
    if (!window.EventSource) return;
    var es = new EventSource("/api/events");
    var lostTimer = null;
    es.onopen = function () { clearTimeout(lostTimer); $("meta-live").hidden = true; };
    es.onmessage = function (ev) {
      var data; try { data = JSON.parse(ev.data); } catch (e) { return; }
      if (data && data.changed) load({ keepScroll: true });
    };
    es.onerror = function () {
      clearTimeout(lostTimer);
      lostTimer = setTimeout(function () { $("meta-live").hidden = false; $("meta-live").textContent = "связь потеряна — переподключаюсь"; }, 5000);
    };
  }
```

`load(opts)` fetches `/api/map`, hashes the body text (a small string hash function `hashOf(s)`), skips `applyMap` when equal to `state.lastBodyHash`, else stores the hash and calls `applyMap(map, opts)`. `applyMap(map, opts)`: when `opts && opts.keepScroll`, record `window.scrollY`, `$("spine").scrollTop`, and `$("timeline").scrollLeft`, keep `state.selected` and `state.editing`/`state.verdict` when the node still exists, re-render, restore the scroll positions; also compute `state.appeared = ids present now and absent before` for the timeline blink (Task 14). Call `connectEvents()` after the first `load()`. `renderTail(map)` is called from `applyMap`.

CSS: `.tail`, `.timeline`, `.verdict`, `.vbtns`, `.tag.author-user|agent|unknown`, `.tag.status-rejected { text-decoration: line-through; color: var(--bad); }`, `li.unseen .q::before { content: "●"; color: var(--open); }`, `h2.cell-inbox` accent.

- [ ] **Step 4: Run the server suite and look at the page**

Run: `python3 -m unittest tests.test_server -v`, then `bin/aang view --root . --port 8795` in the background and open `http://127.0.0.1:8795/` — the dogfood map of this repo must render with cells, the hook line («хук не установлен — aang install») and, with `aang view` running, `hand-edit` a field and see the page refresh without reload. Stop the server.
Expected: tests PASS; page renders; no console errors.

- [ ] **Step 5: Commit**

```bash
git add ui/index.html tests/test_server.py
git commit -m "viewer: cells, author, verdicts, seen, copy link, hook status, tail strip, live updates"
```

---

### Task 14: Viewer — timeline SVG

**Files:**
- Modify: `ui/index.html` (`renderTimeline`, called from `applyMap` and `select`; CSS)

**Interfaces:**
- Consumes: `M.timelineLayout`, `neighbours(n, map)` (existing), `state.selected`, `state.appeared`.
- Produces: `renderTimeline(map)`; `#timeline` contains one scrollable `<div class="tl-scroll">` with an `<svg>` of `layout.width × (layout.height + 18)`; marks are `<g class="mark k-<kind> c-<cell> a-<author>" data-id>` with a `<title>`; selected node's arcs `<path class="tl-arc out|in">`; coverage `<line class="tl-cov">`; tail hatched `<rect class="tl-tail">` with user ticks `<line class="tl-tick">` at `x` of each user tail turn.

- [ ] **Step 1: Implement**

```js
  var TL = { pxPerTurn: 12, laneHeight: 28, gutter: 60, stepDown: 6 };
  function markShape(m, r) {
    if (m.kind === "tacit") return "<path d=\"M" + m.x + " " + (m.y - r) + " L" + (m.x + r) + " " + m.y + " L" + m.x + " " + (m.y + r) + " L" + (m.x - r) + " " + m.y + "Z\"/>";
    if (m.kind === "open") return "<rect x=\"" + (m.x - r) + "\" y=\"" + (m.y - r) + "\" width=\"" + 2 * r + "\" height=\"" + 2 * r + "\"/>";
    return "<circle cx=\"" + m.x + "\" cy=\"" + m.y + "\" r=\"" + r + "\"" + (m.author === "agent" ? " class=\"hollow\"" : "") + "/>";
  }
  function renderTimeline(map) {
    var el = $("timeline");
    if (!map.nodes || !map.nodes.length) { el.hidden = true; return; }
    el.hidden = false;
    var lay = M.timelineLayout(map, TL);
    var H = lay.height + 18, r = 5;
    var byId = {}; lay.marks.forEach(function (m) { byId[m.id] = m; });
    var svg = "<svg width=\"" + lay.width + "\" height=\"" + H + "\" viewBox=\"0 0 " + lay.width + " " + H + "\" role=\"img\" aria-label=\"Ход сессии: узлы по ходам\">";
    lay.lanes.forEach(function (l) {
      svg += "<line class=\"tl-lane\" x1=\"" + TL.gutter + "\" y1=\"" + l.y + "\" x2=\"" + lay.width + "\" y2=\"" + l.y + "\"/>" +
        "<text class=\"tl-lane-label k-" + l.kind + "\" x=\"" + (TL.gutter - 6) + "\" y=\"" + (l.y + 4) + "\" text-anchor=\"end\">" + esc(KIND_MARK[l.kind]) + "</text>";
    });
    if (lay.coverage) {
      svg += "<rect class=\"tl-tail\" x=\"" + lay.coverage.x + "\" y=\"0\" width=\"" + Math.max(0, lay.width - lay.coverage.x) + "\" height=\"" + lay.height + "\"/>" +
        "<line class=\"tl-cov\" x1=\"" + lay.coverage.x + "\" y1=\"0\" x2=\"" + lay.coverage.x + "\" y2=\"" + lay.height + "\"/>";
      (map.tail || []).forEach(function (t) {
        if (t.role !== "user") return;
        var x = TL.gutter + (t.turn - 1) * TL.pxPerTurn;
        svg += "<line class=\"tl-tick\" x1=\"" + x + "\" y1=\"" + (lay.height - 6) + "\" x2=\"" + x + "\" y2=\"" + lay.height + "\"/>";
      });
    }
    for (var t = 10; t <= (map.coverage && map.coverage.turns) || 0; t += 10) {
      svg += "<text class=\"tl-axis\" x=\"" + (TL.gutter + (t - 1) * TL.pxPerTurn) + "\" y=\"" + (H - 4) + "\" text-anchor=\"middle\">" + t + "</text>";
    }
    var sel = state.selected ? byId[state.selected] : null;
    if (sel) neighbours(byId[sel.id] && byIdMap(map, sel.id), map).forEach(function (e) {
      var o = byId[e.id]; if (!o) return;
      var mid = (sel.x + o.x) / 2, lift = Math.min(40, Math.abs(sel.x - o.x) / 4 + 8);
      svg += "<path class=\"tl-arc " + e.dir + "\" d=\"M" + sel.x + " " + sel.y + " Q " + mid + " " + (Math.min(sel.y, o.y) - lift) + " " + o.x + " " + o.y + "\"/>";
    });
    lay.marks.forEach(function (m) {
      var cls = "mark k-" + m.kind + " c-" + m.cell + (m.author ? " a-" + m.author : "") + (m.unseen ? " unseen" : "") +
        (m.superseded ? " sup" : "") + (m.rejected ? " rej" : "") + (state.selected === m.id ? " sel" : "") + (state.appeared && state.appeared[m.id] ? " appeared" : "");
      var n = byIdMap(map, m.id);
      svg += "<g class=\"" + cls + "\" data-id=\"" + esc(m.id) + "\" tabindex=\"0\" role=\"button\"><title>" + esc(m.id) + (m.turn ? " · ход " + m.turn : " · без хода") + " — " + esc(n ? n.question : "") + "</title>" +
        (m.unseen ? "<circle class=\"ring\" cx=\"" + m.x + "\" cy=\"" + m.y + "\" r=\"" + (r + 3) + "\"/>" : "") + markShape(m, r) +
        (m.rejected ? "<path class=\"x\" d=\"M" + (m.x - r) + " " + (m.y - r) + " L" + (m.x + r) + " " + (m.y + r) + " M" + (m.x + r) + " " + (m.y - r) + " L" + (m.x - r) + " " + (m.y + r) + "\"/>" : "") +
        (m.superseded ? "<line class=\"strike\" x1=\"" + (m.x - r - 2) + "\" y1=\"" + m.y + "\" x2=\"" + (m.x + r + 2) + "\" y2=\"" + m.y + "\"/>" : "") + "</g>";
    });
    svg += "</svg>";
    var scroll = el.querySelector(".tl-scroll");
    var atEnd = !scroll || scroll.scrollLeft + scroll.clientWidth >= scroll.scrollWidth - 40;
    var left = scroll ? scroll.scrollLeft : 0;
    el.innerHTML = "<div class=\"tl-scroll\">" + svg + "</div>";
    scroll = el.querySelector(".tl-scroll");
    scroll.scrollLeft = atEnd ? scroll.scrollWidth : left;
    el.querySelectorAll("g.mark").forEach(function (g) {
      g.addEventListener("click", function () { select(g.getAttribute("data-id"), true); });
      g.addEventListener("keydown", function (ev) { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); select(g.getAttribute("data-id"), true); } });
    });
  }
  function byIdMap(map, id) { return byId(map, id); }
```

(Use the existing `byId(map, id)` directly; `byIdMap` is only named here to keep the two dictionaries apart — inline it.) CSS: `.timeline { max-width: 1400px; margin: 12px auto 0; }`, `.tl-scroll { overflow-x: auto; }`, `.tl-lane { stroke: var(--line); }`, `.tl-tail { fill: url(#hatch) }` — define a `<pattern id="hatch">` inside the SVG `<defs>` (diagonal lines, `stroke: var(--line)`), `.tl-cov { stroke: var(--ink-2); stroke-dasharray: 3 3; }`, `.tl-tick { stroke: var(--ink-2); }`, `.mark circle, .mark rect, .mark path { fill: currentColor; stroke: currentColor; }`, `.mark .hollow { fill: var(--panel); stroke-width: 2; }`, `.mark.c-inbox { color: var(--open); } .mark.c-research, .mark.c-discuss { color: var(--warn); } .mark.c-confirmed { color: var(--ok); } .mark.c-rejected { color: var(--bad); } .mark.c-tacit { color: var(--tacit); } .mark.c-orphaned, .mark.c-hanging { color: var(--open); } .mark.c-decisions { color: var(--ink-2); }`, `.mark .ring { fill: none; stroke: currentColor; stroke-width: 1.5; opacity: .7; }`, `.mark.appeared .ring { animation: aang-blink 1.2s 1; }` with `@keyframes aang-blink { 0%,100% { opacity: .7 } 50% { opacity: 0 } }` under `@media (prefers-reduced-motion: no-preference)`, `.mark.sel circle, .mark.sel rect, .mark.sel path { stroke-width: 3; }`, `.tl-arc { fill: none; stroke: var(--decision); stroke-width: 1.5; } .tl-arc.in { stroke-dasharray: 4 3; }`, `.mark .x, .mark .strike { stroke: var(--bad); stroke-width: 2; fill: none; }`. Responsive: `@media (max-width: 900px) { .timeline { display: none; } }` plus a toggle button `#timeline-toggle` in the tools («показать ход сессии») that sets `display: block`; the spec's single-lane fold at 900 px is implemented as: below 900 px `renderTimeline` passes `laneHeight: 10` with all three `y` collapsed — simplest: `TL_NARROW = {pxPerTurn: 12, laneHeight: 0, gutter: 40, stepDown: 6}` produces one lane (`y = 0` for all) and the SVG height becomes `24`; pick `window.matchMedia("(max-width: 900px)").matches ? TL_NARROW : TL`, and re-render on `resize`.

`select(id, scroll)` calls `renderTimeline(state.map)` after `renderDetail`; `applyMap` calls it after `renderSpine`.

- [ ] **Step 2: Check in the browser**

Run `bin/aang view --root . --port 8795` (background), open the page: the lane strip shows the dogfood map's 20 nodes by turn, the coverage line at turn 52, hatching to the right; clicking a mark selects the row; selecting `d6` draws its arcs. Resize below 900 px: the strip collapses to one lane. Stop the server.

- [ ] **Step 3: Run the tests**

Run: `python3 -m unittest tests.test_server -v` — the string tests still pass (`"Ход сессии"` may be added to the vocabulary test).

- [ ] **Step 4: Commit**

```bash
git add ui/index.html tests/test_server.py
git commit -m "viewer: timeline strip — turn × kind at fixed scale, coverage and tail, arcs for the selected node"
```

---

### Task 15: Viewer — neighbourhood mini-graph in the pane

**Files:**
- Modify: `ui/index.html` (`neighbourhoodHtml`, called from `renderDetail` above `linksHtml`; CSS)

**Interfaces:**
- Consumes: `M.neighbourhoodLayout(n, map, {width: 320, height: 180, max: 6})`, `REL_LABEL`.
- Produces: `<section class="hood"><svg …></svg></section>`; nodes are `<g class="hn" data-goto>`; the `+N` node has `data-more="1"` and toggles the `links` section open (`<details>`-wrap `linksHtml`'s list when overflow > 0).

- [ ] **Step 1: Implement**

```js
  function neighbourhoodHtml(n, map) {
    var lay = M.neighbourhoodLayout(n, map, { width: 320, height: 180, max: 6 });
    var all = lay.left.concat(lay.right, lay.top, lay.bottom);
    if (!all.length) return "";
    var node = function (e, cls) {
      var t = byId(map, e.id);
      var label = e.overflow ? e.id : e.id;
      return "<g class=\"hn " + cls + (e.overflow ? " more" : "") + "\" data-" + (e.overflow ? "more=\"1\"" : "goto=\"" + esc(e.id) + "\"") + " tabindex=\"0\" role=\"button\">" +
        "<title>" + esc(e.overflow ? "ещё " + e.overflow + " — см. список связей" : e.id + " — " + (t ? t.question : "нет в карте")) + "</title>" +
        "<rect x=\"" + (e.x - 22) + "\" y=\"" + (e.y - 11) + "\" width=\"44\" height=\"22\" rx=\"4\"/>" +
        "<text x=\"" + e.x + "\" y=\"" + (e.y + 4) + "\" text-anchor=\"middle\">" + esc(label) + "</text></g>";
    };
    var edge = function (e, from, to, label) {
      var mx = (from.x + to.x) / 2, my = (from.y + to.y) / 2;
      return "<line class=\"he\" x1=\"" + from.x + "\" y1=\"" + from.y + "\" x2=\"" + to.x + "\" y2=\"" + to.y + "\"/>" +
        (label ? "<text class=\"hl\" x=\"" + mx + "\" y=\"" + (my - 4) + "\" text-anchor=\"middle\">" + esc(label) + "</text>" : "");
    };
    var c = lay.center;
    var svg = "<svg viewBox=\"0 0 320 180\" width=\"320\" height=\"180\" role=\"img\" aria-label=\"Окрестность узла " + esc(n.id) + "\">";
    lay.left.forEach(function (e) { svg += edge(e, c, e, REL_LABEL[e.rel] || e.rel); });
    lay.right.forEach(function (e) { if (!e.overflow) svg += edge(e, e, c, REL_LABEL[e.rel] || e.rel); });
    lay.top.forEach(function (e) { svg += edge(e, c, e, "заменено"); });
    lay.bottom.forEach(function (e) { svg += edge(e, e, c, "заменяет"); });
    svg += "<g class=\"hn center\"><rect x=\"" + (c.x - 26) + "\" y=\"" + (c.y - 13) + "\" width=\"52\" height=\"26\" rx=\"5\"/><text x=\"" + c.x + "\" y=\"" + (c.y + 5) + "\" text-anchor=\"middle\">" + esc(n.id) + "</text></g>";
    lay.left.forEach(function (e) { svg += node(e, "l"); });
    lay.right.forEach(function (e) { svg += node(e, "r"); });
    lay.top.forEach(function (e) { svg += node(e, "t"); });
    lay.bottom.forEach(function (e) { svg += node(e, "b"); });
    return "<section class=\"hood\" aria-label=\"Окрестность\"><h3>Окрестность</h3>" + svg + "</svg>" +
      "<p class=\"hint\">слева — на чём держится и что осиротило; справа — что держится на нём</p></section>";
  }
```

`renderDetail`: `html += neighbourhoodHtml(n, map); html += linksHtml(n, map);`. In `bindDetail`, `[data-more]` scrolls to and opens the `.links` section (`el.querySelector(".links").scrollIntoView(); ` and if it is wrapped in `<details>`, set `open = true`). CSS: `.hood svg { max-width: 100%; height: auto; display: block; }`, `.hn rect { fill: var(--panel-2); stroke: var(--line); } .hn.center rect { stroke: var(--decision); stroke-width: 2; } .hn text { font: 12px var(--font-mono); fill: var(--ink); } .hn.more rect { stroke-dasharray: 3 3; } .he { stroke: var(--ink-2); } .hl { font: 10px var(--font-ui); fill: var(--ink-2); }`, `.hn:focus rect, .hn:hover rect { stroke: var(--decision); }`.

- [ ] **Step 2: Check in the browser**

With the dogfood map, select `t5`: left empty, right `d7`, `d11`, `o6` (the three dependants the spec names). Select `d3`: top `d4`. Select `o6`: left `d7` («осиротело решением») and `t5` («опирается на»).

- [ ] **Step 3: Tests and commit**

Run: `python3 -m unittest discover -s tests -t .` — PASS. Add «Окрестность» to the vocabulary test.

```bash
git add ui/index.html tests/test_server.py
git commit -m "viewer: neighbourhood mini-graph in the pane"
```

---

### Task 16: Skill and README

**Files:**
- Modify: `.claude/skills/aang/SKILL.md`
- Modify: `README.md`

**Interfaces:** none (text). The strings below are the spec's; keep them.

- [ ] **Step 1: Skill frontmatter and procedure**

Frontmatter: delete `disable-model-invocation: true`; `description` becomes: `Map what this session decided … Run when the user types /aang, or when the aang hook tells you to refresh the map; never on your own initiative.`

Procedure changes:
- New step 0 (before «1. If `.aang/map.json` exists»): «If `.aang/outbox.jsonl` exists and is not empty, read it: each line is a verdict the user gave in the viewer (`confirmed` / `rejected` / `research` / `discuss` on a node, with an optional text). Carry every verdict into the candidate — `status: rejected`, `triage: research|discuss`, an answered `open` becomes a `decision` with `decided_by: user` — and after a successful merge empty the file (`: > .aang/outbox.jsonl`).»
- Step 6: `aang merge` with no `--session`: «merge knows the session from `.aang/session.json`, written by the hook; without it, it takes the newest transcript under `~/.claude/projects` or `~/.codex/sessions` and prints which. Read that line and confirm it is this session.» Same for steps 7 and 8. Delete the `$CLAUDE_CODE_SESSION_ID` sentences.
- Step 8: «If `aang view` prints `уже запущен`, the viewer is already open on that URL — do not start another.»
- Step 9 adds: how many nodes sit in «Входящее», and, if the hook is not installed (the `merge` output or `session.json` absence tells you), one line: `aang install` connects live updates.

New section after «Three kinds»: **«Пачка в конце шага»** — verbatim from the spec's Codex section («Скилл учит раскладывать пачку»): decisions the agent made itself are `decision`, `status: proposed`, `decided_by: agent`; «обрати внимание на X» / «запусти Z» are `open` with `orphaned_by`; questions to the user are `open` with `why` saying so; the user's verdicts in chat map to `status`/`triage`/`decided_by`; rejected stays as `rejected`.

Fields: in the `decision` field list add `decided_by` («`user` when the user chose or agreed in words or by acting; `agent` when you chose and the user has not yet weighed in — then `status: proposed`») and `triage` («`research` / `discuss` when the user said "изучи" / "обсудим"; `null` otherwise; only on `proposed` decisions and `open` nodes»). `status` gains `rejected` («the user said no; keep the node, put the reason in `against`»). In «The file» JSON example add `"decided_by": "user", "triage": null`. «Never» gains: «Write `seen_at`», «Mark an `open` node `accepted` or `rejected`: answer it (it becomes a decision) or leave it».

- [ ] **Step 2: README**

Install block gains:

```sh
ln -s ~/src/aang/.claude/skills/aang ~/.agents/skills/aang   # `$aang` in Codex
aang install                                                  # live updates: hooks for Claude Code and Codex
```

Commands table gains `aang hook` («called by the harness; not for humans») and `aang install [--claude] [--codex] [--print]`. A new section **«Live»** (4–6 sentences): what the hook does on the three events, the 5-turn / 15-minute rule and `.aang/config.json`, the viewer's cells and verdicts and that verdicts reach the agent on the next prompt, deixis by id, and that `.aang/session.json` / `outbox.jsonl` / `candidate.json` belong in `.gitignore`. «The map» section: the three new node fields and `rejected`. «Files» table: the three new files.

- [ ] **Step 3: Verify the skill still parses and the vocabulary test passes**

Run: `head -5 .claude/skills/aang/SKILL.md` (frontmatter has `name`, `description`, no `disable-model-invocation`), then `python3 -m unittest discover -s tests -t .`.

- [ ] **Step 4: Commit**

```bash
git add .claude/skills/aang/SKILL.md README.md
git commit -m "skill, readme: hook-driven refresh, verdicts from the viewer, the end-of-step batch, Codex install"
```

---

### Task 17: End-to-end verification and dogfood

**Files:**
- Modify: `.aang/map.json` only through `/aang` (never by hand); `docs/decisions.md` via `aang export`.

- [ ] **Step 1: Full suite**

Run: `python3 -m unittest discover -s tests -t .` — all PASS, `ModelJsTest` not skipped.

- [ ] **Step 2: Hook round-trip without a harness**

```sh
printf '%s' '{"session_id":"x","transcript_path":"tests/fixtures/normal.jsonl","cwd":"'"$PWD"'","hook_event_name":"SessionStart","prompt_id":"p"}' | bin/aang hook; echo "exit $?"
cat .aang/session.json
printf '%s' '{"session_id":"x","transcript_path":"tests/fixtures/normal.jsonl","cwd":"'"$PWD"'","hook_event_name":"UserPromptSubmit","prompt_id":"p","prompt":"что с d6?"}' | bin/aang hook
```

Expected: exit 0; `session.json` names `claude`; the second call prints a JSON with `additionalContext` containing `d6 — Чем становится итоговый продукт?`. Then delete `.aang/session.json` (it points at a fixture).

- [ ] **Step 3: Install dry-run**

Run: `bin/aang install --print | head -40` — both harnesses listed, the herdr `SessionStart` entry preserved, the aang entries added; nothing written (`git -C ~ status` is irrelevant; check `ls -la ~/.claude/settings.json` mtime unchanged).

- [ ] **Step 4: Playwright pass on the real viewer**

Start `bin/aang view --root . --port 8796` in the background; with the Playwright MCP tools open `http://127.0.0.1:8796/`, take screenshots of: the page top (cells + timeline), `t5` selected (mini-graph shows `d7, d11, o6`), the verdict form on an `open` node (do not submit on the dogfood map). Save screenshots under `.superpowers/ux/live-*.png` (untracked). Stop the server.

- [ ] **Step 5: Dogfood**

In this session run `/aang` (the skill), then `bin/aang export`, and commit `.aang/map.json` and `docs/decisions.md` with message `aang: dogfood map after the live companion`.

- [ ] **Step 6: Finish the branch**

Invoke `superpowers:finishing-a-development-branch`; the branch is `worktree-live-companion`, target `master`. Do not merge without the user's word — other agents work in parallel on `master`.

---

## Self-review against the spec

- L1 → Tasks 9, 10, 16. L2 → Tasks 8, 13. L3 → Tasks 6 (tail), 12, 14. L4 → Tasks 1, 4, 13. L5 → Tasks 2, 4, 12, 13. L6 → Tasks 3, 7, 9, 16. L7 → Task 9. L8 → Tasks 5, 9, 10. L9 → Tasks 12, 14 (fixed scale, no library). L10 → Tasks 6, 13.
- Data section: `rejected`/`decided_by`/`triage`/`seen_at` → Task 1; cell rule → Task 2 (Python) and 12 (JS), compared by test; files → Task 3; `.gitignore` hint → Task 11; export → Task 4.
- Hook section: root discovery, harness detection, three events, thresholds, `config.json`, `last_nudge_turn`, `candidate.json` guard, `stop_hook_active`, reason text, answer shapes → Task 9; skill loses `disable-model-invocation` → Task 16.
- Viewer section: SSE + preserved state → Tasks 8, 13; tail → 6, 13; cells → 13; verdict table and routes → 2, 7, 13; seen → 7, 13; copy link → 13; timeline details (lanes, shapes, ring, coverage, hatch, ticks, arcs, autoscroll, narrow modes) → 14; neighbourhood (≤6, `+N`, columns) → 12, 15; header (hook status, SSE state, cell counts) → 13.
- Codex section: adapter, both trees, `cwd` preference, `session.json` first, skill link, `merge` prints the source, `view` reuse → Tasks 5, 6, 11, 16.
- Install section → Task 10 (`--print`, idempotence, foreign hooks, `config.toml` warning, absolute command).
- Deviation recorded: `cwd` preference wins over recency outright (not only on an mtime tie) — Task 5's docstring says so; the spec's tie rule was weaker than useful. Residual cell «Решения» for superseded / user-proposed decisions — Task 2 — the spec table had no home for them.
- Type consistency: `TranscriptSource(root=)` (6) is what `cli._source` (11), `hook._view` (9) and tests use; `annotate(..., session_info, root)` (6) is called by `hook._view` (9) and `Handler._view` (6); `session.outbox_append(root, kind, node_id, text, at=None)` (3) is called by `server._post_verdict` (7) and tests (9); `triage.apply_verdict(node, verdict, text)` (2) by `server._post_verdict` (7); `M.timelineLayout(map, opts)` (12) by `renderTimeline` (14); `M.neighbourhoodLayout(n, map, opts)` (12) by `neighbourhoodHtml` (15); `install.run(targets, command, out, print_only)` (10) by `cli.cmd_install` (10).
