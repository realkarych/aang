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
  GET  /                 ui/index.html
  GET  /api/map          the map, every citation resolved, per-node `verified`,
                         `related_by` and `cell`, top-level `coverage`, `warnings`,
                         `tail`, `hook` and `root` (see `annotate`)
  POST /api/node/<id>    {"field": value, ...} → edit, `hand_edited: true`, save, return the map
"""

import json
import os
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
TAIL_TEXT_CAP = 200

# Fields the viewer may change through POST. `id` is identity, `hand_edited` is set here,
# `added_at` is aang's stamp and `related_by` is derived (U4). `relates` is content a human
# corrects like any other field; a bad edge (wrong vocabulary, forward reference, missing
# target, over the cap) is refused by the validation every edit passes through, with 422.
EDITABLE_FIELDS = ("kind", "status", "superseded_by", "question", "decision", "why",
                   "against", "consequence", "cites", "relates")

_UI_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
                        "ui", "index.html")


# ----------------------------------------------------------------------------- transcript

class TranscriptSource(object):
    """Locates and indexes the session transcript, re-indexing only when the file changes.

    `path` pins a transcript file; otherwise the path `.aang/session.json` recorded for
    `root` is used, and only when that is absent or stale is `session_id` (or, failing
    that, the newest session of `root`'s own project) looked up under `roots`
    (None → `~/.claude/projects` and `~/.codex/sessions`). Never raises: `turns()` returns
    `(turns, error)` where `error` is a Russian string when the transcript is missing
    or empty.
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
        if self.pinned:
            return self.pinned
        if self.root:
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
            self.path = path
            try:
                st = os.stat(path)
                stamp = (st.st_mtime, st.st_size)
            except OSError:
                stamp = None
            if stamp is None or stamp != self._stamp:
                self._turns = transcript.index(path)
                self._stamp = stamp
            if not self._turns:
                return [], "транскрипт %s пуст или нечитаем" % path
            return self._turns, None


# ----------------------------------------------------------------------------- view

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


# ----------------------------------------------------------------------------- handler

class Handler(BaseHTTPRequestHandler):
    server_version = "aang/0.1"
    sys_version = ""

    # --- helpers

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

    def _gate(self):  # type: () -> bool
        if not self._host_allowed():
            self._text(403, "Запрос отклонён: заголовок Host не локальный. "
                            "aang отвечает только на 127.0.0.1 / localhost / [::1].")
            return False
        return True

    def log_message(self, fmt, *args):  # type: (str, *Any) -> None
        if getattr(self.server, "verbose", False):
            BaseHTTPRequestHandler.log_message(self, fmt, *args)

    # --- routes

    def do_HEAD(self):  # type: () -> None
        self.do_GET()

    def do_GET(self):  # type: () -> None
        if not self._gate():
            return
        path = urlsplit(self.path).path
        root = self.server.root  # type: ignore[attr-defined]
        if path in ("/", "/index.html"):
            ui_path = getattr(self.server, "ui_path", _UI_PATH)
            try:
                with open(ui_path, "rb") as handle:
                    body = handle.read()
            except OSError:
                self._text(404, "ui/index.html не найден — интерфейс ещё не собран. "
                                "Карта доступна на /api/map.")
                return
            self._send(200, body, "text/html; charset=utf-8")
        elif path == "/api/map":
            self._json(200, self._view(store.load(root)))
        else:
            self._text(404, "Нет такого пути: %s" % path)

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
        node_id = unquote(path[len("/api/node/"):])
        body = self._read_body()
        if body is None:
            return
        try:
            edit = json.loads(body.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            self._json(400, {"errors": ["тело запроса — не JSON"]})
            return
        if not isinstance(edit, dict) or not edit:
            self._json(400, {"errors": ["ожидался объект {\"поле\": значение, …}"]})
            return
        unknown = [k for k in edit if k not in EDITABLE_FIELDS]
        if unknown:
            self._json(400, {"errors": ["поле нельзя менять через API: %s" % ", ".join(sorted(unknown))]})
            return

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
            node.update(edit)
            node["hand_edited"] = True
            errors = schema.validate(schema.normalize(map_dict))
            if errors:
                self._json(422, {"errors": errors})
                return
            try:
                store.save(root, map_dict)
            except OSError as exc:
                self._json(500, {"errors": ["не удалось сохранить карту: %s" % exc]})
                return
        self._json(200, self._view(map_dict))

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


# ----------------------------------------------------------------------------- server

class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, root, transcript_source, ui_path=None, verbose=False):
        # type: (Tuple[str, int], str, TranscriptSource, Optional[str], bool) -> None
        self.root = root
        self.transcript_source = transcript_source
        self.ui_path = ui_path or _UI_PATH
        self.verbose = verbose
        self.write_lock = threading.Lock()
        ThreadingHTTPServer.__init__(self, address, Handler)

    @property
    def url(self):  # type: () -> str
        return "http://%s:%d/" % (BIND_HOST, self.server_address[1])


def make_server(root, port=DEFAULT_PORT, transcript_source=None, ui_path=None, verbose=False):
    # type: (str, int, Optional[TranscriptSource], Optional[str], bool) -> Server
    """A server bound to 127.0.0.1:`port` (0 picks a free port). Call `serve_forever()`."""
    source = transcript_source if transcript_source is not None else TranscriptSource(root=root)
    if source.root is None:
        source.root = root
    return Server((BIND_HOST, port), root, source, ui_path=ui_path, verbose=verbose)
