import copy
import glob
import json
import os
import shutil
import tempfile
import unittest
from unittest import mock

from aang import schema, store, transcript

FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")


def node(node_id, **overrides):
    base = {
        "id": node_id,
        "kind": "decision",
        "status": "accepted",
        "superseded_by": None,
        "question": "Вопрос %s?" % node_id,
        "decision": "Решение %s" % node_id,
        "why": "потому что %s" % node_id,
        "against": [],
        "consequence": "",
        "cites": [{"turn": None, "role": None, "quote": "давай pass@1 на отложенном"}],
        "hand_edited": False,
    }
    base.update(overrides)
    return base


def a_map(*nodes, **top):
    out = {"version": 1, "session_id": "s1", "generated_at": "2026-09-11T12:00:00Z",
           "title": "t", "nodes": list(nodes)}
    out.update(top)
    return out


def ids(map_dict):
    return [n["id"] for n in map_dict["nodes"]]


class LoadSaveTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="aang-store-")
        self.addCleanup(shutil.rmtree, self.root, True)

    def test_absent_file_loads_as_valid_empty_map(self):
        loaded = store.load(self.root)
        self.assertEqual(loaded["nodes"], [])
        self.assertEqual(schema.validate(loaded), [])

    def test_corrupt_file_loads_as_empty_map(self):
        os.makedirs(store.map_dir(self.root))
        with open(store.map_path(self.root), "w") as handle:
            handle.write('{"version": 1, "nodes": [{"id": "d1", "ki')
        loaded = store.load(self.root)
        self.assertEqual(loaded["nodes"], [])
        self.assertEqual(schema.validate(loaded), [])

    def test_non_object_json_loads_as_empty_map(self):
        os.makedirs(store.map_dir(self.root))
        with open(store.map_path(self.root), "w") as handle:
            handle.write("[1, 2, 3]")
        self.assertEqual(store.load(self.root)["nodes"], [])

    def test_roundtrip_creates_dir_and_keeps_unicode(self):
        m = a_map(node("d1", question="Чем мерить?"))
        path = store.save(self.root, m)
        self.assertEqual(path, store.map_path(self.root))
        with open(path, encoding="utf-8") as handle:
            raw = handle.read()
        self.assertIn("Чем мерить?", raw)  # ensure_ascii=False: the file is hand-editable
        self.assertEqual(store.load(self.root), schema.normalize(copy.deepcopy(m)))

    def test_save_leaves_no_temp_file(self):
        store.save(self.root, a_map(node("d1")))
        store.save(self.root, a_map(node("d1"), node("d2")))
        self.assertEqual(sorted(os.listdir(store.map_dir(self.root))), ["map.json"])

    def test_new_file_is_readable_and_existing_mode_is_kept(self):
        store.save(self.root, a_map(node("d1")))
        mode = os.stat(store.map_path(self.root)).st_mode & 0o777
        self.assertNotEqual(mode, 0o600)  # not mkstemp's private default
        os.chmod(store.map_path(self.root), 0o600)
        store.save(self.root, a_map(node("d2")))
        self.assertEqual(os.stat(store.map_path(self.root)).st_mode & 0o777, 0o600)

    def test_crash_before_rename_keeps_old_file_intact(self):
        store.save(self.root, a_map(node("d1")))
        with mock.patch("aang.store.os.replace", side_effect=OSError("disk gone")):
            with self.assertRaises(OSError):
                store.save(self.root, a_map(node("d1"), node("d2")))
        self.assertEqual(ids(store.load(self.root)), ["d1"])
        self.assertEqual(glob.glob(os.path.join(store.map_dir(self.root), "*.tmp")), [])
        self.assertEqual(glob.glob(os.path.join(store.map_dir(self.root), ".map-*")), [])

    def test_crash_mid_write_never_produces_partial_map(self):
        store.save(self.root, a_map(node("d1")))
        real_fdopen = os.fdopen

        def exploding_fdopen(fd, *args, **kwargs):
            handle = real_fdopen(fd, *args, **kwargs)
            original_write = handle.write

            def write(data):
                original_write(data[: len(data) // 2])
                raise OSError("no space left")
            handle.write = write
            return handle

        with mock.patch("aang.store.os.fdopen", exploding_fdopen):
            with self.assertRaises(OSError):
                store.save(self.root, a_map(node("d1"), node("d2")))
        with open(store.map_path(self.root), encoding="utf-8") as handle:
            json.load(handle)  # still parses
        self.assertEqual(ids(store.load(self.root)), ["d1"])
        self.assertEqual(sorted(os.listdir(store.map_dir(self.root))), ["map.json"])


class MergeTest(unittest.TestCase):
    def test_hand_edited_node_survives_when_new_omits_it(self):
        old = a_map(node("d1", hand_edited=True), node("d2"))
        new = a_map(node("d3"))
        merged = store.merge(old, new)
        self.assertEqual(ids(merged), ["d1", "d3"])
        self.assertTrue(merged["nodes"][0]["hand_edited"])
        self.assertEqual(schema.validate(merged), [])

    def test_new_never_overwrites_hand_edited_fields(self):
        old = a_map(node("d1", hand_edited=True, decision="человеческая правка",
                         why="человек знает лучше", against=["а"], consequence="x",
                         cites=[{"quote": "цитата, которую выбрал человек"}]))
        new = a_map(node("d1", decision="модель переписала", why="модель", against=["b"],
                         consequence="y", cites=[{"quote": "модельная цитата тоже"}]))
        merged = store.merge(old, new)
        got = merged["nodes"][0]
        self.assertEqual(got["decision"], "человеческая правка")
        self.assertEqual(got["why"], "человек знает лучше")
        self.assertEqual(got["against"], ["а"])
        self.assertEqual(got["consequence"], "x")
        self.assertEqual(got["cites"][0]["quote"], "цитата, которую выбрал человек")
        self.assertTrue(got["hand_edited"])

    def test_non_hand_edited_node_is_replaced_in_full(self):
        old = a_map(node("d1", decision="старое", kind="tacit"))
        new = a_map(node("d1", decision="новое", kind="decision"))
        merged = store.merge(old, new)
        self.assertEqual(merged["nodes"][0]["decision"], "новое")
        self.assertEqual(merged["nodes"][0]["kind"], "decision")
        self.assertFalse(merged["nodes"][0]["hand_edited"])

    def test_non_hand_edited_node_omitted_by_new_is_dropped(self):
        merged = store.merge(a_map(node("d1"), node("d2")), a_map(node("d2")))
        self.assertEqual(ids(merged), ["d2"])

    def test_kind_conflict_hand_edited_keeps_its_kind(self):
        old = a_map(node("t1", kind="tacit", hand_edited=True))
        new = a_map(node("t1", kind="decision"))
        self.assertEqual(store.merge(old, new)["nodes"][0]["kind"], "tacit")

    def test_new_supersedes_hand_edited_node(self):
        old = a_map(node("d1", hand_edited=True, decision="правка"))
        new = a_map(node("d1", status="superseded", superseded_by="d2", decision="модель"),
                    node("d2"))
        merged = store.merge(old, new)
        d1 = merged["nodes"][0]
        self.assertEqual(d1["status"], "superseded")
        self.assertEqual(d1["superseded_by"], "d2")
        self.assertEqual(d1["decision"], "правка")  # content untouched
        self.assertTrue(d1["hand_edited"])
        self.assertEqual(schema.validate(merged), [])

    def test_regeneration_never_unsupersedes_or_repoints_hand_edited(self):
        old = a_map(node("d1", hand_edited=True, status="superseded", superseded_by="d2"),
                    node("d2", hand_edited=True))
        new = a_map(node("d1"), node("d2"), node("d3"))
        merged = store.merge(old, new)
        self.assertEqual(merged["nodes"][0]["status"], "superseded")
        self.assertEqual(merged["nodes"][0]["superseded_by"], "d2")
        new2 = a_map(node("d1", status="superseded", superseded_by="d3"), node("d2"), node("d3"))
        merged2 = store.merge(old, new2)
        self.assertEqual(merged2["nodes"][0]["superseded_by"], "d2")

    def test_supersede_target_of_kept_node_is_retained(self):
        # d1 (hand-edited) is superseded by d2 which the model forgot; d2 by d3, also forgotten.
        old = a_map(node("d1", hand_edited=True, status="superseded", superseded_by="d2"),
                    node("d2", status="superseded", superseded_by="d3"),
                    node("d3"))
        new = a_map(node("d4"))
        merged = store.merge(old, new)
        self.assertEqual(sorted(ids(merged)), ["d1", "d2", "d3", "d4"])
        self.assertEqual(schema.validate(merged), [])

    def test_order_new_first_then_survivors_keep_their_place(self):
        old = a_map(node("d1"), node("d2", hand_edited=True), node("d3"), node("d4", hand_edited=True))
        new = a_map(node("d1"), node("d3"), node("d5"))
        self.assertEqual(ids(store.merge(old, new)), ["d1", "d2", "d3", "d4", "d5"])

    def test_survivor_with_no_surviving_predecessor_goes_first(self):
        old = a_map(node("d1", hand_edited=True), node("d2"))
        new = a_map(node("d2"), node("d3"))
        self.assertEqual(ids(store.merge(old, new)), ["d1", "d2", "d3"])

    def test_top_level_fields_prefer_new_but_fall_back_to_old(self):
        old = a_map(session_id="old-s", title="старый", generated_at="2026-01-01T00:00:00Z")
        new = a_map(session_id="", title="новый", generated_at="")
        merged = store.merge(old, new)
        self.assertEqual(merged["session_id"], "old-s")
        self.assertEqual(merged["title"], "новый")
        self.assertEqual(merged["generated_at"], "2026-01-01T00:00:00Z")
        self.assertEqual(merged["version"], 1)

    def test_inputs_are_not_mutated(self):
        old = a_map(node("d1", hand_edited=True))
        new = a_map(node("d1", decision="x"), node("d2"))
        old_copy, new_copy = copy.deepcopy(old), copy.deepcopy(new)
        store.merge(old, new)
        self.assertEqual(old, old_copy)
        self.assertEqual(new, new_copy)

    def test_empty_and_garbage_inputs(self):
        self.assertEqual(store.merge({}, a_map(node("d1")))["nodes"][0]["id"], "d1")
        self.assertEqual(store.merge(a_map(node("d1")), {})["nodes"], [])
        self.assertEqual(store.merge(None, {"version": 1, "nodes": ["junk", 3]})["nodes"], [])

    def test_second_regeneration_keeps_hand_edit(self):
        # generate → hand-edit → regenerate → the edit is still there (R6)
        first = store.merge({}, a_map(node("d1", decision="модель v1"), node("t1", kind="tacit")))
        first["nodes"][0]["decision"] = "человек поправил"
        first["nodes"][0]["hand_edited"] = True
        second = store.merge(first, a_map(node("d1", decision="модель v2"), node("t1", kind="tacit",
                                                                              decision="v2")))
        self.assertEqual(second["nodes"][0]["decision"], "человек поправил")
        self.assertTrue(second["nodes"][0]["hand_edited"])
        self.assertEqual(second["nodes"][1]["decision"], "v2")
        third = store.merge(second, a_map(node("t1", kind="tacit")))
        self.assertEqual(ids(third), ["d1", "t1"])
        self.assertEqual(third["nodes"][0]["decision"], "человек поправил")


class FillTurnsTest(unittest.TestCase):
    def setUp(self):
        self.turns = transcript.index(os.path.join(FIXTURES, "normal.jsonl"))

    def test_fills_turn_and_role_from_quote(self):
        m = a_map(node("d1", cites=[{"quote": "давай pass@1"},
                                    {"quote": "нужно 500 примеров вместо 100", "role": "assistant"}]))
        report = store.fill_turns(m, self.turns)
        cites = m["nodes"][0]["cites"]
        self.assertEqual((cites[0]["turn"], cites[0]["role"]), (4, "user"))
        self.assertEqual((cites[1]["turn"], cites[1]["role"]), (5, "assistant"))
        self.assertTrue(all(r["ok"] for r in report))
        self.assertEqual([r["node_id"] for r in report], ["d1", "d1"])

    def test_model_supplied_turn_is_discarded_and_recomputed(self):
        m = a_map(node("d1", cites=[{"turn": 2, "quote": "давай pass@1"}]))
        store.fill_turns(m, self.turns)
        self.assertEqual(m["nodes"][0]["cites"][0]["turn"], 4)

    def test_unfound_quote_keeps_null_turn(self):
        m = a_map(node("d1", cites=[{"turn": 3, "quote": "этого никто никогда не говорил"}]))
        report = store.fill_turns(m, self.turns)
        self.assertIsNone(m["nodes"][0]["cites"][0]["turn"])
        self.assertFalse(report[0]["ok"])

    def test_no_turns_leaves_everything_null(self):
        m = a_map(node("d1", cites=[{"quote": "давай pass@1"}]))
        store.fill_turns(m, [])
        self.assertIsNone(m["nodes"][0]["cites"][0]["turn"])


class ExportTest(unittest.TestCase):
    def test_newest_first_superseded_marked_valuable_kinds_first(self):
        m = a_map(
            node("d1", question="Первый вопрос?", status="superseded", superseded_by="d2",
                 decision="старое"),
            node("d2", question="Второй вопрос?", decision="новое", against=["контраргумент"],
                 consequence="следствие"),
            node("t1", kind="tacit", question="Неявный?", decision="500"),
            node("o1", kind="open", status="proposed", question="Открытый?", decision="",
                 cites=[], why="никто не вернулся"),
        )
        text = store.export_markdown(m)
        self.assertLess(text.index("Неявные решения"), text.index("Открытое"))
        self.assertLess(text.index("Открытое"), text.index("## Решения"))
        self.assertLess(text.index("Второй вопрос?"), text.index("Первый вопрос?"))
        self.assertIn("~~Первый вопрос?~~", text)
        self.assertIn("**Заменено:** d2", text)
        self.assertIn("- контраргумент", text)
        self.assertIn("**Следствие:** следствие", text)
        self.assertIn("«давай pass@1 на отложенном»", text)
        self.assertNotIn("**Решение:**", text.split("### o1")[1].split("###")[0])

    def test_marks_unverified_and_hand_edited(self):
        m = a_map(node("d1", hand_edited=True))
        m["nodes"][0]["verified"] = False
        m["nodes"][0]["cites"][0]["ok"] = False
        text = store.export_markdown(m)
        self.assertIn("**Не проверено** — цитата не найдена в транскрипте", text)
        self.assertIn("исправлено вручную", text)
        self.assertIn("ход не найден: «давай pass@1 на отложенном» — не подтверждена", text)

    def test_missing_transcript_says_unchecked_not_not_found(self):
        # nothing was searched, so the document must not claim a citation was looked for
        m = a_map(node("d1"), node("o1", kind="open", status="proposed", cites=[]))
        for n in m["nodes"]:
            n["verified"] = False
            for c in n["cites"]:
                c["ok"] = False
        text = store.export_markdown(m, transcript_error="транскрипт сессии не найден: s1")
        self.assertIn("> Цитаты не проверены: транскрипт сессии не найден: s1", text)
        self.assertEqual(text.count("**Не проверялось** — транскрипт недоступен"), 2)
        self.assertIn("ход не указан: «давай pass@1 на отложенном»", text)
        sections = text.split("###", 1)[1]  # the blockquote above may say "не найден"
        self.assertNotIn("не найден", sections)
        self.assertNotIn("не подтверждена", sections)
        self.assertNotIn("Не проверено", sections)
        self.assertNotIn("Нет цитат", sections)

    def test_node_without_citations_says_so(self):
        m = a_map(node("o1", kind="open", status="proposed", cites=[]),
                  node("d1"))
        m["nodes"][0]["verified"] = False
        m["nodes"][1]["verified"] = True
        m["nodes"][1]["cites"][0]["ok"] = True
        text = store.export_markdown(m)
        o1 = text.split("### o1")[1].split("###")[0]
        self.assertIn("**Нет цитат** — узел нельзя проверить", o1)
        self.assertNotIn("не найдена", o1)
        self.assertNotIn("Не проверено", text)
        self.assertNotIn("не подтверждена", text)

    def test_the_three_unverified_states_use_different_words(self):
        unchecked = store.export_markdown(a_map(node("d1", verified=False)), transcript_error="нет")
        nocites = store.export_markdown(a_map(node("d1", verified=False, cites=[])))
        notfound = store.export_markdown(a_map(node("d1", verified=False)))
        lines = [t.split("**Статус:**")[1].split("\n")[0] for t in (unchecked, nocites, notfound)]
        self.assertEqual(len(set(lines)), 3, lines)

    def test_empty_map_exports_a_document(self):
        text = store.export_markdown({})
        self.assertTrue(text.startswith("# Карта решений"))


if __name__ == "__main__":
    unittest.main()
