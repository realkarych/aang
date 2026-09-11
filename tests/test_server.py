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
        self.srv = server.make_server(self.root, 0, source, ui_path=self.ui_path or self.ui)
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

    def test_index_carries_the_relation_vocabulary(self):
        """Search, neighbourhood, coverage and triage words; and every relation label the export
        uses, so the Python and JS copies of REL_LABELS cannot drift apart unnoticed."""
        page = self.request("GET", "/")[2].decode("utf-8")
        for word in ("скрыто", "ни с чем не связано", "На этом держатся", "покрыто до хода",
                     "ни одна цитата не разрешена", "Осиротело решениями", "Просто висит", "новое"):
            self.assertIn(word, page, word)
        for rel, label in store.REL_LABELS.items():
            self.assertIn("\"" + label + "\"", page, rel)

    def test_index_is_self_contained(self):
        page = self.request("GET", "/")[2].decode("utf-8")
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
        self.assertEqual([], view["warnings"])


if __name__ == "__main__":
    unittest.main()
