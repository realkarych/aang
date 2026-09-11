import io
import json
import os
import re
import shutil
import tempfile
import time
import unittest

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
        store.save(self.root, candidate(decision("d1", "давай pass@1"),
                                        decision("t1", "нужно 500 примеров вместо 100", kind="tacit")))
        code, out, err = self.run_cli("check", "--root", self.root, "--transcript", NORMAL)
        self.assertEqual(code, 0, out + err)
        self.assertIn("9 ходов", out)
        self.assertIn("ход 4/user", out)
        self.assertIn("✓ каждая цитата найдена", out)

    def test_bad_citation_exits_1_and_names_node(self):
        store.save(self.root, candidate(decision("d1", "давай pass@1"),
                                        decision("d2", "фраза, которой в сессии не было")))
        code, out, err = self.run_cli("check", "--root", self.root, "--transcript", NORMAL)
        self.assertEqual(code, 1)
        self.assertIn("✗ d2", out)
        self.assertIn("✓ d1", out)
        self.assertIn("не подтверждено: 1", out)

    def test_wrong_turn_number_exits_1(self):
        store.save(self.root, candidate(decision("d1", "давай pass@1", cites=[{"turn": 2, "quote": "давай pass@1"}])))
        code, out, _ = self.run_cli("check", "--root", self.root, "--transcript", NORMAL)
        self.assertEqual(code, 1)
        self.assertIn("не найдена в ходе 2", out)

    def test_invalid_map_exits_1_with_errors(self):
        store.save(self.root, candidate(decision("d1", "давай pass@1", status="done")))
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
        store.save(self.root, candidate(decision("d1", "давай pass@1")))
        code, out, _ = self.run_cli("check", "--root", self.root, "--transcript", MISSING)
        self.assertEqual(code, 1)
        self.assertIn("транскрипт сессии не найден", out)
        self.assertIn("✗ d1", out)

    def test_open_node_without_cites_is_reported_not_fatal(self):
        store.save(self.root, candidate(
            decision("d1", "давай pass@1"),
            {"id": "o1", "kind": "open", "status": "proposed", "question": "Кто платит?", "why": "следствие"}))
        code, out, _ = self.run_cli("check", "--root", self.root, "--transcript", NORMAL)
        self.assertEqual(code, 0, out)
        self.assertIn("нет цитат", out)


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
        self.assertTrue(os.path.exists(path))  # a refused candidate is left for inspection

    def test_invalid_candidate_exits_1_with_named_errors(self):
        store.save(self.root, candidate(decision("d1", "давай pass@1")))
        self.write_candidate(candidate(decision("d1", "давай pass@1", kind="wat"),
                                       decision("d2", "")))
        code, _, err = self.run_cli("merge", "--root", self.root, "--transcript", NORMAL)
        self.assertEqual(code, 1)
        self.assertIn("невалиден", err)
        self.assertIn("узел d1, поле kind", err)
        self.assertIn("узел d2, поле cites[0].quote", err)
        self.assertEqual([n["id"] for n in store.load(self.root)["nodes"]], ["d1"])

    def test_merge_fills_turns_records_session_and_consumes_candidate(self):
        cand_path = self.write_candidate(candidate(
            decision("d1", "давай pass@1"),
            decision("t1", "нужно 500 примеров вместо 100", kind="tacit"),
            decision("d2", "выдуманная цитата, которой не было", cites=[{"turn": 7, "quote": "выдуманная цитата, которой не было"}])))
        code, out, err = self.run_cli("merge", "--root", self.root, "--transcript", NORMAL)
        self.assertEqual(code, 0, out + err)
        saved = store.load(self.root)
        by_id = dict((n["id"], n) for n in saved["nodes"])
        self.assertEqual(by_id["d1"]["cites"][0]["turn"], 4)
        self.assertEqual(by_id["d1"]["cites"][0]["role"], "user")
        self.assertEqual(by_id["t1"]["cites"][0]["turn"], 5)
        # an unresolvable citation is saved with turn null, not dropped
        self.assertIn("d2", by_id)
        self.assertIsNone(by_id["d2"]["cites"][0]["turn"])
        self.assertEqual(saved["session_id"], "normal")  # from the transcript file name
        self.assertIn("не найдено: 1", out)
        self.assertIn("turn: null", out)
        self.assertFalse(os.path.exists(cand_path))
        # and check now says exactly which one is unverified
        code, out, _ = self.run_cli("check", "--root", self.root, "--transcript", NORMAL)
        self.assertEqual(code, 1)
        self.assertIn("✗ d2", out)

    def test_merge_stamps_generated_at_with_current_utc_time(self):
        cand = candidate(decision("d1", "давай pass@1"))
        cand["generated_at"] = "1999-01-01T00:00:00Z"  # the model's guess is not trusted
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
        cand = candidate(decision("d1", "давай pass@1"))
        cand["generated_at"] = ""
        self.write_candidate(cand)
        self.assertEqual(self.run_cli("merge", "--root", self.root, "--transcript", NORMAL)[0], 0)
        self.assertNotEqual(store.load(self.root)["generated_at"], "")

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
        # first merge names session A explicitly; the map records it
        self.write_candidate(candidate(decision("d1", "давай pass@1")))
        code, out, err = self.run_cli("merge", "--root", self.root, "--transcript-root", roots,
                                      "--session", "aaaa1111-0000-0000-0000-000000000001")
        self.assertEqual(code, 0, out + err)
        self.assertEqual(store.load(self.root)["session_id"], "aaaa1111-0000-0000-0000-000000000001")
        # second merge: candidate has no session id, and another project's session B is newer
        self.write_candidate(candidate(decision("d1", "давай pass@1"),
                                       decision("d2", "нужно 500 примеров вместо 100")))
        code, out, err = self.run_cli("merge", "--root", self.root, "--transcript-root", roots)
        self.assertEqual(code, 0, out + err)
        saved = store.load(self.root)
        self.assertEqual(saved["session_id"], "aaaa1111-0000-0000-0000-000000000001")
        by_id = dict((n["id"], n) for n in saved["nodes"])
        self.assertEqual(by_id["d1"]["cites"][0]["turn"], 4)   # resolved against A, not B
        self.assertEqual(by_id["d2"]["cites"][0]["turn"], 5)
        self.assertIn("не найдено: 0", out)
        self.assertNotIn("bbbb2222", out + err)
        code, out, _ = self.run_cli("check", "--root", self.root, "--transcript-root", roots)
        self.assertEqual(code, 0, out)

    def test_candidate_session_id_still_wins_over_the_maps(self):
        roots = self._two_projects()
        old = candidate(decision("d1", "давай pass@1"))
        old["session_id"] = "aaaa1111-0000-0000-0000-000000000001"
        store.save(self.root, old)
        cand = candidate(decision("d1", "давай pass@1"))
        cand["session_id"] = "bbbb2222-0000-0000-0000-000000000002"
        self.write_candidate(cand)
        code, out, _ = self.run_cli("merge", "--root", self.root, "--transcript-root", roots)
        self.assertEqual(code, 0, out)
        saved = store.load(self.root)
        self.assertEqual(saved["session_id"], "bbbb2222-0000-0000-0000-000000000002")
        self.assertIsNone(saved["nodes"][0]["cites"][0]["turn"])  # B has no such words

    def test_newest_session_is_taken_and_stamped_only_when_nobody_names_one(self):
        roots = self._two_projects()
        self.write_candidate(candidate(decision("d1", "давай pass@1")))
        code, out, _ = self.run_cli("merge", "--root", self.root, "--transcript-root", roots)
        self.assertEqual(code, 0, out)
        self.assertEqual(store.load(self.root)["session_id"], "bbbb2222-0000-0000-0000-000000000002")

    def test_keep_flag_leaves_candidate(self):
        cand_path = self.write_candidate(candidate(decision("d1", "давай pass@1")))
        code, _, _ = self.run_cli("merge", "--root", self.root, "--transcript", NORMAL, "--keep")
        self.assertEqual(code, 0)
        self.assertTrue(os.path.exists(cand_path))

    def test_missing_transcript_merges_with_null_turns(self):
        self.write_candidate(candidate(decision("d1", "давай pass@1")))
        code, out, _ = self.run_cli("merge", "--root", self.root, "--transcript", MISSING)
        self.assertEqual(code, 0)
        self.assertIn("ходы не проставлены", out)
        self.assertIsNone(store.load(self.root)["nodes"][0]["cites"][0]["turn"])

    def test_second_regeneration_preserves_hand_edit(self):
        # 1. generate
        self.write_candidate(candidate(decision("d1", "давай pass@1", why="модель v1"),
                                       decision("d2", "нужно 500 примеров вместо 100")))
        self.assertEqual(self.run_cli("merge", "--root", self.root, "--transcript", NORMAL)[0], 0)
        # 2. hand-edit the file
        m = store.load(self.root)
        m["nodes"][0]["why"] = "человек исправил"
        m["nodes"][0]["hand_edited"] = True
        store.save(self.root, m)
        # 3. regenerate: model rewrites d1, drops d2, adds d3
        self.write_candidate(candidate(decision("d1", "давай pass@1", why="модель v2"),
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
        store.save(self.root, candidate(decision("d1", "давай pass@1", hand_edited=True,
                                                 status="superseded", superseded_by="ghost")))
        self.write_candidate(candidate(decision("d2", "давай pass@1")))
        code, _, err = self.run_cli("merge", "--root", self.root, "--transcript", NORMAL)
        self.assertEqual(code, 1)
        self.assertIn("не сохранена", err)
        self.assertIn("ghost", err)
        self.assertEqual([n["id"] for n in store.load(self.root)["nodes"]], ["d1"])

    def test_explicit_candidate_path(self):
        path = self.write_candidate(candidate(decision("d1", "давай pass@1")),
                                    name=os.path.join(self.root, "elsewhere.json"))
        code, _, _ = self.run_cli("merge", "--root", self.root, "--transcript", NORMAL, "--candidate", path)
        self.assertEqual(code, 0)
        self.assertEqual(store.load(self.root)["nodes"][0]["id"], "d1")


class ExportTest(CliTestCase):
    def test_writes_markdown_under_root(self):
        store.save(self.root, candidate(decision("d1", "давай pass@1"),
                                        decision("d2", "чего не было", question="Второй?")))
        code, out, _ = self.run_cli("export", "--root", self.root, "--transcript", NORMAL,
                                    "--out", os.path.join("docs", "decisions.md"))
        self.assertEqual(code, 0, out)
        path = os.path.join(self.root, "docs", "decisions.md")
        self.assertTrue(os.path.exists(path))
        with open(path, encoding="utf-8") as handle:
            text = handle.read()
        self.assertIn("### d1", text)
        self.assertLess(text.index("### d2"), text.index("### d1"))  # newest first
        self.assertIn("Не проверено", text.split("### d2")[1].split("###")[0])
        self.assertIn("не проверено: 1", out)

    def test_unreachable_transcript_is_stated_not_reported_as_not_found(self):
        store.save(self.root, candidate(decision("d1", "давай pass@1"),
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
        store.save(self.root, candidate(decision("d1", "давай pass@1"),
                                        decision("o1", "", kind="open", status="proposed", decision="", cites=[])))
        code, out, _ = self.run_cli("export", "--root", self.root, "--transcript", NORMAL, "--out", "d.md")
        self.assertEqual(code, 0, out)
        with open(os.path.join(self.root, "d.md"), encoding="utf-8") as handle:
            text = handle.read()
        self.assertIn("**Нет цитат** — узел нельзя проверить", text.split("### o1")[1])
        self.assertNotIn("не найдена", text)
        self.assertNotIn("Не проверено", text)

    def test_invalid_map_is_not_exported(self):
        store.save(self.root, candidate(decision("d1", "давай pass@1", kind="nope")))
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


if __name__ == "__main__":
    unittest.main()
