import io
import json
import os
import re
import shutil
import tempfile
import time
import unittest
from unittest import mock

from aang import cli, store

FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")
NORMAL = os.path.join(FIXTURES, "normal.jsonl")
MISSING = os.path.join(FIXTURES, "does-not-exist.jsonl")


def candidate(*nodes):
    return {"version": 1, "session_id": "", "generated_at": "2026-09-11T12:00:00Z",
            "title": "проба", "nodes": list(nodes)}


def decision(node_id, quote, **overrides):
    base = {"id": node_id, "kind": "decision", "status": "accepted",
            "question": "Вопрос %s?" % node_id, "decision": "Решение %s" % node_id,
            "why": "почему %s" % node_id, "cites": [{"quote": quote}]}
    base.update(overrides)
    return base


class CliTestCase(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="aang-cli-")
        self.addCleanup(shutil.rmtree, self.root, True)

    def run_cli(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        code = cli.main(list(argv), stdout=out, stderr=err)
        return code, out.getvalue(), err.getvalue()

    def write_candidate(self, cand, name=None):
        os.makedirs(store.map_dir(self.root), exist_ok=True)
        path = name or store.candidate_path(self.root)
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(cand, handle, ensure_ascii=False)
        return path


class CheckTest(CliTestCase):
    def test_no_map_exits_1(self):
        code, out, err = self.run_cli("check", "--root", self.root, "--transcript", NORMAL)
        self.assertEqual(code, 1)
        self.assertIn("Карты нет", err)

    def test_valid_map_all_cites_found_exits_0(self):
        store.save(self.root, candidate(decision("d1", "давай тогда pass@1"),
                                        decision("t1", "нужно 500 примеров вместо 100", kind="tacit")))
        code, out, err = self.run_cli("check", "--root", self.root, "--transcript", NORMAL)
        self.assertEqual(code, 0, out + err)
        self.assertIn("9 ходов", out)
        self.assertIn("ход 4/user", out)
        self.assertIn("✓ каждая цитата найдена", out)

    def test_bad_citation_exits_1_and_names_node(self):
        store.save(self.root, candidate(decision("d1", "давай тогда pass@1"),
                                        decision("d2", "фраза, которой в сессии не было")))
        code, out, err = self.run_cli("check", "--root", self.root, "--transcript", NORMAL)
        self.assertEqual(code, 1)
        self.assertIn("✗ d2", out)
        self.assertIn("✓ d1", out)
        self.assertIn("не подтверждено: 1", out)

    def test_wrong_turn_number_exits_1(self):
        store.save(self.root, candidate(decision("d1", "давай тогда pass@1", cites=[{"turn": 2, "quote": "давай тогда pass@1"}])))
        code, out, _ = self.run_cli("check", "--root", self.root, "--transcript", NORMAL)
        self.assertEqual(code, 1)
        self.assertIn("не найдена в ходе 2", out)

    def test_invalid_map_exits_1_with_errors(self):
        store.save(self.root, candidate(decision("d1", "давай тогда pass@1", status="done")))
        code, out, _ = self.run_cli("check", "--root", self.root, "--transcript", NORMAL)
        self.assertEqual(code, 1)
        self.assertIn("невалидна", out)
        self.assertIn("узел d1, поле status", out)

    def test_corrupt_map_exits_1(self):
        os.makedirs(store.map_dir(self.root))
        with open(store.map_path(self.root), "w") as handle:
            handle.write("{{{")
        code, _, err = self.run_cli("check", "--root", self.root, "--transcript", NORMAL)
        self.assertEqual(code, 1)
        self.assertIn("не читается", err)

    def test_missing_transcript_exits_1_but_prints_map(self):
        store.save(self.root, candidate(decision("d1", "давай тогда pass@1")))
        code, out, _ = self.run_cli("check", "--root", self.root, "--transcript", MISSING)
        self.assertEqual(code, 1)
        self.assertIn("транскрипт сессии не найден", out)
        self.assertIn("✗ d1", out)

    def test_open_node_without_cites_is_reported_not_fatal(self):
        store.save(self.root, candidate(
            decision("d1", "давай тогда pass@1"),
            {"id": "o1", "kind": "open", "status": "proposed", "question": "Кто платит?", "why": "следствие"}))
        code, out, _ = self.run_cli("check", "--root", self.root, "--transcript", NORMAL)
        self.assertEqual(code, 0, out)
        self.assertIn("нет цитат", out)
        self.assertIn("△ o1", out)
        self.assertIn("✓ d1", out)
        self.assertNotIn("✗", out)
        self.assertIn("узлов без цитат: 1", out)
        self.assertIn("Итог: ✓", out)
        self.assertIn("1 узел без цитат", out)

    def test_check_prints_warnings_but_still_exits_zero(self):
        store.save(self.root, candidate(
            decision("d1", "давай тогда pass@1"),
            decision("d2", "нужно 500 примеров вместо 100", why="следует из d1")))
        code, out, _ = self.run_cli("check", "--root", self.root, "--transcript", NORMAL)
        self.assertEqual(0, code, out)
        self.assertIn("Замечания:", out)
        self.assertIn("узел d2: в тексте упомянут d1, но связи на него нет", out)
        self.assertLess(out.index("Итог:"), out.index("Замечания:"))

    def test_check_remarks_on_an_open_node_without_orphaned_by(self):
        store.save(self.root, candidate(
            decision("d1", "давай тогда pass@1"),
            decision("o1", "", kind="open", status="proposed", decision="", cites=[],
                     why="Заявлено как главный механизм; способа замера нет")))
        code, out, _ = self.run_cli("check", "--root", self.root, "--transcript", NORMAL)
        self.assertEqual(0, code, out)
        self.assertIn("Итог: ✓", out)
        self.assertIn("Замечания:", out)
        self.assertIn("узел o1: открытый вопрос без orphaned_by — укажите решение или скажите в why, что его нет",
                      out)

    def test_check_prints_no_warnings_block_when_there_are_none(self):
        store.save(self.root, candidate(decision("d1", "давай тогда pass@1")))
        code, out, _ = self.run_cli("check", "--root", self.root, "--transcript", NORMAL)
        self.assertEqual(0, code, out)
        self.assertNotIn("Замечания", out)

    def test_check_warnings_do_not_rescue_a_failing_map(self):
        store.save(self.root, candidate(
            decision("d1", "давай тогда pass@1"),
            decision("d2", "фраза, которой в сессии не было", why="следует из d1")))
        code, out, _ = self.run_cli("check", "--root", self.root, "--transcript", NORMAL)
        self.assertEqual(1, code)
        self.assertIn("Замечания:", out)

    def test_clean_map_summary_has_no_uncited_note(self):
        store.save(self.root, candidate(decision("d1", "давай тогда pass@1")))
        code, out, _ = self.run_cli("check", "--root", self.root, "--transcript", NORMAL)
        self.assertEqual(code, 0, out)
        self.assertIn("узлов без цитат: 0", out)
        self.assertNotIn("без цитат —", out)
        self.assertNotIn("△", out)


class MergeTest(CliTestCase):
    def test_no_candidate_exits_1(self):
        code, _, err = self.run_cli("merge", "--root", self.root, "--transcript", NORMAL)
        self.assertEqual(code, 1)
        self.assertIn("Кандидата нет", err)
        self.assertFalse(os.path.exists(store.map_path(self.root)))

    def test_corrupt_candidate_exits_1_nothing_written(self):
        path = self.write_candidate({})
        with open(path, "w") as handle:
            handle.write("not json")
        code, _, err = self.run_cli("merge", "--root", self.root, "--transcript", NORMAL)
        self.assertEqual(code, 1)
        self.assertIn("не читается", err)
        self.assertFalse(os.path.exists(store.map_path(self.root)))
        self.assertTrue(os.path.exists(path))

    def test_invalid_candidate_exits_1_with_named_errors(self):
        store.save(self.root, candidate(decision("d1", "давай тогда pass@1")))
        self.write_candidate(candidate(decision("d1", "давай тогда pass@1", kind="wat"),
                                       decision("d2", "")))
        code, _, err = self.run_cli("merge", "--root", self.root, "--transcript", NORMAL)
        self.assertEqual(code, 1)
        self.assertIn("невалиден", err)
        self.assertIn("узел d1, поле kind", err)
        self.assertIn("узел d2, поле cites[0].quote", err)
        self.assertEqual([n["id"] for n in store.load(self.root)["nodes"]], ["d1"])

    def test_merge_fills_turns_records_session_and_consumes_candidate(self):
        cand_path = self.write_candidate(candidate(
            decision("d1", "давай тогда pass@1"),
            decision("t1", "нужно 500 примеров вместо 100", kind="tacit"),
            decision("d2", "выдуманная цитата, которой не было", cites=[{"turn": 7, "quote": "выдуманная цитата, которой не было"}])))
        code, out, err = self.run_cli("merge", "--root", self.root, "--transcript", NORMAL)
        self.assertEqual(code, 0, out + err)
        saved = store.load(self.root)
        by_id = dict((n["id"], n) for n in saved["nodes"])
        self.assertEqual(by_id["d1"]["cites"][0]["turn"], 4)
        self.assertEqual(by_id["d1"]["cites"][0]["role"], "user")
        self.assertEqual(by_id["t1"]["cites"][0]["turn"], 5)
        self.assertIn("d2", by_id)
        self.assertIsNone(by_id["d2"]["cites"][0]["turn"])
        self.assertEqual(saved["session_id"], "normal")
        self.assertIn("не найдено: 1", out)
        self.assertIn("turn: null", out)
        self.assertFalse(os.path.exists(cand_path))
        code, out, _ = self.run_cli("check", "--root", self.root, "--transcript", NORMAL)
        self.assertEqual(code, 1)
        self.assertIn("✗ d2", out)

    def test_merge_stamps_generated_at_with_current_utc_time(self):
        cand = candidate(decision("d1", "давай тогда pass@1"))
        cand["generated_at"] = "1999-01-01T00:00:00Z"
        self.write_candidate(cand)
        before = time.time()
        code, _, _ = self.run_cli("merge", "--root", self.root, "--transcript", NORMAL)
        self.assertEqual(code, 0)
        stamp = store.load(self.root)["generated_at"]
        self.assertRegex(stamp, r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
        parsed = time.mktime(time.strptime(stamp, "%Y-%m-%dT%H:%M:%SZ")) - time.timezone
        self.assertGreaterEqual(int(parsed), int(before) - 1)
        self.assertLessEqual(parsed, time.time() + 1)

    def test_generated_at_is_stamped_even_when_candidate_has_none(self):
        cand = candidate(decision("d1", "давай тогда pass@1"))
        cand["generated_at"] = ""
        self.write_candidate(cand)
        self.assertEqual(self.run_cli("merge", "--root", self.root, "--transcript", NORMAL)[0], 0)
        self.assertNotEqual(store.load(self.root)["generated_at"], "")

    def test_merge_stamps_added_at_once_and_keeps_it_on_regeneration(self):
        self.write_candidate(candidate(decision("d1", "давай тогда pass@1")))
        self.assertEqual(self.run_cli("merge", "--root", self.root, "--transcript", NORMAL)[0], 0)
        saved = store.load(self.root)
        first = saved["nodes"][0]["added_at"]
        self.assertRegex(first, r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
        self.assertEqual(first, saved["generated_at"])
        self.write_candidate(candidate(
            decision("d1", "давай тогда pass@1", why="переписано", added_at="1999-01-01T00:00:00Z"),
            decision("d2", "нужно 500 примеров вместо 100")))
        with mock.patch.object(cli, "_now_iso", return_value="2030-01-01T00:00:00Z"):
            self.assertEqual(self.run_cli("merge", "--root", self.root, "--transcript", NORMAL)[0], 0)
        by_id = dict((n["id"], n) for n in store.load(self.root)["nodes"])
        self.assertEqual(first, by_id["d1"]["added_at"])
        self.assertEqual("переписано", by_id["d1"]["why"])
        self.assertEqual("2030-01-01T00:00:00Z", by_id["d2"]["added_at"])

    def test_merge_stamps_nodes_of_a_map_written_before_added_at_existed(self):
        store.save(self.root, candidate(decision("d1", "давай тогда pass@1"),
                                        decision("t1", "нужно 500 примеров вместо 100", kind="tacit")))
        self.write_candidate(candidate(decision("d1", "давай тогда pass@1"),
                                       decision("t1", "нужно 500 примеров вместо 100", kind="tacit")))
        with mock.patch.object(cli, "_now_iso", return_value="2030-01-01T00:00:00Z"):
            self.assertEqual(self.run_cli("merge", "--root", self.root, "--transcript", NORMAL)[0], 0)
        stamps = set(n["added_at"] for n in store.load(self.root)["nodes"])
        self.assertEqual(set(["2026-09-11T12:00:00Z"]), stamps)

    def test_first_run_after_the_upgrade_keeps_its_own_delta(self):
        store.save(self.root, candidate(decision("d1", "давай тогда pass@1"),
                                        decision("t1", "нужно 500 примеров вместо 100", kind="tacit")))
        self.write_candidate(candidate(decision("d1", "давай тогда pass@1"),
                                       decision("t1", "нужно 500 примеров вместо 100", kind="tacit"),
                                       decision("d2", "Ещё вариант: pass@5"),
                                       decision("d3", "давай тогда pass@1")))
        with mock.patch.object(cli, "_now_iso", return_value="2030-01-01T00:00:00Z"):
            self.assertEqual(self.run_cli("merge", "--root", self.root, "--transcript", NORMAL)[0], 0)
        by_id = dict((n["id"], n["added_at"]) for n in store.load(self.root)["nodes"])
        self.assertEqual({"d1": "2026-09-11T12:00:00Z", "t1": "2026-09-11T12:00:00Z",
                          "d2": "2030-01-01T00:00:00Z", "d3": "2030-01-01T00:00:00Z"}, by_id)

    def test_pre_field_map_without_generated_at_is_backfilled_with_now(self):
        old = candidate(decision("d1", "давай тогда pass@1"))
        old["generated_at"] = ""
        store.save(self.root, old)
        self.write_candidate(candidate(decision("d1", "давай тогда pass@1")))
        with mock.patch.object(cli, "_now_iso", return_value="2030-01-01T00:00:00Z"):
            self.assertEqual(self.run_cli("merge", "--root", self.root, "--transcript", NORMAL)[0], 0)
        self.assertEqual("2030-01-01T00:00:00Z", store.load(self.root)["nodes"][0]["added_at"])

    def test_merge_keeps_and_names_the_target_of_a_frozen_edge(self):
        store.save(self.root, candidate(
            decision("t1", "Ещё вариант: pass@5", kind="tacit"),
            decision("d1", "давай тогда pass@1", status="superseded", superseded_by="d3",
                     relates=[{"to": "t1", "rel": "rests_on"}]),
            decision("d3", "нужно 500 примеров вместо 100")))
        self.write_candidate(candidate(decision("d3", "нужно 500 примеров вместо 100")))
        code, out, err = self.run_cli("merge", "--root", self.root, "--transcript", NORMAL)
        self.assertEqual(code, 0, err)
        self.assertEqual(["t1", "d1", "d3"], [n["id"] for n in store.load(self.root)["nodes"]])
        self.assertIn("сохранены (нет в кандидате, но на них ссылаются сохранённые узлы): t1", out)
        self.assertIn("заменённые сохранены (нет в кандидате, но это история): d1", out)
        self.assertNotIn("убраны", out)

    def _two_projects(self):
        """A transcript root with session A (this map's) and a newer session B elsewhere."""
        roots = os.path.join(self.root, "projects")
        a_dir = os.path.join(roots, "-Users-x-proj-a")
        b_dir = os.path.join(roots, "-Users-x-proj-b")
        os.makedirs(a_dir)
        os.makedirs(b_dir)
        a_path = os.path.join(a_dir, "aaaa1111-0000-0000-0000-000000000001.jsonl")
        b_path = os.path.join(b_dir, "bbbb2222-0000-0000-0000-000000000002.jsonl")
        shutil.copy(NORMAL, a_path)
        with open(b_path, "w", encoding="utf-8") as handle:
            handle.write(json.dumps({"type": "user", "uuid": "b1", "message": {
                "role": "user", "content": "Совсем другая сессия, в которой этих слов нет."}}) + "\n")
        os.utime(a_path, (1000000000, 1000000000))
        os.utime(b_path, (2000000000, 2000000000))
        return roots

    def test_second_merge_keeps_the_maps_session_when_candidate_has_none(self):
        roots = self._two_projects()
        self.write_candidate(candidate(decision("d1", "давай тогда pass@1")))
        code, out, err = self.run_cli("merge", "--root", self.root, "--transcript-root", roots,
                                      "--session", "aaaa1111-0000-0000-0000-000000000001")
        self.assertEqual(code, 0, out + err)
        self.assertEqual(store.load(self.root)["session_id"], "aaaa1111-0000-0000-0000-000000000001")
        self.write_candidate(candidate(decision("d1", "давай тогда pass@1"),
                                       decision("d2", "нужно 500 примеров вместо 100")))
        code, out, err = self.run_cli("merge", "--root", self.root, "--transcript-root", roots)
        self.assertEqual(code, 0, out + err)
        saved = store.load(self.root)
        self.assertEqual(saved["session_id"], "aaaa1111-0000-0000-0000-000000000001")
        by_id = dict((n["id"], n) for n in saved["nodes"])
        self.assertEqual(by_id["d1"]["cites"][0]["turn"], 4)
        self.assertEqual(by_id["d2"]["cites"][0]["turn"], 5)
        self.assertIn("не найдено: 0", out)
        self.assertNotIn("bbbb2222", out + err)
        code, out, _ = self.run_cli("check", "--root", self.root, "--transcript-root", roots)
        self.assertEqual(code, 0, out)

    def test_candidate_session_id_still_wins_over_the_maps(self):
        roots = self._two_projects()
        old = candidate(decision("d1", "давай тогда pass@1"))
        old["session_id"] = "aaaa1111-0000-0000-0000-000000000001"
        store.save(self.root, old)
        cand = candidate(decision("d1", "давай тогда pass@1"))
        cand["session_id"] = "bbbb2222-0000-0000-0000-000000000002"
        self.write_candidate(cand)
        code, out, _ = self.run_cli("merge", "--root", self.root, "--transcript-root", roots)
        self.assertEqual(code, 0, out)
        saved = store.load(self.root)
        self.assertEqual(saved["session_id"], "bbbb2222-0000-0000-0000-000000000002")
        self.assertIsNone(saved["nodes"][0]["cites"][0]["turn"])

    def test_newest_session_is_taken_and_stamped_only_when_nobody_names_one(self):
        roots = self._two_projects()
        self.write_candidate(candidate(decision("d1", "давай тогда pass@1")))
        code, out, _ = self.run_cli("merge", "--root", self.root, "--transcript-root", roots)
        self.assertEqual(code, 0, out)
        self.assertEqual(store.load(self.root)["session_id"], "bbbb2222-0000-0000-0000-000000000002")

    def test_empty_session_flag_is_the_same_as_none(self):
        roots = self._two_projects()
        self.write_candidate(candidate(decision("d1", "давай тогда pass@1")))
        code, out, err = self.run_cli("merge", "--root", self.root, "--transcript-root", roots,
                                      "--session", "")
        self.assertEqual(code, 0, out + err)
        self.assertEqual(store.load(self.root)["session_id"], "bbbb2222-0000-0000-0000-000000000002")
        self.assertNotIn("транскрипт сессии не найден", out + err)

    def test_keep_flag_leaves_candidate(self):
        cand_path = self.write_candidate(candidate(decision("d1", "давай тогда pass@1")))
        code, _, _ = self.run_cli("merge", "--root", self.root, "--transcript", NORMAL, "--keep")
        self.assertEqual(code, 0)
        self.assertTrue(os.path.exists(cand_path))

    def test_missing_transcript_merges_with_null_turns(self):
        self.write_candidate(candidate(decision("d1", "давай тогда pass@1")))
        code, out, _ = self.run_cli("merge", "--root", self.root, "--transcript", MISSING)
        self.assertEqual(code, 0)
        self.assertIn("ходы не проставлены", out)
        self.assertIsNone(store.load(self.root)["nodes"][0]["cites"][0]["turn"])

    def test_second_regeneration_preserves_hand_edit(self):
        self.write_candidate(candidate(decision("d1", "давай тогда pass@1", why="модель v1"),
                                       decision("d2", "нужно 500 примеров вместо 100")))
        self.assertEqual(self.run_cli("merge", "--root", self.root, "--transcript", NORMAL)[0], 0)
        m = store.load(self.root)
        m["nodes"][0]["why"] = "человек исправил"
        m["nodes"][0]["hand_edited"] = True
        store.save(self.root, m)
        self.write_candidate(candidate(decision("d1", "давай тогда pass@1", why="модель v2"),
                                       decision("d3", "Ещё вариант: pass@5")))
        code, out, _ = self.run_cli("merge", "--root", self.root, "--transcript", NORMAL)
        self.assertEqual(code, 0, out)
        saved = store.load(self.root)
        self.assertEqual([n["id"] for n in saved["nodes"]], ["d1", "d3"])
        self.assertEqual(saved["nodes"][0]["why"], "человек исправил")
        self.assertTrue(saved["nodes"][0]["hand_edited"])
        self.assertIn("правки сохранены: d1", out)
        self.assertIn("убраны (нет в кандидате и не правились): d2", out)
        self.assertEqual(self.run_cli("check", "--root", self.root, "--transcript", NORMAL)[0], 0)

    def test_broken_hand_edit_blocks_merge_and_keeps_map(self):
        store.save(self.root, candidate(decision("d1", "давай тогда pass@1", hand_edited=True,
                                                 status="superseded", superseded_by="ghost")))
        self.write_candidate(candidate(decision("d2", "давай тогда pass@1")))
        code, _, err = self.run_cli("merge", "--root", self.root, "--transcript", NORMAL)
        self.assertEqual(code, 1)
        self.assertIn("не сохранена", err)
        self.assertIn("ghost", err)
        self.assertEqual([n["id"] for n in store.load(self.root)["nodes"]], ["d1"])

    def test_explicit_candidate_path(self):
        path = self.write_candidate(candidate(decision("d1", "давай тогда pass@1")),
                                    name=os.path.join(self.root, "elsewhere.json"))
        code, _, _ = self.run_cli("merge", "--root", self.root, "--transcript", NORMAL, "--candidate", path)
        self.assertEqual(code, 0)
        self.assertEqual(store.load(self.root)["nodes"][0]["id"], "d1")


class ExportTest(CliTestCase):
    def test_writes_markdown_under_root(self):
        store.save(self.root, candidate(decision("d1", "давай тогда pass@1"),
                                        decision("d2", "чего не было", question="Второй?")))
        code, out, _ = self.run_cli("export", "--root", self.root, "--transcript", NORMAL,
                                    "--out", os.path.join("docs", "decisions.md"))
        self.assertEqual(code, 0, out)
        path = os.path.join(self.root, "docs", "decisions.md")
        self.assertTrue(os.path.exists(path))
        with open(path, encoding="utf-8") as handle:
            text = handle.read()
        self.assertIn("### d1", text)
        self.assertLess(text.index("### d2"), text.index("### d1"))
        self.assertIn("Не проверено", text.split("### d2")[1].split("###")[0])
        self.assertIn("не проверено: 1", out)

    def test_unreachable_transcript_is_stated_not_reported_as_not_found(self):
        store.save(self.root, candidate(decision("d1", "давай тогда pass@1"),
                                        decision("o1", "", kind="open", status="proposed", decision="", cites=[])))
        code, out, _ = self.run_cli("export", "--root", self.root, "--transcript", MISSING,
                                    "--out", "d.md")
        self.assertEqual(code, 0, out)
        with open(os.path.join(self.root, "d.md"), encoding="utf-8") as handle:
            text = handle.read()
        self.assertIn("> Цитаты не проверены: транскрипт сессии не найден", text)
        self.assertEqual(text.count("**Не проверялось** — транскрипт недоступен"), 2)
        self.assertNotIn("не найдена", text)
        self.assertNotIn("не подтверждена", text)
        self.assertNotIn("Не проверено", text)
        self.assertIn("не проверялось: 2 — транскрипт недоступен", out)

    def test_node_without_citations_is_not_reported_as_not_found(self):
        store.save(self.root, candidate(decision("d1", "давай тогда pass@1"),
                                        decision("o1", "", kind="open", status="proposed", decision="", cites=[])))
        code, out, _ = self.run_cli("export", "--root", self.root, "--transcript", NORMAL, "--out", "d.md")
        self.assertEqual(code, 0, out)
        with open(os.path.join(self.root, "d.md"), encoding="utf-8") as handle:
            text = handle.read()
        self.assertIn("**Нет цитат** — узел нельзя проверить", text.split("### o1")[1])
        self.assertNotIn("не найдена", text)
        self.assertNotIn("Не проверено", text)

    def test_export_shows_both_sides_of_every_relation(self):
        store.save(self.root, candidate(
            decision("t1", "Ещё вариант: pass@5", kind="tacit", question="Остаться на 3.9?"),
            decision("d1", "давай тогда pass@1", question="Чем мерить?",
                     relates=[{"to": "t1", "rel": "rests_on"}]),
            decision("d4", "давай тогда pass@1", question="Порог 72 часа?"),
            decision("d5", "нужно 500 примеров вместо 100", question="Разворот?",
                     relates=[{"to": "d4", "rel": "moots"}]),
            decision("o1", "", kind="open", status="proposed", question="Хвост?", decision="",
                     cites=[], relates=[{"to": "d1", "rel": "orphaned_by"}]),
            decision("o2", "", kind="open", status="proposed", question="Кто платит?", decision="",
                     cites=[])))
        code, out, _ = self.run_cli("export", "--root", self.root, "--transcript", NORMAL, "--out", "d.md")
        self.assertEqual(code, 0, out)
        with open(os.path.join(self.root, "d.md"), encoding="utf-8") as handle:
            text = handle.read()
        section = lambda i: text.split("### %s" % i)[1].split("###")[0]
        self.assertIn("- на этом держится d1 (Чем мерить?)", section("t1"))
        self.assertIn("- оставило висеть o1 (Хвост?)", section("d1"))
        self.assertIn("**Неактуально** — d5 (Разворот?) сделало это неактуальным", section("d4"))
        self.assertIn("**Связи:** ни с чем не связано", section("o2"))
        self.assertNotIn("ни с чем не связано", section("d4") + section("t1") + section("d1"))

    def test_invalid_map_is_not_exported(self):
        store.save(self.root, candidate(decision("d1", "давай тогда pass@1", kind="nope")))
        code, _, err = self.run_cli("export", "--root", self.root, "--transcript", NORMAL,
                                    "--out", "d.md")
        self.assertEqual(code, 1)
        self.assertIn("узел d1, поле kind", err)
        self.assertFalse(os.path.exists(os.path.join(self.root, "d.md")))


class ParserTest(CliTestCase):
    def test_no_command_prints_help(self):
        code, out, _ = self.run_cli()
        self.assertEqual(code, 2)
        self.assertIn("view", out)


class SessionJsonInCliTest(CliTestCase):
    def write_candidate(self, *nodes):
        os.makedirs(os.path.join(self.root, ".aang"), exist_ok=True)
        with open(store.candidate_path(self.root), "w", encoding="utf-8") as h:
            json.dump(candidate(*nodes), h)

    def test_merge_takes_the_transcript_from_session_json_and_says_so(self):
        from aang import session
        session.write(self.root, {"harness": "codex", "transcript_path": NORMAL})
        self.write_candidate(decision("d1", "давай тогда pass@1"))
        code, out, err = self.run_cli("merge", "--root", self.root,
                                      "--transcript-root", os.path.join(self.root, "nowhere"))
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

    def test_merge_survives_a_gitignore_that_is_not_utf8(self):
        with open(os.path.join(self.root, ".gitignore"), "wb") as h:
            h.write(b"# caf\xe9\n.aang/candidate.json\n")
        self.write_candidate(decision("d1", "давай тогда pass@1"))
        code, out, err = self.run_cli("merge", "--root", self.root, "--transcript", NORMAL)
        self.assertEqual(0, code, err)
        hints = [line for line in out.splitlines() if line.startswith("Совет:")]
        self.assertEqual(1, len(hints), out)
        self.assertIn(".aang/session.json", hints[0])
        self.assertIn(".aang/outbox.jsonl", hints[0])
        self.assertNotIn("candidate.json", hints[0])

    def test_check_uses_session_json_too(self):
        from aang import session
        self.write_candidate(decision("d1", "давай тогда pass@1"))
        self.run_cli("merge", "--root", self.root, "--transcript", NORMAL)
        session.write(self.root, {"harness": "claude", "transcript_path": NORMAL})
        code, out, _ = self.run_cli("check", "--root", self.root,
                                    "--transcript-root", os.path.join(self.root, "nowhere"))
        self.assertEqual(0, code, out)


class ViewReuseTest(CliTestCase):
    def test_second_view_on_the_same_root_prints_the_running_url(self):
        import threading
        from aang import server
        store.save(self.root, candidate())
        srv = server.make_server(self.root, 0,
                                 server.TranscriptSource(path=NORMAL, roots=[], root=self.root))
        port = srv.server_address[1]
        thread = threading.Thread(target=srv.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
        thread.start()
        self.addCleanup(srv.server_close)
        self.addCleanup(srv.shutdown)
        code, out, err = self.run_cli("view", "--root", self.root, "--port", str(port))
        self.assertEqual(0, code, err)
        self.assertIn("уже запущен", out)
        self.assertIn("http://127.0.0.1:%d/" % port, out)

    def test_port_held_by_someone_else_is_still_an_error(self):
        import socket
        other = tempfile.mkdtemp(prefix="aang-other-")
        self.addCleanup(shutil.rmtree, other, True)
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        sock.listen(1)
        self.addCleanup(sock.close)
        code, out, err = self.run_cli("view", "--root", self.root,
                                      "--port", str(sock.getsockname()[1]))
        self.assertEqual(1, code)
        self.assertIn("порт", err.lower())


if __name__ == "__main__":
    unittest.main()
