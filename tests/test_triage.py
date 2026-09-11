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
        """Seen after it was added, it leaves the inbox; seen before it was re-added, it returns."""
        seen = node("o1", kind="open", status="proposed", seen_at="2026-09-11T13:00:00Z",
                    relates=[{"to": "d1", "rel": "orphaned_by"}])
        self.assertEqual("orphaned", triage.cell(seen))
        seen["relates"] = []
        self.assertEqual("hanging", triage.cell(seen))
        stale = node("o1", kind="open", status="proposed", seen_at="2026-09-11T11:00:00Z")
        self.assertEqual("inbox", triage.cell(stale))

    def test_agent_proposal_stays_in_inbox_after_seen(self):
        self.assertEqual("inbox", triage.cell(node("d1", status="proposed", decided_by="agent", seen_at="2026-09-11T13:00:00Z")))

    def test_residuals(self):
        """A proposal whose author is unknown is not the agent's inbox: it falls to the residual cell."""
        self.assertEqual("tacit", triage.cell(node("t1", kind="tacit")))
        self.assertEqual("decisions", triage.cell(node("d1", status="superseded", superseded_by="d2")))
        self.assertEqual("decisions", triage.cell(node("d1", status="proposed", decided_by="user")))
        self.assertEqual("decisions", triage.cell(node("d1", status="proposed")))

    def test_cells_are_ordered_and_titled(self):
        keys = [c[0] for c in triage.CELLS]
        self.assertEqual(["inbox", "research", "discuss", "confirmed", "rejected", "tacit", "orphaned", "hanging", "decisions"], keys)
        self.assertEqual("Входящее", dict((k, t) for k, t, _ in triage.CELLS)["inbox"])
        self.assertEqual(dict((k, t) for k, t, _ in triage.CELLS), triage.titles())


class UnseenTest(unittest.TestCase):
    def test_rules(self):
        """With no `added_at` the age is unknown: never seen counts as unseen, a mark counts as seen."""
        self.assertTrue(triage.is_unseen(node("d1")))
        self.assertTrue(triage.is_unseen(node("d1", seen_at="2026-09-11T11:00:00Z")))
        self.assertFalse(triage.is_unseen(node("d1", seen_at="2026-09-11T12:00:00Z")))
        self.assertFalse(triage.is_unseen(node("d1", added_at="", seen_at="2026-09-11T12:00:00Z")))
        self.assertTrue(triage.is_unseen(node("d1", added_at="")))


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
        """An open question cannot carry `rejected` (schema); rejecting it means «this should not be
        pursued» — recorded as a decision the user made, with the reason as the answer.
        """
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
