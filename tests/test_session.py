import json
import os
import shutil
import tempfile
import unittest

from aang import session, store


class SessionFileTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="aang-sess-")
        self.addCleanup(shutil.rmtree, self.root, True)

    def test_now_iso_shape(self):
        self.assertRegex(session.now_iso(), r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")

    def test_find_root_walks_up_to_the_map(self):
        store.save(self.root, {"version": 1, "nodes": []})
        deep = os.path.join(self.root, "a", "b")
        os.makedirs(deep)
        self.assertEqual(self.root, session.find_root(deep))
        self.assertEqual(self.root, session.find_root(self.root))
        other = tempfile.mkdtemp(prefix="aang-nomap-")
        self.addCleanup(shutil.rmtree, other, True)
        self.assertIsNone(session.find_root(other))

    def test_write_read_update(self):
        self.assertIsNone(session.read(self.root))
        path = session.write(self.root, {"harness": "claude", "session_id": "s1"})
        self.assertEqual(os.path.join(self.root, ".aang", "session.json"), path)
        self.assertEqual({"harness": "claude", "session_id": "s1"}, session.read(self.root))
        got = session.update(self.root, last_nudge_turn=7)
        self.assertEqual({"harness": "claude", "session_id": "s1", "last_nudge_turn": 7}, got)
        self.assertEqual(got, session.read(self.root))
        self.assertEqual([], [n for n in os.listdir(os.path.join(self.root, ".aang")) if n.endswith(".tmp")])

    def test_corrupt_session_file_reads_as_none(self):
        os.makedirs(os.path.join(self.root, ".aang"))
        with open(os.path.join(self.root, ".aang", "session.json"), "w") as h:
            h.write("{not json")
        self.assertIsNone(session.read(self.root))
        self.assertEqual({"a": 1}, session.update(self.root, a=1))

    def test_transcript_path_only_when_the_file_exists(self):
        self.assertIsNone(session.transcript_path(self.root))
        real = os.path.join(self.root, "t.jsonl")
        open(real, "w").close()
        session.write(self.root, {"transcript_path": real})
        self.assertEqual(real, session.transcript_path(self.root))
        session.write(self.root, {"transcript_path": os.path.join(self.root, "gone.jsonl")})
        self.assertIsNone(session.transcript_path(self.root))


class OutboxTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="aang-outbox-")
        self.addCleanup(shutil.rmtree, self.root, True)

    def test_append_read_clear(self):
        self.assertEqual([], session.outbox_read(self.root))
        session.outbox_append(self.root, "confirmed", "o3", "ответ", at="2026-09-11T12:00:00Z")
        session.outbox_append(self.root, "research", "d9", "")
        got = session.outbox_read(self.root)
        self.assertEqual({"at": "2026-09-11T12:00:00Z", "kind": "confirmed", "node": "o3", "text": "ответ"}, got[0])
        self.assertEqual(("research", "d9", ""), (got[1]["kind"], got[1]["node"], got[1]["text"]))
        self.assertRegex(got[1]["at"], r"Z$")
        session.outbox_clear(self.root)
        self.assertEqual([], session.outbox_read(self.root))
        self.assertTrue(os.path.isfile(os.path.join(self.root, ".aang", "outbox.jsonl")))
        session.outbox_clear(self.root)

    def test_bad_lines_are_skipped(self):
        os.makedirs(os.path.join(self.root, ".aang"))
        with open(os.path.join(self.root, ".aang", "outbox.jsonl"), "w") as h:
            h.write('{"at":"x","kind":"discuss","node":"o1","text":""}\nnot json\n\n[1,2]\n')
        self.assertEqual(1, len(session.outbox_read(self.root)))


class ConfigTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="aang-cfg-")
        self.addCleanup(shutil.rmtree, self.root, True)

    def test_defaults_and_overrides(self):
        self.assertEqual({"nudge_turns": 5, "nudge_minutes": 15}, session.config(self.root))
        os.makedirs(os.path.join(self.root, ".aang"))
        with open(os.path.join(self.root, ".aang", "config.json"), "w") as h:
            json.dump({"nudge_turns": 8, "nudge_minutes": "no", "extra": 1}, h)
        self.assertEqual({"nudge_turns": 8, "nudge_minutes": 15}, session.config(self.root))
