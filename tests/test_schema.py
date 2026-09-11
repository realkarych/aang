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
        # d1 -> t1 -> d3, no cycle
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


if __name__ == "__main__":
    unittest.main()
