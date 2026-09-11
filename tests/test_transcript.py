import os
import shutil
import tempfile
import unittest

from aang import transcript

FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")


def fixture(name):
    return os.path.join(FIXTURES, name)


class IndexTest(unittest.TestCase):
    def test_normal_session(self):
        turns = transcript.index(fixture("normal.jsonl"))
        self.assertEqual([t["turn"] for t in turns], list(range(1, 10)))
        self.assertEqual([t["role"] for t in turns],
                         ["user", "user", "assistant", "user", "assistant",
                          "user", "user", "assistant", "assistant"])
        self.assertEqual([t["uuid"] for t in turns],
                         ["u-cmd", "u-1", "a-1-text", "u-2", "a-2-text",
                          "u-3a", "u-3b", "a-3-text", "a-4-text"])
        self.assertTrue(turns[1]["text"].startswith("Чем мерить"))
        self.assertEqual(turns[1]["ts"], "2026-09-11T10:00:01.000Z")
        # user list content: only text blocks, image ignored
        self.assertEqual(turns[3]["text"], "давай pass@1")

    def test_assistant_message_split_across_records_is_one_turn(self):
        turns = transcript.index(fixture("normal.jsonl"))
        # msg_a1: thinking / text / tool_use -> one turn carrying only the text
        self.assertIn("pass@1", turns[2]["text"])
        self.assertNotIn("tool_use", turns[2]["text"])
        # msg_a2: tool_use first, text second -> uuid/ts come from the text record
        self.assertEqual(turns[4]["uuid"], "a-2-text")
        self.assertEqual(turns[4]["ts"], "2026-09-11T10:00:10.000Z")
        # msg_a3: two text records -> joined
        self.assertEqual(turns[7]["text"], "Ок, ночной прогон. Записал.\nSecond text block of the same message.")

    def test_skips_meta_sidechain_and_control_records(self):
        texts = "\n".join(t["text"] for t in transcript.index(fixture("normal.jsonl")))
        self.assertNotIn("Caveat: injected", texts)
        self.assertNotIn("Sidechain", texts)
        self.assertNotIn("task-notification", texts)
        self.assertNotIn("file.txt", texts)  # tool_result content

    def test_numbering_is_stable(self):
        a = transcript.index(fixture("normal.jsonl"))
        b = transcript.index(fixture("normal.jsonl"))
        self.assertEqual(a, b)

    def test_tool_only_assistant_records_produce_no_turns(self):
        turns = transcript.index(fixture("tool_only.jsonl"))
        self.assertEqual(len(turns), 1)
        self.assertEqual(turns[0]["role"], "user")
        self.assertEqual(turns[0]["text"], "Запусти тесты.")

    def test_truncated_and_malformed_lines_are_skipped(self):
        turns = transcript.index(fixture("truncated.jsonl"))
        self.assertEqual([t["text"] for t in turns],
                         ["Первая реплика пользователя.", "Ответ ассистента целиком.", "Вторая реплика пользователя."])

    def test_empty_file(self):
        self.assertEqual(transcript.index(fixture("empty.jsonl")), [])

    def test_missing_file_and_none(self):
        self.assertEqual(transcript.index(fixture("no-such-dir/none.jsonl")), [])
        self.assertEqual(transcript.index(None), [])
        self.assertEqual(transcript.index(""), [])

    def test_text_cap(self):
        turns = transcript.index(fixture("normal.jsonl"), text_cap=10)
        self.assertTrue(all(len(t["text"]) <= 10 for t in turns))
        self.assertEqual(len(turns), 9)


class FindSessionTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="aang-fixtures-")
        self.root = os.path.join(self.tmp, "projects")
        shutil.copytree(os.path.join(FIXTURES, "projects"), self.root)
        self.a = os.path.join(self.root, "-Users-x-proj-a", "aaaa1111-0000-0000-0000-000000000001.jsonl")
        self.b = os.path.join(self.root, "-Users-x-proj-b", "bbbb2222-0000-0000-0000-000000000002.jsonl")
        self.b3 = os.path.join(self.root, "-Users-x-proj-b", "bbbb3333-0000-0000-0000-000000000003.jsonl")
        self.sub = os.path.join(self.root, "-Users-x-proj-a", "aaaa1111-0000-0000-0000-000000000001",
                                "subagents", "agent-zzz.jsonl")
        self.mem = os.path.join(self.root, "-Users-x-proj-b", "memory", "agent-mem.jsonl")
        base = 1_700_000_000
        os.utime(self.a, (base, base + 10))
        os.utime(self.b, (base, base + 20))
        os.utime(self.b3, (base, base + 5))
        os.utime(self.sub, (base, base + 999))
        os.utime(self.mem, (base, base + 999))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_newest_ignores_subagent_and_memory_files(self):
        self.assertEqual(transcript.find_session(roots=[self.root]), self.b)
        os.utime(self.a, (0, 2_000_000_000))
        self.assertEqual(transcript.find_session(roots=[self.root]), self.a)

    def test_by_id_and_prefix(self):
        self.assertEqual(transcript.find_session("aaaa1111-0000-0000-0000-000000000001", roots=[self.root]), self.a)
        self.assertEqual(transcript.find_session("bbbb2222", roots=[self.root]), self.b)
        self.assertIsNone(transcript.find_session("bbbb", roots=[self.root]))  # ambiguous prefix
        self.assertIsNone(transcript.find_session("cccc", roots=[self.root]))
        self.assertIsNone(transcript.find_session("agent-zzz", roots=[self.root]))

    def test_missing_root_is_normal(self):
        self.assertIsNone(transcript.find_session(roots=[os.path.join(self.tmp, "absent")]))
        self.assertIsNone(transcript.find_session(roots=[]))
        self.assertIsNone(transcript.find_session("x", roots=[]))

    def test_multiple_roots(self):
        empty = os.path.join(self.tmp, "empty-root")
        os.makedirs(empty)
        self.assertEqual(transcript.find_session(roots=[empty, self.root]), self.b)


class ResolveTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.turns = transcript.index(fixture("normal.jsonl"))

    def one(self, cite):
        results = transcript.resolve([cite], self.turns)
        self.assertEqual(len(results), 1)
        r = results[0]
        for key in ("turn", "role", "ok", "excerpt", "reason", "quote", "matches"):
            self.assertIn(key, r)
        return r

    def test_quote_only_finds_its_turn(self):
        r = self.one({"quote": "k>1 маскирует нестабильность промпта"})
        self.assertTrue(r["ok"])
        self.assertEqual(r["turn"], 3)
        self.assertEqual(r["role"], "assistant")
        self.assertEqual(r["matches"], [3])
        self.assertEqual(r["reason"], "")
        self.assertIn("маскирует нестабильность", r["excerpt"])

    def test_case_whitespace_punctuation_markdown_are_forgiven(self):
        for quote in (
            "ПРЕДЛАГАЮ   pass@1 на отложенном наборе",
            "Предлагаю pass@1, на отложенном наборе.",
            "«Предлагаю pass@1 на отложенном наборе»",
            "предлагаю pass@1 на отложенном наборе - k>1 маскирует",   # em dash vs hyphen
            "Ещё вариант pass@5",                                        # colon dropped
            "Еще вариант: pass@5",                                       # ё/е
            "Предлагаю pass@1 на отложенном наборе",                     # no ** markdown
            "k>1 маскирует нестабильность промпта",                      # no backticks
        ):
            r = self.one({"quote": quote})
            self.assertTrue(r["ok"], "%r -> %s" % (quote, r["reason"]))
            self.assertEqual(r["turn"], 3, quote)

    def test_substance_is_not_forgiven(self):
        for quote in (
            "Предлагаю pass@5 на отложенном наборе",     # number changed
            "k<1 маскирует нестабильность промпта",       # operator changed
            "Предлагаю pass@1 на случайном наборе",       # word changed
            "Предлагаю на отложенном наборе pass@1",      # order changed
            "Предлагаю pass@1 отложенном наборе",         # word dropped
            "we decided to switch the storage to sqlite",
        ):
            r = self.one({"quote": quote})
            self.assertFalse(r["ok"], quote)
            self.assertIsNone(r["turn"])
            self.assertEqual(r["matches"], [])
            self.assertIn("не найдена", r["reason"])

    def test_edges_may_be_partial_words(self):
        r = self.one({"quote": "лагаю pass@1 на отложенном набо"})
        self.assertTrue(r["ok"], r["reason"])
        self.assertEqual(r["turn"], 3)

    def test_ellipsis_fragments_in_order(self):
        r = self.one({"quote": "Предлагаю pass@1 на отложенном … маскирует нестабильность промпта"})
        self.assertTrue(r["ok"], r["reason"])
        self.assertEqual(r["turn"], 3)
        r = self.one({"quote": "Предлагаю pass@1 на отложенном ... маскирует нестабильность промпта"})
        self.assertTrue(r["ok"], r["reason"])
        # fragments in the wrong order do not verify
        r = self.one({"quote": "маскирует нестабильность промпта … Предлагаю pass@1 на отложенном"})
        self.assertFalse(r["ok"])
        # fragments from different turns do not verify
        r = self.one({"quote": "Предлагаю pass@1 на отложенном … прогон дорожает втрое"})
        self.assertFalse(r["ok"])

    def test_short_quotes_and_short_fragments_are_never_ok(self):
        for quote in ("pass@1", "давай", "Предлагаю pass@1 на отложенном … промпта", "…", "...", "— —", ""):
            r = self.one({"quote": quote})
            self.assertFalse(r["ok"], quote)
            self.assertIsNone(r["turn"])
        r = self.one({"quote": "pass@1"})
        self.assertIn("короткая", r["reason"])
        r = self.one({"quote": "…"})
        self.assertIn("нет цитаты", r["reason"])

    def test_missing_quote_is_never_ok_even_with_a_valid_turn(self):
        r = self.one({"turn": 3})
        self.assertFalse(r["ok"])
        self.assertEqual(r["turn"], 3)
        self.assertIn("нет цитаты", r["reason"])
        self.assertTrue(r["excerpt"].startswith("Предлагаю"))
        r = self.one({"turn": 3, "quote": None})
        self.assertFalse(r["ok"])

    def test_multiple_matches_report_all_and_pick_last(self):
        r = self.one({"quote": "Мы решили, что набор будет из пятисот примеров"})
        self.assertTrue(r["ok"])
        self.assertEqual(r["matches"], [6, 7])
        self.assertEqual(r["turn"], 7)
        self.assertIn("6, 7", r["reason"])
        self.assertIn("последний", r["reason"])

    def test_given_turn_is_verified_not_searched(self):
        r = self.one({"turn": 6, "quote": "Мы решили, что набор будет из пятисот примеров"})
        self.assertTrue(r["ok"])
        self.assertEqual(r["turn"], 6)
        self.assertEqual(r["reason"], "")

    def test_given_turn_mismatch_is_reported_not_repaired(self):
        r = self.one({"turn": 2, "quote": "k>1 маскирует нестабильность промпта"})
        self.assertFalse(r["ok"])
        self.assertEqual(r["turn"], 2)
        self.assertEqual(r["role"], "user")
        self.assertEqual(r["matches"], [3])
        self.assertIn("не найдена в ходе 2", r["reason"])
        self.assertIn("ходе 3", r["reason"])
        # fallback excerpt: the cited turn's beginning
        self.assertTrue(r["excerpt"].startswith("Чем мерить"))

    def test_nonexistent_turn(self):
        for turn in (0, 99, -1):
            r = self.one({"turn": turn, "quote": "k>1 маскирует нестабильность промпта"})
            self.assertFalse(r["ok"], turn)
            self.assertEqual(r["turn"], turn)
            self.assertIn("нет в транскрипте", r["reason"])
            self.assertEqual(r["excerpt"], "")

    def test_non_integer_turn_is_treated_as_absent(self):
        r = self.one({"turn": "3", "quote": "k>1 маскирует нестабильность промпта"})
        self.assertTrue(r["ok"])
        self.assertEqual(r["turn"], 3)
        r = self.one({"turn": True, "quote": "k>1 маскирует нестабильность промпта"})
        self.assertEqual(r["turn"], 3)

    def test_role_mismatch_is_not_ok(self):
        r = self.one({"role": "user", "quote": "k>1 маскирует нестабильность промпта"})
        self.assertFalse(r["ok"])
        self.assertEqual(r["turn"], 3)
        self.assertEqual(r["role"], "assistant")
        self.assertIn("реплика assistant", r["reason"])
        r = self.one({"role": "assistant", "quote": "k>1 маскирует нестабильность промпта"})
        self.assertTrue(r["ok"])

    def test_excerpt_window(self):
        long_text = ("слово " * 100) + "ЯКОРЬ ВОТ ЗДЕСЬ цитата " + ("слово " * 100)
        turns = [{"turn": 1, "role": "user", "ts": None, "uuid": "x", "text": long_text}]
        r = transcript.resolve([{"quote": "якорь вот здесь цитата"}], turns)[0]
        self.assertTrue(r["ok"])
        self.assertIn("ЯКОРЬ ВОТ ЗДЕСЬ цитата", r["excerpt"])
        self.assertTrue(r["excerpt"].startswith("…") and r["excerpt"].endswith("…"))
        self.assertLessEqual(len(r["excerpt"]), 2 * transcript.EXCERPT_CONTEXT + len("ЯКОРЬ ВОТ ЗДЕСЬ цитата") + 2)

    def test_multiline_and_second_block(self):
        r = self.one({"quote": "нужно 500 примеров вместо 100, прогон дорожает втрое"})
        self.assertTrue(r["ok"])
        self.assertEqual(r["turn"], 5)
        r = self.one({"quote": "Second text block of the same message"})
        self.assertEqual(r["turn"], 8)

    def test_bad_inputs_do_not_raise(self):
        self.assertEqual(transcript.resolve(None, self.turns), [])
        self.assertEqual(transcript.resolve("x", self.turns), [])
        r = transcript.resolve(["not a dict", 5], self.turns)
        self.assertEqual([x["ok"] for x in r], [False, False])
        r = transcript.resolve([{"quote": "k>1 маскирует нестабильность промпта"}], [])
        self.assertFalse(r[0]["ok"])
        r = transcript.resolve([{"quote": "k>1 маскирует нестабильность промпта"}], None)
        self.assertFalse(r[0]["ok"])
        r = transcript.resolve([{"quote": "k>1 маскирует нестабильность промпта"}], [{"turn": 1}, "junk", {"text": 5}])
        self.assertFalse(r[0]["ok"])

    def test_results_keep_input_order(self):
        cites = [{"quote": "давай pass@1 и всё"}, {"quote": "k>1 маскирует нестабильность промпта"}]
        r = transcript.resolve(cites, self.turns)
        self.assertEqual([x["quote"] for x in r], [c["quote"] for c in cites])
        self.assertEqual([x["ok"] for x in r], [False, True])


if __name__ == "__main__":
    unittest.main()
