import http.client
import json
import os
import shutil
import tempfile
import threading
import unittest

from aang import server, store

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
             "cites": [{"quote": "давай pass@1"}, {"quote": "Ещё вариант: pass@5", "turn": 3}]},
            {"id": "d2", "kind": "decision", "status": "accepted", "question": "Сколько?",
             "decision": "500", "why": "так сказали",
             "cites": [{"quote": "нужно 500 примеров вместо 100"}, {"quote": "этого никто не говорил"}]},
            {"id": "o1", "kind": "open", "status": "proposed", "question": "Кто платит?",
             "why": "следствие", "cites": []},
        ],
    }


class ServerTestCase(unittest.TestCase):
    transcript = NORMAL

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="aang-srv-")
        self.addCleanup(shutil.rmtree, self.root, True)
        self.ui = os.path.join(self.root, "index.html")
        with open(self.ui, "w", encoding="utf-8") as handle:
            handle.write("<title>aang</title><p>привет</p>")
        store.save(self.root, sample_map())
        source = server.TranscriptSource(path=self.transcript, roots=[])
        self.srv = server.make_server(self.root, 0, source, ui_path=self.ui)
        self.port = self.srv.server_address[1]
        self.thread = threading.Thread(target=self.srv.serve_forever, kwargs={"poll_interval": 0.02},
                                       daemon=True)
        self.thread.start()
        self.addCleanup(self.srv.server_close)
        self.addCleanup(self.srv.shutdown)

    def request(self, method, path, body=None, host="127.0.0.1", send_host=True):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            conn.putrequest(method, path, skip_host=True)
            if send_host:
                conn.putheader("Host", host)
            payload = None
            if body is not None:
                payload = json.dumps(body).encode("utf-8")
                conn.putheader("Content-Type", "application/json")
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
        for body in ({"id": "d9"}, {"hand_edited": False}, {"verified": True}, {"colour": "red"}):
            self.assertEqual(self.request("POST", "/api/node/d1", body=body)[0], 400, body)
        self.assertFalse(store.load(self.root)["nodes"][0]["hand_edited"])

    def test_bad_bodies(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn.request("POST", "/api/node/d1", body=b"{not json", headers={"Content-Length": "9"})
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


class AnnotateTest(unittest.TestCase):
    def test_does_not_mutate_input(self):
        m = sample_map()
        turns = []
        server.annotate(m, turns, "нет транскрипта")
        self.assertNotIn("verified", m["nodes"][0])
        self.assertNotIn("ok", m["nodes"][0]["cites"][0])


if __name__ == "__main__":
    unittest.main()
