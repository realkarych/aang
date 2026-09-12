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

    def test_triage_opens_even_an_accepted_decision(self):
        self.assertEqual("open", blocks.block(node("d1", triage="research")))

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

    def test_a_rejected_tacit_reads_rejected(self):
        self.assertEqual(("✖", "отвергнуто", "решение t1"),
                         blocks.line(node("t1", kind="tacit", status="rejected")))

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
        self.assertEqual([("Модели", ["d1", "d3"]), ("вьюер", ["d2"])], self.names(groups))

    def test_the_displayed_spelling_is_the_earliest_named_nodes(self):
        groups = blocks.topics([
            node("n0", relates=[{"to": "n2", "rel": "rests_on"}]),
            node("n1", topic="MODELI"),
            node("n2", topic="Modeli"),
        ])
        self.assertEqual([("MODELI", ["n0", "n1", "n2"])], self.names(groups))

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
