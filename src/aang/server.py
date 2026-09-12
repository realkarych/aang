"""The local server the viewer talks to. Loopback only (R7).

Binds `127.0.0.1`, never `0.0.0.0`, and answers 403 to any request whose `Host` is not
`127.0.0.1` / `localhost` / `[::1]`. Without that check a web page could rebind its DNS
name to 127.0.0.1 and read the session transcript through the browser.

A `POST` is additionally refused (403) when the browser reports an `Origin` other than
the viewer's own, and (415) unless the body is declared `application/json`. The Host
check alone does not stop a page on any other site from sending a `text/plain` POST to
127.0.0.1 while `aang view` runs; that page could rewrite the map and have its garbage
stamped `hand_edited: true`, which regeneration then preserves.

Routes:
  GET  /                         ui/index.html
  GET  /model.js                 ui/model.js
  GET  /api/map                  the map, every citation resolved, per-node `verified`,
                                 `related_by` and `cell`, top-level `coverage`, `warnings`,
                                 `tail`, `hook` and `root` (see `annotate`)
  GET  /api/events               text/event-stream: `: connected`, then one
                                 `data: {"changed": [...]}` per change of the map, of
                                 `.aang/session.json` or of the transcript, `: ping` when idle
  POST /api/node/<id>            {"field": value, ...} → edit, `hand_edited: true`, save,
                                 return the map
  POST /api/node/<id>/verdict    {"verdict": ..., "text": ...} → `triage.apply_verdict`, save,
                                 append the verdict to the outbox, return the map
  POST /api/node/<id>/seen       {} → `seen_at` = now, save, return the map; not a hand edit
                                 and nothing for the agent to pick up

Every POST answers with the whole map, so the viewer never has to merge a patch into
what it already shows.
"""

import json
import os
import queue
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import unquote, urlsplit

from . import schema, session, store, transcript, triage

ALLOWED_HOSTS = ("127.0.0.1", "localhost", "[::1]")
ALLOWED_ORIGIN_SCHEME = "http://"
BIND_HOST = "127.0.0.1"
DEFAULT_PORT = 8790
MAX_BODY = 1 << 20
PING_SECONDS = 30
TAIL_TEXT_CAP = 200

EDITABLE_FIELDS = ("kind", "status", "superseded_by", "question", "decision", "why",
                   "against", "consequence", "cites", "relates", "decided_by", "triage")

_UI_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
                        "ui", "index.html")
_MODEL_PATH = os.path.join(os.path.dirname(_UI_PATH), "model.js")

_NEVER_LOOKED = object()


def _stamp(path):  # type: (Optional[str]) -> Optional[Tuple[float, int]]
    """`(mtime, size)` of a file — the cheapest «did it change?» there is — or None
    when there is no such file. Never raises."""
    if not path:
        return None
    try:
        st = os.stat(path)
    except OSError:
        return None
    return (st.st_mtime, st.st_size)


class TranscriptSource(object):
    """Locates and indexes the session transcript, re-indexing only when the file changes.

    Re-indexing is keyed on the path as well as on `(mtime, size)`: two different
    transcripts can carry the same stamp, so a located path that is not the one indexed
    last is read again.

    `path` and `session_id` are what the human asked for on the command line, so both
    outrank the path `.aang/session.json` records for `root`; the session file is the
    default, and only when it is absent or stale is an id (the one `turns()` is given,
    usually the map's, or failing that the newest session of `root`'s own project)
    looked up under `roots` (None → `~/.claude/projects` and `~/.codex/sessions`).
    Never raises: `turns()` returns `(turns, error)` where `error` is a Russian string
    when the transcript is missing or empty.
    """

    def __init__(self, path=None, session_id=None, roots=None, root=None):
        # type: (Optional[str], Optional[str], Optional[List[str]], Optional[str]) -> None
        self.pinned = path
        self.session_id = session_id
        self.roots = roots
        self.root = root
        self.path = None  # type: Optional[str]
        self._stamp = None  # type: Optional[Tuple[float, int]]
        self._turns = []  # type: List[Dict[str, Any]]
        self._lock = threading.Lock()

    def locate(self, session_id=None):  # type: (Optional[str]) -> Optional[str]
        """The transcript to read: an explicit flag first, then the session file, then a lookup.

        An explicit `--session` skips the session file entirely — it would otherwise
        answer with the transcript of whatever session is running right now, which is
        exactly the one the flag was given to override.
        """
        if self.pinned:
            return self.pinned
        if self.root and not self.session_id:
            recorded = session.transcript_path(self.root)
            if recorded:
                return recorded
        return transcript.find_session(self.session_id or session_id or None, self.roots, cwd=self.root)

    def turns(self, session_id=None):  # type: (Optional[str]) -> Tuple[List[Dict[str, Any]], Optional[str]]
        with self._lock:
            path = self.locate(session_id)
            if not path or not os.path.isfile(path):
                self.path, self._stamp, self._turns = None, None, []
                wanted = self.pinned or self.session_id or session_id
                if wanted:
                    return [], "транскрипт сессии не найден: %s" % wanted
                return [], "транскрипт сессии не найден"
            moved = path != self.path
            self.path = path
            stamp = _stamp(path)
            if stamp is None or stamp != self._stamp or moved:
                self._turns = transcript.index(path)
                self._stamp = stamp
            if not self._turns:
                return [], "транскрипт %s пуст или нечитаем" % path
            return self._turns, None


def annotate(map_dict, turns, transcript_error=None, transcript_path=None, session_info=None, root=None):
    # type: (Any, List[Dict[str, Any]], Optional[str], Optional[str], Optional[Dict[str, Any]], Optional[str]) -> Dict[str, Any]
    """The map as `/api/map` serves it — the one place `verified` is derived.

    Each citation is replaced by its resolution (`turn` filled from the quote when the
    file has none, `role`, `ok`, `excerpt`, `reason`, `quote`, `matches`). A node is
    `verified` only when it has at least one citation and every one resolved `ok`;
    a node with nothing to check is not verified. With `transcript_error` set, nothing
    is resolved and every node is `verified: false`.

    `related_by` on each node is the reverse of everyone else's `relates` — derived here,
    never stored, so the two sides cannot disagree (spec U4); a node nothing points at
    gets `[]`, not a missing key. Whatever the file claims under that key is discarded.

    `coverage` is `{"covered_to": int|None, "turns": int}`: the largest turn among the
    citations that resolved `ok` (a claim nobody could verify extends nothing) against
    the transcript's length right now, never a stored count (spec U6). `warnings` is
    `schema.warnings` so remarks travel with the map instead of being recomputed.

    `cell` on each node is `triage.cell` — derived here like `verified`, never stored.
    `tail` is what the map does not account for yet: the turns past `covered_to`, each
    `{"turn", "role", "text"}` with the text cut to `TAIL_TEXT_CAP`. It is empty when
    nothing is covered (there is no «past» to show) or the transcript is unreadable.
    `hook` reports `.aang/session.json` (`installed`, `harness`, `last_event_at`) and
    `root` is the project the map belongs to, so the viewer can name both.

    An invalid map is never rendered: `errors` is non-empty and `nodes` is empty; the
    other keys keep their shape (`coverage` with `covered_to: null`, `warnings: []`,
    `tail: []`).
    """
    map_dict = schema.normalize(json.loads(json.dumps(map_dict)))
    errors = schema.validate(map_dict)
    view = {
        "version": map_dict.get("version"),
        "session_id": map_dict.get("session_id", ""),
        "generated_at": map_dict.get("generated_at", ""),
        "title": map_dict.get("title", ""),
        "root": root,
        "transcript_path": transcript_path,
        "transcript_error": transcript_error,
        "turns": len(turns) if not transcript_error else 0,
        "errors": errors,
        "coverage": {"covered_to": None, "turns": 0},
        "warnings": [],
        "hook": _hook_info(session_info),
        "tail": [],
        "nodes": [],
    }
    view["coverage"]["turns"] = view["turns"]
    if errors:
        return view
    view["warnings"] = schema.warnings(map_dict)
    covered = []  # type: List[int]
    for node in map_dict["nodes"]:
        cites = node.get("cites") or []
        if transcript_error:
            resolved = [_unresolved(cite, transcript_error) for cite in cites]
        else:
            resolved = transcript.resolve(cites, turns)
        node["cites"] = resolved
        node["verified"] = bool(resolved) and all(c["ok"] for c in resolved)
        covered.extend(c["turn"] for c in resolved if c["ok"] and isinstance(c["turn"], int))
        view["nodes"].append(node)

    reverse = {}  # type: Dict[str, List[Dict[str, str]]]
    for node in view["nodes"]:
        for rel in node.get("relates") or []:
            target = rel.get("to")
            if target:
                reverse.setdefault(target, []).append({"from": node["id"], "rel": rel.get("rel", "")})
    for node in view["nodes"]:
        node["related_by"] = reverse.get(node["id"], [])
        node["cell"] = triage.cell(node)

    covered_to = max(covered) if covered else None
    view["coverage"]["covered_to"] = covered_to
    if covered_to is not None and not transcript_error:
        view["tail"] = [{"turn": t["turn"], "role": t["role"],
                         "text": (t.get("text") or "")[:TAIL_TEXT_CAP]}
                        for t in turns if t["turn"] > covered_to]
    return view


def _hook_info(session_info):  # type: (Optional[Dict[str, Any]]) -> Dict[str, Any]
    """What `.aang/session.json` says about the hook: absent means it never ran."""
    info = session_info if isinstance(session_info, dict) else None
    return {"installed": info is not None,
            "harness": info.get("harness") if info else None,
            "last_event_at": info.get("last_event_at") if info else None}


def _unresolved(cite, reason):  # type: (Dict[str, Any], str) -> Dict[str, Any]
    return {
        "turn": cite.get("turn"),
        "role": cite.get("role"),
        "ok": False,
        "excerpt": "",
        "reason": "не проверено: %s" % reason,
        "quote": cite.get("quote") or "",
        "matches": [],
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "aang/0.1"
    sys_version = ""

    def _host_allowed(self):  # type: () -> bool
        host = self.headers.get("Host")
        if not host:
            return False
        host = host.strip().lower()
        if host.startswith("["):
            end = host.find("]")
            if end < 0:
                return False
            host = host[:end + 1]
        elif ":" in host:
            host = host.rsplit(":", 1)[0]
        return host in ALLOWED_HOSTS

    def _origin_allowed(self):  # type: () -> bool
        """True without an `Origin` header (curl, the CLI) or with one naming this server.

        Browsers send `Origin` on every POST, so a cross-site page cannot omit it; a
        missing header means a non-browser client, which the Host check already covers.
        """
        origin = self.headers.get("Origin")
        if origin is None:
            return True
        origin = origin.strip().lower()
        if not origin.startswith(ALLOWED_ORIGIN_SCHEME):
            return False
        host = origin[len(ALLOWED_ORIGIN_SCHEME):]
        if "/" in host or not host:
            return False
        if host.startswith("["):
            end = host.find("]")
            if end < 0:
                return False
            host, port = host[:end + 1], host[end + 1:]
        elif ":" in host:
            host, port = host.rsplit(":", 1)
            port = ":" + port
        else:
            port = ""
        if port and not _is_port(port):
            return False
        return host in ALLOWED_HOSTS

    def _content_type_is_json(self):  # type: () -> bool
        ctype = (self.headers.get("Content-Type") or "").split(";", 1)[0].strip().lower()
        return ctype == "application/json"

    def _send(self, status, body, content_type):  # type: (int, bytes, str) -> None
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, status, payload):  # type: (int, Any) -> None
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self._send(status, body, "application/json; charset=utf-8")

    def _text(self, status, message):  # type: (int, str) -> None
        self._send(status, (message + "\n").encode("utf-8"), "text/plain; charset=utf-8")

    def _view(self, map_dict):  # type: (Dict[str, Any]) -> Dict[str, Any]
        root = self.server.root  # type: ignore[attr-defined]
        source = self.server.transcript_source  # type: ignore[attr-defined]
        turns, error = source.turns(map_dict.get("session_id") or None)
        return annotate(map_dict, turns, error, source.path, session.read(root), root)

    def _file(self, path, ctype, missing):  # type: (str, str, str) -> None
        """Serve one file of the built interface, or 404 with `missing` when it is absent."""
        try:
            with open(path, "rb") as handle:
                body = handle.read()
        except OSError:
            self._text(404, missing)
            return
        self._send(200, body, ctype)

    def _gate(self):  # type: () -> bool
        if not self._host_allowed():
            self._text(403, "Запрос отклонён: заголовок Host не локальный. "
                            "aang отвечает только на 127.0.0.1 / localhost / [::1].")
            return False
        return True

    def log_message(self, fmt, *args):  # type: (str, *Any) -> None
        if getattr(self.server, "verbose", False):
            BaseHTTPRequestHandler.log_message(self, fmt, *args)

    def do_HEAD(self):  # type: () -> None
        self.do_GET()

    def do_GET(self):  # type: () -> None
        if not self._gate():
            return
        path = urlsplit(self.path).path
        root = self.server.root  # type: ignore[attr-defined]
        if path in ("/", "/index.html"):
            self._file(getattr(self.server, "ui_path", _UI_PATH), "text/html; charset=utf-8",
                       "ui/index.html не найден — интерфейс ещё не собран. "
                       "Карта доступна на /api/map.")
        elif path == "/model.js":
            self._file(getattr(self.server, "model_path", _MODEL_PATH),
                       "application/javascript; charset=utf-8",
                       "ui/model.js не найден — интерфейс собран не полностью.")
        elif path == "/api/map":
            self._json(200, self._view(store.load(root)))
        elif path == "/api/events":
            self._events()
        else:
            self._text(404, "Нет такого пути: %s" % path)

    def _events(self):  # type: () -> None
        """The change stream the viewer listens to instead of polling `/api/map`.

        The body never ends by itself, so `HEAD` is answered with the headers and nothing
        else. The loop leaves when the viewer goes away (writing to a closed socket raises
        an `OSError` — a broken pipe or a reset) and when the watcher stops and wakes every
        subscriber with `None`, so closing the server does not wait out a ping.
        """
        if self.command == "HEAD":
            self._send(200, b"", "text/event-stream; charset=utf-8")
            return
        watcher = self.server.watcher  # type: ignore[attr-defined]
        events = watcher.subscribe()
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(b": connected\n\n")
            self.wfile.flush()
            while True:
                try:
                    event = events.get(timeout=PING_SECONDS)
                except queue.Empty:
                    frame = ": ping\n\n"
                else:
                    if event is None:
                        return
                    frame = "data: %s\n\n" % json.dumps(event, ensure_ascii=False)
                self.wfile.write(frame.encode("utf-8"))
                self.wfile.flush()
        except OSError:
            pass
        finally:
            watcher.unsubscribe(events)

    def do_POST(self):  # type: () -> None
        if not self._gate():
            return
        if not self._origin_allowed():
            self._json(403, {"errors": ["запрос отклонён: Origin %r не локальный — писать в карту может "
                                        "только сам интерфейс aang" % self.headers.get("Origin")]})
            return
        if not self._content_type_is_json():
            self._json(415, {"errors": ["ожидается Content-Type: application/json"]})
            return
        path = urlsplit(self.path).path
        if not path.startswith("/api/node/"):
            self._text(404, "Нет такого пути: %s" % path)
            return
        rest = unquote(path[len("/api/node/"):])
        parts = rest.split("/")
        node_id = parts[0]
        action = parts[1] if len(parts) == 2 else ("" if len(parts) == 1 else None)
        if action is None or not node_id:
            self._text(404, "Нет такого пути: %s" % path)
            return
        body = self._read_body()
        if body is None:
            return
        try:
            payload = json.loads(body.decode("utf-8")) if body else {}
        except (ValueError, UnicodeDecodeError):
            self._json(400, {"errors": ["тело запроса — не JSON"]})
            return
        if not isinstance(payload, dict):
            self._json(400, {"errors": ["ожидался объект JSON"]})
            return
        if action == "":
            self._post_edit(node_id, payload)
        elif action == "verdict":
            self._post_verdict(node_id, payload)
        elif action == "seen":
            self._post_seen(node_id)
        else:
            self._text(404, "Нет такого пути: %s" % path)

    def _mutate(self, node_id, change, after_save=None):
        # type: (str, Any, Any) -> None
        """Load under the write lock, apply `change(node) -> Optional[str]`, validate, save,
        run `after_save(node)`, answer with the view.

        Errors: 404 unknown node, 409 a map that was already invalid before the change
        (the file is a human's to fix, not ours to overwrite), 422 a change refused by the
        verdict rule or by the schema, 500 a save that failed. Nothing reaches the disk
        until every check has passed; past that point the two writes can part ways, and a
        saved map whose outbox line was not written answers 500 saying exactly that, so
        the human knows the agent will not hear about this verdict.
        """
        root = self.server.root  # type: ignore[attr-defined]
        with self.server.write_lock:  # type: ignore[attr-defined]
            map_dict = store.load(root)
            node = next((n for n in map_dict["nodes"]
                         if isinstance(n, dict) and n.get("id") == node_id), None)
            if node is None:
                self._json(404, {"errors": ["узла %s нет в карте" % node_id]})
                return
            before = schema.validate(map_dict)
            if before:
                self._json(409, {"errors": ["карта невалидна, сначала исправьте файл .aang/map.json"] + before})
                return
            refused = change(node)
            if refused:
                self._json(422, {"errors": [refused]})
                return
            errors = schema.validate(schema.normalize(map_dict))
            if errors:
                self._json(422, {"errors": errors})
                return
            try:
                store.save(root, map_dict)
            except OSError as exc:
                self._json(500, {"errors": ["не удалось сохранить карту: %s" % exc]})
                return
            if after_save is not None:
                try:
                    after_save(node)
                except OSError as exc:
                    self._json(500, {"errors": ["карта сохранена, но событие для агента не записано: %s" % exc]})
                    return
        self._json(200, self._view(map_dict))

    def _post_edit(self, node_id, edit):  # type: (str, Dict[str, Any]) -> None
        """A human's correction of any field the viewer may touch — stamped `hand_edited`.

        `EDITABLE_FIELDS` leaves out what is not a human's to set through the API: `id` is
        identity, `hand_edited` is set here, `added_at` is aang's stamp and `related_by` is
        derived (U4). `relates` is content corrected like any other field; a bad edge —
        wrong vocabulary, forward reference, missing target, over the cap — is refused by
        the validation every edit passes through, with 422.
        """
        if not edit:
            self._json(400, {"errors": ["ожидался объект {\"поле\": значение, …}"]})
            return
        unknown = [k for k in edit if k not in EDITABLE_FIELDS]
        if unknown:
            self._json(400, {"errors": ["поле нельзя менять через API: %s" % ", ".join(sorted(unknown))]})
            return

        def apply_edit(node):  # type: (Dict[str, Any]) -> Optional[str]
            node.update(edit)
            node["hand_edited"] = True
            return None

        self._mutate(node_id, apply_edit)

    def _post_verdict(self, node_id, payload):  # type: (str, Dict[str, Any]) -> None
        """A verdict from the viewer: the node changes, and the agent hears about it."""
        verdict = payload.get("verdict")
        text = payload.get("text") or ""
        if not isinstance(verdict, str) or not isinstance(text, str):
            self._json(400, {"errors": ["ожидался объект {\"verdict\": …, \"text\": …}"]})
            return
        root = self.server.root  # type: ignore[attr-defined]
        self._mutate(node_id,
                     lambda node: triage.apply_verdict(node, verdict, text),
                     lambda node: session.outbox_append(root, verdict, node_id, text.strip()))

    def _post_seen(self, node_id):  # type: (str) -> None
        """«Я это видел» — a stamp, not an edit: no `hand_edited`, nothing for the agent."""
        def stamp(node):  # type: (Dict[str, Any]) -> Optional[str]
            node["seen_at"] = session.now_iso()
            return None

        self._mutate(node_id, stamp)

    def _read_body(self):  # type: () -> Optional[bytes]
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            self._json(400, {"errors": ["некорректный Content-Length"]})
            return None
        if length < 0 or length > MAX_BODY:
            self._json(413, {"errors": ["тело запроса больше %d байт" % MAX_BODY]})
            return None
        return self.rfile.read(length) if length else b""


def _is_port(suffix):  # type: (str) -> bool
    """`:8790` → True; anything else (empty, `:`, `:x`, `:80:80`) → False."""
    return suffix.startswith(":") and suffix[1:].isdigit()


class Watcher(threading.Thread):
    """Polls `(mtime, size)` of a few files and tells subscribers which label changed.

    `paths_fn` returns `{label: path}` and is called on every tick, so it has to be cheap
    (see `Server._watched_paths`); a label whose file is missing is watched as None and
    its appearance is a change like any other. `stop()` also wakes every subscriber with
    `None`, so a handler blocked on its queue ends its stream at once instead of waiting
    out a ping. The stop flag is `_stopped`: `_stop` is a method of `Thread` itself, and
    shadowing it breaks `join()`.
    """

    def __init__(self, paths_fn, interval=1.0):  # type: (Any, float) -> None
        threading.Thread.__init__(self, daemon=True)
        self.paths_fn = paths_fn
        self.interval = interval
        self._subs = []  # type: List[queue.Queue]
        self._lock = threading.Lock()
        self._stopped = threading.Event()
        self._last = self.snapshot()

    def snapshot(self):  # type: () -> Dict[str, Any]
        return dict((label, _stamp(path)) for label, path in (self.paths_fn() or {}).items())

    def subscribe(self):  # type: () -> queue.Queue
        events = queue.Queue()  # type: queue.Queue
        with self._lock:
            self._subs.append(events)
        return events

    def unsubscribe(self, events):  # type: (queue.Queue) -> None
        with self._lock:
            if events in self._subs:
                self._subs.remove(events)

    def stop(self):  # type: () -> None
        self._stopped.set()
        self._publish(None)

    def run(self):  # type: () -> None
        while not self._stopped.wait(self.interval):
            current = self.snapshot()
            changed = sorted(label for label in set(current) | set(self._last)
                             if current.get(label) != self._last.get(label))
            self._last = current
            if changed:
                self._publish({"changed": changed})

    def _publish(self, event):  # type: (Any) -> None
        with self._lock:
            subs = list(self._subs)
        for events in subs:
            events.put(event)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, root, transcript_source, ui_path=None, verbose=False,
                 watch_interval=1.0):
        # type: (Tuple[str, int], str, TranscriptSource, Optional[str], bool, float) -> None
        self.root = root
        self.transcript_source = transcript_source
        self.ui_path = ui_path or _UI_PATH
        self.verbose = verbose
        self.write_lock = threading.Lock()
        self._session_stamp = _NEVER_LOOKED  # type: Any
        self._located = None  # type: Optional[str]
        ThreadingHTTPServer.__init__(self, address, Handler)
        self.watcher = Watcher(self._watched_paths, interval=watch_interval)
        self.watcher.start()

    @property
    def url(self):  # type: () -> str
        return "http://%s:%d/" % (BIND_HOST, self.server_address[1])

    def _watched_paths(self):  # type: () -> Dict[str, Optional[str]]
        """The three files the watcher polls: the map, `.aang/session.json`, the transcript.

        The session file is watched, not only read, so a hook that starts after the server
        is noticed; the transcript is whatever that file (or a lookup) points at now.
        """
        session_path = os.path.join(store.map_dir(self.root), session.SESSION_FILE)
        return {"map": store.map_path(self.root),
                "session": session_path,
                "transcript": self._transcript_path(session_path)}

    def _transcript_path(self, session_path):  # type: (str) -> Optional[str]
        """Where the transcript is, answered from cache whenever that is honest.

        `TranscriptSource.locate` can end in `transcript.find_session`, which opens the head
        of every candidate transcript under `~/.claude/projects` and `~/.codex/sessions`;
        once a second that is far too much. So the answer is the path the last `turns()`
        left on the source, or the one located here before, and a fresh lookup happens only
        when there is none yet, when `.aang/session.json` changed since the last tick (the
        hook rewrites it as the session runs) or when the remembered file is gone. The map's
        `session_id` is read for the same reason: only when a lookup actually happens.

        Called from the watcher thread only, which is what makes the two cached fields safe.
        """
        known = self.transcript_source.path or self._located
        stamp = _stamp(session_path)
        if stamp == self._session_stamp and (known is None or os.path.exists(known)):
            return known
        self._session_stamp = stamp
        self._located = self.transcript_source.locate(store.load(self.root).get("session_id") or None)
        return self._located

    def server_close(self):  # type: () -> None
        """Stop the watcher, then the socket.

        A failed `bind` makes `TCPServer.__init__` call this to release the socket, and
        that happens before there is a watcher — so the attribute is asked for, not
        assumed. Without that, a taken port surfaces as `AttributeError` instead of the
        `OSError` the caller is waiting for, and the socket leaks.
        """
        watcher = getattr(self, "watcher", None)
        if watcher is not None:
            watcher.stop()
        ThreadingHTTPServer.server_close(self)


def make_server(root, port=DEFAULT_PORT, transcript_source=None, ui_path=None, verbose=False,
                watch_interval=1.0):
    # type: (str, int, Optional[TranscriptSource], Optional[str], bool, float) -> Server
    """A server bound to 127.0.0.1:`port` (0 picks a free port). Call `serve_forever()`."""
    source = transcript_source if transcript_source is not None else TranscriptSource(root=root)
    if source.root is None:
        source.root = root
    return Server((BIND_HOST, port), root, source, ui_path=ui_path, verbose=verbose,
                  watch_interval=watch_interval)
