import http.client
import itertools
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import unittest

from aang import schema, server, store, triage

FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")
NORMAL = os.path.join(FIXTURES, "normal.jsonl")


def sample_map():
    return {
        "version": 1,
        "session_id": "s1",
        "generated_at": "2026-09-11T12:00:00Z",
        "title": "тест",
        "nodes": [
            {"id": "d1", "kind": "decision", "status": "accepted", "question": "Чем мерить?",
             "decision": "pass@1", "why": "k>1 маскирует",
             "cites": [{"quote": "давай тогда pass@1"}, {"quote": "Ещё вариант: pass@5", "turn": 3}]},
            {"id": "d2", "kind": "decision", "status": "accepted", "question": "Сколько?",
             "decision": "500", "why": "так сказали",
             "cites": [{"quote": "нужно 500 примеров вместо 100"}, {"quote": "этого никто не говорил"}]},
            {"id": "o1", "kind": "open", "status": "proposed", "question": "Кто платит?",
             "why": "следствие", "cites": []},
        ],
    }


class ServerTestCase(unittest.TestCase):
    transcript = NORMAL
    ui_path = None  # None → a stub page written in setUp; a path → serve that file

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="aang-srv-")
        self.addCleanup(shutil.rmtree, self.root, True)
        self.ui = os.path.join(self.root, "index.html")
        with open(self.ui, "w", encoding="utf-8") as handle:
            handle.write("<title>aang</title><p>привет</p>")
        store.save(self.root, sample_map())
        source = server.TranscriptSource(path=self.transcript, roots=[])
        self.srv = server.make_server(self.root, 0, source, ui_path=self.ui_path or self.ui,
                                      watch_interval=0.05)
        self.port = self.srv.server_address[1]
        self.thread = threading.Thread(target=self.srv.serve_forever, kwargs={"poll_interval": 0.02},
                                       daemon=True)
        self.thread.start()
        self.addCleanup(self.srv.server_close)
        self.addCleanup(self.srv.shutdown)

    def request(self, method, path, body=None, host="127.0.0.1", send_host=True,
                origin=None, content_type="application/json"):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            conn.putrequest(method, path, skip_host=True)
            if send_host:
                conn.putheader("Host", host)
            if origin is not None:
                conn.putheader("Origin", origin)
            payload = None
            if body is not None:
                payload = json.dumps(body).encode("utf-8")
                if content_type is not None:
                    conn.putheader("Content-Type", content_type)
                conn.putheader("Content-Length", str(len(payload)))
            conn.endheaders(payload)
            resp = conn.getresponse()
            data = resp.read()
            return resp.status, resp.getheader("Content-Type"), data
        finally:
            conn.close()

    def get_json(self, path, **kw):
        status, ctype, data = self.request("GET", path, **kw)
        self.assertEqual(status, 200, data)
        self.assertEqual(ctype, "application/json; charset=utf-8")
        return json.loads(data.decode("utf-8"))


class RoutesTest(ServerTestCase):
    def test_binds_loopback_only(self):
        self.assertEqual(self.srv.server_address[0], "127.0.0.1")
        self.assertEqual(self.srv.url, "http://127.0.0.1:%d/" % self.port)

    def test_index_html(self):
        status, ctype, data = self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertEqual(ctype, "text/html; charset=utf-8")
        self.assertIn("привет".encode("utf-8"), data)

    def test_missing_ui_is_404_not_crash(self):
        os.unlink(self.ui)
        status, ctype, data = self.request("GET", "/")
        self.assertEqual(status, 404)
        self.assertTrue(ctype.startswith("text/plain"))
        self.assertIn("index.html".encode("utf-8"), data)

    def test_unknown_path_404(self):
        self.assertEqual(self.request("GET", "/nope")[0], 404)
        self.assertEqual(self.request("POST", "/api/other", body={})[0], 404)

    def test_api_map_shape_and_verified(self):
        view = self.get_json("/api/map")
        self.assertEqual(view["version"], 1)
        self.assertEqual(view["title"], "тест")
        self.assertEqual(view["transcript_path"], NORMAL)
        self.assertIsNone(view["transcript_error"])
        self.assertEqual(view["turns"], 9)
        self.assertEqual(view["errors"], [])
        by_id = dict((n["id"], n) for n in view["nodes"])
        self.assertTrue(by_id["d1"]["verified"])
        self.assertFalse(by_id["d2"]["verified"])   # one citation is invented
        self.assertFalse(by_id["o1"]["verified"])   # nothing to verify
        c0, c1 = by_id["d1"]["cites"]
        self.assertEqual(sorted(c0), ["excerpt", "matches", "ok", "quote", "reason", "role", "turn"])
        self.assertEqual((c0["turn"], c0["role"], c0["ok"]), (4, "user", True))
        self.assertIn("pass@1", c0["excerpt"])
        self.assertEqual((c1["turn"], c1["role"], c1["ok"]), (3, "assistant", True))
        bad = by_id["d2"]["cites"][1]
        self.assertFalse(bad["ok"])
        self.assertIsNone(bad["turn"])
        self.assertTrue(bad["reason"])
        for node in view["nodes"]:
            self.assertFalse(node["hand_edited"])
            self.assertIn("superseded_by", node)

    def test_api_map_with_invalid_file_is_not_rendered(self):
        broken = sample_map()
        broken["nodes"][0]["status"] = "acepted"
        store.save(self.root, broken)
        view = self.get_json("/api/map")
        self.assertEqual(view["nodes"], [])
        self.assertTrue(any("d1" in e and "status" in e for e in view["errors"]))

    def test_api_map_with_absent_file_is_empty_map(self):
        os.unlink(store.map_path(self.root))
        view = self.get_json("/api/map")
        self.assertEqual(view["nodes"], [])
        self.assertEqual(view["errors"], [])


class ViewerStringsTest(ServerTestCase):
    """The real ui/index.html: the words the trust model rests on must survive a rename."""
    ui_path = server._UI_PATH

    def test_index_carries_the_verification_vocabulary(self):
        status, ctype, data = self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertEqual(ctype, "text/html; charset=utf-8")
        page = data.decode("utf-8")
        for word in ("\"проверено\"", "проверено, с оговоркой", "\"не проверено\"", "нет цитат", "не проверялось",
                     "ход не найден", "ход не указан", "правлено вручную", "заменено",
                     "Карта не прошла проверку", "узлы не показаны"):
            self.assertIn(word, page, word)

    def viewer_text(self):
        """The viewer the reader gets: the page plus the model it loads.

        The cell titles moved to `ui/model.js`, which the page pulls in with a `<script src>`,
        so a word can be on either side of that line and still be on the screen.
        """
        page = self.request("GET", "/")[2].decode("utf-8")
        model = self.request("GET", "/model.js")[2].decode("utf-8")
        return page + model

    def test_index_carries_the_relation_vocabulary(self):
        """Search, neighbourhood, coverage and triage words; and every relation label the export
        uses, so the Python and JS copies of REL_LABELS cannot drift apart unnoticed."""
        page = self.request("GET", "/")[2].decode("utf-8")
        text = self.viewer_text()
        for word in ("скрыто", "ни с чем не связано", "На этом держатся", "покрыто до хода",
                     "ни одна цитата не разрешена", "Осиротело решениями", "Просто висит", "новое",
                     # the mini-graph over the list: its heading, and the line that reads it
                     "Окрестность", "слева — на чём держится и что осиротило",
                     "справа — что держится на нём",
                     # the reverse of `moots` is a status flag, as in the export, not a dependant
                     "неактуально", "это неактуальным", "ничего на этом не держится"):
            self.assertIn(word, text, word)
        # Presence is not enough: with the labels of two relations swapped every string is still
        # on the page, and the viewer then tells the reader the opposite of the export. So the
        # check is the binding itself — the key, a colon, that label — tolerant of quoting and
        # whitespace, not of the JS object literal pairing a key with someone else's words.
        for rel, label in store.REL_LABELS.items():
            binding = re.compile(r"(?<![\w$])" + re.escape(rel) + r"[\"']?\s*:\s*[\"']" +
                                 re.escape(label) + r"[\"']")
            self.assertTrue(binding.search(page),
                            "%s: the viewer does not bind this key to %r (store.REL_LABELS)" % (rel, label))

    def test_index_carries_the_cells_verdicts_and_live_words(self):
        """The cells, the verdict buttons, the hook line and the live-updates words. The last
        assertion pins that the old kind-ordering pair is gone: the spine is grouped by the
        cells of `ui/model.js`, the one place the rule lives."""
        page = self.request("GET", "/")[2].decode("utf-8")
        text = self.viewer_text()
        for word in ("Входящее", "Ресерч", "Обсудить", "Подтверждено", "Отвергнуто", "ничего нового",
                     "подтвердить", "в ресерч", "обсудить", "отвергнуть", "видел", "скопировать ссылку",
                     "не на карте", "хук не установлен", "aang install", "связь потеряна", "/api/events",
                     "решил: вы", "решил: агент", "\"мои\"", "\"агента\""):
            self.assertIn(word, text, word)
        self.assertNotIn("ordered(map)", page.split("function ordered(")[0])

    def test_index_carries_the_timeline_words(self):
        """The turn strip names itself the same way in three places: the section label, the
        picture's alternative text, and the button that brings it back on a narrow screen. A node
        whose citations never resolved to a turn is told so in words, not left off the axis."""
        text = self.viewer_text()
        for word in ("Ход сессии", "узлы по ходам", "показать ход сессии", "скрыть ход сессии",
                     "без хода"):
            self.assertIn(word, text, word)

    def test_index_editor_keeps_its_draft_and_every_status(self):
        """Two things a live re-render must not cost the reader. The text typed into an open
        editor: it is kept in `state.editing.value`, not in the DOM the re-render replaces. And a
        status the map can hold: an option list short of `schema.STATUSES` leaves a node whose
        status is missing from it showing someone else's, and «сохранить» then writes that."""
        page = self.request("GET", "/")[2].decode("utf-8")
        self.assertIn("state.editing.value", page)
        options = re.search(r"\[([^\]]*)\]\.map\(function \(s\) \{", page)
        self.assertTrue(options, "the status editor's option list is not where it was")
        for status in schema.STATUSES:
            self.assertIn("\"%s\"" % status, options.group(1), status)

    def test_index_is_self_contained(self):
        page = self.request("GET", "/")[2].decode("utf-8")
        self.assertIn('src="model.js"', page)
        self.assertNotIn("http://", page)
        self.assertNotIn("https://", page)
        self.assertNotIn("overflow-x: hidden", page)  # would only mask a layout that widens the page


class HostCheckTest(ServerTestCase):
    def test_accepted_hosts(self):
        for host in ("127.0.0.1", "127.0.0.1:%d" % self.port, "localhost", "localhost:1",
                     "LOCALHOST", "[::1]", "[::1]:8790"):
            self.assertEqual(self.request("GET", "/api/map", host=host)[0], 200, host)

    def test_rejected_hosts(self):
        for host in ("evil.example", "evil.example:%d" % self.port, "127.0.0.1.evil.example",
                     "localhost.evil", "0.0.0.0", "192.168.1.5", "[::2]", "", "[::1"):
            status, ctype, data = self.request("GET", "/api/map", host=host)
            self.assertEqual(status, 403, host)
            self.assertIn("Host".encode("utf-8"), data)

    def test_missing_host_rejected(self):
        self.assertEqual(self.request("GET", "/api/map", send_host=False)[0], 403)

    def test_post_and_index_gated_too(self):
        self.assertEqual(self.request("GET", "/", host="evil.example")[0], 403)
        status, _, _ = self.request("POST", "/api/node/d1", body={"why": "x"}, host="evil.example")
        self.assertEqual(status, 403)
        self.assertFalse(store.load(self.root)["nodes"][0]["hand_edited"])


class CrossSiteWriteTest(ServerTestCase):
    """A page on another origin must not be able to write the map (the Host check alone
    lets a browser POST to 127.0.0.1 from anywhere)."""

    def assert_untouched(self):
        self.assertFalse(any(n["hand_edited"] for n in store.load(self.root)["nodes"]))

    def test_reviewers_cross_site_post_is_refused(self):
        status, ctype, data = self.request(
            "POST", "/api/node/d2", body={"why": "WRITTEN BY A CROSS-SITE PAGE", "question": "pwned"},
            origin="https://evil.example", content_type="text/plain")
        self.assertEqual(status, 403, data)
        self.assertIn("Origin", data.decode("utf-8"))
        self.assert_untouched()
        self.assertEqual(store.load(self.root)["nodes"][1]["why"], "так сказали")

    def test_foreign_origins_403(self):
        for origin in ("https://evil.example", "http://evil.example", "http://127.0.0.1.evil.example",
                       "http://127.0.0.1.evil.example:%d" % self.port, "https://127.0.0.1:%d" % self.port,
                       "http://localhost:%d/" % self.port, "http://localhost:x", "http://[::1]:%d:1" % self.port,
                       "http://[::1", "null", "", "http://", "file://"):
            status, _, data = self.request("POST", "/api/node/d1", body={"why": "x"}, origin=origin)
            self.assertEqual(status, 403, (origin, data))
        self.assert_untouched()

    def test_own_origins_accepted(self):
        for origin in ("http://127.0.0.1:%d" % self.port, "http://localhost:%d" % self.port,
                       "http://[::1]:%d" % self.port, "http://127.0.0.1", "HTTP://LOCALHOST:%d" % self.port):
            status, _, data = self.request("POST", "/api/node/d1", body={"why": origin}, origin=origin)
            self.assertEqual(status, 200, (origin, data))
        self.assertEqual(store.load(self.root)["nodes"][0]["why"], "HTTP://LOCALHOST:%d" % self.port)

    def test_non_json_content_type_415(self):
        for ctype in ("text/plain", "multipart/form-data", "application/x-www-form-urlencoded",
                      "application/jsonx", None):
            status, _, data = self.request("POST", "/api/node/d1", body={"why": "x"}, content_type=ctype)
            self.assertEqual(status, 415, (ctype, data))
            self.assertIn("application/json", data.decode("utf-8"))
        self.assert_untouched()

    def test_json_content_type_variants_accepted(self):
        for ctype in ("application/json", "application/json; charset=utf-8", "Application/JSON"):
            status, _, data = self.request("POST", "/api/node/d1", body={"why": ctype}, content_type=ctype)
            self.assertEqual(status, 200, (ctype, data))

    def test_viewers_own_request_shape_still_works(self):
        # exactly what ui/index.html sends: same-origin Origin + application/json
        status, _, data = self.request("POST", "/api/node/d2", body={"why": "из интерфейса"},
                                       origin="http://127.0.0.1:%d" % self.port,
                                       content_type="application/json")
        self.assertEqual(status, 200, data)
        self.assertTrue(store.load(self.root)["nodes"][1]["hand_edited"])

    def test_origin_and_content_type_checked_before_the_body_is_touched(self):
        # a 404 path or a bad body must not leak past a foreign Origin
        status, _, _ = self.request("POST", "/nope", body={"why": "x"}, origin="https://evil.example")
        self.assertEqual(status, 403)
        status, _, _ = self.request("POST", "/api/node/zzz", body={"why": "x"}, content_type="text/plain")
        self.assertEqual(status, 415)


class EditTest(ServerTestCase):
    def test_edit_sets_hand_edited_saves_and_returns_view(self):
        status, ctype, data = self.request("POST", "/api/node/d1",
                                           body={"why": "поправил человек", "against": ["минус"]})
        self.assertEqual(status, 200, data)
        self.assertEqual(ctype, "application/json; charset=utf-8")
        view = json.loads(data.decode("utf-8"))
        d1 = view["nodes"][0]
        self.assertEqual(d1["why"], "поправил человек")
        self.assertTrue(d1["hand_edited"])
        self.assertTrue(d1["verified"])
        on_disk = store.load(self.root)["nodes"][0]
        self.assertEqual(on_disk["why"], "поправил человек")
        self.assertEqual(on_disk["against"], ["минус"])
        self.assertTrue(on_disk["hand_edited"])
        # the resolution results are not persisted, only the citation
        self.assertNotIn("ok", on_disk["cites"][0])
        self.assertNotIn("verified", on_disk)

    def test_edit_cites_is_reresolved(self):
        status, _, data = self.request("POST", "/api/node/d2",
                                       body={"cites": [{"quote": "нужно 500 примеров вместо 100"}]})
        self.assertEqual(status, 200)
        view = json.loads(data.decode("utf-8"))
        self.assertTrue(view["nodes"][1]["verified"])

    def test_invalid_edit_is_refused_and_not_saved(self):
        status, _, data = self.request("POST", "/api/node/d1", body={"status": "done"})
        self.assertEqual(status, 422)
        errors = json.loads(data.decode("utf-8"))["errors"]
        self.assertTrue(any("d1" in e and "status" in e for e in errors))
        self.assertFalse(store.load(self.root)["nodes"][0]["hand_edited"])

    def test_protected_and_unknown_fields_400(self):
        for body in ({"id": "d9"}, {"hand_edited": False}, {"verified": True}, {"colour": "red"},
                     {"related_by": []}, {"added_at": "2026-01-01T00:00:00Z"}):
            self.assertEqual(self.request("POST", "/api/node/d1", body=body)[0], 400, body)
        self.assertFalse(store.load(self.root)["nodes"][0]["hand_edited"])

    def test_relates_is_edited_like_any_other_field(self):
        status, _, data = self.request("POST", "/api/node/d2",
                                       body={"relates": [{"to": "d1", "rel": "rests_on"}]})
        self.assertEqual(status, 200, data)
        view = json.loads(data.decode("utf-8"))
        self.assertEqual([{"from": "d2", "rel": "rests_on"}], view["nodes"][0]["related_by"])
        on_disk = store.load(self.root)["nodes"][1]
        self.assertEqual([{"to": "d1", "rel": "rests_on"}], on_disk["relates"])
        self.assertTrue(on_disk["hand_edited"])
        self.assertNotIn("related_by", on_disk)

    def test_forward_relates_edit_is_refused_with_the_schema_error(self):
        status, _, data = self.request("POST", "/api/node/d1",
                                       body={"relates": [{"to": "d2", "rel": "rests_on"}]})
        self.assertEqual(status, 422, data)
        errors = json.loads(data.decode("utf-8"))["errors"]
        self.assertTrue(any("d1" in e and "relates[0].to" in e and "ссылка вперёд" in e for e in errors), errors)
        on_disk = store.load(self.root)["nodes"][0]
        self.assertEqual([], on_disk["relates"])
        self.assertFalse(on_disk["hand_edited"])

    def test_bad_bodies(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn.request("POST", "/api/node/d1", body=b"{not json",
                     headers={"Content-Length": "9", "Content-Type": "application/json"})
        self.assertEqual(conn.getresponse().status, 400)
        conn.close()
        self.assertEqual(self.request("POST", "/api/node/d1", body=[1, 2])[0], 400)
        self.assertEqual(self.request("POST", "/api/node/d1", body={})[0], 400)

    def test_unknown_node_404(self):
        self.assertEqual(self.request("POST", "/api/node/zzz", body={"why": "x"})[0], 404)

    def test_edit_on_invalid_map_409(self):
        broken = sample_map()
        broken["nodes"][1]["kind"] = "wat"
        store.save(self.root, broken)
        self.assertEqual(self.request("POST", "/api/node/d1", body={"why": "x"})[0], 409)


class MissingTranscriptTest(ServerTestCase):
    transcript = os.path.join(FIXTURES, "does-not-exist.jsonl")

    def test_map_still_served_all_unverified(self):
        view = self.get_json("/api/map")
        self.assertIsNone(view["transcript_path"])
        self.assertIn("не найден", view["transcript_error"])
        self.assertEqual(view["turns"], 0)
        self.assertEqual(len(view["nodes"]), 3)
        for node in view["nodes"]:
            self.assertFalse(node["verified"])
            for cite in node["cites"]:
                self.assertFalse(cite["ok"])
                self.assertIn("не проверено", cite["reason"])
        # the file's own turn number is echoed, nothing is invented
        self.assertEqual(view["nodes"][0]["cites"][1]["turn"], 3)
        self.assertIsNone(view["nodes"][0]["cites"][0]["turn"])

    def test_edit_still_works_without_transcript(self):
        status, _, data = self.request("POST", "/api/node/o1", body={"why": "правка"})
        self.assertEqual(status, 200)
        self.assertTrue(store.load(self.root)["nodes"][2]["hand_edited"])


class EmptyTranscriptTest(ServerTestCase):
    transcript = os.path.join(FIXTURES, "empty.jsonl")

    def test_empty_transcript_is_an_error_not_a_crash(self):
        view = self.get_json("/api/map")
        self.assertIn("пуст", view["transcript_error"])
        self.assertTrue(all(not n["verified"] for n in view["nodes"]))


class TranscriptSourceTest(unittest.TestCase):
    def test_lookup_by_session_id_in_explicit_roots(self):
        roots = [os.path.join(FIXTURES, "projects")]
        source = server.TranscriptSource(session_id="bbbb2222", roots=roots)
        turns, error = source.turns()
        self.assertIsNone(error)
        self.assertTrue(source.path.endswith("bbbb2222-0000-0000-0000-000000000002.jsonl"))
        self.assertTrue(turns)

    def test_map_session_id_used_when_source_has_none(self):
        source = server.TranscriptSource(roots=[os.path.join(FIXTURES, "projects")])
        _, error = source.turns("aaaa1111")
        self.assertIsNone(error)
        self.assertIn("aaaa1111", source.path)

    def test_unknown_session_names_it(self):
        source = server.TranscriptSource(session_id="nope", roots=[os.path.join(FIXTURES, "projects")])
        turns, error = source.turns()
        self.assertEqual(turns, [])
        self.assertIn("nope", error)

    def test_reindexes_when_file_changes(self):
        tmp = tempfile.mkdtemp(prefix="aang-ts-")
        self.addCleanup(shutil.rmtree, tmp, True)
        path = os.path.join(tmp, "s.jsonl")
        shutil.copy(NORMAL, path)
        source = server.TranscriptSource(path=path)
        turns, _ = source.turns()
        self.assertEqual(len(turns), 9)
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(json.dumps({"type": "user", "uuid": "u-new", "message": {"role": "user",
                                     "content": "новая реплика"}}) + "\n")
        turns, _ = source.turns()
        self.assertEqual(len(turns), 10)

    def test_reindexes_when_the_path_changes_under_the_same_stamp(self):
        """Two files of the same size and mtime: only the path tells them apart."""
        tmp = tempfile.mkdtemp(prefix="aang-ts-")
        self.addCleanup(shutil.rmtree, tmp, True)

        def write(path, texts):
            with open(path, "w", encoding="utf-8") as handle:
                for i, text in enumerate(texts):
                    handle.write(json.dumps({"type": "user", "uuid": "u%d" % i,
                                             "message": {"role": "user", "content": text}}) + "\n")

        one, two = os.path.join(tmp, "one.jsonl"), os.path.join(tmp, "two.jsonl")
        write(two, ["первая", "вторая"])
        write(one, ["x"])
        write(one, ["x" * (1 + os.path.getsize(two) - os.path.getsize(one))])
        self.assertEqual(os.path.getsize(two), os.path.getsize(one))
        stat = os.stat(two)
        os.utime(one, ns=(stat.st_atime_ns, stat.st_mtime_ns))

        source = server.TranscriptSource(path=one)
        self.assertEqual(1, len(source.turns()[0]))
        source.pinned = two
        self.assertEqual(2, len(source.turns()[0]))


class AnnotateTest(unittest.TestCase):
    def test_does_not_mutate_input(self):
        m = sample_map()
        turns = []
        server.annotate(m, turns, "нет транскрипта")
        self.assertNotIn("verified", m["nodes"][0])
        self.assertNotIn("ok", m["nodes"][0]["cites"][0])


def _turns(n, text="живая цитата отсюда, ход %d"):
    """`n` synthetic turns shaped like `transcript.index` output, each carrying the quote."""
    return [{"turn": i, "role": "user" if i % 2 else "assistant", "ts": None, "uuid": "",
             "text": text % i} for i in range(1, n + 1)]


def _node(node_id, kind="decision", status="accepted", **fields):
    """A valid node. A decision needs a citation, so the default is one that resolves
    nowhere in `_turns` — it satisfies the validator without covering any turn."""
    node = {"id": node_id, "kind": kind, "status": status, "question": "вопрос %s" % node_id,
            "cites": []}
    if kind != "open":
        node["decision"] = "решение %s" % node_id
        node["why"] = "потому что"
        node["cites"] = [{"quote": "цитата, которой нет ни в одном ходе"}]
    node.update(fields)
    return node


def _map(nodes):
    return {"version": 1, "session_id": "s1", "generated_at": "2026-09-11T12:00:00Z",
            "title": "тест", "nodes": nodes}


def _by_id(view, node_id):
    return [n for n in view["nodes"] if n["id"] == node_id][0]


class ReverseIndexTest(unittest.TestCase):
    def test_annotate_builds_reverse_index(self):
        m = _map([_node("d1"), _node("o1", kind="open", status="proposed",
                                     relates=[{"to": "d1", "rel": "orphaned_by"}])])
        view = server.annotate(m, _turns(3))
        self.assertEqual([{"from": "o1", "rel": "orphaned_by"}], _by_id(view, "d1")["related_by"])

    def test_annotate_reverse_index_is_empty_list_not_missing(self):
        view = server.annotate(_map([_node("d1")]), _turns(3))
        self.assertEqual([], view["nodes"][0]["related_by"])

    def test_source_node_keeps_its_forward_edges_and_gets_empty_reverse(self):
        m = _map([_node("d1"), _node("d2", relates=[{"to": "d1", "rel": "rests_on"}])])
        view = server.annotate(m, _turns(3))
        d2 = _by_id(view, "d2")
        self.assertEqual([{"to": "d1", "rel": "rests_on"}], d2["relates"])
        self.assertEqual([], d2["related_by"])

    def test_reverse_index_follows_map_order_with_several_sources(self):
        m = _map([_node("d1"),
                  _node("d2", relates=[{"to": "d1", "rel": "rests_on"}]),
                  _node("o1", kind="open", status="proposed",
                        relates=[{"to": "d1", "rel": "orphaned_by"}, {"to": "d2", "rel": "moots"}])])
        view = server.annotate(m, _turns(3))
        self.assertEqual([{"from": "d2", "rel": "rests_on"}, {"from": "o1", "rel": "orphaned_by"}],
                         _by_id(view, "d1")["related_by"])
        self.assertEqual([{"from": "o1", "rel": "moots"}], _by_id(view, "d2")["related_by"])

    def test_related_by_written_into_the_file_is_replaced_by_the_derived_one(self):
        # U4: the reverse side is never stored; whatever the file claims is discarded.
        m = _map([_node("d1", related_by=[{"from": "ghost", "rel": "rests_on"}]),
                  _node("d2", relates=[{"to": "d1", "rel": "rests_on"}])])
        view = server.annotate(m, _turns(3))
        self.assertEqual([{"from": "d2", "rel": "rests_on"}], _by_id(view, "d1")["related_by"])

    def test_reverse_index_is_built_without_a_transcript(self):
        m = _map([_node("d1"), _node("d2", relates=[{"to": "d1", "rel": "rests_on"}])])
        view = server.annotate(m, [], "нет транскрипта")
        self.assertEqual([{"from": "d2", "rel": "rests_on"}], _by_id(view, "d1")["related_by"])


class CoverageTest(unittest.TestCase):
    def test_annotate_reports_coverage(self):
        m = _map([_node("d1", cites=[{"quote": "живая цитата отсюда", "turn": 5}])])
        view = server.annotate(m, _turns(12))
        self.assertEqual({"covered_to": 5, "turns": 12}, view["coverage"])

    def test_coverage_is_none_when_nothing_resolved(self):
        view = server.annotate(_map([_node("d1")]), _turns(12))
        self.assertIsNone(view["coverage"]["covered_to"])
        self.assertEqual(12, view["coverage"]["turns"])

    def test_unresolved_citation_does_not_extend_coverage(self):
        # U6: a claim nobody could verify does not extend the map's reach.
        m = _map([_node("d1", cites=[{"quote": "живая цитата отсюда", "turn": 5}]),
                  _node("d2", cites=[{"quote": "этого нигде нет в тексте", "turn": 9}])])
        view = server.annotate(m, _turns(12))
        self.assertFalse(_by_id(view, "d2")["cites"][0]["ok"])
        self.assertEqual(5, view["coverage"]["covered_to"])

    def test_coverage_takes_the_largest_resolved_turn_across_nodes(self):
        m = _map([_node("d1", cites=[{"quote": "живая цитата отсюда", "turn": 2}]),
                  _node("d2", cites=[{"quote": "живая цитата отсюда", "turn": 7},
                                     {"quote": "живая цитата отсюда", "turn": 4}])])
        view = server.annotate(m, _turns(9))
        self.assertEqual({"covered_to": 7, "turns": 9}, view["coverage"])

    def test_coverage_counts_a_turn_filled_in_from_the_quote(self):
        m = _map([_node("d1", cites=[{"quote": "только здесь и нигде больше"}])])
        turns = _turns(6)
        turns[3]["text"] = "а вот только здесь и нигде больше"  # turn 4
        view = server.annotate(m, turns)
        self.assertEqual({"covered_to": 4, "turns": 6}, view["coverage"])

    def test_coverage_without_transcript_is_none_of_zero(self):
        m = _map([_node("d1", cites=[{"quote": "живая цитата отсюда", "turn": 5}])])
        view = server.annotate(m, [], "нет транскрипта")
        self.assertEqual({"covered_to": None, "turns": 0}, view["coverage"])


class WarningsInViewTest(unittest.TestCase):
    def test_warnings_travel_with_the_map(self):
        m = _map([_node("d1"), _node("d2", why="держится на d1, но ребра нет")])
        view = server.annotate(m, _turns(3))
        self.assertEqual(1, len(view["warnings"]))
        self.assertIn("d1", view["warnings"][0])

    def test_warnings_empty_list_when_clean(self):
        m = _map([_node("d1"), _node("d2", why="держится на d1",
                                     relates=[{"to": "d1", "rel": "rests_on"}])])
        view = server.annotate(m, _turns(3))
        self.assertEqual([], view["warnings"])

    def test_invalid_map_keeps_the_shape(self):
        view = server.annotate({"version": 1, "nodes": [{"id": "x"}]}, _turns(3))
        self.assertTrue(view["errors"])
        self.assertEqual([], view["nodes"])
        self.assertEqual({"covered_to": None, "turns": 3}, view["coverage"])
        self.assertEqual([], view["warnings"])


class ViewShapeOverHttpTest(ServerTestCase):
    def test_api_map_carries_reverse_index_coverage_and_warnings(self):
        view = self.get_json("/api/map")
        for node in view["nodes"]:
            self.assertEqual([], node["related_by"])
        self.assertIsInstance(view["coverage"]["covered_to"], int)
        self.assertEqual(view["turns"], view["coverage"]["turns"])
        # The sample map's o1 is open with no `orphaned_by`: the one remark it earns
        # travels with the map, so the viewer can show it (U8).
        self.assertEqual(["узел o1: открытый вопрос без orphaned_by — укажите решение или скажите в why, что его нет"],
                         view["warnings"])


def _viewer_function(name):
    """The source of one top-level `function <name>(...) {...}` from ui/index.html or ui/model.js."""
    for path in (server._UI_PATH, server._MODEL_PATH):
        with open(path, encoding="utf-8") as handle:
            page = handle.read()
        start = page.find("function %s(" % name)
        if start < 0:
            continue
        depth = 0
        for i in range(start, len(page)):
            if page[i] == "{":
                depth += 1
            elif page[i] == "}":
                depth -= 1
                if depth == 0:
                    return page[start:i + 1]
        raise AssertionError("unbalanced braces in %s" % name)
    raise AssertionError("no function %s in the viewer" % name)


def _model_call(expr):
    """Evaluate `expr` against ui/model.js under node; return the parsed JSON result."""
    with open(server._MODEL_PATH, encoding="utf-8") as handle:
        source = handle.read()
    script = ("var module = {exports: {}}; var window = {};\n" + source +
              "\nvar M = module.exports; process.stdout.write(JSON.stringify(" + expr + "));")
    done = subprocess.run(["node", "-e", script], capture_output=True, check=True)
    return json.loads(done.stdout.decode("utf-8"))


_TIMELINE_OPTS = "{pxPerTurn: 12, laneHeight: 28, gutter: 60, stepDown: 6}"
_NEIGHBOURHOOD_OPTS = "{width: 320, height: 180, max: 6}"


T1, T2, T3 = "2026-09-11T13:00:00Z", "2026-09-11T14:00:00Z", "2026-09-11T15:00:00Z"


class NewMarksTest(unittest.TestCase):
    """The viewer's «новое» marks (U7): a node is new when its `added_at` equals the map's
    `generated_at` — both stamped by the same merge — so a run that added nothing clears them.
    The function is lifted from the real page and run under node when node is on PATH."""

    def test_the_rule_is_equality_with_generated_at(self):
        src = _viewer_function("newIds")
        self.assertIn("n.added_at === map.generated_at", src)
        self.assertNotIn("latest", src)  # the "max stamp" rule stayed lit after a no-op run

    def new_ids(self, generated_at, stamps):
        nodes = [{"id": "n%d" % i} for i in range(len(stamps))]
        for node, stamp in zip(nodes, stamps):
            if stamp is not None:
                node["added_at"] = stamp
        script = (_viewer_function("newIds") + "\nprocess.stdout.write(JSON.stringify(Object.keys(newIds(%s))));"
                  % json.dumps({"generated_at": generated_at, "nodes": nodes}))
        done = subprocess.run(["node", "-e", script], capture_output=True, check=True)
        return json.loads(done.stdout.decode("utf-8"))

    @unittest.skipUnless(shutil.which("node"), "node not on PATH")
    def test_first_run_marks_nothing(self):
        # Every node entered with this run: that is not a delta, and marking all would say nothing.
        self.assertEqual([], self.new_ids(T1, [T1, T1, T1]))

    @unittest.skipUnless(shutil.which("node"), "node not on PATH")
    def test_run_that_added_nodes_marks_exactly_those(self):
        self.assertEqual(["n2", "n3"], self.new_ids(T2, [T1, T1, T2, T2]))

    @unittest.skipUnless(shutil.which("node"), "node not on PATH")
    def test_run_that_added_nothing_clears_the_marks(self):
        # `generated_at` moved past every stamp: the previous run added nothing, so nothing is new.
        self.assertEqual([], self.new_ids(T3, [T1, T1, T2, T2]))

    @unittest.skipUnless(shutil.which("node"), "node not on PATH")
    def test_unstamped_nodes_are_unknown_not_new(self):
        self.assertEqual([], self.new_ids(T2, [None, None]))
        self.assertEqual([], self.new_ids(T2, [None, T2]))  # nothing older: no delta to show


class CellAndTailTest(unittest.TestCase):
    def test_every_node_carries_its_cell(self):
        view = server.annotate(_map([_node("d1", status="proposed", decided_by="agent",
                                           cites=[{"quote": "живая цитата отсюда, ход 2"}]),
                                     _node("t1", kind="tacit")]), _turns(6))
        self.assertEqual("inbox", _by_id(view, "d1")["cell"])
        self.assertEqual("tacit", _by_id(view, "t1")["cell"])

    def test_tail_is_the_turns_after_coverage(self):
        view = server.annotate(_map([_node("d1", cites=[{"quote": "живая цитата отсюда, ход 2"}])]), _turns(5))
        self.assertEqual(2, view["coverage"]["covered_to"])
        self.assertEqual([3, 4, 5], [t["turn"] for t in view["tail"]])
        self.assertEqual({"turn", "role", "text"}, set(view["tail"][0]))

    def test_tail_text_is_capped(self):
        long_turns = _turns(3, text="слово " * 100 + "ход %d")
        view = server.annotate(_map([_node("d1", cites=[{"quote": "слово слово слово слово", "turn": 1}])]),
                               long_turns)
        self.assertEqual([2, 3], [t["turn"] for t in view["tail"]])
        self.assertTrue(all(len(t["text"]) <= server.TAIL_TEXT_CAP for t in view["tail"]))
        self.assertLess(server.TAIL_TEXT_CAP, len(long_turns[1]["text"]))

    def test_tail_empty_without_coverage_or_transcript(self):
        self.assertEqual([], server.annotate(_map([_node("o1", kind="open", status="proposed", cites=[])]), _turns(4))["tail"])
        self.assertEqual([], server.annotate(_map([_node("d1")]), [], transcript_error="нет")["tail"])

    def test_hook_and_root_in_the_view(self):
        view = server.annotate(_map([]), [], session_info={"harness": "codex", "last_event_at": "2026-09-11T12:00:00Z"}, root="/x")
        self.assertEqual({"installed": True, "harness": "codex", "last_event_at": "2026-09-11T12:00:00Z"}, view["hook"])
        self.assertEqual("/x", view["root"])
        view = server.annotate(_map([]), [])
        self.assertEqual({"installed": False, "harness": None, "last_event_at": None}, view["hook"])
        self.assertIsNone(view["root"])


class SessionFileSourceTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="aang-src-")
        self.addCleanup(shutil.rmtree, self.root, True)

    def test_session_json_wins_over_lookup(self):
        from aang import session
        store.save(self.root, sample_map())
        session.write(self.root, {"harness": "claude", "transcript_path": NORMAL})
        source = server.TranscriptSource(roots=[], root=self.root)
        turns, error = source.turns("does-not-matter")
        self.assertIsNone(error)
        self.assertEqual(NORMAL, source.path)

    def test_explicit_path_still_wins_over_session_json(self):
        from aang import session
        store.save(self.root, sample_map())
        session.write(self.root, {"transcript_path": os.path.join(FIXTURES, "tool_only.jsonl")})
        source = server.TranscriptSource(path=NORMAL, roots=[], root=self.root)
        source.turns()
        self.assertEqual(NORMAL, source.path)

    def test_explicit_session_id_still_wins_over_session_json(self):
        from aang import session
        store.save(self.root, sample_map())
        session.write(self.root, {"transcript_path": NORMAL})
        source = server.TranscriptSource(session_id="aaaa1111-0000-0000-0000-000000000001",
                                         roots=[os.path.join(FIXTURES, "projects")], root=self.root)
        source.turns()
        self.assertTrue(source.path and source.path.endswith("aaaa1111-0000-0000-0000-000000000001.jsonl"))

    def test_stale_session_json_falls_back_to_lookup(self):
        from aang import session
        store.save(self.root, sample_map())
        session.write(self.root, {"transcript_path": os.path.join(self.root, "gone.jsonl")})
        source = server.TranscriptSource(roots=[os.path.join(FIXTURES, "projects")], root=self.root)
        source.turns("aaaa1111-0000-0000-0000-000000000001")
        self.assertTrue(source.path and source.path.endswith("aaaa1111-0000-0000-0000-000000000001.jsonl"))


class ViewOverHttpHasNewKeysTest(ServerTestCase):
    def test_api_map_carries_cell_tail_hook_root(self):
        view = self.get_json("/api/map")
        self.assertIn("tail", view); self.assertIn("hook", view); self.assertEqual(self.root, view["root"])
        self.assertTrue(all("cell" in n for n in view["nodes"]))


class VerdictRouteTest(ServerTestCase):
    def outbox(self):
        from aang import session
        return session.outbox_read(self.root)

    def test_confirm_open_with_text(self):
        status, _, data = self.request("POST", "/api/node/o1/verdict", {"verdict": "confirmed", "text": "Платит заказчик"})
        self.assertEqual(200, status, data)
        view = json.loads(data)
        o1 = _by_id(view, "o1")
        self.assertEqual(("decision", "Платит заказчик", "accepted", "user", True, "confirmed"),
                         (o1["kind"], o1["decision"], o1["status"], o1["decided_by"], o1["hand_edited"], o1["cell"]))
        saved = store.load(self.root)
        self.assertEqual("decision", [n for n in saved["nodes"] if n["id"] == "o1"][0]["kind"])
        self.assertEqual([("confirmed", "o1", "Платит заказчик")], [(e["kind"], e["node"], e["text"]) for e in self.outbox()])

    def test_confirm_open_without_text_is_422_and_writes_nothing(self):
        status, _, data = self.request("POST", "/api/node/o1/verdict", {"verdict": "confirmed", "text": ""})
        self.assertEqual(422, status, data)
        self.assertIn("ответ", json.loads(data)["errors"][0])
        self.assertEqual("open", [n for n in store.load(self.root)["nodes"] if n["id"] == "o1"][0]["kind"])
        self.assertEqual([], self.outbox())

    def test_reject_and_research(self):
        status, _, data = self.request("POST", "/api/node/d1/verdict", {"verdict": "rejected", "text": "нет"})
        self.assertEqual(200, status, data)
        d1 = _by_id(json.loads(data), "d1")
        self.assertEqual(("rejected", ["нет"], "rejected"), (d1["status"], d1["against"], d1["cell"]))
        status, _, data = self.request("POST", "/api/node/d2/verdict", {"verdict": "research"})
        self.assertEqual(200, status, data)
        d2 = _by_id(json.loads(data), "d2")
        self.assertEqual(("proposed", "research", "research"), (d2["status"], d2["triage"], d2["cell"]))
        self.assertEqual(["rejected", "research"], [e["kind"] for e in self.outbox()])

    def test_bad_bodies_and_unknown_node(self):
        self.assertEqual(400, self.request("POST", "/api/node/d1/verdict", {"text": "x"})[0])
        self.assertEqual(422, self.request("POST", "/api/node/d1/verdict", {"verdict": "maybe"})[0])
        self.assertEqual(404, self.request("POST", "/api/node/zz/verdict", {"verdict": "rejected"})[0])
        self.assertEqual([], self.outbox())

    def test_cross_site_verdict_is_refused(self):
        status, _, _ = self.request("POST", "/api/node/d1/verdict", {"verdict": "rejected"}, origin="http://evil.example")
        self.assertEqual(403, status)
        self.assertEqual("accepted", [n for n in store.load(self.root)["nodes"] if n["id"] == "d1"][0]["status"])


class SeenRouteTest(ServerTestCase):
    def test_seen_stamps_without_hand_edit_or_outbox(self):
        from aang import session
        status, _, data = self.request("POST", "/api/node/o1/seen", {})
        self.assertEqual(200, status, data)
        o1 = _by_id(json.loads(data), "o1")
        self.assertRegex(o1["seen_at"], r"Z$")
        self.assertFalse(o1["hand_edited"])
        self.assertEqual("hanging", o1["cell"])
        self.assertEqual([], session.outbox_read(self.root))

    def test_unknown_node_404(self):
        self.assertEqual(404, self.request("POST", "/api/node/zz/seen", {})[0])


class EditNewFieldsTest(ServerTestCase):
    def test_decided_by_and_triage_are_editable(self):
        status, _, data = self.request("POST", "/api/node/d1", {"decided_by": "agent", "status": "proposed", "triage": "discuss"})
        self.assertEqual(200, status, data)
        self.assertEqual("discuss", _by_id(json.loads(data), "d1")["cell"])
        status, _, data = self.request("POST", "/api/node/o1", {"decided_by": "user"})
        self.assertEqual(422, status, data)


class WatcherTest(unittest.TestCase):
    def test_reports_the_label_of_the_file_that_changed(self):
        """A file that is rewritten and a file that only now appears are both changes."""
        root = tempfile.mkdtemp(prefix="aang-watch-")
        self.addCleanup(shutil.rmtree, root, True)
        a = os.path.join(root, "a.json"); b = os.path.join(root, "b.json")
        open(a, "w").close()
        w = server.Watcher(lambda: {"map": a, "session": b}, interval=0.05)
        q = w.subscribe()
        w.start()
        self.addCleanup(w.stop)
        with open(a, "w") as h:
            h.write("changed")
        self.assertEqual({"changed": ["map"]}, q.get(timeout=2))
        open(b, "w").close()
        self.assertEqual({"changed": ["session"]}, q.get(timeout=2))
        w.unsubscribe(q)

    def test_stop_ends_the_thread_and_wakes_its_subscribers(self):
        """`join()` on a stopped watcher must work: a `Thread` has private names of its own."""
        w = server.Watcher(dict, interval=0.01)
        q = w.subscribe()
        w.start()
        w.stop()
        w.join(timeout=2)
        self.assertFalse(w.is_alive())
        self.assertIsNone(q.get(timeout=2))


class WatchedPathsTest(unittest.TestCase):
    """What the watcher polls, and how rarely it may go looking for the transcript."""

    def setUp(self):
        from aang import session
        self.root = tempfile.mkdtemp(prefix="aang-paths-")
        self.addCleanup(shutil.rmtree, self.root, True)
        store.save(self.root, sample_map())
        self.session = session
        self.source = server.TranscriptSource(path=NORMAL, roots=[], root=self.root)
        self.srv = server.make_server(self.root, 0, self.source, watch_interval=60)
        self.addCleanup(self.srv.server_close)
        self.lookups = []
        located = self.source.locate

        def counting(session_id=None):
            self.lookups.append(session_id)
            return located(session_id)

        self.source.locate = counting

    def test_watches_the_map_the_session_file_and_the_transcript(self):
        paths = self.srv._watched_paths()
        self.assertEqual(store.map_path(self.root), paths["map"])
        self.assertEqual(os.path.join(store.map_dir(self.root), self.session.SESSION_FILE),
                         paths["session"])
        self.assertEqual(NORMAL, paths["transcript"])

    def test_the_located_path_is_remembered_between_ticks(self):
        self.srv._watched_paths()
        self.srv._watched_paths()
        self.assertEqual([], self.lookups)

    def test_a_changed_session_file_sends_it_looking_again(self):
        self.srv._watched_paths()
        self.session.write(self.root, {"harness": "claude", "transcript_path": NORMAL})
        self.assertEqual(NORMAL, self.srv._watched_paths()["transcript"])
        self.assertEqual(1, len(self.lookups))


class EventsRouteTest(ServerTestCase):
    def test_stream_announces_map_changes(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        self.addCleanup(conn.close)
        conn.putrequest("GET", "/api/events", skip_host=True)
        conn.putheader("Host", "127.0.0.1")
        conn.endheaders()
        resp = conn.getresponse()
        self.assertEqual(200, resp.status)
        self.assertEqual("text/event-stream; charset=utf-8", resp.getheader("Content-Type"))
        self.assertEqual("no-store", resp.getheader("Cache-Control"))
        self.assertEqual(b": connected\n\n", resp.readline() + resp.readline())
        m = store.load(self.root); m["title"] = "изменено"; store.save(self.root, m)
        line = resp.readline()
        deadline = time.time() + 3
        while not line.startswith(b"data:") and time.time() < deadline:
            line = resp.readline()
        self.assertIn(b'"map"', line)

    def test_events_gated_by_host(self):
        status, _, _ = self.request("GET", "/api/events", host="evil.example")
        self.assertEqual(403, status)

    def test_head_does_not_stream(self):
        status, ctype, data = self.request("HEAD", "/api/events")
        self.assertEqual((200, "text/event-stream; charset=utf-8", b""), (status, ctype, data))


class ModelJsRouteTest(ServerTestCase):
    def test_model_js_is_served_when_present(self):
        status, ctype, data = self.request("GET", "/model.js")
        if os.path.isfile(server._MODEL_PATH):
            self.assertEqual((200, "application/javascript; charset=utf-8"), (status, ctype))
            self.assertTrue(data)
        else:
            self.assertEqual(404, status)
            self.assertIn("model.js".encode("utf-8"), data)


@unittest.skipUnless(shutil.which("node"), "node not on PATH")
class ModelJsTest(unittest.TestCase):
    """ui/model.js is the viewer's pure half: no DOM, so node can run it and these tests can
    hold it to the same rules the Python side follows."""

    def test_cells_match_python_order(self):
        keys = _model_call("M.CELLS.map(function (c) { return c.key; })")
        self.assertEqual([c[0] for c in triage.CELLS], keys)

    def test_cell_titles_match_python(self):
        """The headings live once per language; a rewording on one side must not leave the
        viewer calling a cell something the export never calls it."""
        got = _model_call("M.CELLS.map(function (c) { return [c.key, c.title, c.sub]; })")
        self.assertEqual([list(c) for c in triage.CELLS], got)

    def test_cell_of_agrees_with_python_on_a_grid(self):
        cases = []
        for kind, status, decided_by, tri, seen in itertools.product(
                ("decision", "tacit", "open"), ("accepted", "proposed", "superseded", "rejected"),
                (None, "user", "agent"), (None, "research", "discuss"),
                (None, "2026-09-11T11:00:00Z", "2026-09-11T13:00:00Z")):
            cases.append({"id": "x", "kind": kind, "status": status, "decided_by": decided_by,
                          "triage": tri, "seen_at": seen, "added_at": "2026-09-11T12:00:00Z",
                          "relates": [{"to": "d0", "rel": "orphaned_by"}]
                                     if kind == "open" and status == "proposed" else []})
        got = _model_call("%s.map(M.cellOf)" % json.dumps(cases))
        self.assertEqual([triage.cell(c) for c in cases], got)

    def test_unseen_agrees_with_python(self):
        cases = []
        for seen, added in itertools.product((None, "", "2026-09-11T11:00:00Z", "2026-09-11T13:00:00Z"),
                                             (None, "", "2026-09-11T12:00:00Z")):
            cases.append({"id": "x", "seen_at": seen, "added_at": added})
        got = _model_call("%s.map(M.isUnseen)" % json.dumps(cases))
        self.assertEqual([triage.is_unseen(c) for c in cases], got)

    def test_author_is_named_only_for_decisions(self):
        self.assertEqual(["user", "agent", "unknown", None], _model_call(
            "[{kind:'decision', decided_by:'user'}, {kind:'decision', decided_by:'agent'},"
            " {kind:'decision'}, {kind:'open', decided_by:'user'}].map(M.authorOf)"))

    def test_first_turn_is_the_earliest_verified_citation(self):
        self.assertEqual([3, None, None], _model_call(
            "[{cites:[{turn:9, ok:true}, {turn:3, ok:true}, {turn:1, ok:false}]},"
            " {cites:[{turn:2, ok:false}]}, {cites:[]}].map(M.firstTurn)"))

    def test_timeline_positions_are_a_function_of_turn_and_kind(self):
        m = {"coverage": {"covered_to": 4, "turns": 10}, "nodes": [
            {"id": "d1", "kind": "decision", "status": "accepted", "cites": [{"turn": 3, "ok": True}]},
            {"id": "d2", "kind": "decision", "status": "accepted", "cites": [{"turn": 3, "ok": True}]},
            {"id": "t1", "kind": "tacit", "status": "accepted",
             "cites": [{"turn": 1, "ok": True}, {"turn": 9, "ok": True}]},
            {"id": "o1", "kind": "open", "status": "proposed", "cites": []}]}
        lay = _model_call("M.timelineLayout(%s, %s)" % (json.dumps(m), _TIMELINE_OPTS))
        marks = dict((k["id"], k) for k in lay["marks"])
        self.assertEqual(60 + 2 * 12, marks["d1"]["x"])
        self.assertEqual(marks["d1"]["x"], marks["d2"]["x"])
        self.assertEqual(marks["d1"]["y"] + 6, marks["d2"]["y"])
        self.assertEqual(60, marks["t1"]["x"])
        self.assertTrue(marks["o1"]["noTurn"])
        self.assertEqual(30, marks["o1"]["x"])
        self.assertEqual(["tacit", "open", "decision"], [lane["kind"] for lane in lay["lanes"]])
        self.assertEqual(60 + 4 * 12, lay["coverage"]["x"])
        self.assertEqual(60 + 10 * 12, lay["width"])

    def test_a_later_map_moves_nothing_that_was_already_there(self):
        """U9: a mark sits where its turn and kind put it, so a longer session and new nodes
        leave every earlier mark exactly where the reader last saw it."""
        m = {"coverage": {"covered_to": 4, "turns": 10}, "nodes": [
            {"id": "d1", "kind": "decision", "status": "accepted", "cites": [{"turn": 3, "ok": True}]},
            {"id": "d2", "kind": "decision", "status": "accepted", "cites": [{"turn": 3, "ok": True}]},
            {"id": "t1", "kind": "tacit", "status": "accepted", "cites": [{"turn": 1, "ok": True}]},
            {"id": "o1", "kind": "open", "status": "proposed", "cites": []}]}
        lay = _model_call("M.timelineLayout(%s, %s)" % (json.dumps(m), _TIMELINE_OPTS))
        grown = dict(m)
        grown["coverage"] = {"covered_to": 12, "turns": 30}
        grown["nodes"] = m["nodes"] + [{"id": "d3", "kind": "decision", "status": "accepted",
                                        "cites": [{"turn": 20, "ok": True}]}]
        lay2 = _model_call("M.timelineLayout(%s, %s)" % (json.dumps(grown), _TIMELINE_OPTS))
        old = dict((k["id"], (k["x"], k["y"])) for k in lay["marks"])
        for k in lay2["marks"]:
            if k["id"] in old:
                self.assertEqual(old[k["id"]], (k["x"], k["y"]), k["id"])

    def test_timeline_without_coverage_says_so(self):
        lay = _model_call("M.timelineLayout({nodes: []}, %s)" % _TIMELINE_OPTS)
        self.assertIsNone(lay["coverage"])
        self.assertEqual([], lay["marks"])

    def test_timeline_is_wide_enough_for_a_turn_past_the_count(self):
        m = {"coverage": {"covered_to": 2, "turns": 4}, "nodes": [
            {"id": "d1", "kind": "decision", "status": "accepted", "cites": [{"turn": 9, "ok": True}]}]}
        lay = _model_call("M.timelineLayout(%s, %s)" % (json.dumps(m), _TIMELINE_OPTS))
        marks = dict((k["id"], k) for k in lay["marks"])
        self.assertEqual(60 + 8 * 12, marks["d1"]["x"])
        self.assertEqual(60 + 9 * 12, lay["width"])

    def test_neighbourhood_layout(self):
        m = {"nodes": [
            {"id": "t5", "kind": "tacit", "relates": [],
             "related_by": [{"from": "d7", "rel": "rests_on"}, {"from": "o6", "rel": "rests_on"}]},
            {"id": "d7", "kind": "decision", "relates": [{"to": "t5", "rel": "rests_on"}],
             "related_by": [{"from": "o6", "rel": "orphaned_by"}], "superseded_by": None},
            {"id": "o6", "kind": "open",
             "relates": [{"to": "d7", "rel": "orphaned_by"}, {"to": "t5", "rel": "rests_on"}], "related_by": []},
            {"id": "d8", "kind": "decision", "relates": [], "related_by": [], "superseded_by": "d7"}]}
        lay = _model_call("M.neighbourhoodLayout(%s, %s, %s)"
                          % (json.dumps(m["nodes"][1]), json.dumps(m), _NEIGHBOURHOOD_OPTS))
        self.assertEqual("d7", lay["center"]["id"])
        self.assertEqual(["t5"], [n["id"] for n in lay["left"]])
        self.assertEqual(["o6"], [n["id"] for n in lay["right"]])
        self.assertEqual([], lay["top"])
        self.assertEqual(["d8"], [n["id"] for n in lay["bottom"]])
        self.assertEqual(0, lay["overflow"])
        self.assertTrue(all(n["x"] < 160 for n in lay["left"]) and all(n["x"] > 160 for n in lay["right"]))

    def test_neighbourhood_keeps_the_relation_of_every_edge(self):
        """A slot without its `rel` is an unlabelled arc: the reader could not tell what holds
        what up. What supersedes this node goes above it, what it superseded below."""
        m = {"nodes": [
            {"id": "t5", "kind": "tacit", "relates": [], "related_by": [{"from": "d7", "rel": "rests_on"}]},
            {"id": "d7", "kind": "decision", "relates": [{"to": "t5", "rel": "rests_on"}],
             "related_by": [{"from": "o6", "rel": "orphaned_by"}], "superseded_by": "d9"},
            {"id": "d9", "kind": "decision", "relates": [], "related_by": []}]}
        lay = _model_call("M.neighbourhoodLayout(%s, %s, %s)"
                          % (json.dumps(m["nodes"][1]), json.dumps(m), _NEIGHBOURHOOD_OPTS))
        self.assertEqual([("t5", "rests_on")], [(n["id"], n["rel"]) for n in lay["left"]])
        self.assertEqual([("o6", "orphaned_by")], [(n["id"], n["rel"]) for n in lay["right"]])
        self.assertEqual([("d9", "superseded_by")], [(n["id"], n["rel"]) for n in lay["top"]])

    def test_neighbourhood_overflow(self):
        rb = [{"from": "o%d" % i, "rel": "rests_on"} for i in range(1, 10)]
        m = {"nodes": [{"id": "t1", "kind": "tacit", "relates": [], "related_by": rb}] +
             [{"id": "o%d" % i, "kind": "open", "relates": [{"to": "t1", "rel": "rests_on"}],
               "related_by": []} for i in range(1, 10)]}
        lay = _model_call("M.neighbourhoodLayout(%s, %s, %s)"
                          % (json.dumps(m["nodes"][0]), json.dumps(m), _NEIGHBOURHOOD_OPTS))
        self.assertEqual(6, len(lay["right"]))
        self.assertEqual(4, lay["overflow"])
        self.assertEqual("+4", lay["right"][-1]["id"])
        self.assertEqual(4, lay["right"][-1]["overflow"])

    def test_neighbourhood_overflow_trims_the_sides_in_turn(self):
        """Nine neighbours over four sides: five survive, taken from the front of each side in
        the order the map lists them, and no one side carries the whole loss."""
        centre = {"id": "c", "kind": "decision", "superseded_by": "s",
                  "relates": [{"to": "l%d" % i, "rel": "rests_on"} for i in range(1, 4)],
                  "related_by": [{"from": "r%d" % i, "rel": "rests_on"} for i in range(1, 5)]}
        m = {"nodes": [centre, {"id": "b1", "kind": "decision", "superseded_by": "c"}]}
        lay = _model_call("M.neighbourhoodLayout(%s, %s, %s)"
                          % (json.dumps(centre), json.dumps(m), _NEIGHBOURHOOD_OPTS))
        self.assertEqual(4, lay["overflow"])
        kept = dict((side, [n["id"] for n in lay[side] if "overflow" not in n])
                    for side in ("left", "right", "top", "bottom"))
        self.assertEqual(5, sum(len(ids) for ids in kept.values()))
        self.assertEqual(["l1", "l2"], kept["left"])
        self.assertEqual(["r1", "r2", "r3"], kept["right"])
        self.assertEqual("+4", lay["right"][-1]["id"])

    def test_verdict_buttons(self):
        self.assertEqual([], _model_call("M.verdictButtons({kind:'decision', status:'superseded'})"))
        self.assertEqual(["confirmed"], _model_call("M.verdictButtons({kind:'decision', status:'rejected'})"))
        self.assertEqual(["research", "discuss", "rejected"],
                         _model_call("M.verdictButtons({kind:'decision', status:'accepted'})"))
        self.assertEqual(["confirmed", "research", "discuss", "rejected"],
                         _model_call("M.verdictButtons({kind:'open', status:'proposed'})"))

    def test_every_offered_button_is_a_verdict_python_accepts(self):
        offered = set()
        for kind, status in itertools.product(("decision", "tacit", "open"),
                                              ("accepted", "proposed", "superseded", "rejected")):
            offered.update(_model_call("M.verdictButtons({kind:'%s', status:'%s'})" % (kind, status)))
        self.assertTrue(offered)
        self.assertEqual(set(), offered - set(triage.VERDICTS))


if __name__ == "__main__":
    unittest.main()
