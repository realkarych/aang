import copy
import unittest

from aang import schema


def valid_map():
    return {
        "version": 1,
        "session_id": "7df13757-1020-45f3-b525-12ff1c856bb7",
        "generated_at": "2026-09-11T12:00:00Z",
        "title": "aang · пайплайн оценки",
        "nodes": [
            {
                "id": "d1",
                "kind": "decision",
                "status": "superseded",
                "superseded_by": "d3",
                "question": "Чем мерить качество прогона?",
                "decision": "pass@5",
                "why": "меньше дисперсия",
                "against": ["маскирует нестабильность промпта"],
                "consequence": "",
                "cites": [{"turn": 3, "role": "assistant", "quote": "Ещё вариант: pass@5"}],
                "hand_edited": False,
            },
            {
                "id": "d3",
                "kind": "decision",
                "status": "accepted",
                "superseded_by": None,
                "question": "Чем мерить качество прогона?",
                "decision": "pass@1 на отложенном наборе",
                "why": "k>1 маскирует нестабильность промпта",
                "against": ["Дисперсия выше, нужен набор существеннее"],
                "consequence": "500 примеров вместо 100, прогон дорожает втрое",
                "cites": [{"quote": "давай тогда pass@1"}],
                "hand_edited": False,
            },
            {
                "id": "t1",
                "kind": "tacit",
                "status": "accepted",
                "question": "Сколько примеров в отложенном наборе?",
                "decision": "500",
                "why": "число возникло в реплике ассистента и никем не обсуждалось",
                "cites": [{"quote": "нужно 500 примеров вместо 100"}],
            },
            {
                "id": "o1",
                "kind": "open",
                "status": "proposed",
                "question": "Кто платит за прогон втрое дороже?",
                "why": "следствие d3, к которому никто не вернулся",
                "cites": [],
            },
        ],
    }


def _node(node_id, kind="decision", status="accepted", relates=None, added_at="", **fields):
    """A minimal valid node of the given kind; extra fields override the defaults."""
    is_open = kind == "open"
    node = {
        "id": node_id,
        "kind": kind,
        "status": status,
        "question": "q",
        "decision": "" if is_open else "d",
        "why": "w",
        "cites": [] if is_open else [{"quote": "цитата"}],
    }
    if relates is not None:
        node["relates"] = relates
    if added_at:
        node["added_at"] = added_at
    node.update(fields)
    return node


def _map(nodes):
    return {"version": 1, "nodes": nodes}


class ValidateTest(unittest.TestCase):
    def assertError(self, map_dict, *needles):
        errors = schema.validate(map_dict)
        self.assertTrue(errors, "expected a validation error")
        joined = "\n".join(errors)
        for needle in needles:
            self.assertIn(needle, joined, "missing %r in errors:\n%s" % (needle, joined))
        return errors

    def mutate(self, node_id, **fields):
        m = valid_map()
        node = next(n for n in m["nodes"] if n["id"] == node_id)
        for key, value in fields.items():
            if value is KeyError:
                node.pop(key, None)
            else:
                node[key] = value
        return m

    def test_valid_map_passes(self):
        self.assertEqual(schema.validate(valid_map()), [])

    def test_valid_map_still_passes_after_normalize(self):
        self.assertEqual(schema.validate(schema.normalize(valid_map())), [])

    def test_not_a_dict(self):
        self.assertError([], "карта")
        self.assertError(None, "карта")

    def test_version(self):
        m = valid_map()
        m["version"] = 2
        self.assertError(m, "version")
        del m["version"]
        self.assertError(m, "version", "отсутствует")

    def test_nodes_missing_or_not_list(self):
        m = valid_map()
        m["nodes"] = {}
        self.assertError(m, "nodes")
        del m["nodes"]
        self.assertError(m, "nodes")

    def test_node_not_a_dict(self):
        m = valid_map()
        m["nodes"].append("d9")
        self.assertError(m, "узел #5")

    def test_duplicate_ids(self):
        m = valid_map()
        m["nodes"][1]["id"] = "d1"
        self.assertError(m, "узел d1", "id", "дубликат")

    def test_missing_id(self):
        m = valid_map()
        del m["nodes"][0]["id"]
        self.assertError(m, "узел #1", "id")

    def test_bad_kind(self):
        self.assertError(self.mutate("d3", kind="note"), "узел d3", "kind")
        self.assertError(self.mutate("d3", kind=KeyError), "узел d3", "kind")

    def test_bad_status(self):
        self.assertError(self.mutate("d3", status="done"), "узел d3", "status")

    def test_superseded_by_unknown_node(self):
        self.assertError(self.mutate("d1", superseded_by="zzz"), "узел d1", "superseded_by", "zzz")

    def test_supersede_self(self):
        self.assertError(self.mutate("d1", superseded_by="d1"), "узел d1", "superseded_by", "сам")

    def test_supersede_cycle(self):
        m = self.mutate("d3", status="superseded", superseded_by="d1")
        errors = self.assertError(m, "superseded_by", "цикл")
        self.assertTrue(any("узел d1" in e and "цикл" in e for e in errors))
        self.assertTrue(any("узел d3" in e and "цикл" in e for e in errors))

    def test_supersede_long_cycle_and_chain(self):
        m = valid_map()
        m["nodes"][0]["superseded_by"] = "t1"
        m["nodes"][2]["status"] = "superseded"
        m["nodes"][2]["superseded_by"] = "d3"
        self.assertEqual(schema.validate(m), [])
        m["nodes"][1]["status"] = "superseded"
        m["nodes"][1]["superseded_by"] = "d1"
        self.assertError(m, "цикл")

    def test_superseded_status_without_target(self):
        self.assertError(self.mutate("d1", superseded_by=None), "узел d1", "superseded_by")

    def test_target_without_superseded_status(self):
        self.assertError(self.mutate("d1", status="accepted"), "узел d1", "status", "superseded")

    def test_decision_requires_cites(self):
        self.assertError(self.mutate("d3", cites=[]), "узел d3", "cites")
        self.assertError(self.mutate("d3", cites=KeyError), "узел d3", "cites")

    def test_tacit_requires_cites(self):
        self.assertError(self.mutate("t1", cites=[]), "узел t1", "cites")

    def test_open_may_omit_cites(self):
        self.assertEqual(schema.validate(self.mutate("o1", cites=KeyError)), [])

    def test_open_must_not_carry_a_decision(self):
        self.assertError(self.mutate("o1", decision="да"), "узел o1", "decision")

    def test_required_text_per_kind(self):
        self.assertError(self.mutate("d3", question=""), "узел d3", "question")
        self.assertError(self.mutate("d3", decision="  "), "узел d3", "decision")
        self.assertError(self.mutate("d3", why=KeyError), "узел d3", "why")
        self.assertError(self.mutate("t1", decision=""), "узел t1", "decision")
        self.assertError(self.mutate("t1", why=""), "узел t1", "why")
        self.assertError(self.mutate("o1", question=""), "узел o1", "question")

    def test_text_fields_must_be_strings(self):
        self.assertError(self.mutate("d3", consequence=["x"]), "узел d3", "consequence")

    def test_against_entries(self):
        self.assertError(self.mutate("d3", against="строка"), "узел d3", "against")
        self.assertError(self.mutate("d3", against=["ok", 5]), "узел d3", "against[1]")

    def test_cite_requires_quote(self):
        self.assertError(self.mutate("d3", cites=[{"turn": 4}]), "узел d3", "cites[0].quote")
        self.assertError(self.mutate("d3", cites=[{"quote": "   "}]), "узел d3", "cites[0].quote")
        self.assertError(self.mutate("d3", cites=["давай тогда pass@1"]), "узел d3", "cites[0]")

    def test_cite_turn_and_role(self):
        self.assertError(self.mutate("d3", cites=[{"turn": 0, "quote": "давай тогда pass@1"}]), "cites[0].turn")
        self.assertError(self.mutate("d3", cites=[{"turn": "4", "quote": "давай тогда pass@1"}]), "cites[0].turn")
        self.assertError(self.mutate("d3", cites=[{"turn": True, "quote": "давай тогда pass@1"}]), "cites[0].turn")
        self.assertError(self.mutate("d3", cites=[{"role": "system", "quote": "давай тогда pass@1"}]), "cites[0].role")
        self.assertEqual(schema.validate(self.mutate("d3", cites=[{"turn": None, "role": None, "quote": "давай тогда pass@1"}])), [])

    def test_hand_edited_must_be_bool(self):
        self.assertError(self.mutate("d3", hand_edited="yes"), "узел d3", "hand_edited")

    def test_top_level_strings(self):
        m = valid_map()
        m["title"] = 5
        self.assertError(m, "title")

    def test_relates_rejects_unknown_rel(self):
        m = _map([_node("d1"), _node("d2", relates=[{"to": "d1", "rel": "зависит"}])])
        self.assertTrue(any("rel" in e and "d2" in e for e in schema.validate(m)))

    def test_relates_rejects_missing_target(self):
        m = _map([_node("d1", relates=[{"to": "d9", "rel": "rests_on"}])])
        self.assertTrue(any("d9" in e for e in schema.validate(m)))

    def test_relates_rejects_self_reference(self):
        m = _map([_node("d1", relates=[{"to": "d1", "rel": "rests_on"}])])
        self.assertTrue(any("d1" in e for e in schema.validate(m)))

    def test_relates_rejects_forward_reference(self):
        m = _map([_node("d1", relates=[{"to": "d2", "rel": "rests_on"}]), _node("d2")])
        self.assertTrue(any("вперёд" in e for e in schema.validate(m)))

    def test_relates_caps_fan_out_at_three_total(self):
        nodes = [_node("d1"), _node("d2"), _node("d3"), _node("d4")]
        nodes.append(_node("d5", relates=[
            {"to": "d1", "rel": "rests_on"}, {"to": "d2", "rel": "rests_on"},
            {"to": "d3", "rel": "moots"}, {"to": "d4", "rel": "moots"}]))
        self.assertTrue(any("не более трёх" in e for e in schema.validate(_map(nodes))))

    def test_relates_allows_three(self):
        nodes = [_node("d1"), _node("d2"), _node("d3")]
        nodes.append(_node("d4", relates=[
            {"to": "d1", "rel": "rests_on"}, {"to": "d2", "rel": "rests_on"},
            {"to": "d3", "rel": "moots"}]))
        self.assertEqual([], schema.validate(_map(nodes)))

    def test_relates_must_be_a_list_of_objects(self):
        self.assertTrue(any("relates" in e for e in schema.validate(_map([_node("d1", relates="d0")]))))
        m = _map([_node("d1"), _node("d2", relates=["d1"])])
        self.assertTrue(any("relates[0]" in e for e in schema.validate(m)))

    def test_added_at_must_be_a_string(self):
        self.assertTrue(any("added_at" in e for e in schema.validate(_map([_node("d1", added_at=5)]))))
        self.assertEqual([], schema.validate(_map([_node("d1", added_at="2026-09-11T12:00:00Z")])))

    def test_relates_two_cycle_is_rejected_by_direction(self):
        m = _map([_node("d1", relates=[{"to": "d2", "rel": "rests_on"}]),
                  _node("d2", relates=[{"to": "d1", "rel": "moots"}])])
        errors = schema.validate(m)
        self.assertTrue(any("узел d1" in e and "вперёд" in e for e in errors))
        self.assertFalse(any("узел d2" in e for e in errors))

    def test_map_without_relates_still_valid(self):
        self.assertEqual([], schema.validate(_map([_node("d1"), _node("d2")])))


class WarningsTest(unittest.TestCase):
    def test_prose_id_without_edge_is_a_warning_not_an_error(self):
        m = _map([_node("d1"), _node("o1", kind="open", status="proposed",
                                     why="Осиротело решением d1: продукт развернулся")])
        self.assertEqual([], schema.validate(m))
        self.assertTrue(any("d1" in w and "o1" in w for w in schema.warnings(m)))

    def test_prose_id_with_edge_is_not_warned(self):
        m = _map([_node("d1"), _node("o1", kind="open", status="proposed",
                                     why="Осиротело решением d1",
                                     relates=[{"to": "d1", "rel": "orphaned_by"}])])
        self.assertEqual([], schema.warnings(m))

    def test_prose_mention_of_nonexistent_id_is_not_warned(self):
        m = _map([_node("d1", why="как в d99")])
        self.assertEqual([], schema.warnings(m))

    def test_superseded_by_counts_as_an_edge(self):
        m = _map([_node("d1", status="superseded", superseded_by="d2", why="заменено d2"), _node("d2")])
        self.assertEqual([], schema.warnings(m))

    def test_self_mention_is_not_warned(self):
        self.assertEqual([], schema.warnings(_map([_node("d1", why="см. d1")])))

    def test_edge_on_later_node_covers_earlier_mention(self):
        m = _map([_node("d1", why="см. d2"), _node("d2", relates=[{"to": "d1", "rel": "moots"}])])
        self.assertEqual([], schema.warnings(m))

    def test_uncovered_forward_mention_says_where_the_edge_belongs(self):
        ws = schema.warnings(_map([_node("d1", why="см. d2"), _node("d2")]))
        self.assertEqual(1, len(ws))
        self.assertIn("узел d1", ws[0])
        self.assertIn("d2 ниже по списку: связь ставится на нём, или d2 поднимается выше", ws[0])
        self.assertNotIn("связи на него нет", ws[0])

    def test_open_node_without_orphaned_by_is_a_warning_not_an_error(self):
        m = _map([_node("d1"), _node("o1", kind="open", status="proposed",
                                     why="Поднято и брошено, решения за этим нет")])
        self.assertEqual([], schema.validate(m))
        self.assertEqual(["узел o1: открытый вопрос без orphaned_by — укажите решение или скажите в why, что его нет"],
                         schema.warnings(m))

    def test_open_node_with_orphaned_by_is_not_warned(self):
        m = _map([_node("d1"), _node("o1", kind="open", status="proposed",
                                     relates=[{"to": "d1", "rel": "orphaned_by"}])])
        self.assertEqual([], schema.warnings(m))

    def test_open_node_with_only_rests_on_is_still_warned(self):
        m = _map([_node("t1", kind="tacit"), _node("o1", kind="open", status="proposed",
                                                    relates=[{"to": "t1", "rel": "rests_on"}])])
        ws = schema.warnings(m)
        self.assertEqual(1, len(ws))
        self.assertIn("узел o1: открытый вопрос без orphaned_by", ws[0])

    def test_only_open_nodes_are_asked_for_orphaned_by(self):
        self.assertEqual([], schema.warnings(_map([_node("d1"), _node("t1", kind="tacit")])))

    def test_id_inside_a_word_is_not_a_mention(self):
        self.assertEqual([], schema.warnings(_map([_node("d11"), _node("d2", why="см. md11 и d11a")])))

    def test_warnings_do_not_mutate_the_map(self):
        m = _map([_node("d1")])
        schema.warnings(m)
        self.assertNotIn("relates", m["nodes"][0])
        self.assertNotIn("added_at", m["nodes"][0])

    def test_warnings_survive_garbage(self):
        self.assertEqual([], schema.warnings(None))
        self.assertEqual([], schema.warnings({"version": 1, "nodes": ["d1", None]}))


class NormalizeTest(unittest.TestCase):
    def test_fills_defaults_in_place(self):
        m = {"version": 1, "nodes": [{"id": "d1", "kind": "decision", "status": "accepted",
                                       "question": "q", "decision": "d", "why": "w",
                                       "cites": [{"quote": "давай тогда pass@1"}]}]}
        out = schema.normalize(m)
        self.assertIs(out, m)
        self.assertEqual(m["title"], "")
        self.assertEqual(m["session_id"], "")
        self.assertEqual(m["generated_at"], "")
        node = m["nodes"][0]
        self.assertIs(node["superseded_by"], None)
        self.assertIs(node["hand_edited"], False)
        self.assertEqual(node["against"], [])
        self.assertEqual(node["consequence"], "")
        self.assertEqual(node["cites"][0], {"quote": "давай тогда pass@1", "turn": None, "role": None})
        self.assertEqual(schema.validate(m), [])

    def test_does_not_invent_identity_fields(self):
        m = {"nodes": [{"question": "q"}]}
        schema.normalize(m)
        self.assertNotIn("version", m)
        self.assertNotIn("id", m["nodes"][0])
        self.assertNotIn("kind", m["nodes"][0])
        self.assertTrue(schema.validate(m))

    def test_preserves_existing_values(self):
        m = valid_map()
        before = copy.deepcopy(m)
        schema.normalize(m)
        for key in ("version", "session_id", "generated_at", "title"):
            self.assertEqual(m[key], before[key])
        self.assertEqual(m["nodes"][0]["against"], before["nodes"][0]["against"])
        self.assertEqual(m["nodes"][0]["superseded_by"], "d3")

    def test_garbage_becomes_empty_map(self):
        for garbage in (None, [], "x", {}):
            out = schema.normalize(garbage)
            self.assertEqual(schema.validate(out), [])
            self.assertEqual(out["nodes"], [])

    def test_leaves_non_dict_nodes_for_validate(self):
        m = {"version": 1, "nodes": ["d1", None]}
        schema.normalize(m)
        self.assertEqual(m["nodes"], ["d1", None])
        self.assertTrue(schema.validate(m))

    def test_normalize_fills_relates_and_added_at(self):
        out = schema.normalize(_map([_node("d1")]))
        self.assertEqual([], out["nodes"][0]["relates"])
        self.assertEqual("", out["nodes"][0]["added_at"])

    def test_normalize_keeps_relates_and_added_at(self):
        m = _map([_node("d1"), _node("d2", relates=[{"to": "d1"}], added_at="2026-09-11T12:00:00Z")])
        out = schema.normalize(m)
        self.assertEqual([{"to": "d1", "rel": ""}], out["nodes"][1]["relates"])
        self.assertEqual("2026-09-11T12:00:00Z", out["nodes"][1]["added_at"])
        self.assertTrue(any("rel" in e for e in schema.validate(out)))


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
        self.assertEqual([], self.errors(_node("d1")))
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

    def test_normalize_fills_the_three_fields(self):
        m = schema.normalize(_map([_node("d1")]))
        n = m["nodes"][0]
        self.assertIn("decided_by", n); self.assertIsNone(n["decided_by"])
        self.assertIn("triage", n); self.assertIsNone(n["triage"])
        self.assertIn("topic", n); self.assertIsNone(n["topic"])

    def test_user_hand_made_decision_may_have_no_cites(self):
        self.assertEqual([], self.errors(_node("d1", decided_by="user", hand_edited=True, cites=[])))
        errs = self.errors(_node("d1", decided_by="agent", hand_edited=True, cites=[]))
        self.assertTrue(any("узел d1, поле cites" in e for e in errs), errs)
        errs = self.errors(_node("d1", decided_by="user", hand_edited=False, cites=[]))
        self.assertTrue(any("узел d1, поле cites" in e for e in errs), errs)


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


class TopicTest(unittest.TestCase):
    def test_topic_is_a_short_string_or_null(self):
        self.assertEqual([], schema.validate(_map([_node("d1", topic="размер PR")])))
        self.assertEqual([], schema.validate(_map([_node("d1", topic=None)])))
        errors = schema.validate(_map([_node("d1", topic=5)]))
        self.assertTrue(any("поле topic" in e and "строка" in e for e in errors), errors)
        self.assertEqual([], schema.validate(_map([_node("d1", topic="x" * schema.TOPIC_MAX)])))
        errors = schema.validate(_map([_node("d1", topic="x" * (schema.TOPIC_MAX + 1))]))
        self.assertTrue(any("поле topic" in e and str(schema.TOPIC_MAX) in e for e in errors), errors)

    def test_normalize_fills_topic_and_blanks_an_empty_one(self):
        m = schema.normalize(_map([_node("d1")]))
        self.assertIsNone(m["nodes"][0]["topic"])
        m = schema.normalize(_map([_node("d1", topic="   ")]))
        self.assertIsNone(m["nodes"][0]["topic"])

    def test_normalize_drops_seen_at(self):
        m = schema.normalize(_map([_node("d1", seen_at="2026-09-11T12:00:00Z")]))
        self.assertNotIn("seen_at", m["nodes"][0])
        self.assertEqual([], schema.validate(m))


if __name__ == "__main__":
    unittest.main()
