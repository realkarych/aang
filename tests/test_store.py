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
        self.assertIn("Чем мерить?", raw)
        self.assertEqual(store.load(self.root), schema.normalize(copy.deepcopy(m)))

    def test_save_leaves_no_temp_file(self):
        store.save(self.root, a_map(node("d1")))
        store.save(self.root, a_map(node("d1"), node("d2")))
        self.assertEqual(sorted(os.listdir(store.map_dir(self.root))), ["map.json"])

    def test_new_file_is_readable_and_existing_mode_is_kept(self):
        store.save(self.root, a_map(node("d1")))
        mode = os.stat(store.map_path(self.root)).st_mode & 0o777
        self.assertNotEqual(mode, 0o600)
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
            json.load(handle)
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

    def test_superseded_node_survives_when_new_omits_it(self):
        old = a_map(node("d1", status="superseded", superseded_by="d2", decision="старое"),
                    node("d2"))
        new = a_map(node("d2"), node("d3"))
        merged = store.merge(old, new)
        self.assertEqual(ids(merged), ["d1", "d2", "d3"])
        d1 = merged["nodes"][0]
        self.assertEqual(d1["status"], "superseded")
        self.assertEqual(d1["superseded_by"], "d2")
        self.assertEqual(d1["decision"], "старое")
        self.assertFalse(d1["hand_edited"])
        self.assertEqual(schema.validate(merged), [])
        merged2 = store.merge(merged, a_map(node("d3")))
        self.assertEqual(ids(merged2), ["d1", "d2", "d3"])
        self.assertEqual(schema.validate(merged2), [])

    def test_superseded_node_omitted_together_with_its_replacement(self):
        old = a_map(node("d1", status="superseded", superseded_by="d2"), node("d2"), node("d3"))
        merged = store.merge(old, a_map(node("d3")))
        self.assertEqual(ids(merged), ["d1", "d2", "d3"])
        self.assertEqual(schema.validate(merged), [])

    def test_reemitted_superseded_node_keeps_its_stored_text(self):
        old = a_map(node("d1", status="superseded", superseded_by="d2", decision="старое",
                         why="старая причина", against=["старый довод"],
                         cites=[{"turn": 3, "role": "user", "quote": "старая цитата"}]),
                    node("d2"))
        new = a_map(node("d1", status="superseded", superseded_by="d2", decision="переписано",
                         why="новая причина", against=[], kind="tacit",
                         cites=[{"turn": None, "role": None, "quote": "другая цитата"}]),
                    node("d2"), node("d3"))
        merged = store.merge(old, new)
        self.assertEqual(ids(merged), ["d1", "d2", "d3"])
        d1 = merged["nodes"][0]
        self.assertEqual(d1["decision"], "старое")
        self.assertEqual(d1["why"], "старая причина")
        self.assertEqual(d1["against"], ["старый довод"])
        self.assertEqual(d1["kind"], "decision")
        self.assertEqual(d1["cites"][0]["quote"], "старая цитата")
        self.assertEqual(d1["cites"][0]["turn"], 3)
        self.assertEqual(d1["status"], "superseded")
        self.assertEqual(d1["superseded_by"], "d2")
        self.assertFalse(d1["hand_edited"])
        self.assertEqual(schema.validate(merged), [])

    def test_regeneration_never_unsupersedes_or_repoints_a_superseded_node(self):
        old = a_map(node("d1", status="superseded", superseded_by="d2", decision="старое"),
                    node("d2"), node("d3"))
        revived = a_map(node("d1", decision="снова актуально"), node("d2"), node("d3"))
        merged = store.merge(old, revived)
        d1 = merged["nodes"][0]
        self.assertEqual(d1["status"], "superseded")
        self.assertEqual(d1["superseded_by"], "d2")
        self.assertEqual(d1["decision"], "старое")
        self.assertEqual(schema.validate(merged), [])
        repointed = a_map(node("d1", status="superseded", superseded_by="d3"), node("d2"), node("d3"))
        merged2 = store.merge(old, repointed)
        self.assertEqual(merged2["nodes"][0]["superseded_by"], "d2")
        self.assertEqual(schema.validate(merged2), [])

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
        self.assertEqual(d1["decision"], "правка")
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


class AddedAtTest(unittest.TestCase):
    def test_stamp_added_at_only_fills_missing(self):
        m = {"version": 1, "nodes": [{"id": "d1", "added_at": "2026-01-01T00:00:00Z"},
                                     {"id": "d2"}]}
        out = store.stamp_added_at(m, "2026-09-11T12:00:00Z")
        self.assertEqual("2026-01-01T00:00:00Z", out["nodes"][0]["added_at"])
        self.assertEqual("2026-09-11T12:00:00Z", out["nodes"][1]["added_at"])

    def test_stamp_fills_empty_string_too(self):
        m = a_map(node("d1", added_at=""))
        out = store.stamp_added_at(m, "2026-09-11T12:00:00Z")
        self.assertEqual("2026-09-11T12:00:00Z", out["nodes"][0]["added_at"])

    def test_merge_preserves_added_at_of_existing_node(self):
        old = a_map(node("d1", added_at="2026-01-01T00:00:00Z"))
        new = a_map(node("d1", why="переписано моделью"))
        out = store.merge(old, new)
        self.assertEqual("2026-01-01T00:00:00Z", out["nodes"][0]["added_at"])
        self.assertEqual("переписано моделью", out["nodes"][0]["why"])

    def test_merge_keeps_added_at_of_hand_edited_and_frozen_nodes(self):
        old = a_map(node("d1", status="superseded", superseded_by="d2", added_at="2026-01-01T00:00:00Z"),
                    node("d2", hand_edited=True, added_at="2026-01-02T00:00:00Z"))
        new = a_map(node("d1", status="superseded", superseded_by="d2", added_at="2026-09-11T00:00:00Z"),
                    node("d2", added_at="2026-09-11T00:00:00Z"))
        out = store.merge(old, new)
        by_id = dict((n["id"], n) for n in out["nodes"])
        self.assertEqual("2026-01-01T00:00:00Z", by_id["d1"]["added_at"])
        self.assertEqual("2026-01-02T00:00:00Z", by_id["d2"]["added_at"])

    def test_merge_discards_added_at_the_model_wrote_for_a_new_node(self):
        out = store.merge(a_map(), a_map(node("d1", added_at="1999-01-01T00:00:00Z")))
        self.assertEqual("", out["nodes"][0]["added_at"])


class RelatesMergeTest(unittest.TestCase):
    def test_merge_keeps_relates_of_frozen_superseded_node(self):
        old = a_map(node("d0"), node("d2"),
                    node("d1", status="superseded", superseded_by="d2",
                         relates=[{"to": "d0", "rel": "rests_on"}]))
        new = a_map(node("d0"), node("d2"),
                    node("d1", status="superseded", superseded_by="d2", relates=[]))
        out = store.merge(old, new)
        frozen = [n for n in out["nodes"] if n["id"] == "d1"][0]
        self.assertEqual([{"to": "d0", "rel": "rests_on"}], frozen["relates"])
        self.assertEqual(schema.validate(out), [])

    def test_merge_keeps_relates_of_hand_edited_node(self):
        old = a_map(node("d0"), node("d1", hand_edited=True,
                                      relates=[{"to": "d0", "rel": "rests_on"}]))
        new = a_map(node("d0"), node("d1", relates=[]))
        out = store.merge(old, new)
        kept = [n for n in out["nodes"] if n["id"] == "d1"][0]
        self.assertEqual([{"to": "d0", "rel": "rests_on"}], kept["relates"])

    def test_merge_never_rewrites_relates_of_hand_edited_node(self):
        old = a_map(node("d0"), node("t1", kind="tacit"),
                    node("d1", hand_edited=True, relates=[{"to": "d0", "rel": "rests_on"}]))
        new = a_map(node("d0"), node("t1", kind="tacit"),
                    node("d1", relates=[{"to": "t1", "rel": "moots"}]))
        out = store.merge(old, new)
        kept = [n for n in out["nodes"] if n["id"] == "d1"][0]
        self.assertEqual([{"to": "d0", "rel": "rests_on"}], kept["relates"])

    def test_merge_takes_relates_from_candidate_for_ordinary_node(self):
        old = a_map(node("d0"), node("d1"))
        new = a_map(node("d0"), node("d1", relates=[{"to": "d0", "rel": "rests_on"}]))
        out = store.merge(old, new)
        updated = [n for n in out["nodes"] if n["id"] == "d1"][0]
        self.assertEqual([{"to": "d0", "rel": "rests_on"}], updated["relates"])

    def test_merge_drops_relates_the_candidate_dropped_for_ordinary_node(self):
        old = a_map(node("d0"), node("d1", relates=[{"to": "d0", "rel": "rests_on"}]))
        new = a_map(node("d0"), node("d1"))
        out = store.merge(old, new)
        self.assertEqual([], [n for n in out["nodes"] if n["id"] == "d1"][0]["relates"])

    def test_target_of_a_frozen_nodes_edge_survives_when_the_candidate_drops_it(self):
        old = a_map(node("t1", kind="tacit"),
                    node("d1", status="superseded", superseded_by="d3",
                         relates=[{"to": "t1", "rel": "rests_on"}]),
                    node("d3"))
        out = store.merge(old, a_map(node("d3")))
        self.assertEqual(["t1", "d1", "d3"], ids(out))
        self.assertEqual(schema.validate(out), [])

    def test_target_of_a_hand_edited_nodes_edge_survives_when_the_candidate_drops_it(self):
        old = a_map(node("d1"), node("d2", hand_edited=True, relates=[{"to": "d1", "rel": "rests_on"}]))
        out = store.merge(old, a_map(node("d2")))
        self.assertEqual(["d1", "d2"], ids(out))
        self.assertFalse([n for n in out["nodes"] if n["id"] == "d1"][0]["hand_edited"])
        self.assertEqual(schema.validate(out), [])

    def test_pinned_target_brings_its_own_targets_along(self):
        old = a_map(node("t1", kind="tacit"),
                    node("d1", relates=[{"to": "t1", "rel": "rests_on"}]),
                    node("d2", hand_edited=True, relates=[{"to": "d1", "rel": "moots"}]))
        out = store.merge(old, a_map(node("d2")))
        self.assertEqual(["t1", "d1", "d2"], ids(out))
        self.assertEqual(schema.validate(out), [])

    def test_protected_node_reordered_above_its_target_is_moved_back_below_it(self):
        old = a_map(node("d1"), node("d2", hand_edited=True, relates=[{"to": "d1", "rel": "rests_on"}]))
        out = store.merge(old, a_map(node("d2"), node("d1")))
        self.assertEqual(["d1", "d2"], ids(out))
        self.assertEqual(schema.validate(out), [])

    def test_reorder_moves_along_a_candidate_node_that_rests_on_the_protected_one(self):
        old = a_map(node("d1"), node("d2", hand_edited=True, relates=[{"to": "d1", "rel": "rests_on"}]))
        new = a_map(node("d2"), node("d3", relates=[{"to": "d2", "rel": "rests_on"}]), node("d1"))
        out = store.merge(old, new)
        self.assertEqual(["d1", "d2", "d3"], ids(out))
        self.assertEqual(schema.validate(out), [])

    def test_an_order_that_already_works_is_left_alone(self):
        old = a_map(node("d1"), node("d2", hand_edited=True, relates=[{"to": "d1", "rel": "rests_on"}]),
                    node("d3", hand_edited=True))
        new = a_map(node("d4"), node("d1"), node("d5", relates=[{"to": "d4", "rel": "moots"}]))
        self.assertEqual(["d4", "d1", "d2", "d3", "d5"], ids(store.merge(old, new)))

    def test_contradicting_edges_are_left_for_validate(self):
        old = a_map(node("d1"), node("d2", hand_edited=True, relates=[{"to": "d1", "rel": "rests_on"}]))
        out = store.merge(old, a_map(node("d2"), node("d1", relates=[{"to": "d2", "rel": "rests_on"}])))
        self.assertEqual(["d2", "d1"], ids(out))
        self.assertTrue(any("ссылка вперёд" in e for e in schema.validate(out)))

    def test_merge_strips_related_by_and_verified_from_the_candidate(self):
        new = a_map(node("d1", related_by=[{"from": "ghost", "rel": "moots"}], verified=True))
        out = store.merge(a_map(), new)
        self.assertNotIn("related_by", out["nodes"][0])
        self.assertNotIn("verified", out["nodes"][0])

    def test_merge_strips_a_stale_related_by_from_protected_nodes_too(self):
        old = a_map(node("d1", hand_edited=True, related_by=[{"from": "ghost", "rel": "moots"}]),
                    node("d2", status="superseded", superseded_by="d1", related_by=[]))
        out = store.merge(old, a_map(node("d1")))
        self.assertFalse(any("related_by" in n for n in out["nodes"]))


class FillTurnsTest(unittest.TestCase):
    def setUp(self):
        self.turns = transcript.index(os.path.join(FIXTURES, "normal.jsonl"))

    def test_fills_turn_and_role_from_quote(self):
        m = a_map(node("d1", cites=[{"quote": "давай тогда pass@1"},
                                    {"quote": "нужно 500 примеров вместо 100", "role": "assistant"}]))
        report = store.fill_turns(m, self.turns)
        cites = m["nodes"][0]["cites"]
        self.assertEqual((cites[0]["turn"], cites[0]["role"]), (4, "user"))
        self.assertEqual((cites[1]["turn"], cites[1]["role"]), (5, "assistant"))
        self.assertTrue(all(r["ok"] for r in report))
        self.assertEqual([r["node_id"] for r in report], ["d1", "d1"])

    def test_model_supplied_turn_is_discarded_and_recomputed(self):
        m = a_map(node("d1", cites=[{"turn": 2, "quote": "давай тогда pass@1"}]))
        store.fill_turns(m, self.turns)
        self.assertEqual(m["nodes"][0]["cites"][0]["turn"], 4)

    def test_unfound_quote_keeps_null_turn(self):
        m = a_map(node("d1", cites=[{"turn": 3, "quote": "этого никто никогда не говорил"}]))
        report = store.fill_turns(m, self.turns)
        self.assertIsNone(m["nodes"][0]["cites"][0]["turn"])
        self.assertFalse(report[0]["ok"])

    def test_no_turns_leaves_everything_null(self):
        m = a_map(node("d1", cites=[{"quote": "давай тогда pass@1"}]))
        store.fill_turns(m, [])
        self.assertIsNone(m["nodes"][0]["cites"][0]["turn"])


class ExportTest(unittest.TestCase):
    def test_newest_first_superseded_marked_blocks_in_order(self):
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
        self.assertLess(text.index("## Решено"), text.index("## Под вопросом"))
        self.assertLess(text.index("#### d2 · Второй вопрос?"),
                        text.index("#### d1 · ~~Первый вопрос?~~"))
        self.assertIn("~~Первый вопрос?~~", text)
        self.assertIn("**Заменено:** d2", text)
        self.assertIn("- контраргумент", text)
        self.assertIn("**Следствие:** следствие", text)
        self.assertIn("«давай pass@1 на отложенном»", text)
        self.assertNotIn("**Решение:**", text.split("#### o1")[1].split("###")[0])

    def test_marks_unverified_and_hand_edited(self):
        m = a_map(node("d1", hand_edited=True))
        m["nodes"][0]["verified"] = False
        m["nodes"][0]["cites"][0]["ok"] = False
        text = store.export_markdown(m)
        self.assertIn("**Не проверено** — цитата не найдена в транскрипте", text)
        self.assertIn("исправлено вручную", text)
        self.assertIn("ход не найден: «давай pass@1 на отложенном» — не подтверждена", text)

    def test_missing_transcript_says_unchecked_not_not_found(self):
        m = a_map(node("d1"), node("o1", kind="open", status="proposed", cites=[]))
        for n in m["nodes"]:
            n["verified"] = False
            for c in n["cites"]:
                c["ok"] = False
        text = store.export_markdown(m, transcript_error="транскрипт сессии не найден: s1")
        self.assertIn("> Цитаты не проверены: транскрипт сессии не найден: s1", text)
        self.assertEqual(text.count("**Не проверялось** — транскрипт недоступен"), 2)
        self.assertIn("ход не указан: «давай pass@1 на отложенном»", text)
        sections = text.split("####", 1)[1]
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
        o1 = text.split("#### o1")[1].split("###")[0]
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

    def test_export_lists_relations_in_words(self):
        m = a_map(node("d1", question="Порог?"),
                  node("o1", kind="open", status="proposed", question="Что с хвостом?",
                       decision="", cites=[], relates=[{"to": "d1", "rel": "orphaned_by"}]))
        md = store.export_markdown(m)
        self.assertIn("осиротело решением d1 (Порог?)", md)
        self.assertIn("**Связи:**", md)

    def test_export_has_a_label_for_every_relation_kind(self):
        self.assertEqual(sorted(store.REL_LABELS), sorted(schema.RELS))
        nodes = [node("d0", question="База?")]
        for i, rel in enumerate(schema.RELS, 1):
            nodes.append(node("d%d" % i, relates=[{"to": "d0", "rel": rel}]))
        md = store.export_markdown(a_map(*nodes))
        for rel in schema.RELS:
            self.assertIn("- %s d0 (База?)" % store.REL_LABELS[rel], md)

    def test_export_says_an_isolated_node_is_related_to_nothing(self):
        md = store.export_markdown(a_map(node("d1", related_by=[])))
        self.assertIn("**Связи:** ни с чем не связано", md)
        self.assertNotIn("**Связи:**\n", md)

    def test_export_shows_the_reverse_side_on_the_target(self):
        m = a_map(node("t1", kind="tacit", question="Остаться на 3.9?",
                       related_by=[{"from": "d1", "rel": "rests_on"}]),
                  node("d1", question="Чем мерить?", relates=[{"to": "t1", "rel": "rests_on"}],
                       related_by=[{"from": "o1", "rel": "orphaned_by"}]),
                  node("o1", kind="open", status="proposed", question="Что с хвостом?", decision="",
                       cites=[], relates=[{"to": "d1", "rel": "orphaned_by"}], related_by=[]))
        md = store.export_markdown(m)
        t1 = md.split("#### t1")[1].split("###")[0]
        d1 = md.split("#### d1")[1].split("###")[0]
        self.assertIn("- на этом держится d1 (Чем мерить?)", t1)
        self.assertIn("- опирается на t1 (Остаться на 3.9?)", d1)
        self.assertIn("- оставило висеть o1 (Что с хвостом?)", d1)
        self.assertNotIn("ни с чем не связано", t1 + d1)

    def test_export_marks_a_mooted_node_on_the_node_itself(self):
        m = a_map(node("d4", question="Порог 72 часа?", related_by=[{"from": "d5", "rel": "moots"}]),
                  node("d5", question="Разворот на /aang?", relates=[{"to": "d4", "rel": "moots"}],
                       related_by=[]))
        md = store.export_markdown(m)
        d4 = md.split("#### d4")[1].split("###")[0]
        status = d4.split("**Статус:**")[1].split("\n")[0]
        self.assertIn("**Неактуально** — d5 (Разворот на /aang?) сделало это неактуальным", status)
        self.assertNotIn("ни с чем не связано", d4)
        self.assertIn("- сделало неактуальным d4 (Порог 72 часа?)", md.split("#### d5")[1].split("###")[0])

    def test_export_agrees_the_verb_with_several_mooters(self):
        m = a_map(node("d1", related_by=[{"from": "d2", "rel": "moots"}, {"from": "d3", "rel": "moots"}]),
                  node("d2", relates=[{"to": "d1", "rel": "moots"}]),
                  node("d3", relates=[{"to": "d1", "rel": "moots"}]))
        md = store.export_markdown(m)
        self.assertIn("d2 (Вопрос d2?), d3 (Вопрос d3?) сделали это неактуальным", md)

    def test_export_superseded_pair_is_not_isolated(self):
        m = a_map(node("d1", question="Старый?", status="superseded", superseded_by="d2", related_by=[]),
                  node("d2", question="Новый?", related_by=[]))
        md = store.export_markdown(m)
        self.assertNotIn("ни с чем не связано", md)
        self.assertIn("- заменяет d1 (Старый?)", md.split("#### d2")[1].split("###")[0])

    def test_export_reverse_labels_cover_the_vocabulary(self):
        self.assertEqual(sorted(list(store.REL_LABELS_BACK) + ["moots"]), sorted(schema.RELS))

    def test_empty_map_exports_a_document(self):
        text = store.export_markdown({})
        self.assertTrue(text.startswith("# Карта решений"))


class TopicAndCellMergeTest(unittest.TestCase):
    def node(self, node_id, **fields):
        base = {"id": node_id, "kind": "decision", "status": "accepted", "question": "В?",
                "decision": "Р", "why": "п", "cites": [{"quote": "три слова тут есть"}]}
        base.update(fields)
        return base

    def test_topic_is_content_and_comes_from_the_candidate(self):
        old = {"version": 1, "nodes": [self.node("d1", topic="старая", added_at="2026-09-11T11:00:00Z")]}
        new = {"version": 1, "nodes": [self.node("d1", topic="новая"), self.node("d2", topic=None)]}
        by_id = dict((n["id"], n) for n in store.merge(old, new)["nodes"])
        self.assertEqual("новая", by_id["d1"]["topic"])
        self.assertEqual("2026-09-11T11:00:00Z", by_id["d1"]["added_at"])
        self.assertIsNone(by_id["d2"]["topic"])
        self.assertNotIn("seen_at", by_id["d1"])

    def test_a_hand_edited_nodes_topic_is_its_own(self):
        old = {"version": 1, "nodes": [self.node("d1", topic="своя", hand_edited=True)]}
        new = {"version": 1, "nodes": [self.node("d1", topic="чужая")]}
        self.assertEqual("своя", store.merge(old, new)["nodes"][0]["topic"])
        self.assertIn("topic", store.CONTENT_FIELDS)

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
        heads = [line for line in text.splitlines() if line.startswith("#")]
        self.assertEqual(["# т",
                          "## Решено",
                          "### модели", "#### d1 · Вопрос d1?",
                          "### порт", "#### d3 · Вопрос d3?", "#### d2 · ~~Вопрос d2?~~",
                          "## Под вопросом",
                          "### модели", "#### o1 · Вопрос o1?",
                          "## Отвергнуто",
                          "### модели", "#### d4 · Вопрос d4?"],
                         heads)

    def test_an_empty_block_is_omitted(self):
        text = store.export_markdown({"version": 1, "nodes": [self.node("d1", topic="x")]})
        self.assertIn("## Решено", text)
        self.assertNotIn("## Под вопросом", text)
        self.assertNotIn("## Отвергнуто", text)


if __name__ == "__main__":
    unittest.main()
