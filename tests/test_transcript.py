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
                         ["u-0", "u-1", "a-1-text", "u-2", "a-2-text",
                          "u-3a", "u-3b", "a-3-text", "a-4-text"])
        self.assertTrue(turns[1]["text"].startswith("Чем мерить"))
        self.assertEqual(turns[1]["ts"], "2026-09-11T10:00:01.000Z")
        # user list content: only text blocks, image ignored
        self.assertEqual(turns[3]["text"], "давай тогда pass@1")

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

    def test_numbering_is_stable_as_a_live_file_grows(self):
        # A live session keeps appending: tool records and control records must not
        # renumber earlier turns, and only a new text-bearing message adds a turn.
        before = transcript.index(fixture("normal.jsonl"))
        tmp = tempfile.mkdtemp(prefix="aang-live-")
        try:
            path = os.path.join(tmp, "live.jsonl")
            shutil.copyfile(fixture("normal.jsonl"), path)
            with open(path, "a", encoding="utf-8") as handle:
                handle.write('{"type": "assistant", "isSidechain": false, "uuid": "a-9-tool", "timestamp": "t", '
                             '"message": {"id": "msg_a9", "role": "assistant", "content": '
                             '[{"type": "tool_use", "id": "toolu_9", "name": "Bash", "input": {}}]}}\n')
                handle.write('{"type": "user", "isSidechain": false, "uuid": "u-tr-9", "timestamp": "t", '
                             '"message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "toolu_9", "content": "x"}]}}\n')
                handle.write('{"type": "system", "subtype": "turn_duration", "durationMs": 1}\n')
            self.assertEqual(transcript.index(path), before)
            with open(path, "a", encoding="utf-8") as handle:
                handle.write('{"type": "assistant", "isSidechain": false, "uuid": "a-9-text", "timestamp": "t", '
                             '"message": {"id": "msg_a9", "role": "assistant", "content": '
                             '[{"type": "text", "text": "Новый ход."}]}}\n')
            after = transcript.index(path)
            self.assertEqual(after[:-1], before)
            self.assertEqual(after[-1]["turn"], len(before) + 1)
            self.assertEqual(after[-1]["text"], "Новый ход.")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_tool_only_assistant_records_produce_no_turns(self):
        turns = transcript.index(fixture("tool_only.jsonl"))
        self.assertEqual(len(turns), 1)
        self.assertEqual(turns[0]["role"], "user")
        self.assertEqual(turns[0]["text"], "Запусти тесты.")

    def test_injected_user_records_are_not_turns(self):
        # Slash-command echoes, relayed subagent reports, task notifications, system
        # reminders and compaction summaries arrive as `user` records nobody typed.
        # None of it may become a turn — a quote from it would verify as the user's words.
        turns = transcript.index(fixture("injected.jsonl"))
        self.assertEqual([t["uuid"] for t in turns], ["u-real-1", "a-1", "u-mixed", "a-2"])
        self.assertEqual([t["role"] for t in turns], ["user", "assistant", "user", "assistant"])
        texts = "\n".join(t["text"] for t in turns)
        for injected in ("command-name", "Set model to", "DONE_WITH_CONCERNS", "outranks everything",
                         "Another Claude session", "task-notification", "finished the whole review",
                         "system-reminder", "opened the file", "being continued"):
            self.assertNotIn(injected, texts, injected)
        # a real message that shares a record with a system reminder keeps its own text
        self.assertEqual(turns[2]["text"], "Поднимай порог до трёх суток, выходные должны переживать.")

    def test_injected_text_never_resolves(self):
        turns = transcript.index(fixture("injected.jsonl"))
        for quote in ("Task 1 status: DONE_WITH_CONCERNS. Commit 71e0779 on main",
                      "Stale `error` outranks everything, forever",
                      "Set model to `Fable 5.1` and saved as your default",
                      "Agent finished the whole review",
                      "the user said поднимай порог до трёх суток"):
            r = transcript.resolve([{"quote": quote}], turns)[0]
            self.assertFalse(r["ok"], quote)
            self.assertIsNone(r["turn"], quote)
        r = transcript.resolve([{"quote": "Поднимай порог до трёх суток"}], turns)[0]
        self.assertTrue(r["ok"])
        self.assertEqual(r["role"], "user")

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

    def test_edge_words_must_be_whole(self):
        # A partial word at the edge can flip meaning: never verify it.
        turns = [
            {"turn": 1, "role": "user", "ts": None, "uuid": "x",
             "text": "It is impossible to ship this by Friday. Это бесполезно для нас сейчас."},
        ]
        for quote in ("possible to ship this by Friday",
                      "лагаю pass@1 на отложенном набо",
                      "полезно для нас сейчас",
                      "It is impossible to ship this by Frida"):
            r = transcript.resolve([{"quote": quote}], turns + self.turns)[0]
            self.assertFalse(r["ok"], quote)
            self.assertEqual(r["matches"], [], quote)
        r = transcript.resolve([{"quote": "impossible to ship this by Friday"}], turns)[0]
        self.assertTrue(r["ok"])
        r = transcript.resolve([{"quote": "бесполезно для нас сейчас"}], turns)[0]
        self.assertTrue(r["ok"])

    def test_ellipsis_fragments_in_order_and_never_clean(self):
        r = self.one({"quote": "Предлагаю pass@1 на отложенном … k>1 маскирует нестабильность промпта"})
        self.assertTrue(r["ok"], r["reason"])
        self.assertEqual(r["turn"], 3)
        self.assertIn("пропусками", r["reason"])
        self.assertIn("пропущено 1 слово", r["reason"])  # "наборе" was skipped
        r = self.one({"quote": "Предлагаю pass@1 на отложенном ... k>1 маскирует нестабильность промпта"})
        self.assertTrue(r["ok"], r["reason"])
        self.assertTrue(r["reason"])
        # fragments in the wrong order do not verify
        r = self.one({"quote": "k>1 маскирует нестабильность промпта … Предлагаю pass@1 на отложенном"})
        self.assertFalse(r["ok"])
        # fragments from different turns do not verify
        r = self.one({"quote": "Предлагаю pass@1 на отложенном … нужно 500 примеров вместо 100"})
        self.assertFalse(r["ok"])
        # a one-word elision that drops a negation is ok but visibly stitched
        turns = [{"turn": 1, "role": "user", "ts": None, "uuid": "x",
                  "text": "тезис про параллельности как бы не раскрыт в этом документе вообще"}]
        r = transcript.resolve([{"quote": "тезис про параллельности как бы … раскрыт в этом документе вообще"}], turns)[0]
        self.assertTrue(r["ok"])
        self.assertIn("пропущено 1 слово", r["reason"])

    def test_parenthesised_dots_in_code_are_not_an_ellipsis(self):
        turns = [{"turn": 1, "role": "assistant", "ts": None, "uuid": "x",
                  "text": "Call accounting is one function `_call_clauses(...) -> (clauses, accounted)` "
                          "now, and nothing else changed."}]
        r = transcript.resolve([{"quote": "one function _call_clauses(...) -> (clauses, accounted)"}], turns)[0]
        self.assertTrue(r["ok"], r["reason"])
        self.assertEqual(r["reason"], "")
        # the editorial mark still elides
        r = transcript.resolve([{"quote": "Call accounting is one function [...] now, and nothing else changed"}], turns)[0]
        self.assertTrue(r["ok"], r["reason"])
        self.assertIn("пропусками", r["reason"])

    def test_ellipsis_gap_is_capped(self):
        head = "первый фрагмент из четырёх слов"
        tail = "последний фрагмент тоже четыре слова"
        def turn_with_gap(n):
            return [{"turn": 1, "role": "user", "ts": None, "uuid": "x",
                     "text": head + " " + ("слово " * n) + tail}]
        quote = head + " … " + tail
        r = transcript.resolve([{"quote": quote}], turn_with_gap(transcript.MAX_GAP_TOKENS))[0]
        self.assertTrue(r["ok"], r["reason"])
        self.assertIn("пропущено %d слов" % transcript.MAX_GAP_TOKENS, r["reason"])
        r = transcript.resolve([{"quote": quote}], turn_with_gap(transcript.MAX_GAP_TOKENS + 1))[0]
        self.assertFalse(r["ok"])
        self.assertIn("не найдена", r["reason"])

    def test_ellipsis_search_is_not_greedy(self):
        # The first fragment occurs twice; only the second occurrence is within reach of
        # the second fragment. A greedy first-occurrence search would miss it.
        text = ("наш общий план работы " + ("х " * (transcript.MAX_GAP_TOKENS + 5))
                + "наш общий план работы и конечный результат его")
        turns = [{"turn": 1, "role": "user", "ts": None, "uuid": "x", "text": text}]
        r = transcript.resolve([{"quote": "наш общий план работы … конечный результат его"}], turns)[0]
        self.assertFalse(r["ok"])  # fragment 2 is only 3 words: below the ellipsis minimum
        r = transcript.resolve([{"quote": "наш общий план работы … и конечный результат его"}], turns)[0]
        self.assertTrue(r["ok"], r["reason"])
        self.assertIn("пропущено 0 слов", r["reason"])

    def test_short_quotes_and_short_fragments_are_never_ok(self):
        for quote in ("pass@1", "давай", "implementation", "пользователь", "нестабильность промпта",
                      "да да да", "| | |", "| | | | |", "k>1 == <=",
                      "Предлагаю pass@1 на отложенном … нестабильность промпта",  # 3-word fragment
                      "…", "...", "— —", ""):
            r = self.one({"quote": quote})
            self.assertFalse(r["ok"], quote)
            self.assertIsNone(r["turn"], quote)
            self.assertEqual(r["matches"], [], quote)
        r = self.one({"quote": "implementation"})
        self.assertIn("короткая", r["reason"])
        r = self.one({"quote": "Предлагаю pass@1 на отложенном … нестабильность промпта"})
        self.assertIn("в каждом фрагменте", r["reason"])
        r = self.one({"quote": "…"})
        self.assertIn("нет цитаты", r["reason"])
        # the floor is exactly 3 words and 12 chars
        r = self.one({"quote": "давай тогда pass@1"})
        self.assertTrue(r["ok"], r["reason"])
        self.assertEqual(r["turn"], 4)

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
        cites = [{"quote": "давай тогда pass@1 и всё"}, {"quote": "k>1 маскирует нестабильность промпта"}]
        r = transcript.resolve(cites, self.turns)
        self.assertEqual([x["quote"] for x in r], [c["quote"] for c in cites])
        self.assertEqual([x["ok"] for x in r], [False, True])


CODEX = os.path.join(FIXTURES, "codex.jsonl")
CODEX_ROOT = os.path.join(FIXTURES, "codex-sessions")
CLAUDE_ROOT = os.path.join(FIXTURES, "projects")


class CodexIndexTest(unittest.TestCase):
    def test_turns_come_from_item_completed_only(self):
        turns = transcript.index(CODEX)
        self.assertEqual([("user", 1), ("assistant", 2)], [(t["role"], t["turn"]) for t in turns])
        self.assertIn("pass@1 на отложенном", turns[0]["text"])
        self.assertNotIn("environment_context", turns[0]["text"])
        self.assertEqual("2026-09-11T19:01:00.329Z", turns[0]["ts"])
        self.assertEqual("um-1", turns[0]["uuid"])

    def test_quotes_resolve_against_codex_turns(self):
        turns = transcript.index(CODEX)
        got = transcript.resolve([{"quote": "нужно 500 примеров вместо 100"}], turns)
        self.assertTrue(got[0]["ok"])
        self.assertEqual(2, got[0]["turn"])
        self.assertEqual("assistant", got[0]["role"])

    def test_harness_and_project(self):
        self.assertEqual("codex", transcript.harness_of(CODEX))
        self.assertEqual("/Users/x/proj-a", transcript.project_of(CODEX))
        claude = os.path.join(CLAUDE_ROOT, "-Users-x-proj-a", "aaaa1111-0000-0000-0000-000000000001.jsonl")
        self.assertEqual("claude", transcript.harness_of(claude))
        self.assertEqual("/Users/x/proj-a", transcript.project_of(claude))


class ProjectOfTest(unittest.TestCase):
    """A project path with a `-` in it is an ordinary case (this repo's own worktree is one),
    and the Claude folder name cannot encode it back: the transcript's `cwd` decides."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="aang-project-")
        self.folder = os.path.join(self.tmp, "projects", "-Users-x-live-companion")
        os.makedirs(self.folder)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def write(self, name, line):
        path = os.path.join(self.folder, name)
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(line + "\n")
        return path

    def test_recorded_cwd_wins_over_the_folder_name(self):
        path = self.write("s1.jsonl", '{"type": "user", "uuid": "u-1", "cwd": "/Users/x/live-companion", '
                                      '"message": {"role": "user", "content": "Привет."}}')
        self.assertEqual("/Users/x/live-companion", transcript.project_of(path))
        self.assertEqual(path, transcript.find_session(None, [os.path.join(self.tmp, "projects")],
                                                       cwd="/Users/x/live-companion"))

    def test_folder_name_is_the_lossy_fallback(self):
        path = self.write("s2.jsonl", '{"type": "summary", "summary": "нет cwd в записи"}')
        self.assertEqual(os.path.normpath("/Users/x/live/companion"), transcript.project_of(path))


class CrossHarnessLookupTest(unittest.TestCase):
    roots = [CLAUDE_ROOT, CODEX_ROOT]

    def test_codex_id_found_by_suffix(self):
        path = transcript.find_session("cccc2222-0000-0000-0000-000000000002", self.roots)
        self.assertTrue(path and path.endswith("-cccc2222-0000-0000-0000-000000000002.jsonl"), path)

    def test_claude_id_still_found(self):
        path = transcript.find_session("aaaa1111-0000-0000-0000-000000000001", self.roots)
        self.assertTrue(path and path.endswith("aaaa1111-0000-0000-0000-000000000001.jsonl"), path)

    def test_cwd_wins_over_recency(self):
        """Touch a proj-b transcript so it is newest; asking for proj-a must still return proj-a's."""
        target = os.path.join(CODEX_ROOT, "2026", "09", "11",
                              "rollout-2026-09-11T11-00-00-cccc2222-0000-0000-0000-000000000002.jsonl")
        os.utime(target, None)
        self.assertEqual(target, transcript.find_session(None, [CODEX_ROOT]))
        got = transcript.find_session(None, self.roots, cwd="/Users/x/proj-a")
        self.assertEqual("/Users/x/proj-a", transcript.project_of(got))

    def test_default_roots_include_both_trees(self):
        roots = transcript.default_roots()
        self.assertTrue(any(r.endswith(os.path.join(".claude", "projects")) for r in roots))
        self.assertTrue(any(r.endswith(os.path.join(".codex", "sessions")) for r in roots))


if __name__ == "__main__":
    unittest.main()
