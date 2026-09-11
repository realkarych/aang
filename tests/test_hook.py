"""Tests for `aang hook`.

The turn numbers below come from `fixtures/normal.jsonl`: it indexes to 9 turns, 5 of
them the user's, and 4 of those fall after turn 1 — the turn `StopTest.covered_map`
cites. `TURNS` is what the hook records as `last_nudge_turn`, which is the transcript's
length at nudge time.
"""

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

TURNS = 9
USER_TURNS_AFTER_FIRST = 4


def a_map(*nodes, **kw):
    generated_at = kw.pop("generated_at", "2026-09-11T12:00:00Z")
    assert not kw, kw
    return {"version": 1, "session_id": "s1", "generated_at": generated_at, "title": "т", "nodes": list(nodes)}


def decision(node_id, quote, **fields):
    base = {"id": node_id, "kind": "decision", "status": "accepted", "question": "Вопрос %s?" % node_id,
            "decision": "Решение %s" % node_id, "why": "почему", "cites": [{"quote": quote}]}
    base.update(fields)
    return base


class Recorder(object):
    """A stdout stand-in that snapshots the outbox at the moment the answer is written."""

    def __init__(self, root):
        self.root = root
        self.text = ""
        self.outbox_at_write = None

    def write(self, chunk):
        if self.outbox_at_write is None:
            self.outbox_at_write = session.outbox_read(self.root)
        self.text += chunk

    def flush(self):
        pass


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

    def test_payload_that_is_not_an_object_is_silent(self):
        out, err = io.StringIO(), io.StringIO()
        self.assertEqual(0, hook.run("[1, 2]", {}, out, err))
        self.assertEqual("", out.getvalue())
        self.assertNotEqual("", err.getvalue())


class SessionStartTest(HookCase):
    def test_writes_session_json_with_harness(self):
        store.save(self.root, a_map())
        code, out, _ = self.run_hook(self.codex("SessionStart", source="startup"))
        self.assertEqual((0, ""), (code, out))
        data = session.read(self.root)
        self.assertEqual(("codex", "c1", NORMAL, NOW),
                         (data["harness"], data["session_id"], data["transcript_path"], data["last_event_at"]))

    def test_finds_the_map_above_cwd_and_keeps_last_nudge(self):
        store.save(self.root, a_map())
        session.write(self.root, {"last_nudge_turn": 4})
        deep = os.path.join(self.root, "sub")
        os.makedirs(deep)
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
        store.save(self.root, a_map(decision("d1", "давай тогда pass@1"),
                                    decision("d2", "нужно 500 примеров вместо 100")))

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

    def test_outbox_is_cleared_only_after_the_answer_was_written(self):
        session.outbox_append(self.root, "rejected", "d1", "не так")
        out, err = Recorder(self.root), io.StringIO()
        hook.run(json.dumps(self.claude("UserPromptSubmit", prompt="дальше")), {}, out, err, now=NOW)
        self.assertEqual(["d1"], [e["node"] for e in out.outbox_at_write])
        self.assertEqual([], session.outbox_read(self.root))
        self.assertIn("отверг d1", out.text)

    def test_an_event_without_a_kind_does_not_crash(self):
        path = os.path.join(self.root, ".aang", "outbox.jsonl")
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(json.dumps({"at": NOW, "node": "d1", "text": ""}, ensure_ascii=False) + "\n")
        code, out, err = self.run_hook(self.claude("UserPromptSubmit", prompt="дальше"))
        self.assertEqual(0, code)
        self.assertIn("? d1 «Вопрос d1?»", self.context(out)["additionalContext"])
        self.assertEqual("", err)

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
        code, out, _ = self.run_hook(self.claude("UserPromptSubmit",
                                                 prompt=" ".join("d%d" % i for i in range(1, 9))))
        ctx = self.context(out)["additionalContext"]
        self.assertEqual(5, ctx.count(" — Вопрос d"))
        self.assertIn("и ещё 3", ctx)

    def test_coverage_line_only_with_a_tail(self):
        code, out, _ = self.run_hook(self.claude("UserPromptSubmit", prompt="d1"))
        self.assertIn("покрывает ходы до", self.context(out)["additionalContext"])

    def test_no_coverage_line_when_the_map_covers_everything(self):
        store.save(self.root, a_map(decision("d1", "No message id — stands alone.")))
        code, out, _ = self.run_hook(self.claude("UserPromptSubmit", prompt="d1"))
        ctx = self.context(out)["additionalContext"]
        self.assertIn("d1 — Вопрос d1?", ctx)
        self.assertNotIn("покрывает ходы до", ctx)


class StopTest(HookCase):
    def covered_map(self):
        """A quote from turn 1 covers only turn 1, leaving 8 turns of tail, 4 of them the user's."""
        return a_map(decision("d1", "Начнём с метрик"))

    def set_nudge_turns(self, value):
        with open(os.path.join(self.root, ".aang", "config.json"), "w") as handle:
            json.dump({"nudge_turns": value}, handle)

    def test_nudges_after_enough_user_turns_and_records_the_turn(self):
        store.save(self.root, self.covered_map())
        self.set_nudge_turns(2)
        code, out, _ = self.run_hook(self.claude("Stop", turn_number=3, stop_hook_active=True))
        ans = json.loads(out)["hookSpecificOutput"]
        self.assertEqual(("Stop", True), (ans["hookEventName"], ans["continueConversation"]))
        self.assertIn("обнови карту", ans["continueReason"].lower())
        self.assertIn("skill \"aang\"", ans["continueReason"])
        self.assertIn("%d хода" % USER_TURNS_AFTER_FIRST, ans["continueReason"])
        self.assertEqual(TURNS, session.read(self.root)["last_nudge_turn"])

    def test_codex_answer_shape(self):
        store.save(self.root, self.covered_map())
        self.set_nudge_turns(2)
        code, out, _ = self.run_hook(self.codex("Stop", stop_hook_active=False))
        ans = json.loads(out)
        self.assertEqual("block", ans["decision"])
        self.assertIn("$aang", ans["reason"])

    def test_silent_below_threshold(self):
        store.save(self.root, self.covered_map())
        code, out, _ = self.run_hook(self.claude("Stop", turn_number=3, stop_hook_active=True),
                                     now="2026-09-11T12:05:00Z")
        self.assertEqual("", out)

    def test_minutes_rule(self):
        store.save(self.root, self.covered_map())
        code, out, _ = self.run_hook(self.claude("Stop", turn_number=3, stop_hook_active=True),
                                     now="2026-09-11T12:20:00Z")
        self.assertNotEqual("", out)

    def test_no_double_nudge_and_no_nudge_while_candidate_exists(self):
        store.save(self.root, self.covered_map())
        session.write(self.root, {"last_nudge_turn": TURNS})
        code, out, _ = self.run_hook(self.claude("Stop", turn_number=3, stop_hook_active=True),
                                     now="2026-09-11T13:00:00Z")
        self.assertEqual("", out)
        session.write(self.root, {"last_nudge_turn": 0})
        with open(store.candidate_path(self.root), "w") as handle:
            handle.write("{}")
        code, out, _ = self.run_hook(self.claude("Stop", turn_number=3, stop_hook_active=True),
                                     now="2026-09-11T13:00:00Z")
        self.assertEqual("", out)

    def test_claude_stop_hook_inactive_is_silent(self):
        store.save(self.root, self.covered_map())
        code, out, _ = self.run_hook(self.claude("Stop", turn_number=3, stop_hook_active=False),
                                     now="2026-09-11T13:00:00Z")
        self.assertEqual("", out)

    def test_missing_transcript_is_silent(self):
        store.save(self.root, self.covered_map())
        code, out, err = self.run_hook(self.claude("Stop", transcript_path=os.path.join(self.root, "none.jsonl"),
                                                   turn_number=3, stop_hook_active=True),
                                       now="2026-09-11T13:00:00Z")
        self.assertEqual((0, ""), (code, out))

    def test_nudges_when_nothing_is_covered_yet(self):
        store.save(self.root, a_map(decision("d1", "цитаты нет в транскрипте")))
        self.set_nudge_turns(4)
        code, out, _ = self.run_hook(self.claude("Stop", turn_number=3, stop_hook_active=True))
        self.assertIn("обнови карту", json.loads(out)["hookSpecificOutput"]["continueReason"].lower())
